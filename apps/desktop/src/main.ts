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

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";

import type { EngineEndpoint } from "@hukube/host";

const appScheme = "hukube";
const appOrigin = `${appScheme}://app`;
/** Set during development to load the UI from the Vite dev server. */
const devUiUrl = process.env["HUKUBE_UI_URL"];
const uiOrigin = devUiUrl ? new URL(devUiUrl).origin : appOrigin;

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

function createWindow(path = "/") {
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== uiOrigin) event.preventDefault();
  });
  void win.loadURL(new URL(path, devUiUrl ?? `${appOrigin}/`).href);
}

function openExternal(url: string) {
  const { protocol: scheme } = new URL(url);
  if (scheme === "https:" || scheme === "http:") void shell.openExternal(url);
}

ipcMain.handle("hukube:engine", () => endpoint);
ipcMain.on("hukube:open-window", (_event, path: unknown) => {
  if (typeof path === "string" && path.startsWith("/")) createWindow(path);
});
ipcMain.on("hukube:open-external", (_event, url: unknown) => {
  if (typeof url === "string") openExternal(url);
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
