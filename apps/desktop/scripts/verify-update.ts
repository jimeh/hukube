import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir, homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

// A real packaged two-version update using electron-updater's provider,
// metadata, HTTP downloader, digest verification and native installer.
const arch = process.argv[2] ?? process.arch;
const root = resolve(import.meta.dirname, "../../..");
const target = `${process.platform === "darwin" ? "mac" : "linux"}-${arch}`;
const signed =
  process.env["HUKUBE_SIGN_UPDATE_TEST"] === "1" && process.env["GITHUB_ACTIONS"] === "true";
const testId = randomUUID();
process.env["HUKUBE_UPDATE_TEST_ID"] = testId;
const cacheRoot =
  process.platform === "darwin"
    ? join(homedir(), "Library/Caches")
    : (process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"));
const cache = join(cacheRoot, `hukube-update-test-${testId}-updater`);
for (const version of ["0.0.1", "0.0.2"])
  execFileSync("bun", ["apps/desktop/scripts/package.ts", "test", arch, version], {
    cwd: root,
    stdio: "inherit",
  });
execFileSync("bun", ["apps/desktop/scripts/verify-lifecycle.ts", arch], {
  cwd: root,
  stdio: "inherit",
});
const directory = (version: string) => join(root, `.data/packages/test/${version}/${target}`);
const scratch = await mkdtemp(join(tmpdir(), "hukube-update-"));
const receipts: string[] = [];
const serve = async (request: IncomingMessage, response: ServerResponse) => {
  try {
    const name = decodeURIComponent(new URL(request.url!, "http://localhost").pathname).slice(1);
    if (!name || basename(name) !== name) {
      response.writeHead(404).end();
      return;
    }
    const file = join(directory("0.0.2"), name);
    const size = (await stat(file)).size;
    receipts.push(name);
    // Full download is a supported fallback for providers without ranges.
    response.writeHead(200, {
      "Content-Length": size,
      "Content-Type": name.endsWith("yml") ? "text/yaml" : "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
};
const server = createServer((request, response) => {
  void serve(request, response);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Feed did not start.");
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
delete env["ELECTRON_RUN_AS_NODE"];
env["HUKUBE_USER_DATA_DIR"] = join(scratch, "profile");
env["HUKUBE_UPDATE_TEST_FEED"] = `http://127.0.0.1:${address.port}/`;
env["KUBECONFIG"] = join(root, "e2e/fixtures/empty-kubeconfig.yaml");
env["APPIMAGE_EXTRACT_AND_RUN"] = "1";
let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  let executable: string;
  let installed: string;
  if (process.platform === "darwin") {
    execFileSync("ditto", [
      "-x",
      "-k",
      join(directory("0.0.1"), `hukube-0.0.1-${target}.zip`),
      scratch,
    ]);
    installed = join(scratch, "hukube.app");
    executable = join(installed, "Contents/MacOS/hukube");
  } else {
    installed = join(scratch, "hukube.AppImage");
    await copyFile(join(directory("0.0.1"), "hukube-0.0.1-linux-x64.AppImage"), installed);
    executable = installed;
  }
  instance = await electron.launch({ executablePath: executable, args: ["--no-sandbox"], env });
  const window = await instance.firstWindow();
  await window.getByRole("heading", { name: "Open a cluster" }).waitFor();
  expect(await instance.evaluate(({ app }) => app.getVersion())).toBe("0.0.1");
  await expect
    .poll(() =>
      instance!.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("hukube-updates")?.label,
      ),
    )
    .toBe("Check for Updates…");
  await instance.evaluate(({ dialog, Menu }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); // Later
    Menu.getApplicationMenu()!.getMenuItemById("hukube-updates")!.click();
  });
  if (process.platform === "darwin" && !signed) {
    await expect
      .poll(
        () =>
          instance!.evaluate(
            ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("hukube-updates")?.label,
          ),
        { timeout: 120_000 },
      )
      .toBe("Check for Updates Again…");
    expect(receipts).toContain(`hukube-0.0.2-${target}.zip`);
    await expect(window.getByRole("heading", { name: "Open a cluster" })).toBeVisible();
    console.log(
      "PASS: two-version packaged Mac metadata/download reached Squirrel and unsigned installation was rejected; running app and Engine remain usable. Signed installation remains a credential-dependent check.",
    );
  } else {
    await expect
      .poll(
        () =>
          instance!.evaluate(
            ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("hukube-updates")?.label,
          ),
        { timeout: 120_000 },
      )
      .toBe("Restart to Update to 0.0.2…");
    // Use the real menu and native prompt; only its response is driven here.
    await instance.evaluate(({ dialog, Menu }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      Menu.getApplicationMenu()!.getMenuItemById("hukube-updates")!.click();
    });
    await instance.waitForEvent("close", { timeout: 60_000 });
    instance = undefined;
    if (process.platform === "linux") {
      expect(
        createHash("sha512")
          .update(await readFile(installed))
          .digest("hex"),
      ).toBe(
        createHash("sha512")
          .update(await readFile(join(directory("0.0.2"), "hukube-0.0.2-linux-x64.AppImage")))
          .digest("hex"),
      );
    } else {
      await expect
        .poll(
          () =>
            execFileSync(
              "/usr/libexec/PlistBuddy",
              ["-c", "Print CFBundleShortVersionString", join(installed, "Contents/Info.plist")],
              { encoding: "utf8" },
            ).trim(),
          { timeout: 60_000 },
        )
        .toBe("0.0.2");
    }
    instance = await electron.launch({ executablePath: executable, args: ["--no-sandbox"], env });
    const updated = await instance.firstWindow();
    await updated.getByRole("heading", { name: "Open a cluster" }).waitFor();
    expect(await instance.evaluate(({ app }) => app.getVersion())).toBe("0.0.2");
    const endpoint = await updated.evaluate(() =>
      (
        window as unknown as {
          hukubeDesktop: { engine(): Promise<{ url: string; token: string }> };
        }
      ).hukubeDesktop.engine(),
    );
    expect((await fetch(`${endpoint.url}/healthz`)).ok).toBe(true);
    const resources = await instance.evaluate(() => process.resourcesPath);
    expect(
      execFileSync(join(resources, "engine/hukube-engine"), ["--version"], { encoding: "utf8" }),
    ).toMatch(/^hukube-engine 0\.0\.2 \([a-f0-9]{40}\)\n$/);
    console.log(
      `PASS: ${target} installed 0.0.1 -> 0.0.2 and started the updated UI with its bundled Engine.`,
    );
  }
} finally {
  if (instance) await instance.close();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(scratch, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
}
