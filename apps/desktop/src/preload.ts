// Exposes the desktop Host's bridge to the UI. Runs sandboxed, so it may only
// import from "electron".
import { contextBridge, ipcRenderer } from "electron";

import type { DesktopBridge } from "@hukube/host";

const bridge: DesktopBridge = {
  engine: () => ipcRenderer.invoke("hukube:engine"),
  openWindow: (path) => ipcRenderer.send("hukube:open-window", path),
  openExternal: (url) => ipcRenderer.send("hukube:open-external", url),
};

contextBridge.exposeInMainWorld("hukubeDesktop", bridge);
