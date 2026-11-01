import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  Harness,
  childEnvironment,
  launchEnvironment,
  readEnvironment,
  resolveIdentity,
  safePath,
  withLock,
} from "./harness.ts";
import { startVerify, stopVerify } from "./verify.ts";

const command = process.argv[2];
const owner = command === "engine" ? readEnvironment() : resolveIdentity();
const harness = new Harness(owner);
if (command !== "engine")
  console.error(
    `Private test owner: ${owner.root}\nCluster: ${owner.cluster}\nKubeconfig: ${owner.kubeconfig}\nCleanup from this checkout: mise run worktree:teardown`,
  );

function child(executable: string, args: string[], env = childEnvironment(owner)): never {
  const result = spawnSync(executable, args, {
    cwd: join(owner.root, "e2e"),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

switch (command) {
  case "cluster":
    withLock(owner, () => harness.ensure());
    break;
  case "delete":
    withLock(owner, () => harness.delete());
    break;
  case "seed":
    withLock(owner, () => harness.seed());
    break;
  case "verify":
    withLock(owner, () => harness.seed());
    await startVerify(owner);
    break;
  case "verify-stop":
    await stopVerify(owner);
    break;
  case "e2e": {
    withLock(owner, () => harness.ensure());
    const data = join(owner.data, "engine");
    safePath(owner, data);
    rmSync(data, { recursive: true, force: true });
    const args = ["bunx", "playwright", "test", ...process.argv.slice(3)];
    const env = launchEnvironment(owner);
    if (process.platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"])
      child("xvfb-run", ["-a", ...args], env);
    child(args[0]!, args.slice(1), env);
    break;
  }
  case "engine":
    harness.assertContext();
    safePath(owner, join(owner.data, "engine"));
    child(join(owner.root, "engine/bin/hukube-engine"), [
      "--web",
      "--ui-dir",
      join(owner.root, "apps/app/dist"),
      "--listen",
      "127.0.0.1:0",
      "--token=e2e",
      "--kubeconfig",
      owner.kubeconfig,
      "--data-dir",
      join(owner.data, "engine"),
    ]);
    break;
  default:
    throw new Error("Expected cluster, delete, seed, verify, verify-stop, e2e or engine.");
}
