import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
const root = resolve(import.meta.dirname, "../../..");
const target = `${process.platform === "darwin" ? "mac" : "linux"}-${process.argv[2] ?? process.arch}`;
const directory = join(root, `.data/packages/test/0.0.1/${target}`);
const scratch = await mkdtemp(join(tmpdir(), "hukube-quit-"));
const executable = target.startsWith("mac")
  ? join(
      directory,
      target === "mac-arm64" ? "mac-arm64" : "mac",
      "hukube.app/Contents/MacOS/hukube",
    )
  : join(directory, "hukube-0.0.1-linux-x64.AppImage");
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);
delete env["ELECTRON_RUN_AS_NODE"];
env["KUBECONFIG"] = join(root, "e2e/fixtures/empty-kubeconfig.yaml");
env["HUKUBE_USER_DATA_DIR"] = scratch;
env["APPIMAGE_EXTRACT_AND_RUN"] = "1";
const instance = await electron.launch({ executablePath: executable, args: ["--no-sandbox"], env });
let hasClosed = false;
instance.once("close", () => {
  hasClosed = true;
});
try {
  const first = await instance.firstWindow();
  await first.getByRole("heading", { name: "Open a cluster" }).waitFor();
  const endpoint = await first.evaluate(() =>
    (
      window as unknown as { hukubeDesktop: { engine(): Promise<{ url: string; token: string }> } }
    ).hukubeDesktop.engine(),
  );
  await instance.evaluate(({ app, autoUpdater, dialog, Menu }) => {
    const test = globalThis as unknown as {
      installCalls: number;
      prompts: string[];
      answers: number[];
    };
    test.installCalls = 0;
    test.prompts = [];
    test.answers = [1, 0];
    const modules = (
      process as unknown as {
        mainModule: {
          require(name: string): {
            MacUpdater: { prototype: Record<string, unknown> };
            AppImageUpdater: { prototype: Record<string, unknown> };
          };
        };
      }
    ).mainModule.require("electron-updater");
    const prototype =
      process.platform === "darwin"
        ? modules.MacUpdater.prototype
        : modules.AppImageUpdater.prototype;
    prototype["checkForUpdates"] = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "0.0.2" },
    });
    prototype["downloadUpdate"] = async () => {
      autoUpdater.emit("update-downloaded");
      return [];
    };
    prototype["quitAndInstall"] = () => {
      test.installCalls++;
    };
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      test.prompts.push((args.at(-1) as { message: string }).message);
      return test.answers.shift() ?? 0;
    };
    Menu.getApplicationMenu()!.getMenuItemById("hukube-updates")!.click();
    void app;
  });
  await expect
    .poll(() =>
      instance.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("hukube-updates")?.label,
      ),
    )
    .toBe("Restart to Update to 0.0.2…");
  await first.evaluate(() =>
    (
      window as unknown as { hukubeDesktop: { openWindow(url: string): void } }
    ).hukubeDesktop.openWindow("/"),
  );
  await expect.poll(() => instance.windows().length).toBe(2);
  for (const window of instance.windows()) {
    await window.getByRole("heading", { name: "Open a cluster" }).waitFor();
    await window.evaluate(() => {
      addEventListener("beforeunload", (event) => {
        event.preventDefault();
        event.returnValue = "";
      });
      (
        window as unknown as {
          hukubeDesktop: { reportOpenWork(work: { edits: number; sessions: number }): void };
        }
      ).hukubeDesktop.reportOpenWork({ edits: 1, sessions: 1 });
    });
  }
  await instance.evaluate(({ dialog, Menu }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    Menu.getApplicationMenu()!.getMenuItemById("hukube-updates")!.click();
  });
  await expect
    .poll(() =>
      instance.evaluate(() => (globalThis as unknown as { prompts: string[] }).prompts.length),
    )
    .toBe(2);
  expect(
    await instance.evaluate(() => (globalThis as unknown as { installCalls: number }).installCalls),
  ).toBe(0);
  await expect.poll(() => instance.windows().length).toBe(1);
  expect((await fetch(`${endpoint.url}/healthz`)).ok).toBe(true);
  const surviving = instance.windows()[0]!;
  await expect(surviving.getByRole("heading", { name: "Open a cluster" })).toBeVisible();
  expect(
    await instance.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("hukube-updates")?.label,
    ),
  ).toBe("Restart to Update to 0.0.2…");
  await instance.evaluate(({ Menu }) => {
    (globalThis as unknown as { answers: number[] }).answers = [1];
    Menu.getApplicationMenu()!.getMenuItemById("hukube-updates")!.click();
  });
  await expect
    .poll(() =>
      instance.evaluate(() => (globalThis as unknown as { installCalls: number }).installCalls),
    )
    .toBe(1);
  expect(instance.windows()).toHaveLength(0);
  // The installer has begun, but has not yet requested its final quit.
  expect((await fetch(`${endpoint.url}/healthz`)).ok).toBe(true);
  const closed = instance.waitForEvent("close");
  await instance.evaluate(({ app }) => app.quit());
  await closed;
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${endpoint.url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    })
    .toBe(false);
  console.log(
    `PASS: ${target} every window can cancel an update restart; edits/Exec Session prompts survive retry; the Engine stays alive through consent and installer entry, then stops on final quit.`,
  );
} finally {
  if (!hasClosed) await instance.close();
  await rm(scratch, { recursive: true, force: true });
}
