import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { engineToken } from "./env.ts";

/** The raw process reads one sentinel byte after all palette input has finished. */
export async function palettePreservesExecInput(page: Page, input: Locator, screen: Locator) {
  await input.pressSequentially(
    "stty raw -echo; printf 'command-%s-ready\\n' $((6*7)); printf 'key-byte-%s\\n' \"$(head -c 1 | od -An -tx1 | tr -d ' \\n')\"; stty sane; printf 'command-%s-done\\n' $((6*7))",
  );
  await input.press("Enter");
  // The computed marker proves the reader is running; echoed command text cannot match it.
  await expect(screen).toContainText("command-42-ready");
  await input.focus();
  await page.keyboard.down("ControlOrMeta");
  await page.keyboard.down("Shift");
  try {
    await page.keyboard.down("P");
    await page.keyboard.down("P"); // An actual repeated keydown must stay consumed.
    await expect(page.getByRole("combobox", { name: "Search commands" })).toBeFocused();
  } finally {
    await page.keyboard.up("P");
    await page.keyboard.up("Shift");
    await page.keyboard.up("ControlOrMeta");
  }
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  await input.press("ControlOrMeta+Shift+P");
  const search = page.getByRole("combobox", { name: "Search commands" });
  await search.fill("Select all terminal text");
  await search.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await expect(input).toBeFocused();
  await input.pressSequentially("Z");
  // Completion orders the negative assertion: every preceding input would have
  // reached head before Z. A leaked Ctrl+P, Escape or Enter changes the first byte.
  await expect(screen).toContainText("command-42-done");
  await expect(screen).toContainText("key-byte-5a");
}

/** Fresh bounded observation; writes always CAS against that observation. */
async function keyboardSetting(
  page: Page,
  candidate?: unknown,
): Promise<{ value: unknown; revision: string }> {
  return page.evaluate(
    ({ token, write }) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`, [
          "hukube.v1",
          `hukube.token.${token}`,
        ]);
        let sent = false;
        let observed: { value: unknown; revision: string };
        const finish = (error?: string) => {
          clearTimeout(deadline);
          socket.close();
          if (error) reject(Error(error));
          else resolve(observed);
        };
        const deadline = setTimeout(
          () => finish("Keyboard setting read/write did not settle"),
          10000,
        );
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              id: 1,
              type: "subscribe",
              method: "settings.watch",
              params: { key: "app/keybindings" },
            }),
          );
        socket.onerror = () => finish("Keyboard setting socket failed");
        socket.onmessage = (event) => {
          const m = JSON.parse(String(event.data)) as {
            id: number;
            type: string;
            data: { value: unknown; revision: string };
            error?: { message: string };
          };
          if (m.type === "error") {
            finish(m.error?.message ?? "Keyboard setting failed");
            return;
          }
          if (m.id === 1 && m.type === "data") {
            observed = m.data;
            if (write === undefined) finish();
            else if (!sent) {
              sent = true;
              socket.send(
                JSON.stringify({
                  id: 2,
                  type: "request",
                  method: "settings.put",
                  params: { key: "app/keybindings", value: write, ifRevision: observed.revision },
                }),
              );
            }
          }
          if (m.id === 2 && m.type === "result") finish();
        };
      }),
    { token: engineToken, write: candidate },
  );
}
export function commandTests() {
  test("command palette discovers unavailable targets and edits a keyboard rule without dispatching", async ({
    page,
  }) => {
    await page.goto(`/#token=${engineToken}`);
    await page.getByRole("button", { name: "Command palette", exact: true }).click();
    const search = page.getByRole("combobox", { name: "Search commands" });
    await expect(search).toBeFocused();
    await search.fill("resource.open");
    await page
      .getByRole("button", { name: "Edit arguments for Open Resource", exact: true })
      .click();
    await page.getByLabel("Resource URI (required)").fill("invalid-uri");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText("canonical Resource URI");
    await page.keyboard.press("Escape");
    await search.fill("Go to Resource");
    await expect(page.getByText("Open a Cluster Workspace first.", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Keyboard shortcuts", exact: true }).click();
    await page.getByRole("button", { name: "Add binding for Open Settings", exact: true }).click();
    await page.getByLabel("Settings category (optional)").selectOption("appearance");
    await page.getByLabel("Condition (when)").fill("route == 'settings'");
    await page.getByRole("button", { name: "Record shortcut", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Alt+U");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("One or two strokes (space separated)")).toHaveValue("Mod+Alt+U");
    await expect(page).toHaveURL(/keyboard-shortcuts/);
    await page.getByRole("button", { name: "Cancel rule", exact: true }).click();
    await page.getByRole("button", { name: "Cancel changes", exact: true }).click();
  });
  test("keyboard draft conflicts across windows and restores the original Engine document", async ({
    page,
    context,
  }) => {
    // This test needs a restorable document. Seed only its own empty-kubeconfig
    // Engine, leaving the suite's Engine and keybindings untouched.
    const root = resolvePath(import.meta.dirname, "../..");
    const scratch = mkdtempSync(join(tmpdir(), "hukube-keyboard-e2e-"));
    const config = join(scratch, "kubeconfig");
    const data = join(scratch, "engine");
    const baseline = { version: 1, rules: [], disabledDefaults: [], future: { keep: true } };
    writeFileSync(
      config,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [],
        contexts: [],
        users: [],
        "current-context": "",
      }),
    );
    mkdirSync(join(data, "settings"), { recursive: true });
    writeFileSync(join(data, "settings", "app%2Fkeybindings.json"), JSON.stringify(baseline));
    const engine = spawn(
      join(root, "engine/bin/hukube-engine"),
      [
        "--web",
        "--ui-dir",
        join(root, "apps/app/dist"),
        "--listen",
        "127.0.0.1:0",
        `--token=${engineToken}`,
        "--kubeconfig",
        config,
        "--data-dir",
        data,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let url = "",
      logs = "";
    engine.stdout.on("data", (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-8192);
      for (const line of logs.split("\n")) {
        try {
          const record = JSON.parse(line) as { url?: string };
          if (record.url) url = record.url;
        } catch {
          /* Wait for a complete ready record. */
        }
      }
    });
    engine.stderr.on("data", (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-8192);
    });
    const other = await context.newPage();
    let original: Awaited<ReturnType<typeof keyboardSetting>> | undefined;
    try {
      await expect
        .poll(
          async () => {
            if (engine.exitCode !== null || engine.signalCode !== null)
              throw Error(`Keyboard test Engine exited: ${logs}`);
            return url
              ? fetch(`${url}/healthz`).then(
                  (r) => r.ok,
                  () => false,
                )
              : false;
          },
          { message: "owned keyboard test Engine readiness", timeout: 15000 },
        )
        .toBe(true);
      await page.goto(`${url}/#token=${engineToken}`);
      original = await keyboardSetting(page);
      expect(original.value).toEqual(baseline);
      for (const p of [page, other]) {
        await p.goto(`${url}/settings/keyboard-shortcuts#token=${engineToken}`);
        await p.getByRole("button", { name: "Add binding for Open Settings", exact: true }).click();
        await p
          .getByLabel("One or two strokes (space separated)")
          .fill(p === page ? "Mod+Alt+U" : "Mod+Alt+I");
        await p.getByLabel("Settings category (optional)").selectOption("appearance");
        await p.getByRole("button", { name: "Save rule", exact: true }).click();
      }
      await page.getByRole("button", { name: "Save shortcuts", exact: true }).click();
      await expect(page.getByText("Saved shortcuts", { exact: true })).toBeVisible();
      await expect(other.getByText(/Conflict with Engine revision/)).toBeVisible();
      await other.keyboard.press("ControlOrMeta+Alt+U");
      await other.keyboard.press("ControlOrMeta+Shift+P");
      await expect(other.getByRole("combobox", { name: "Search commands" })).toBeFocused();
      await expect(other).toHaveURL(/keyboard-shortcuts/);
      await other.keyboard.press("Escape");
      await other
        .getByRole("button", { name: "Save reviewed draft over this revision", exact: true })
        .click();
      await expect(other.getByText("Saved shortcuts", { exact: true })).toBeVisible();
      await other.keyboard.press("ControlOrMeta+Alt+I");
      await expect(other).toHaveURL(/settings\/appearance/);
    } finally {
      try {
        if (original) {
          await keyboardSetting(page, original.value);
          expect((await keyboardSetting(page)).value).toEqual(original.value);
        }
      } finally {
        await other.close();
        engine.kill("SIGTERM");
        try {
          await expect
            .poll(() => engine.exitCode !== null || engine.signalCode !== null, {
              message: "owned keyboard test Engine exit",
            })
            .toBe(true);
        } finally {
          if (engine.exitCode === null && engine.signalCode === null) {
            engine.kill("SIGKILL");
            await expect
              .poll(() => engine.exitCode !== null || engine.signalCode !== null, {
                message: "owned keyboard test Engine forced exit",
              })
              .toBe(true);
          }
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    }
  });
}
