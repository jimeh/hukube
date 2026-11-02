import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Agent, request } from "node:https";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { clusterId, engineToken, kubectl, kubectlCreate } from "./tests/env.ts";

/** One private Pod and an API proxy that holds the first Previous response before EOF. */
export async function logReplayFixture() {
  const root = resolve(import.meta.dirname, "..");
  const scratch = mkdtempSync(join(root, ".data/e2e/log-replay-"));
  const namespace = `e2e-replay-${randomUUID().slice(0, 8)}`;
  const name = "previous-once";
  const config = JSON.parse(kubectl("config", "view", "--raw", "-o", "json")) as {
    "current-context": string;
    contexts: { name: string; context: { cluster: string; user: string } }[];
    clusters: { name: string; cluster: { server: string; "certificate-authority-data": string } }[];
    users: {
      name: string;
      user: { "client-certificate-data": string; "client-key-data": string };
    }[];
  };
  expect(config["current-context"]).toBe(clusterId);
  const context = config.contexts.find((item) => item.name === clusterId)!.context;
  const cluster = config.clusters.find((item) => item.name === context.cluster)!.cluster;
  const user = config.users.find((item) => item.name === context.user)!.user;
  const upstream = new URL(cluster.server);
  expect(upstream.protocol).toBe("https:");
  const agent = new Agent({
    ca: Buffer.from(cluster["certificate-authority-data"], "base64"),
    cert: Buffer.from(user["client-certificate-data"], "base64"),
    key: Buffer.from(user["client-key-data"], "base64"),
    rejectUnauthorized: true,
  });
  let gateRequest = 1;
  let prefixLines = 4;
  const evidence = {
    requests: 0,
    heldAt: 0,
    closedAt: 0,
    forwarded: 0,
    withheld: 0,
    upstreamEnded: false,
    errors: [] as string[],
  };
  const proxy = createServer((incoming, response) => {
    const url = new URL(incoming.url!, upstream);
    if (url.origin !== upstream.origin) {
      response.writeHead(400).end();
      return;
    }
    const headers = { ...incoming.headers, host: upstream.host };
    delete headers["accept-encoding"];
    const outgoing = request(url, { method: incoming.method, headers, agent }, (remote) => {
      response.writeHead(remote.statusCode!, remote.headers);
      const previous =
        url.pathname === `/api/v1/namespaces/${namespace}/pods/${name}/log` &&
        url.searchParams.get("previous") === "true";
      if (!previous || ++evidence.requests !== gateRequest) {
        remote.pipe(response);
        return;
      }
      if (prefixLines === 0) {
        evidence.heldAt = Date.now();
        response.flushHeaders();
      }
      let pending = "";
      remote.setEncoding("utf8");
      remote.on("data", (chunk: string) => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline + 1);
          pending = pending.slice(newline + 1);
          if (evidence.forwarded < prefixLines) {
            response.write(line);
            if (++evidence.forwarded === prefixLines) evidence.heldAt = Date.now();
          } else evidence.withheld++;
        }
      });
      remote.on("end", () => {
        evidence.upstreamEnded = true;
      });
      // This is the RESPONSE lifetime. GET's request-body completion is not a pause.
      response.on("close", () => {
        evidence.closedAt = Date.now();
        remote.destroy();
      });
    });
    outgoing.on("error", (error) => {
      if (!response.destroyed) {
        evidence.errors.push(error.message);
        response.destroy();
      }
    });
    response.on("close", () => outgoing.destroy());
    incoming.pipe(outgoing);
  });
  let engine: ChildProcess | undefined;
  let created = false;
  const close = async () => {
    if (engine && engine.exitCode === null && engine.signalCode === null) {
      const exited = once(engine, "exit");
      engine.kill("SIGTERM");
      await exited;
    }
    proxy.closeAllConnections();
    if (proxy.listening)
      await new Promise<void>((done, reject) =>
        proxy.close((error) => (error ? reject(error) : done())),
      );
    agent.destroy();
    if (created) kubectl("delete", "namespace", namespace, "--wait=true", "--timeout=60s");
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    cluster.server = `http://127.0.0.1:${port}`;
    const derivative = join(scratch, "kubeconfig.json");
    writeFileSync(derivative, JSON.stringify(config), { mode: 0o600 });
    kubectl("create", "namespace", namespace);
    created = true;
    kubectlCreate({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace },
      spec: {
        volumes: [{ name: "once", emptyDir: {} }],
        containers: [
          {
            name: "app",
            image: "busybox:1.36",
            volumeMounts: [{ name: "once", mountPath: "/once" }],
            command: [
              "sh",
              "-c",
              "if [ ! -f /once/done ]; then touch /once/done; printf 'keep original 1\\nhidden original 2\\nkeep original 3\\nkeep original 4\\nkeep withheld 5\\n'; exit 1; fi; echo stable current; sleep 3600",
            ],
          },
        ],
      },
    });
    kubectl("-n", namespace, "wait", "--for=condition=Ready", `pod/${name}`, "--timeout=60s");
    await expect
      .poll(
        () =>
          kubectl(
            "-n",
            namespace,
            "get",
            "pod",
            name,
            "-o",
            "jsonpath={.status.containerStatuses[0].restartCount}",
          ),
        { timeout: 60_000 },
      )
      .toBe("1");
    return {
      namespace,
      name,
      scratch,
      kubeconfig: derivative,
      evidence,
      close,
      holdNextEmpty() {
        gateRequest = evidence.requests + 1;
        prefixLines = 0;
        evidence.heldAt = evidence.closedAt = evidence.forwarded = evidence.withheld = 0;
        evidence.upstreamEnded = false;
      },
      async startWeb() {
        let url: string | undefined;
        let output = "";
        engine = spawn(
          join(root, "engine/bin/hukube-engine"),
          [
            "--web",
            `--ui-dir=${join(root, "apps/app/dist")}`,
            "--listen=127.0.0.1:0",
            `--token=${engineToken}`,
            `--kubeconfig=${derivative}`,
            `--data-dir=${join(scratch, "engine")}`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        engine.stdout!.on("data", (bytes: Buffer) => {
          output += bytes.toString();
          let newline: number;
          while ((newline = output.indexOf("\n")) !== -1) {
            const line = output.slice(0, newline);
            output = output.slice(newline + 1);
            try {
              const record = JSON.parse(line) as { event?: string; url?: string };
              if (record.event === "ready") url = record.url;
            } catch {
              /* Only ready is structured. */
            }
          }
        });
        // Drain stderr without logging credentials, content, or authentication URLs.
        engine.stderr!.resume();
        await expect
          .poll(
            () => {
              if (engine!.exitCode !== null)
                throw new Error(`Replay Engine exited with ${engine!.exitCode}`);
              return url;
            },
            { timeout: 20_000 },
          )
          .toBeTruthy();
        return url!;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
