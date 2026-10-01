// The desktop Host: supervises the Engine and opens windows onto the UI.
// It never proxies cluster traffic; the UI talks to the Engine directly
// (ADR-0002). Bundled as CommonJS, because Playwright's Electron launcher
// cannot drive an ES module entry point.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

import type { EngineEndpoint } from "@hukube/host";

const appScheme = "hukube";
const appOrigin = `${appScheme}://app`;
/** Set during development to load the UI from the Vite dev server. */
const devUiUrl = process.env["HUKUBE_UI_URL"];
/**
 * The scheme and host of a URL. URL.origin is "null" for custom schemes such
 * as hukube://, so it cannot be used to compare against the app's origin.
 */
function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}
const uiOrigin = devUiUrl ? originOf(new URL(devUiUrl)) : appOrigin;

// The app path is apps/desktop in development. Bun inlines __dirname at build
// time, so it cannot locate files at runtime.
const appPath = app.getAppPath();
const repoRoot = join(appPath, "../..");
const engineBinary = app.isPackaged
  ? join(process.resourcesPath, "engine", "hukube-engine")
  : join(repoRoot, "engine/bin/hukube-engine");
const uiDir = app.isPackaged ? join(process.resourcesPath, "ui") : join(repoRoot, "apps/app/dist");

// Lets tests and parallel instances use a separate profile and Engine data dir.
const userDataDir = process.env["HUKUBE_USER_DATA_DIR"];
if (userDataDir) app.setPath("userData", userDataDir);

protocol.registerSchemesAsPrivileged([
  { scheme: appScheme, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let engine: ChildProcess | undefined;
let endpoint: EngineEndpoint | undefined;
let quitting = false;

/**
 * GUI apps on macOS, and some Linux launchers, do not inherit the login
 * shell's PATH, so kubeconfig exec plugins such as `aws` or
 * `gke-gcloud-auth-plugin` would not be found. Ask the login shell for it.
 */
function loginShellPath(): Promise<string | undefined> {
  const shellPath = process.env["SHELL"];
  if (process.platform === "win32" || !shellPath) return Promise.resolve(undefined);
  const marker = "__HUKUBE_PATH__";
  return new Promise((resolve) => {
    execFile(
      shellPath,
      ["-ilc", `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 5000 },
      (err, stdout) => {
        const match = err ? null : new RegExp(`${marker}(.*)${marker}`).exec(stdout);
        resolve(match?.[1]);
      },
    );
  });
}

async function startEngine(): Promise<EngineEndpoint> {
  await access(engineBinary).catch(() => {
    throw new Error(
      `The Engine binary is missing at ${engineBinary}. Run \`mise run build:engine\`.`,
    );
  });
  const token = randomBytes(32).toString("hex");
  const path = (await loginShellPath()) ?? process.env["PATH"];
  const child = spawn(
    engineBinary,
    [
      "--listen=127.0.0.1:0",
      `--allow-origin=${uiOrigin}`,
      `--data-dir=${join(app.getPath("userData"), "engine")}`,
      // The Engine exits when this process dies and its stdin closes.
      "--exit-on-stdin-close",
    ],
    {
      env: { ...process.env, PATH: path, HUKUBE_TOKEN: token },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  engine = child;

  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as { event?: string; url?: string };
        if (msg.event === "ready" && msg.url) resolve({ url: msg.url, token });
      } catch {
        // Only the ready line is JSON; ignore anything else.
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`The Engine exited with code ${code} before it was ready.`));
      if (!quitting) {
        dialog.showErrorBox("hukube", `The Engine stopped unexpectedly (exit code ${code}).`);
        app.quit();
      }
    });
  });
}

/** Serves the built UI on hukube://app, falling back to index.html for app routes. */
function serveUi() {
  protocol.handle(appScheme, async (request) => {
    const { pathname } = new URL(request.url);
    const file = normalize(join(uiDir, decodeURIComponent(pathname)));
    if (!file.startsWith(uiDir + sep)) return new Response("Not found", { status: 404 });
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    return net.fetch(
      pathToFileURL(exists && pathname !== "/" ? file : join(uiDir, "index.html")).href,
    );
  });
}

/** Resolves an app path against the UI, or returns undefined if it leaves the UI's origin. */
function appUrl(path: string): URL | undefined {
  // URL.parse returns null for malformed input instead of throwing, so a bad
  // string from a renderer cannot crash the main process.
  const url = URL.parse(path, devUiUrl ?? `${appOrigin}/`);
  return url && originOf(url) === uiOrigin ? url : undefined;
}

/** Whether an IPC message came from the app's own UI, not another page. */
function fromUi(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frameUrl = URL.parse(event.senderFrame?.url ?? "");
  return frameUrl ? originOf(frameUrl) === uiOrigin : false;
}

function createWindow(url: URL = appUrl("/")!) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "hukube",
    backgroundColor: "#161b21",
    webPreferences: {
      preload: join(appPath, "out/preload.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  // Links to other sites open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler((details) => {
    openExternal(details.url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, destination) => {
    const target = URL.parse(destination);
    if (!target || originOf(target) !== uiOrigin) event.preventDefault();
  });
  void win.loadURL(url.href);
}

function openExternal(url: string) {
  const parsed = URL.parse(url);
  if (parsed?.protocol === "https:" || parsed?.protocol === "http:") {
    void shell.openExternal(parsed.href);
  }
}

// Only the app's UI may learn the Engine's token or open windows.
ipcMain.handle("hukube:engine", (event) => (fromUi(event) ? endpoint : undefined));
ipcMain.on("hukube:open-window", (event, path: unknown) => {
  const url = fromUi(event) && typeof path === "string" ? appUrl(path) : undefined;
  if (url) createWindow(url);
});
ipcMain.on("hukube:open-external", (event, url: unknown) => {
  if (fromUi(event) && typeof url === "string") openExternal(url);
});

app.on("before-quit", () => {
  quitting = true;
  engine?.kill();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (endpoint && BrowserWindow.getAllWindows().length === 0) createWindow();
});

app
  .whenReady()
  .then(async () => {
    serveUi();
    endpoint = await startEngine();
    createWindow();
  })
  .catch((err: unknown) => {
    dialog.showErrorBox("hukube could not start", err instanceof Error ? err.message : String(err));
    app.quit();
  });
