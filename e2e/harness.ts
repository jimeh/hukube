import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type Run = (
  command: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
) => string;
export const run: Run = (command, args, input, env) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input,
    env: env ?? (command === "git" ? gitEnvironment() : process.env),
  });

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

export const ownerLabel = "dev.hukube.test-owner";
export const captureVariable = "HUKUBE_TEST_ENGINE_URL";
export const readyPattern =
  /\{"event":"ready","url":"(?<hukube_test_engine_url>http:\/\/127\.0\.0\.1:[1-9][0-9]*)"\}/;
const idPattern = /^[0-9abcdefghjkmnpqrstvwxyz]{12}$/;
export interface Identity {
  root: string;
  id: string;
  cluster: string;
  data: string;
  kubeconfig: string;
}

export function identity(root: string, id: string): Identity {
  if (!idPattern.test(id))
    throw new Error(
      `Invalid Treeboot ID ${JSON.stringify(id)}; expected 12 lowercase Crockford characters.`,
    );
  if (realpathSync(root) !== root) throw new Error(`Noncanonical test owner: ${root}`);
  const cluster = `hukube-e2e-${id}`;
  if (cluster.length > 32) throw new Error(`Invalid private Cluster name: ${cluster}`);
  return {
    root,
    id,
    cluster,
    data: join(root, ".data/e2e"),
    kubeconfig: join(root, ".data/e2e/kubeconfig"),
  };
}

/** Resolve the actual Git top level, then ask the public CLI exactly once. */
export function resolveIdentity(cwd = process.cwd(), execute: Run = run): Identity {
  const root = realpathSync(execute("git", ["rev-parse", "--show-toplevel"]).replace(/\r?\n$/, ""));
  if (realpathSync(cwd) !== root && !realpathSync(cwd).startsWith(`${root}/`))
    throw new Error(`Git top level ${root} does not contain ${cwd}`);
  return identity(root, execute("treeboot", ["worktree", "id", root]).trim());
}

export function childEnvironment(
  owner: Identity,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    HUKUBE_TEST_ROOT: owner.root,
    HUKUBE_TEST_ID: owner.id,
    E2E_CLUSTER: owner.cluster,
    E2E_KUBECONFIG: owner.kubeconfig,
    HUKUBE_TEST_DATA: owner.data,
  };
}

/** Workers consume the wrapper's identity; ambient names and paths are never defaults. */
export function readEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  root = realpathSync(join(import.meta.dirname, "..")),
): Identity {
  if (env["HUKUBE_TEST_ROOT"] !== root || !env["HUKUBE_TEST_ID"])
    throw new Error(
      "Missing private test identity. Run `mise run e2e` (or `mise run dev:verify`).",
    );
  const owner = identity(root, env["HUKUBE_TEST_ID"]);
  if (
    env["E2E_CLUSTER"] !== owner.cluster ||
    env["E2E_KUBECONFIG"] !== owner.kubeconfig ||
    env["HUKUBE_TEST_DATA"] !== owner.data
  )
    throw new Error(
      "Invalid private test environment; refusing inherited Cluster or path overrides.",
    );
  safePath(owner, owner.kubeconfig);
  return owner;
}

/** Reject even in-tree symlinks: no writes, removals or credentials may escape the owned path. */
export function safePath(owner: Identity, target: string): void {
  if (target !== resolve(target) || !target.startsWith(`${owner.root}/.data/`))
    throw new Error(`Unsafe test path: ${target}`);
  let cursor = owner.root;
  for (const part of target.slice(owner.root.length + 1).split("/")) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error(`Refusing symlink in test path: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function prepareDirectory(owner: Identity, target: string): void {
  safePath(owner, target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  safePath(owner, target);
}

export function encodeOwner(root: string): string {
  return Buffer.from(root, "utf8").toString("base64url");
}

/** k3d delete also edits default/standalone kubeconfigs, despite create's opt-outs. */
export function k3dEnvironment(
  owner: Identity,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (key.startsWith("K3D_")) delete env[key];
  const configDir = join(owner.data, "k3d");
  safePath(owner, owner.kubeconfig);
  safePath(owner, join(configDir, `kubeconfig-${owner.cluster}.yaml`));
  return { ...env, KUBECONFIG: owner.kubeconfig, XDG_CONFIG_HOME: configDir };
}

function processStart(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

export function withLock<T>(owner: Identity, action: () => T): T {
  prepareDirectory(owner, owner.data);
  const lock = join(owner.data, "lifecycle.lock");
  safePath(owner, lock);
  const token = randomUUID();
  const start = processStart(process.pid);
  if (!start)
    throw new Error(
      "Cannot verify this process's start time; refusing to acquire test lifecycle lock.",
    );
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let state = "unverifiable record";
    try {
      const record = JSON.parse(readFileSync(lock, "utf8")) as {
        pid: number;
        start: string;
        token: string;
      };
      if (Number.isSafeInteger(record.pid) && record.pid > 0 && record.start && record.token) {
        const current = processStart(record.pid);
        state =
          current === record.start
            ? `live PID ${record.pid}, start ${current}`
            : `stale or unverifiable PID ${record.pid}, recorded start ${record.start}, observed ${current || "absent"}`;
      }
    } catch {
      /* Preserve malformed records for deliberate recovery. */
    }
    throw new Error(
      `Test lifecycle lock ${lock}: ${state}. No lock was removed. Inspect its record and process; after confirming no lifecycle command is running, remove exactly ${JSON.stringify(lock)} and retry.`,
      { cause: error },
    );
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, start, token }));
    closeSync(fd);
    return action();
  } finally {
    releaseLock(owner, lock, token);
  }
}

function releaseLock(owner: Identity, lock: string, token: string): void {
  safePath(owner, lock);
  const record = JSON.parse(readFileSync(lock, "utf8")) as { token: string };
  if (record.token !== token) throw new Error(`Lifecycle lock token changed; retaining ${lock}.`);
  unlinkSync(lock);
}

interface Container {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean };
  NetworkSettings: { Networks: Record<string, { NetworkID: string }> };
  Mounts: { Type: string; Name?: string; Destination: string }[];
}
interface Network {
  Name: string;
  Id: string;
  Containers: Record<string, unknown> | null;
}
interface Volume {
  Name: string;
  Labels: Record<string, string>;
}
interface Cluster {
  name: string;
  nodes: { name: string }[];
  network: { name: string; isExternal?: boolean };
  imageVolume: string;
}

export class Harness {
  readonly execute: Run;
  constructor(
    readonly owner: Identity,
    execute: Run = run,
  ) {
    this.execute = (command, args, input) =>
      execute(command, args, input, command === "k3d" ? k3dEnvironment(owner) : undefined);
  }

  private query(command: string, args: string[]): unknown {
    try {
      return JSON.parse(this.execute(command, args)) as unknown;
    } catch (error) {
      throw new Error(
        `Cannot query test ownership with ${command} ${args.join(" ")}; refusing lifecycle action. ${String(error)}`,
        { cause: error },
      );
    }
  }

  private resources(kind: "container" | "network" | "volume", name: string): string[] {
    const args =
      kind === "container"
        ? [kind, "ls", "--all", "--quiet"]
        : [kind, "ls", "--format", "{{.Name}}"];
    const ids = [
      ...this.execute("docker", [...args, "--filter", `label=k3d.cluster=${this.owner.cluster}`])
        .trim()
        .split(/\s+/),
      ...this.execute("docker", [...args, "--filter", `name=${name}`])
        .trim()
        .split(/\s+/),
    ].filter(Boolean);
    return [...new Set(ids)];
  }

  /** Inspect only the exact private namespace, including partial and unlabelled collisions. */
  inspect(): { running: boolean } | undefined {
    const { cluster, root } = this.owner;
    const base = `k3d-${cluster}`;
    const containers = this.resources("container", `^/${base}(-|$)`);
    const networks = this.resources("network", `^${base}$`);
    const volumes = this.resources("volume", `^${base}-images$`);
    const listed = (this.query("k3d", ["cluster", "list", "--output", "json"]) as Cluster[]).filter(
      (entry) => entry.name === cluster,
    );
    if (!containers.length && !networks.length && !volumes.length && !listed.length)
      return undefined;
    const refuse = (detail: string): never => {
      throw new Error(
        `Refusing Cluster ${cluster} for owner ${root}: ${detail}. Retained resources: containers [${containers.join(", ")}], networks [${networks.join(", ")}], volumes [${volumes.join(", ")}]. Inspect these exact resources and their ${ownerLabel} labels; no automatic adoption or deletion.`,
      );
    };
    if (!containers.length) refuse("partial resources have no provable server owner");
    const nodes = this.query("docker", ["container", "inspect", ...containers]) as Container[];
    if (
      !Array.isArray(nodes) ||
      nodes.some(
        (node) =>
          !node ||
          typeof node.Id !== "string" ||
          !node.Id ||
          typeof node.Name !== "string" ||
          !node.Config?.Labels ||
          typeof node.State?.Running !== "boolean" ||
          !node.NetworkSettings?.Networks ||
          !Array.isArray(node.Mounts),
      )
    )
      refuse("malformed container inspection");
    const servers = nodes.filter(
      (node) => node.Name === `/${base}-server-0` && node.Config.Labels["k3d.role"] === "server",
    );
    if (servers.length !== 1) refuse("expected precisely one named server");
    const server = servers[0]!;
    if (server.Config.Labels[ownerLabel] !== encodeOwner(root))
      refuse("server owner label does not match the full canonical path");
    for (const node of nodes) {
      const labels = node.Config.Labels;
      const tools =
        node.Name === `/${base}-tools` &&
        labels["k3d.role"] === "noRole" &&
        labels[ownerLabel] === undefined;
      if (node !== server && !tools) refuse(`unexpected node ${node.Name}`);
      // ClusterGet derives cleanup targets from node labels in runtime order.
      // The tools node normally has none of these labels and must never redirect them.
      if (
        tools &&
        Object.keys(labels).some((key) => key.startsWith("k3d.cluster.") && key !== "k3d.cluster")
      )
        refuse(`unexpected Cluster metadata on tools node ${node.Name}`);
      if (labels["app"] !== "k3d" || labels["k3d.cluster"] !== cluster)
        refuse(`invalid k3d labels on ${node.Name}`);
      const nets = Object.entries(node.NetworkSettings.Networks);
      if (nets.length !== 1 || nets[0]![0] !== base)
        refuse(`unexpected network association on ${node.Name}`);
      const mounts = node.Mounts.filter(
        (mount) => mount.Type === "volume" && mount.Destination === "/k3d/images",
      );
      if (mounts.length !== 1 || mounts[0]!.Name !== `${base}-images`)
        refuse(`unexpected image volume on ${node.Name}`);
    }
    const labels = server.Config.Labels;
    if (
      labels["k3d.cluster.network"] !== base ||
      labels["k3d.cluster.network.external"] !== "false" ||
      labels["k3d.cluster.imageVolume"] !== `${base}-images`
    )
      refuse("unexpected managed network/volume labels");
    if (
      networks.length !== 1 ||
      networks[0] !== base ||
      volumes.length !== 1 ||
      volumes[0] !== `${base}-images`
    )
      refuse("unexpected or missing managed network/volume");
    const net = this.query("docker", ["network", "inspect", base]) as Network[];
    if (
      net.length !== 1 ||
      typeof net[0]!.Id !== "string" ||
      !net[0]!.Id ||
      net[0]!.Name !== base ||
      labels["k3d.cluster.network.id"] !== net[0]!.Id ||
      nodes.some((node) => node.NetworkSettings.Networks[base]?.NetworkID !== net[0]!.Id)
    )
      refuse("managed network ID mismatch");
    const allowed = new Set(nodes.map((node) => node.Id));
    if (Object.keys(net[0]!.Containers ?? {}).some((id) => !allowed.has(id)))
      refuse("foreign container attached to managed network");
    const volume = this.query("docker", ["volume", "inspect", `${base}-images`]) as Volume[];
    if (
      volume.length !== 1 ||
      volume[0]!.Name !== `${base}-images` ||
      volume[0]!.Labels?.["k3d.cluster"] !== cluster
    )
      refuse("invalid image volume labels");
    const volumeUsers = this.execute("docker", [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--quiet",
      "--filter",
      `volume=${base}-images`,
    ])
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (volumeUsers.some((id) => !allowed.has(id)))
      refuse("foreign container uses managed image volume");
    // k3d excludes its noRole tools node from ClusterList.
    if (
      listed.length !== 1 ||
      listed[0]!.nodes.length !== 1 ||
      listed[0]!.nodes[0]!.name !== `${base}-server-0` ||
      listed[0]!.network.name !== base ||
      listed[0]!.network.isExternal ||
      listed[0]!.imageVolume !== `${base}-images`
    )
      refuse("k3d listing disagrees with verified runtime resources");
    return { running: server.State.Running };
  }

  ensure(): void {
    const { cluster, root } = this.owner;
    const existing = this.inspect();
    if (!existing) {
      this.execute("k3d", [
        "cluster",
        "create",
        cluster,
        "--no-lb",
        "--no-rollback",
        "--api-port",
        // k3d records literal port 0 in kubeconfig; its allocator requires "random".
        "127.0.0.1:random",
        "--wait",
        "--timeout",
        "180s",
        "--kubeconfig-update-default=false",
        "--kubeconfig-switch-context=false",
        "--runtime-label",
        `${ownerLabel}=${encodeOwner(root)}@server:0`,
        "--k3s-arg",
        "--disable=traefik,metrics-server@server:0",
      ]);
    } else if (!existing.running) {
      this.execute("k3d", ["cluster", "start", cluster, "--wait", "--timeout", "180s"]);
    }
    if (!this.inspect()?.running)
      throw new Error(
        `Private Cluster ${cluster} is not running after create/start; retained for inspection.`,
      );
    this.refreshKubeconfig();
    this.kubectl(["wait", "--for=condition=Ready", "node", "--all", "--timeout=180s"]);
  }

  refreshKubeconfig(): void {
    if (!this.inspect())
      throw new Error(`No verified Cluster ${this.owner.cluster}. Run mise run e2e:cluster.`);
    const config = this.execute("k3d", ["kubeconfig", "get", this.owner.cluster]);
    prepareDirectory(this.owner, this.owner.data);
    safePath(this.owner, this.owner.kubeconfig);
    const temporary = join(this.owner.data, `kubeconfig.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, config, { flag: "wx", mode: 0o600 });
      this.assertContext(temporary);
      safePath(this.owner, this.owner.kubeconfig);
      renameSync(temporary, this.owner.kubeconfig);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  assertContext(kubeconfig = this.owner.kubeconfig): void {
    safePath(this.owner, kubeconfig);
    const current = this.execute("kubectl", [
      "--kubeconfig",
      kubeconfig,
      "config",
      "current-context",
    ]).trim();
    if (current !== `k3d-${this.owner.cluster}`)
      throw new Error(
        `Refusing stale kubeconfig ${kubeconfig}: current context ${JSON.stringify(current)}, expected k3d-${this.owner.cluster}. Run mise run e2e:cluster.`,
      );
  }

  kubectl(args: string[], input?: string): string {
    this.assertContext();
    return this.execute("kubectl", ["--kubeconfig", this.owner.kubeconfig, ...args], input);
  }

  seed(): void {
    this.ensure();
    if (!this.inspect()) throw new Error("Private Cluster disappeared before seeding.");
    const fixtures = join(this.owner.root, "e2e/fixtures/sample");
    this.kubectl(["apply", "-f", join(fixtures, "crds.yaml")]);
    this.kubectl([
      "wait",
      "--for",
      "condition=established",
      "--timeout",
      "30s",
      "crd/widgets.sample.hukube.dev",
      "crd/gadgets.sample.hukube.dev",
    ]);
    this.kubectl([
      "apply",
      "-f",
      join(fixtures, "resources.yaml"),
      "-f",
      join(fixtures, "edit.yaml"),
    ]);
  }

  delete(): void {
    if (this.inspect()) this.execute("k3d", ["cluster", "delete", this.owner.cluster]);
    safePath(this.owner, this.owner.kubeconfig);
    if (existsSync(this.owner.kubeconfig)) unlinkSync(this.owner.kubeconfig);
  }
}

export function capturedURL(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[captureVariable];
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(value))
    throw new Error("Missing or invalid spawned test Engine URL; run mise run e2e.");
  const url = new URL(value);
  if (!url.port || Number(url.port) > 65535)
    throw new Error(`Invalid spawned Engine port: ${value}`);
  return value;
}

export async function healthyURL(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const url = capturedURL(env);
  const response = await fetch(`${url}/healthz`, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Spawned test Engine health check failed: ${response.status}`);
  return url;
}

export function launchEnvironment(owner: Identity, env: NodeJS.ProcessEnv = process.env) {
  const child = childEnvironment(owner, env);
  delete child[captureVariable];
  return child;
}
