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
const appProcess = instance.process();
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
  let entry: { calls: number; windows: number; engineAlive: boolean } | undefined;
  let output = "";
  instance.process().stdout!.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/HUKUBE_INSTALLER_ENTRY:({[^\n]+})/);
    if (match) entry = JSON.parse(match[1]!);
  });
  await instance.evaluate(({ app, autoUpdater, dialog, Menu, BrowserWindow }, healthUrl) => {
    const test = globalThis as unknown as {
      installCalls: number;
      prompts: string[];
      answers: number[];
    };
    test.installCalls = 0;
    test.prompts = [];
    test.answers = [1, 0];
    // A debugged Electron process waits for its Node inspector after quit.
    // Disconnect only once the real quit event proves the lifecycle completed.
    app.on("will-quit", (event) =>
      process.stdout.write(`HUKUBE_WILL_QUIT:prevented=${event.defaultPrevented}\n`),
    );
    app.once("quit", () => {
      process.stdout.write("HUKUBE_QUIT_EVENT\n");
      (
        process as unknown as { mainModule: { require(name: string): { close(): void } } }
      ).mainModule
        .require("node:inspector")
        .close();
    });
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
      const child = (
        process as unknown as {
          mainModule: {
            require(name: string): { execFileSync(command: string, args: string[]): void };
          };
        }
      ).mainModule.require("node:child_process");
      child.execFileSync("curl", ["--fail", "--silent", "--max-time", "2", healthUrl]);
      process.stdout.write(
        `HUKUBE_INSTALLER_ENTRY:${JSON.stringify({ calls: test.installCalls, windows: BrowserWindow.getAllWindows().length, engineAlive: true })}\n`,
      );
      // MacUpdater 6.8 with autoRunAppAfterInstall=false quits synchronously.
      // A nested quit inside the first will-quit is ignored by Electron.
      app.quit();
    };
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      test.prompts.push((args.at(-1) as { message: string }).message);
      return test.answers.shift() ?? 0;
    };
    Menu.getApplicationMenu()!.getMenuItemById("hukube-updates")!.click();
  }, `${endpoint.url}/healthz`);
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
  const closed = instance.waitForEvent("close", { timeout: 30_000 });
  await instance.evaluate(({ Menu }) => {
    (globalThis as unknown as { answers: number[] }).answers = [1];
    Menu.getApplicationMenu()!.getMenuItemById("hukube-updates")!.click();
  });
  await closed.catch((error: unknown) => {
    throw new Error(
      `Installer did not finish quitting; last entry=${JSON.stringify(entry)}, closed=${hasClosed}, output=${output.slice(-2000)}`,
      { cause: error },
    );
  });
  await expect.poll(() => entry).toEqual({ calls: 1, windows: 0, engineAlive: true });
  await expect.poll(() => output.includes("HUKUBE_QUIT_EVENT")).toBe(true);
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
    `PASS: ${target} every window can cancel an update restart; edits/Exec Session prompts survive retry; the Engine stays alive through consent and installer entry, then completes the installer's synchronous final quit.`,
  );
} finally {
  if (!hasClosed) {
    const deadline = setTimeout(() => {
      if (appProcess.exitCode === null) appProcess.kill("SIGKILL");
    }, 5000);
    try {
      await instance.close();
    } finally {
      clearTimeout(deadline);
    }
  }
  await rm(scratch, { recursive: true, force: true });
}
