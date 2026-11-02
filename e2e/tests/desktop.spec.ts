import { logReplayFixture } from "../log-replay.ts";
import { withLogStreamDefaults } from "../log-preferences.ts";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

import { assertLogFiltering, assertPreviousInterruption } from "./logs.ts";

import { openGoToResource, savedSessionLayout } from "./exec.ts";

import { clusterId, kubeconfig, kubectl, kubectlCreate } from "./env.ts";
import {
  createPaneZoomResources,
  observePaneZoom,
  paneZoomExecScenario,
  paneZoomResourceScenario,
} from "./pane-zoom.ts";

const desktopDir = resolve(import.meta.dirname, "../../apps/desktop");
// The electron package exports the path to its binary.
const electronBinary = createRequire(resolve(desktopDir, "package.json"))("electron") as string;

for (const scenario of ["Resources", "Exec and Logs"] as const) {
  test(`Pane zoom preserves ${scenario} in the desktop Host`, async () => {
    test.setTimeout(180_000);
    const namespace = `e2e-zoom-desktop-${Date.now().toString(36)}`;
    kubectl("create", "namespace", namespace);
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    const profile = mkdtempSync(join(tmpdir(), "hukube-zoom-e2e-"));
    try {
      createPaneZoomResources(namespace);
      app = await electron.launch({
        executablePath: electronBinary,
        args: [desktopDir, "--no-sandbox"],
        env: {
          ...process.env,
          KUBECONFIG: kubeconfig,
          HUKUBE_USER_DATA_DIR: profile,
        },
      });
      const window = await app.firstWindow();
      const wire = observePaneZoom(window);
      await window.addInitScript(() => localStorage.setItem("hukube.terminal.renderer", "dom"));
      await window.reload();
      await window.getByRole("button", { name: new RegExp(clusterId) }).click();
      await expect(window.getByText(/Kubernetes v\d/)).toBeVisible();
      if (scenario === "Resources") {
        await paneZoomResourceScenario(window, namespace, wire);
        const after = wire.saved.length;
        await window.getByRole("button", { name: "Zoom Pane", exact: true }).first().click();
        await wire.nextSave(after);
        await window.getByRole("link", { name: clusterId, exact: true }).click({ button: "right" });
        const opened = app.waitForEvent("window");
        await window.getByRole("menuitem", { name: "Move to new window" }).click();
        const other = await opened;
        await expect(other.locator(".dv-groupview:visible")).toHaveCount(2);
        await expect(other.getByRole("button", { name: "Restore Panes" })).toHaveCount(0);
      } else await paneZoomExecScenario(window, namespace, wire);
    } finally {
      // A failed draft/session assertion must not strand teardown in its close guard.
      const child = app?.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      kubectl("delete", "namespace", namespace, "--wait=false");
      rmSync(profile, { recursive: true, force: true });
    }
  });
}

test("starts its own Engine and lists the kubeconfig's clusters", async () => {
  const app = await electron.launch({
    executablePath: electronBinary,
    // Test machines, like Ubuntu 24.04 CI runners, block Chromium's sandbox.
    args: [desktopDir, "--no-sandbox"],
    env: {
      ...process.env,
      KUBECONFIG: kubeconfig,
      HUKUBE_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "hukube-e2e-")),
    },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "Open a cluster" })).toBeVisible();
    await window.getByRole("button", { name: new RegExp(clusterId) }).click();
    await expect(window.getByText(/Kubernetes v\d/)).toBeVisible();
    await window.screenshot({ path: "test-results/desktop-workspace.png" });
  } finally {
    await app.close();
  }
});

test("runs an Exec Session and interrupts a foreground command with Ctrl+C", async () => {
  test.setTimeout(90_000);
  const namespace = `e2e-exec-desktop-${Date.now().toString(36)}`;
  kubectl("create", "namespace", namespace);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    kubectlCreate({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "e2e-exec-desktop", namespace },
      spec: {
        containers: [{ name: "app", image: "busybox:1.36", command: ["sh", "-c", "sleep 3600"] }],
      },
    });
    kubectl(
      "-n",
      namespace,
      "wait",
      "--for=condition=Ready",
      "pod/e2e-exec-desktop",
      "--timeout=60s",
    );
    app = await electron.launch({
      executablePath: electronBinary,
      args: [desktopDir, "--no-sandbox"],
      env: {
        ...process.env,
        KUBECONFIG: kubeconfig,
        HUKUBE_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "hukube-e2e-")),
      },
    });
    const window = await app.firstWindow();
    window.on("dialog", (dialog) => {
      void dialog.accept().catch(() => {});
    });
    await app.evaluate(({ dialog }) => {
      const prompts: { message?: string; detail?: string; buttons?: string[] }[] = [];
      (globalThis as typeof globalThis & { unloadPrompts: typeof prompts }).unloadPrompts = prompts;
      dialog.showMessageBoxSync = (...args: unknown[]) => {
        const options = args.at(-1) as Parameters<typeof dialog.showMessageBoxSync>[0];
        prompts.push(options);
        return 0;
      };
    });
    const saved = savedSessionLayout(window, "e2e-exec-desktop");
    await window.reload();
    // A terminal drawn with WebGL is a canvas, which a test cannot read.
    await window.evaluate(() => localStorage.setItem("hukube.terminal.renderer", "dom"));
    await window.getByRole("button", { name: new RegExp(clusterId) }).click();
    await expect(window.getByText(/Kubernetes v\d/)).toBeVisible();
    await openGoToResource(window);
    await window
      .getByRole("combobox", { name: "Go to Resource" })
      .fill(`${namespace}/pods/e2e-exec-desktop`);
    await window
      .getByRole("option", { name: new RegExp(`^Pod e2e-exec-desktop ${namespace}$`) })
      .click();
    const pod = window
      .getByRole("tabpanel", { name: "e2e-exec-desktop", exact: true })
      .filter({ has: window.getByRole("button", { name: "Open an Exec Session" }) });
    await pod.getByRole("button", { name: "Open an Exec Session" }).click();
    const panel = window
      .getByRole("tabpanel", { name: "app in e2e-exec-desktop", exact: true })
      .filter({ has: window.getByRole("button", { name: "Find in scrollback" }) });
    const input = panel.getByRole("textbox", { name: "Exec Session in app of e2e-exec-desktop" });
    const screen = panel.locator(".xterm-rows");
    await expect(screen).toContainText("/ #");
    // A shell drops what is typed while the session's first size reaches it,
    // so the first command is typed again until its output shows.
    await expect(async () => {
      await input.pressSequentially("echo desktop-$((6*7))");
      await input.press("Enter");
      await expect(screen).toContainText("desktop-42", { timeout: 3000 });
    }).toPass();
    await input.pressSequentially("HUKUBE_DESKTOP=kept-$((6*7)); echo ready-$HUKUBE_DESKTOP");
    await input.press("Enter");
    await expect(screen).toContainText("ready-kept-42");
    await saved();
    await window.reload();
    await expect(panel.getByText("Live", { exact: true })).toBeVisible();
    await input.focus();
    await input.pressSequentially("echo reload-$HUKUBE_DESKTOP");
    await input.press("Enter");
    await expect(screen).toContainText("reload-kept-42");
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { unloadPrompts: unknown[] }).unloadPrompts,
      ),
    ).toEqual([]);
    await app.evaluate(({ app: desktopApp }) => {
      desktopApp.quit();
    });
    await expect
      .poll(() =>
        app!.evaluate(
          () =>
            (globalThis as typeof globalThis & { unloadPrompts: unknown[] }).unloadPrompts.length,
        ),
      )
      .toBe(1);
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { unloadPrompts: unknown[] }).unloadPrompts[0],
      ),
    ).toMatchObject({
      message: "Quit and end the Exec Sessions?",
      detail:
        "Quitting stops the Engine, which ends 1 Exec Session in this window. A command still running in a container may keep running.",
      buttons: ["Cancel", "Quit"],
    });
    await input.focus();
    await input.pressSequentially("echo cancel-$HUKUBE_DESKTOP");
    await input.press("Enter");
    await expect(screen).toContainText("cancel-kept-42");
    // Cancelling Quit clears its flag, so another reload still passes without asking.
    await window.reload();
    await expect(panel.getByText("Live", { exact: true })).toBeVisible();
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { unloadPrompts: unknown[] }).unloadPrompts.length,
      ),
    ).toBe(1);
    await input.focus();
    await input.pressSequentially("sleep 100");
    await input.press("Enter");
    await expect(screen).toContainText("sleep 100");
    await input.press("Control+C");
    await input.pressSequentially("echo interrupted-$((6*7))");
    await input.press("Enter");
    await expect(screen).toContainText("interrupted-42");
    await input.pressSequentially("exit");
    await input.press("Enter");
    await expect(panel.getByText("Ended", { exact: true })).toBeVisible();
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      });
      await app.close();
    }
    kubectl("delete", "namespace", namespace, "--wait=false");
  }
});

test("filters retained Log Stream lines and searches the projection in the desktop Host", async () => {
  test.setTimeout(90_000);
  const namespace = `e2e-logs-desktop-${Date.now().toString(36)}`;
  kubectl("create", "namespace", namespace);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    kubectlCreate({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "e2e-logs-desktop", namespace },
      spec: {
        containers: [
          {
            name: "app",
            image: "busybox:1.36",
            command: [
              "sh",
              "-c",
              "printf 'counter 0 from desktop\\ncounter 1 from desktop\\ncounter 2 from desktop\\n'; sleep 3600",
            ],
          },
        ],
      },
    });
    kubectl(
      "-n",
      namespace,
      "wait",
      "--for=condition=Ready",
      "pod/e2e-logs-desktop",
      "--timeout=60s",
    );
    app = await electron.launch({
      executablePath: electronBinary,
      args: [desktopDir, "--no-sandbox"],
      env: {
        ...process.env,
        KUBECONFIG: kubeconfig,
        HUKUBE_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "hukube-e2e-logs-")),
      },
    });
    const window = await app.firstWindow();
    await window.getByRole("button", { name: new RegExp(clusterId) }).click();
    await expect(window.getByText(/Kubernetes v\d/)).toBeVisible();
    await openGoToResource(window);
    await window
      .getByRole("combobox", { name: "Go to Resource" })
      .fill(`${namespace}/pods/e2e-logs-desktop`);
    await window
      .getByRole("option", { name: new RegExp(`^Pod e2e-logs-desktop ${namespace}$`) })
      .click();
    const panel = window.getByRole("tabpanel", { name: "e2e-logs-desktop", exact: true });
    await panel.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(panel.locator(".monaco-editor .view-lines")).toContainText(
      "counter 2 from desktop",
    );
    await assertLogFiltering(panel);
  } finally {
    await app?.close();
    kubectl("delete", "namespace", namespace, "--wait=false");
  }
});

// oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test("Previous interruption preserves confirmed retained lines in the desktop Host", async ({}, info) => {
  test.setTimeout(180_000);
  const fixture = await logReplayFixture();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      KUBECONFIG: fixture.kubeconfig,
      HUKUBE_USER_DATA_DIR: join(fixture.scratch, "profile"),
    };
    delete env["ELECTRON_RUN_AS_NODE"];
    app = await electron.launch({
      executablePath: electronBinary,
      args: [desktopDir, "--no-sandbox"],
      env,
    });
    const window = await app.firstWindow();
    await withLogStreamDefaults(window, () =>
      assertPreviousInterruption(window, fixture, info, async (factor) => {
        await app!.evaluate(({ BrowserWindow }, zoom) => {
          BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom);
        }, factor);
      }),
    );
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      });
      await app.close();
    }
    await fixture.close();
  }
});
