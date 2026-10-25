import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build, Platform, Arch } from "electron-builder";
import { parse } from "yaml";
import { identity, packageVersion } from "../src/release/inventory.ts";

const [mode = "snapshot", architecture = process.arch, versionOverride] = process.argv.slice(2);
if (!["darwin", "linux"].includes(process.platform))
  throw new Error("Only macOS and Linux are supported.");
if (!["snapshot", "release", "test"].includes(mode) || !["arm64", "x64"].includes(architecture))
  throw new Error("Usage: package.ts snapshot|release|test arm64|x64 [test-version]");
const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "../..");
const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
const version = packageVersion(
  versionOverride ?? (mode === "snapshot" ? `${pkg.version}-snapshot` : pkg.version),
);
const signing =
  mode === "release" ||
  (mode === "test" &&
    process.env["HUKUBE_SIGN_UPDATE_TEST"] === "1" &&
    process.env["GITHUB_ACTIONS"] === "true");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (mode === "release") {
  identity(process.env["RELEASE_TAG"] ?? "", process.env["RELEASE_SHA"] ?? "", version);
  if (sha !== process.env["RELEASE_SHA"])
    throw new Error("Release checkout differs from requested SHA.");
  if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
    throw new Error("Release packages require a clean checkout.");
  if (versionOverride) throw new Error("Release versions come from package.json.");
  if (process.platform === "darwin")
    for (const key of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "MACOS_TEAM_ID",
    ])
      if (!process.env[key]) throw new Error(`${key} is required for a signed, notarized release.`);
}
if (!signing) {
  // Never discover a developer's personal signing identities during local builds.
  process.env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false";
  delete process.env["CSC_LINK"];
  delete process.env["CSC_KEY_PASSWORD"];
  delete process.env["APPLE_API_KEY"];
}
const target = `${process.platform === "darwin" ? "mac" : process.platform}-${architecture}`;
const output = resolve(root, `.data/packages/${mode}/${version}/${target}`);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const engine = join(output, "engine/hukube-engine");
await mkdir(join(output, "engine"));
execFileSync(
  "go",
  [
    "build",
    "-trimpath",
    "-ldflags",
    `-X main.version=${version} -X main.revision=${sha}`,
    "-o",
    engine,
    "./cmd/hukube-engine",
  ],
  {
    cwd: join(root, "engine"),
    stdio: "inherit",
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: process.platform === "darwin" ? "darwin" : "linux",
      GOARCH: architecture === "x64" ? "amd64" : "arm64",
    },
  },
);
await writeFile(join(output, "engine/identity.json"), JSON.stringify({ version, sha, target }));
await build({
  projectDir: desktop,
  publish: "never",
  targets: (process.platform === "darwin" ? Platform.MAC : Platform.LINUX).createTarget(
    undefined,
    architecture === "arm64" ? Arch.arm64 : Arch.x64,
  ),
  config: {
    ...parse(await readFile(join(desktop, "electron-builder.yml"), "utf8")),
    extends: null,
    directories: { output },
    ...(mode === "test" ? { appId: "io.github.jimeh.hukube.update-test" } : {}),
    artifactName: "hukube-${version}-${os}-${arch}.${ext}",
    extraMetadata: {
      version,
      ...(mode === "test"
        ? { name: `hukube-update-test-${process.env["HUKUBE_UPDATE_TEST_ID"] ?? randomUUID()}` }
        : {}),
      hukubeUpdates: mode === "release" ? "release" : mode === "test" ? "test" : "disabled",
      hukubeRevision: sha,
    },
    extraResources: [
      { from: engine, to: "engine/hukube-engine" },
      { from: join(output, "engine/identity.json"), to: "engine/identity.json" },
      { from: resolve(root, "apps/app/dist"), to: "ui" },
    ],
    forceCodeSigning: signing && process.platform === "darwin",
    mac: {
      ...parse(await readFile(join(desktop, "electron-builder.yml"), "utf8")).mac,
      identity: signing ? undefined : "-",
      notarize: mode === "release",
    },
  },
});
console.log(output);
