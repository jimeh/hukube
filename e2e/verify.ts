import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { capturedURL, prepareDirectory, safePath, type Identity } from "./harness.ts";

function processIdentity(pid: number): string {
  try {
    return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

export async function stopVerify(owner: Identity): Promise<void> {
  const dir = join(owner.root, ".data/verify");
  const pidFile = join(dir, "engine.pid");
  safePath(owner, pidFile);
  safePath(owner, join(dir, "url"));
  if (!existsSync(pidFile)) return;
  const [pidText, identity] = readFileSync(pidFile, "utf8").trimEnd().split("\n");
  if (!pidText || !/^[1-9][0-9]*$/.test(pidText) || !Number.isSafeInteger(Number(pidText)))
    throw new Error(`Invalid Engine PID record: ${pidFile}`);
  const pid = Number(pidText);
  let current = processIdentity(pid);
  if (current) {
    if (!identity || current !== identity)
      throw new Error(
        `The Engine PID record no longer identifies its process; leaving PID ${pid} running. Inspect ${pidFile}.`,
      );
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while ((current = processIdentity(pid)) === identity && Date.now() < deadline)
      await setTimeout(100);
    if (current === identity)
      throw new Error(`The Engine did not stop; retaining ${pidFile} so cleanup can be retried.`);
  }
  unlinkSync(pidFile);
  if (existsSync(join(dir, "url"))) unlinkSync(join(dir, "url"));
}

export async function startVerify(owner: Identity): Promise<void> {
  await stopVerify(owner);
  const dir = join(owner.root, ".data/verify");
  prepareDirectory(owner, dir);
  safePath(owner, join(dir, "engine"));
  for (const name of ["engine.out", "engine.log", "engine.pid", "url"])
    safePath(owner, join(dir, name));
  const token = randomBytes(16).toString("hex");
  const out = openSync(join(dir, "engine.out"), "w", 0o600);
  const log = openSync(join(dir, "engine.log"), "w", 0o600);
  const engine = spawn(
    join(owner.root, "engine/bin/hukube-engine"),
    [
      "--web",
      "--ui-dir",
      join(owner.root, "apps/app/dist"),
      "--listen",
      "127.0.0.1:0",
      "--kubeconfig",
      owner.kubeconfig,
      "--data-dir",
      join(dir, "engine"),
    ],
    {
      detached: true,
      env: { ...process.env, HUKUBE_TOKEN: token },
      stdio: ["ignore", out, log],
    },
  );
  closeSync(out);
  closeSync(log);
  let failure: Error | undefined;
  engine.on("error", (error) => {
    failure = error;
  });
  try {
    let url: string | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && engine.exitCode === null) {
      if (failure) throw failure;
      const ready = readFileSync(join(dir, "engine.out"), "utf8")
        .split("\n")
        .find((line) => line.includes('"event":"ready"'));
      if (ready) {
        const record = JSON.parse(ready) as { url: string };
        url = capturedURL({ HUKUBE_TEST_ENGINE_URL: record.url });
        break;
      }
      // Poll the ready record, not elapsed time as evidence that startup completed.
      await setTimeout(100);
    }
    if (!url || !engine.pid)
      throw new Error(
        `The Engine did not start; see ${join(dir, "engine.log")}. ${failure?.message ?? ""}`,
      );
    const identity = processIdentity(engine.pid);
    if (!identity) throw new Error("Cannot record Engine process identity.");
    writeFileSync(join(dir, "engine.pid"), `${engine.pid}\n${identity}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "url"), `${url}/#token=${token}\n`, { mode: 0o600 });
    engine.unref();
    console.log(
      `hukube: ${url}/#token=${token}\nEngine log: ${join(dir, "engine.log")}. Stop it with \`mise run dev:verify:stop\`.`,
    );
  } catch (error) {
    if (engine.pid && engine.exitCode === null) engine.kill("SIGTERM");
    throw error;
  }
}
