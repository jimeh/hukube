import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { parse } from "yaml";
import { packages, verifyManifest } from "../src/release/inventory.ts";
const [directoryArg, target, mode = "snapshot"] = process.argv.slice(2);
if (!directoryArg || !target)
  throw new Error(
    "Usage: verify-package.ts directory mac-arm64|mac-x64|linux-x64 snapshot|release",
  );
const directory = resolve(directoryArg);
const identity = JSON.parse(await readFile(join(directory, "engine/identity.json"), "utf8")) as {
  version: string;
  sha: string;
  target: string;
};
if (identity.target !== target) throw new Error("Wrong target identity.");
const scratch = await mkdtemp(join(tmpdir(), "hukube-package-"));
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8" });
const cdHash = (appPath: string) =>
  spawnSync("codesign", ["-dv", "--verbose=4", appPath])
    .stderr.toString()
    .match(/^CDHash=(.+)$/m)?.[1];
try {
  let executable: string;
  let resources: string;
  if (target.startsWith("mac-")) {
    run("ditto", [
      "-x",
      "-k",
      join(directory, `hukube-${identity.version}-${target}.zip`),
      scratch,
    ]);
    const app = join(scratch, "hukube.app");
    executable = join(app, "Contents/MacOS/hukube");
    resources = join(app, "Contents/Resources");
    const arch = target.endsWith("arm64") ? "arm64" : "x86_64";
    for (const file of [executable, join(resources, "engine/hukube-engine")]) {
      if (run("lipo", ["-archs", file]).trim() !== arch)
        throw new Error("Wrong Mach-O architecture.");
    }
    if (
      run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print CFBundleShortVersionString",
        join(app, "Contents/Info.plist"),
      ]).trim() !== identity.version
    )
      throw new Error("Wrong bundle version.");
    if (mode === "release") {
      for (const file of [app, join(resources, "engine/hukube-engine")]) {
        run("codesign", ["--verify", "--strict", "--deep", file]);
        const result = spawnSync("codesign", ["-dv", "--verbose=4", file]);
        const info = result.stderr.toString();
        if (
          !info.includes(`TeamIdentifier=${process.env["MACOS_TEAM_ID"]}`) ||
          !info.includes("runtime") ||
          !info.includes("Authority=Developer ID Application:")
        )
          throw new Error("Missing Developer ID, expected team, or hardened runtime.");
      }
      run("xcrun", ["stapler", "validate", app]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
      const mount = join(scratch, "dmg");
      await mkdir(mount);
      run("hdiutil", [
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        mount,
        join(directory, `hukube-${identity.version}-${target}.dmg`),
      ]);
      try {
        run("codesign", ["--verify", "--deep", "--strict", join(mount, "hukube.app")]);
        run("xcrun", ["stapler", "validate", join(mount, "hukube.app")]);
        const mountedEngine = join(mount, "hukube.app/Contents/Resources/engine/hukube-engine");
        run("codesign", ["--verify", "--strict", mountedEngine]);
        if (
          createHash("sha256")
            .update(await readFile(mountedEngine))
            .digest("hex") !==
          createHash("sha256")
            .update(await readFile(join(resources, "engine/hukube-engine")))
            .digest("hex")
        )
          throw new Error("DMG and ZIP Engine identities differ.");
        if (!cdHash(app) || cdHash(app) !== cdHash(join(mount, "hukube.app")))
          throw new Error("DMG and ZIP app signatures differ.");
      } finally {
        run("hdiutil", ["detach", mount]);
      }
    }
  } else {
    const image = join(directory, `hukube-${identity.version}-linux-x64.AppImage`);
    execFileSync(image, ["--appimage-extract"], { cwd: scratch, stdio: "ignore" });
    executable = join(scratch, "squashfs-root/hukube");
    resources = join(scratch, "squashfs-root/resources");
    for (const file of [executable, join(resources, "engine/hukube-engine")])
      if (!run("file", [file]).includes("x86-64")) throw new Error("Wrong ELF architecture.");
  }
  const engine = join(resources, "engine/hukube-engine");
  const info = run("go", ["version", "-m", engine]);
  if (
    !info.includes(`GOOS=${target.startsWith("mac") ? "darwin" : "linux"}`) ||
    !info.includes(`GOARCH=${target.endsWith("arm64") ? "arm64" : "amd64"}`)
  )
    throw new Error("Engine OS/architecture mismatch.");
  const canLaunch =
    !target.startsWith("mac") ||
    process.arch === target.slice(4) ||
    (process.arch === "arm64" && target === "mac-x64");
  if (!canLaunch) throw new Error("A native or Rosetta launch is mandatory on release runners.");
  if (run(engine, ["--version"]).trim() !== `hukube-engine ${identity.version} (${identity.sha})`)
    throw new Error("Wrong Engine version or revision.");
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    KUBECONFIG: join(scratch, "empty-kubeconfig"),
    HUKUBE_USER_DATA_DIR: join(scratch, "profile"),
  };
  delete env["ELECTRON_RUN_AS_NODE"];
  await writeFile(
    env["KUBECONFIG"]!,
    "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n",
  );
  const instance = await electron.launch({
    executablePath: executable,
    args: ["--no-sandbox"],
    env,
  });
  try {
    const window = await instance.firstWindow();
    await window.getByRole("heading", { name: "Open a cluster" }).waitFor();
    const version = await instance.evaluate(({ app }) => app.getVersion());
    if (version !== identity.version) throw new Error("Launched version mismatch.");
    await window.screenshot({ path: join(directory, `${target}.png`) });
  } finally {
    await instance.close();
  }
  const candidates = packages(identity.version).filter((n) => n.includes(target));
  await verifyManifest(
    directory,
    parse(
      await readFile(
        join(directory, target.startsWith("mac") ? "latest-mac.yml" : "latest-linux.yml"),
        "utf8",
      ),
    ),
    identity.version,
    candidates,
  );
  const hashes: Record<string, string> = {};
  for (const name of candidates)
    hashes[name] = createHash("sha512")
      .update(await readFile(join(directory, name)))
      .digest("base64");
  await writeFile(
    join(directory, `${target}.json`),
    JSON.stringify(
      {
        ...identity,
        verified: true,
        signed: mode === "release" && target.startsWith("mac"),
        hashes,
      },
      null,
      2,
    ) + "\n",
  );
  const candidateDir = join(directory, "candidates");
  await mkdir(candidateDir, { recursive: true });
  for (const name of await readdir(directory))
    if (candidates.includes(name) || name.endsWith(".blockmap") || name === `${target}.json`)
      await copyFile(join(directory, name), join(candidateDir, name));
  await copyFile(
    join(directory, target.startsWith("mac") ? "latest-mac.yml" : "latest-linux.yml"),
    join(candidateDir, `${target}.yml`),
  );
  console.log(`Verified ${target} ${identity.version} at ${identity.sha}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
