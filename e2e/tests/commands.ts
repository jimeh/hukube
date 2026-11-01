import { expect, test, type Page } from "@playwright/test";
import { engineToken } from "./env.ts";

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
    await page.goto(`/#token=${engineToken}`);
    const original = await keyboardSetting(page);
    // settings.put intentionally cannot recreate an absent setting. Never turn a
    // missing shared document into a persisted one merely to run this test.
    test.skip(
      !original.value ||
        typeof original.value !== "object" ||
        !("version" in original.value) ||
        original.value.version !== 1,
      "Requires an existing version-1 keyboard document so cleanup can restore it exactly",
    );
    const other = await context.newPage();
    try {
      for (const p of [page, other]) {
        await p.goto(`/settings/keyboard-shortcuts#token=${engineToken}`);
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
      await other
        .getByRole("button", { name: "Save reviewed draft over this revision", exact: true })
        .click();
      await expect(other.getByText("Saved shortcuts", { exact: true })).toBeVisible();
      await other.keyboard.press("ControlOrMeta+Alt+I");
      await expect(other).toHaveURL(/settings\/appearance/);
    } finally {
      await keyboardSetting(page, original.value);
      await other.close();
    }
  });
}
