import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";

import {
  Harness,
  captureVariable,
  capturedURL,
  childEnvironment,
  encodeOwner,
  healthyURL,
  identity,
  k3dEnvironment,
  launchEnvironment,
  ownerLabel,
  readEnvironment,
  readyPattern,
  resolveIdentity,
  safePath,
  withLock,
  type Identity,
  type Run,
} from "./harness.ts";
import { stopVerify } from "./verify.ts";

const temporary: string[] = [];
function directory(name = "hukube-harness-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  temporary.push(dir);
  return dir;
}
function fixtureOwner() {
  return identity(directory("hukube ,@é harness-"), "0123456789ab");
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fake only the external CLI boundary. All ownership, context and lifecycle checks are real. */
class Runtime {
  readonly calls: [string, string[], string | undefined, NodeJS.ProcessEnv | undefined][] = [];
  nodes: ReturnType<Runtime["server"]>[] = [];
  networks: string[] = [];
  volumes: string[] = [];
  listed = false;
  context: string;
  queryFailure = "";
  createFailure = false;
  readonly harness: Harness;
  constructor(readonly owner: Identity) {
    this.context = `k3d-${owner.cluster}`;
    this.harness = new Harness(owner, this.execute);
  }
  get base() {
    return `k3d-${this.owner.cluster}`;
  }
  server() {
    return {
      Id: "server-id",
      Name: `/${this.base}-server-0`,
      Config: {
        Labels: {
          app: "k3d",
          "k3d.role": "server",
          "k3d.cluster": this.owner.cluster,
          [ownerLabel]: encodeOwner(this.owner.root),
          "k3d.cluster.network": this.base,
          "k3d.cluster.network.id": "network-id",
          "k3d.cluster.network.external": "false",
          "k3d.cluster.imageVolume": `${this.base}-images`,
        } as Record<string, string>,
      },
      State: { Running: true },
      NetworkSettings: { Networks: { [this.base]: { NetworkID: "network-id" } } },
      Mounts: [{ Type: "volume", Name: `${this.base}-images`, Destination: "/k3d/images" }],
    };
  }
  owned(running = true) {
    this.nodes = [this.server()];
    this.nodes[0]!.State.Running = running;
    this.networks = [this.base];
    this.volumes = [`${this.base}-images`];
    this.listed = true;
    return this;
  }
  tools() {
    const node = this.server();
    node.Id = "tools-id";
    node.Name = `/${this.base}-tools`;
    node.Config.Labels = { app: "k3d", "k3d.role": "noRole", "k3d.cluster": this.owner.cluster };
    this.nodes.push(node);
    return node;
  }
  execute: Run = (command, args, input, env) => {
    this.calls.push([command, args, input, env]);
    const invocation = `${command} ${args.join(" ")}`;
    if (this.queryFailure && invocation.includes(this.queryFailure))
      throw new Error("injected CLI query failure");
    if (command === "docker") {
      if (args[1] === "ls") {
        if (args[0] === "container") {
          const filter = args[args.length - 1]!;
          const selected = this.nodes.filter((node) => {
            if (filter.startsWith("name=")) return new RegExp(filter.slice(5)).test(node.Name);
            if (filter.startsWith("label=k3d.cluster="))
              return (
                node.Config.Labels["k3d.cluster"] === filter.slice("label=k3d.cluster=".length)
              );
            if (filter.startsWith("volume="))
              return node.Mounts.some((mount) => mount.Name === filter.slice(7));
            throw new Error(`Unexpected container filter: ${filter}`);
          });
          return selected.map((node) => node.Id).join("\n");
        }
        if (args[0] === "network") return this.networks.join("\n");
        if (args[0] === "volume") return this.volumes.join("\n");
      }
      if (args[1] === "inspect") {
        if (args[0] === "container")
          return JSON.stringify(this.nodes.filter((node) => args.slice(2).includes(node.Id)));
        if (args[0] === "network")
          return JSON.stringify([
            {
              Name: this.base,
              Id: "network-id",
              Labels: {},
              Containers: Object.fromEntries(
                this.nodes
                  .filter((node) => node.NetworkSettings.Networks[this.base])
                  .map((node) => [node.Id, {}]),
              ),
            },
          ]);
        if (args[0] === "volume")
          return JSON.stringify([
            { Name: `${this.base}-images`, Labels: { "k3d.cluster": this.owner.cluster } },
          ]);
      }
    }
    if (command === "k3d") {
      if (args[1] === "list")
        return JSON.stringify(
          this.listed
            ? [
                {
                  name: this.owner.cluster,
                  nodes: [{ name: `${this.base}-server-0` }],
                  network: { name: this.base, isExternal: false },
                  imageVolume: `${this.base}-images`,
                },
              ]
            : [],
        );
      if (args[1] === "create") {
        this.owned();
        if (this.createFailure) throw new Error("injected partial create");
        return "";
      }
      if (args[1] === "start") {
        this.nodes[0]!.State.Running = true;
        return "";
      }
      if (args[1] === "delete") {
        this.nodes = this.nodes.filter((node) => node.Config.Labels["k3d.cluster"] !== args[2]);
        this.networks = [];
        this.volumes = [];
        this.listed = false;
        return "";
      }
      if (args[0] === "kubeconfig") return "fresh-private-kubeconfig";
    }
    if (command === "kubectl") return args.includes("current-context") ? this.context : "completed";
    throw new Error(`Unexpected external command: ${invocation}`);
  };
  mutations() {
    return this.calls.filter(
      ([command, args]) =>
        command === "k3d" && ["create", "start", "delete"].includes(args[1] ?? ""),
    );
  }
}

const treeboot = (cwd: string, ...args: string[]) =>
  execFileSync("treeboot", args, { cwd, encoding: "utf8", stdio: "pipe" });

describe("private test identity and environment", () => {
  test("resolves canonical actual Git root and calls Treeboot once with explicit path", () => {
    const root = join(directory(), " root with trailing space ");
    mkdirSync(root);
    mkdirSync(join(root, "nested"));
    const calls: string[][] = [];
    const result = resolveIdentity(join(root, "nested"), (command, args) => {
      calls.push([command, ...args]);
      return command === "git" ? `${root}\n` : "0123456789ab\n";
    });
    expect(result.cluster).toBe("hukube-e2e-0123456789ab");
    expect(calls).toEqual([
      ["git", "rev-parse", "--show-toplevel"],
      ["treeboot", "worktree", "id", root],
    ]);
  });
  test("real Treeboot ignores ambient lifecycle overrides and canonicalizes explicit paths", () => {
    const root = directory();
    writeFileSync(join(root, ".treeboot.toml"), "worktree_id = { length = 12 }\n");
    // Fixture-only Git operations, with no delivery checkout or shared hooks involved.
    execFileSync(
      "git",
      ["-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "init", root],
      { stdio: "ignore" },
    );
    const env = {
      ...process.env,
      TREEBOOT_ROOT_PATH: "/foreign",
      TREEBOOT_WORKTREE_PATH: "/foreign",
      TREEBOOT_WORKTREE_ID: "foreign",
    };
    const first = execFileSync("treeboot", ["worktree", "id", root], {
      encoding: "utf8",
      env,
    }).trim();
    const second = execFileSync("treeboot", ["worktree", "id", `${root}/./`], {
      encoding: "utf8",
      env,
    }).trim();
    expect(first).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
    expect(first).toBe(second);
  });
  test("root bootstrap is a no-op, root teardown is rejected, and linked bootstrap repeats setup", () => {
    const root = directory();
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Harness",
          "-c",
          "user.email=harness@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: root, stdio: "pipe" },
      );
    git("init");
    git("commit", "--allow-empty", "-m", "Fixture");
    const config =
      'worktree_id = { length = 12 }\ncommands = ["echo setup >> setup-record"]\nteardown_commands = ["echo teardown >> teardown-record"]\n';
    writeFileSync(join(root, ".treeboot.toml"), config);
    treeboot(root, "run");
    expect(existsSync(join(root, "setup-record"))).toBe(false);
    const rootTeardown = spawnSync("treeboot", ["teardown", "--yes"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(rootTeardown.status).toBe(1);
    expect(rootTeardown.stderr).toContain("teardown is only valid for a linked worktree");
    const linked = join(root, "linked");
    git("worktree", "add", "-b", "fixture-linked", linked);
    writeFileSync(join(linked, ".treeboot.toml"), config);
    treeboot(linked, "run");
    treeboot(linked, "run");
    expect(readFileSync(join(linked, "setup-record"), "utf8")).toBe("setup\nsetup\n");
    expect(treeboot(root, "worktree", "id", root).trim()).not.toBe(
      treeboot(linked, "worktree", "id", linked).trim(),
    );
    treeboot(linked, "teardown", "--yes");
    expect(readFileSync(join(linked, "teardown-record"), "utf8")).toBe("teardown\n");
  });
  test.each(["", "abc", "0123456789ai", "0123456789AB", "../foreign12"])(
    "rejects invalid ID %j",
    (id) => {
      expect(() => identity(directory(), id)).toThrow("Invalid Treeboot ID");
    },
  );
  test("full owner labels round-trip punctuation, spaces and Unicode without k3d separators", () => {
    const root = fixtureOwner().root;
    const label = encodeOwner(root);
    expect(Buffer.from(label, "base64url").toString("utf8")).toBe(root);
    expect(label).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  test("missing or arbitrary inherited identity fails before any kubectl call", () => {
    const runtime = new Runtime(fixtureOwner());
    for (const env of [
      {},
      { E2E_CLUSTER: "hukube-e2e", E2E_KUBECONFIG: "/user/config" },
      { ...childEnvironment(runtime.owner), HUKUBE_TEST_ID: "invalid" },
      { ...childEnvironment(runtime.owner), E2E_CLUSTER: "foreign" },
      { ...childEnvironment(runtime.owner), E2E_KUBECONFIG: "/user/config" },
      { ...childEnvironment(runtime.owner), HUKUBE_TEST_DATA: "/tmp/foreign" },
    ]) {
      expect(() =>
        new Harness(readEnvironment(env, runtime.owner.root), runtime.execute).kubectl([
          "get",
          "pods",
        ]),
      ).toThrow(/identity|environment|Invalid Treeboot ID/);
    }
    expect(runtime.calls).toEqual([]);
  });
  test("rejects path traversal and symlink escapes before writing or invoking kubectl", () => {
    const testOwner = fixtureOwner();
    const foreign = directory();
    symlinkSync(foreign, join(testOwner.root, ".data"));
    expect(() => withLock(testOwner, () => {})).toThrow("symlink");
    expect(() => readEnvironment(childEnvironment(testOwner), testOwner.root)).toThrow("symlink");
    expect(() => safePath(testOwner, join(testOwner.root, "../foreign"))).toThrow("Unsafe");
    expect(existsSync(join(foreign, "e2e"))).toBe(false);
  });
});

describe("owned Cluster lifecycle", () => {
  test("creates privately, disables rollback/default config, and repeats without a second create", () => {
    const runtime = new Runtime(fixtureOwner());
    withLock(runtime.owner, () => runtime.harness.ensure());
    withLock(runtime.owner, () => runtime.harness.ensure());
    expect(runtime.mutations()).toHaveLength(1);
    expect(runtime.mutations()[0]![1]).toEqual(
      expect.arrayContaining([
        runtime.owner.cluster,
        "--no-rollback",
        "--api-port",
        "127.0.0.1:0",
        "--kubeconfig-update-default=false",
        "--kubeconfig-switch-context=false",
        `${ownerLabel}=${encodeOwner(runtime.owner.root)}@server:0`,
      ]),
    );
    expect(readFileSync(runtime.owner.kubeconfig, "utf8")).toBe("fresh-private-kubeconfig");
    expect(existsSync(join(runtime.owner.data, "lifecycle.lock"))).toBe(false);
  });
  test("accepts precisely the named unlabelled noRole tools node beside a verified server", () => {
    const runtime = new Runtime(fixtureOwner()).owned();
    runtime.tools();
    runtime.harness.ensure();
    runtime.harness.delete();
    expect(runtime.mutations().map(([, args]) => args)).toEqual([
      ["cluster", "delete", runtime.owner.cluster],
    ]);
  });
  test.each([
    "foreign owner",
    "missing owner",
    "malformed owner",
    "tools owner",
    "tools cleanup metadata",
    "tools name",
    "agent",
    "extra server",
    "load balancer",
    "foreign network",
    "foreign image volume",
    "external network",
  ])("refuses %s without creating, starting or deleting", (scenario) => {
    const runtime = new Runtime(fixtureOwner()).owned();
    const node = runtime.nodes[0]!;
    if (scenario === "foreign owner") node.Config.Labels[ownerLabel] = encodeOwner(directory());
    if (scenario === "missing owner") delete node.Config.Labels[ownerLabel];
    if (scenario === "malformed owner") node.Config.Labels[ownerLabel] = "broken/owner@label";
    if (scenario === "tools owner")
      runtime.tools().Config.Labels[ownerLabel] = encodeOwner(directory());
    if (scenario === "tools cleanup metadata")
      runtime.tools().Config.Labels["k3d.cluster.network"] = "foreign-network";
    if (scenario === "tools name") runtime.tools().Name += "-foreign";
    if (["agent", "extra server", "load balancer"].includes(scenario)) {
      const extra = runtime.tools();
      extra.Config.Labels["k3d.role"] =
        scenario === "agent" ? "agent" : scenario === "extra server" ? "server" : "loadbalancer";
    }
    if (scenario === "foreign network")
      node.NetworkSettings.Networks["foreign"] = { NetworkID: "foreign" };
    if (scenario === "foreign image volume")
      node.Config.Labels["k3d.cluster.imageVolume"] = "foreign-images";
    if (scenario === "external network")
      node.Config.Labels["k3d.cluster.network.external"] = "true";
    expect(() => runtime.harness.ensure()).toThrow("Refusing Cluster");
    expect(() => runtime.harness.seed()).toThrow("Refusing Cluster");
    expect(() => runtime.harness.delete()).toThrow("Refusing Cluster");
    expect(runtime.mutations()).toEqual([]);
    expect(runtime.calls.filter(([command]) => command === "kubectl")).toEqual([]);
  });
  test("a compact-ID collision cannot delete the other canonical owner", () => {
    const first = fixtureOwner();
    const second = identity(directory(), first.id);
    const runtime = new Runtime(second).owned();
    const collision = new Harness(first, runtime.execute);
    expect(() => collision.delete()).toThrow("server owner label does not match");
    expect(runtime.mutations()).toEqual([]);
    expect(runtime.nodes).toHaveLength(1);
  });
  test("starts a verified stopped Cluster and waits before refreshing its kubeconfig", () => {
    const runtime = new Runtime(fixtureOwner()).owned(false);
    runtime.harness.ensure();
    expect(runtime.mutations().map(([, args]) => args)).toEqual([
      ["cluster", "start", runtime.owner.cluster, "--wait", "--timeout", "180s"],
    ]);
    expect(
      runtime.calls.some(
        ([command, args]) => command === "kubectl" && args.includes("--for=condition=Ready"),
      ),
    ).toBe(true);
  });
  test("retains a partially created owned Cluster and reuses it on retry", () => {
    const runtime = new Runtime(fixtureOwner());
    runtime.createFailure = true;
    expect(() => withLock(runtime.owner, () => runtime.harness.ensure())).toThrow(
      "injected partial create",
    );
    expect(runtime.mutations().map(([, args]) => args[1])).toEqual(["create"]);
    runtime.createFailure = false;
    withLock(runtime.owner, () => runtime.harness.ensure());
    expect(runtime.mutations().map(([, args]) => args[1])).toEqual(["create"]);
  });
  test("refuses unprovable partial auxiliary resources and tools-only leftovers", () => {
    const runtime = new Runtime(fixtureOwner());
    runtime.networks = [runtime.base];
    runtime.volumes = [`${runtime.base}-images`];
    expect(() => runtime.harness.ensure()).toThrow(
      "partial resources have no provable server owner",
    );
    expect(() => runtime.harness.delete()).toThrow(runtime.base);
    runtime.tools();
    expect(() => runtime.harness.delete()).toThrow("expected precisely one named server");
    expect(runtime.mutations()).toEqual([]);
  });
  test.each([
    "docker container ls",
    "docker network ls",
    "docker volume ls",
    "docker container inspect",
    "k3d cluster list",
  ])("query failure in %s is fatal, never absence", (query) => {
    const runtime = new Runtime(fixtureOwner()).owned();
    runtime.queryFailure = query;
    expect(() => runtime.harness.ensure()).toThrow(/query failure|Cannot query/);
    expect(() => runtime.harness.delete()).toThrow(/query failure|Cannot query/);
    expect(runtime.mutations()).toEqual([]);
  });
  test("atomically replaces a stale local kubeconfig only after validating fresh context", () => {
    const runtime = new Runtime(fixtureOwner()).owned();
    mkdirSync(runtime.owner.data, { recursive: true });
    writeFileSync(runtime.owner.kubeconfig, "old-config");
    runtime.context = "foreign";
    expect(() => runtime.harness.refreshKubeconfig()).toThrow("Refusing stale kubeconfig");
    expect(readFileSync(runtime.owner.kubeconfig, "utf8")).toBe("old-config");
    expect(() => runtime.harness.kubectl(["delete", "pods", "--all"])).toThrow(
      "Refusing stale kubeconfig",
    );
    expect(
      runtime.calls.filter(([command, args]) => command === "kubectl" && args.includes("delete")),
    ).toEqual([]);
    runtime.context = `k3d-${runtime.owner.cluster}`;
    runtime.harness.refreshKubeconfig();
    expect(readFileSync(runtime.owner.kubeconfig, "utf8")).toBe("fresh-private-kubeconfig");
  });
  test("unrelated sibling containers are excluded from ownership checks and deletion", () => {
    const runtime = new Runtime(fixtureOwner()).owned();
    const sibling = runtime.server();
    sibling.Id = "sibling-server";
    sibling.Name = "/k3d-hukube-e2e-cdefghjkmnpq-server-0";
    sibling.Config.Labels["k3d.cluster"] = "hukube-e2e-cdefghjkmnpq";
    sibling.Config.Labels[ownerLabel] = encodeOwner(directory());
    sibling.NetworkSettings.Networks = { sibling: { NetworkID: "sibling-network" } };
    sibling.Mounts[0]!.Name = "sibling-images";
    runtime.nodes.push(sibling);
    runtime.harness.delete();
    expect(runtime.mutations().map(([, args]) => args)).toEqual([
      ["cluster", "delete", runtime.owner.cluster],
    ]);
    expect(
      runtime.calls
        .filter(([, args]) => args[0] === "container" && args[1] === "inspect")
        .flatMap(([, args]) => args),
    ).not.toContain("sibling-server");
    expect(runtime.nodes.map((node) => node.Id)).toEqual(["sibling-server"]);
  });
  test("k3d cleanup receives only local default and standalone kubeconfig paths", () => {
    const runtime = new Runtime(fixtureOwner()).owned();
    const env = k3dEnvironment(runtime.owner, {
      KUBECONFIG: "/user/live",
      XDG_CONFIG_HOME: "/user/config",
      K3D_CONFIG: "/foreign/config",
      K3D_RUNTIME: "podman",
    });
    expect(env).toEqual({
      KUBECONFIG: runtime.owner.kubeconfig,
      XDG_CONFIG_HOME: join(runtime.owner.data, "k3d"),
    });
    runtime.harness.delete();
    const deletion = runtime.calls.find(
      ([command, args]) => command === "k3d" && args[1] === "delete",
    );
    expect(deletion?.[3]?.["KUBECONFIG"]).toBe(runtime.owner.kubeconfig);
    expect(deletion?.[3]?.["XDG_CONFIG_HOME"]).toBe(join(runtime.owner.data, "k3d"));
  });
  test("owned deletion targets only the exact private Cluster", () => {
    const runtime = new Runtime(fixtureOwner()).owned();
    runtime.harness.delete();
    expect(runtime.mutations().map(([, args]) => args)).toEqual([
      ["cluster", "delete", runtime.owner.cluster],
    ]);
    expect(runtime.calls.flatMap(([, args]) => args)).not.toContain("hukube-e2e");
  });
});

describe("exclusive lifecycle lock", () => {
  test("refuses a live lock and releases only its own acquired token", () => {
    const testOwner = fixtureOwner();
    const lock = join(testOwner.data, "lifecycle.lock");
    withLock(testOwner, () => {
      const record = readFileSync(lock, "utf8");
      expect(() => withLock(testOwner, () => {})).toThrow(`live PID ${process.pid}`);
      expect(readFileSync(lock, "utf8")).toBe(record);
    });
    expect(existsSync(lock)).toBe(false);
    expect(() =>
      withLock(testOwner, () => {
        writeFileSync(lock, JSON.stringify({ token: "replacement" }));
      }),
    ).toThrow("token changed");
    expect(readFileSync(lock, "utf8")).toContain("replacement");
  });
  test.each([
    JSON.stringify({ pid: process.pid, start: "earlier process", token: "old" }),
    JSON.stringify({ pid: 999999, start: "gone process", token: "old" }),
    "malformed",
  ])("stale or unverifiable lock remains for deliberate recovery: %s", (record) => {
    const testOwner = fixtureOwner();
    mkdirSync(testOwner.data, { recursive: true });
    const lock = join(testOwner.data, "lifecycle.lock");
    writeFileSync(lock, record);
    expect(() => withLock(testOwner, () => {})).toThrow(`Test lifecycle lock ${lock}`);
    expect(() => withLock(testOwner, () => {})).toThrow(
      "after confirming no lifecycle command is running",
    );
    expect(readFileSync(lock, "utf8")).toBe(record);
  });
});

describe("spawned Engine URL", () => {
  test.each([
    undefined,
    "http://localhost:7555",
    "http://evil.test:7555",
    "https://127.0.0.1:7555",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:7555/path",
  ])("rejects absent or invalid capture %s", (url) => {
    expect(() => capturedURL({ [captureVariable]: url })).toThrow(/capture|URL|port/);
  });
  test("clears stale inherited capture only in the launcher; workers preserve it", () => {
    const testOwner = fixtureOwner();
    const env = childEnvironment(testOwner, { [captureVariable]: "http://127.0.0.1:7555" });
    expect(launchEnvironment(testOwner, env)[captureVariable]).toBeUndefined();
    readEnvironment(env, testOwner.root);
    expect(capturedURL(env)).toBe("http://127.0.0.1:7555");
  });
  test("health probe rejects an unhealthy spawned endpoint", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const addr = server.address() as { port: number };
      await expect(
        healthyURL({ [captureVariable]: `http://127.0.0.1:${addr.port}` }),
      ).rejects.toThrow("503");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
  test("two Playwright subprocesses capture their own port-zero ready records and clean up", async () => {
    const testOwner = fixtureOwner();
    const dir = directory();
    const stale = createServer((_request, response) => response.end("foreign"));
    stale.listen(0, "127.0.0.1");
    await once(stale, "listening");
    const stalePort = (stale.address() as { port: number }).port;
    const require = createRequire(import.meta.url);
    const cli = require.resolve("@playwright/test/cli");
    const fixtures = join(import.meta.dirname, "fixtures.ts");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const serverCode = `const http = require('node:http'); const server = http.createServer((req,res) => res.end('healthy')); server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ event: 'ready', url: 'http://127.0.0.1:' + server.address().port })));`;
    writeFileSync(join(dir, "engine.cjs"), serverCode);
    writeFileSync(
      join(dir, "probe.spec.ts"),
      `import { test, expect } from ${JSON.stringify(fixtures)}; import { writeFileSync } from 'node:fs'; test('uses spawned process capture', async ({baseURL}) => { expect(baseURL).not.toBe('http://127.0.0.1:${stalePort}'); writeFileSync(process.env.RESULT, baseURL); });`,
    );
    writeFileSync(
      join(dir, "playwright.config.ts"),
      `export default { testDir: '.', testMatch: 'probe.spec.ts', reporter: 'line', webServer: { command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "engine.cjs"))}`)}, wait: { stdout: ${readyPattern.toString()} }, reuseExistingServer: false } };`,
    );
    try {
      const launch = async (name: string) => {
        const output = join(dir, name);
        const child = spawn(
          process.execPath,
          [
            cli,
            "test",
            "--config",
            join(dir, "playwright.config.ts"),
            "--output",
            join(dir, `${name}-results`),
          ],
          {
            env: {
              ...launchEnvironment(testOwner, {
                ...process.env,
                [captureVariable]: `http://127.0.0.1:${stalePort}`,
              }),
              RESULT: output,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let logs = "";
        child.stdout.on("data", (data) => {
          logs += String(data);
        });
        child.stderr.on("data", (data) => {
          logs += String(data);
        });
        const [code] = await once(child, "exit");
        expect({ code, failure: code === 0 ? "" : logs }).toEqual({ code: 0, failure: "" });
        expect(logs).toContain("1 passed");
        return readFileSync(output, "utf8");
      };
      const urls = await Promise.all([launch("first"), launch("second")]);
      expect(urls[0]).not.toBe(urls[1]);
      for (const url of urls) await expect(fetch(url)).rejects.toThrow("fetch failed");
      expect(await (await fetch(`http://127.0.0.1:${stalePort}`)).text()).toBe("foreign");
    } finally {
      stale.close();
      await once(stale, "close");
    }
  }, 30_000);
  test("verification cleanup terminates only its recorded subprocess and removes its record", async () => {
    const testOwner = fixtureOwner();
    const dir = join(testOwner.root, ".data/verify");
    mkdirSync(dir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const completion = once(child, "exit");
    try {
      await once(child.stdout, "data");
      const record = execFileSync(
        "ps",
        ["-ww", "-p", String(child.pid), "-o", "lstart=", "-o", "command="],
        { encoding: "utf8" },
      ).trim();
      writeFileSync(join(dir, "engine.pid"), `${child.pid}\n${record}\n`);
      writeFileSync(join(dir, "url"), "http://127.0.0.1:12345");
      await stopVerify(testOwner);
      await completion;
      expect(child.signalCode).toBe("SIGTERM");
      expect(existsSync(join(dir, "engine.pid"))).toBe(false);
      expect(existsSync(join(dir, "url"))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await completion;
      }
    }
  });
  test("verification cleanup refuses a changed exact PID/start-time/command record", async () => {
    const testOwner = fixtureOwner();
    const dir = join(testOwner.root, ".data/verify");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "engine.pid"), `${process.pid}\nforeign identity\n`);
    await expect(stopVerify(testOwner)).rejects.toThrow("leaving PID");
    expect(existsSync(join(dir, "engine.pid"))).toBe(true);
  });
});
