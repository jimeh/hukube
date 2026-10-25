import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  app,
  autoUpdater as nativeUpdater,
  dialog,
  Menu,
  Notification,
  type MenuItemConstructorOptions,
} from "electron";
import { MacUpdater, AppImageUpdater } from "electron-updater";
import { Updates, updateMenu, updateError } from "./updates.ts";

const message = (title: string, detail: string) =>
  dialog.showMessageBox({
    type: "info",
    title: "hukube",
    message: title,
    detail,
    buttons: ["OK"],
  });

/** A build-time marker keeps development and snapshot packages off the public feed. */
export async function startUpdates(restart: () => void, recover: () => void): Promise<Updates> {
  const metadata = JSON.parse(await readFile(join(app.getAppPath(), "package.json"), "utf8")) as {
    hukubeUpdates?: string;
  };
  let unavailable: string | undefined;
  if (!app.isPackaged || !["release", "test"].includes(metadata.hukubeUpdates ?? ""))
    unavailable =
      "Automatic updates are disabled in development and snapshot packages. Install a release from github.com/jimeh/hukube/releases.";
  else if (process.platform === "linux") {
    const image = process.env["APPIMAGE"];
    if (!image)
      unavailable =
        "Automatic updates require the AppImage. Run a writable AppImage downloaded from github.com/jimeh/hukube/releases.";
    else {
      try {
        await access(image, constants.W_OK);
        await access(dirname(image), constants.W_OK);
      } catch {
        unavailable =
          "The AppImage or its folder is not writable. Move it to a folder you own and try again.";
      }
    }
  } else if (process.platform === "darwin") {
    const bundle = dirname(dirname(dirname(app.getPath("exe"))));
    try {
      await access(bundle, constants.W_OK);
      await access(dirname(bundle), constants.W_OK);
    } catch {
      unavailable =
        "The app or its folder is not writable. Move hukube to an Applications folder you own, then relaunch it to enable updates.";
    }
  } else unavailable = "Automatic updates are supported on macOS and Linux AppImage installations.";

  const autoUpdater = process.platform === "darwin" ? new MacUpdater() : new AppImageUpdater();
  autoUpdater.autoRunAppAfterInstall = metadata.hukubeUpdates !== "test";
  autoUpdater.autoDownload = false;
  // MacUpdater must let Squirrel validate/stage the ZIP before offering restart.
  // Linux only installs through our explicit, guarded restart path.
  autoUpdater.autoInstallOnAppQuit = process.platform === "darwin";
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  if (metadata.hukubeUpdates === "test") {
    const feed = new URL(process.env["HUKUBE_UPDATE_TEST_FEED"] ?? "http://127.0.0.1:1/");
    if (feed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(feed.hostname))
      throw new Error("Test update feeds must use loopback HTTP.");
    autoUpdater.setFeedURL({ provider: "generic", url: feed.href, useMultipleRangeRequest: false });
  }

  let promptOpen = false;
  const promptRestart = async (version: string) => {
    if (promptOpen) return;
    promptOpen = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "hukube",
        message: `hukube ${version} is ready to install`,
        detail:
          "Restart to install the update. You will be asked about unsaved edits and active Exec Sessions before any window closes.",
        buttons: ["Restart to Update", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) updates.restart();
    } finally {
      promptOpen = false;
    }
  };
  let manual = false;
  const check = async () => {
    if (updates.state.phase === "ready") return promptRestart(updates.state.version);
    manual = true;
    try {
      await updates.check(true);
    } finally {
      manual = false;
    }
  };
  const renderMenu = () => {
    const update: MenuItemConstructorOptions = {
      id: "hukube-updates",
      ...updateMenu(updates.state),
      click: () => {
        void check();
      },
    };
    const template: MenuItemConstructorOptions[] = [
      ...(process.platform === "darwin"
        ? [
            {
              role: "appMenu" as const,
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                update,
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      { role: "help", submenu: process.platform === "darwin" ? [] : [update] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  const updates = new Updates(
    {
      check: async () => {
        const result = await autoUpdater.checkForUpdates();
        return result && result.updateInfo.version !== app.getVersion() && result.isUpdateAvailable
          ? { version: result.updateInfo.version }
          : undefined;
      },
      download: async () => {
        if (process.platform !== "darwin") {
          await autoUpdater.downloadUpdate();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          let downloaded = false;
          let validated = false;
          const done = () => {
            if (downloaded && validated) {
              cleanup();
              resolve();
            }
          };
          const ready = () => {
            validated = true;
            done();
          };
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            nativeUpdater.removeListener("update-downloaded", ready);
            autoUpdater.removeListener("error", failed);
          };
          nativeUpdater.once("update-downloaded", ready);
          autoUpdater.once("error", failed);
          void autoUpdater.downloadUpdate().then(() => {
            downloaded = true;
            done();
          }, failed);
        });
      },
      install: () => autoUpdater.quitAndInstall(false, true),
    },
    {
      changed: (state) => {
        renderMenu();
        if (state.phase === "error") recover();
      },
      current: () => {
        void message("You're up to date", `hukube ${app.getVersion()} is the latest version.`);
      },
      error: (detail) => {
        const feedback = updateError(updates.state, detail);
        void message(feedback.message, feedback.detail);
      },
      ready: (version) => {
        if (manual) {
          void promptRestart(version);
          return;
        }
        try {
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: "hukube update ready",
              body: `Version ${version} is ready. Restart when convenient, or use the application menu to update later.`,
            });
            notification.on("click", () => {
              void promptRestart(version);
            });
            notification.on("failed", () => {});
            notification.show();
          }
        } catch {
          // The ready menu action remains available when native notifications fail.
        }
      },
      restart,
    },
    unavailable,
  );
  autoUpdater.on("download-progress", (progress) => updates.progress(progress.percent));
  // check/download errors reject their promises. Installation can report errors
  // by event instead; restore a usable window without stopping its Engine.
  autoUpdater.on("error", (error) => {
    if (updates.state.phase === "restarting") {
      updates.failed(error);
      void message("Could not install the update", error.message);
    }
  });
  renderMenu();
  if (!unavailable) {
    const initial = setTimeout(() => {
      void updates.check();
    }, 30_000);
    const cadence = setInterval(
      () => {
        void updates.check();
      },
      6 * 60 * 60 * 1000,
    );
    initial.unref();
    cadence.unref();
    app.once("quit", () => {
      clearTimeout(initial);
      clearInterval(cadence);
    });
  }
  return updates;
}
