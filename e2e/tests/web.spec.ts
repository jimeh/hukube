import { expect, test } from "@playwright/test";

import { clusterId, engineToken, kubectl } from "./env.ts";

const namespace = `e2e-${Date.now().toString(36)}`;

test.beforeAll(() => {
  kubectl("create", "namespace", namespace);
});
test.afterAll(() => {
  kubectl("delete", "namespace", namespace, "--wait=false");
});

test("browses a live ConfigMap from the cluster picker to its YAML", async ({ page }) => {
  await page.goto(`/#token=${engineToken}`);
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();

  await expect(page.getByText(/Kubernetes v\d/)).toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "Resource types" });
  await sidebar.getByRole("button", { name: /^ConfigMap \d+$/ }).click();
  await page.getByRole("textbox", { name: "Filter by name" }).fill("e2e-settings");
  const grid = page.getByRole("grid", { name: "ConfigMap resources" });
  // Wait for the filtered list to load, so the next step proves a live update.
  await expect(page.getByText("No matches")).toBeVisible();
  await expect(grid.getByRole("row")).toHaveCount(0);

  // Resources created after the list opened appear without a reload.
  kubectl(
    "-n",
    namespace,
    "create",
    "configmap",
    "e2e-settings",
    "--from-literal=greeting=hello-from-e2e",
  );
  const row = grid.getByRole("row", { name: new RegExp(`e2e-settings ${namespace}`) });
  await expect(row).toBeVisible();

  await row.click();
  await expect(page.locator(".monaco-editor").getByText("hello-from-e2e")).toBeVisible();

  // Deleting it keeps the last known Manifest and marks it deleted.
  kubectl("-n", namespace, "delete", "configmap", "e2e-settings");
  await expect(page.getByText("Deleted", { exact: true })).toBeVisible();
  await expect(page.locator(".monaco-editor").getByText("hello-from-e2e")).toBeVisible();
  await expect(grid.getByRole("row")).toHaveCount(0);
});

test("shows a Resource Type's columns and keeps their cells current", async ({ page }) => {
  await page.goto(`/#token=${engineToken}`);
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();

  const sidebar = page.getByRole("complementary", { name: "Resource types" });
  await sidebar.getByRole("button", { name: /^ConfigMap \d+$/ }).click();
  await page.getByRole("textbox", { name: "Filter by name" }).fill("e2e-columns");
  // The Cluster decides the columns: ConfigMaps have one for their number of
  // keys, between the Namespace and the age.
  await expect(page.getByRole("columnheader", { name: "Data" })).toBeVisible();

  kubectl("-n", namespace, "create", "configmap", "e2e-columns", "--from-literal=first=1");
  const grid = page.getByRole("grid", { name: "ConfigMap resources" });
  const row = grid.getByRole("row", { name: new RegExp(`e2e-columns ${namespace}`) });
  const data = row.getByRole("gridcell").nth(2);
  await expect(data).toHaveText("1");

  // A change that leaves the name and age alone still reaches the list.
  kubectl(
    "-n",
    namespace,
    "patch",
    "configmap",
    "e2e-columns",
    "--type=merge",
    "--patch",
    '{"data":{"second":"2"}}',
  );
  await expect(data).toHaveText("2");
});

test("goes to a Resource and a Resource Type from the palette", async ({ page }) => {
  kubectl(
    "-n",
    namespace,
    "create",
    "configmap",
    "e2e-palette",
    "--from-literal=greeting=hello-from-palette",
  );
  await page.goto(`/#token=${engineToken}`);
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();
  await expect(page.getByText(/Kubernetes v\d/)).toBeVisible();

  // A Namespace and a type prefix scope a fuzzy match on the name.
  await page.keyboard.press("ControlOrMeta+K");
  const input = page.getByRole("combobox", { name: "Go to Resource" });
  // Type at a human pace, so results for earlier text arrive while typing.
  await input.pressSequentially(`${namespace}/cm/e2epal`, { delay: 100 });
  await expect(page.getByRole("option", { name: /e2e-palette/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  const editor = page.locator(".monaco-editor");
  await expect(editor.getByText("hello-from-palette")).toBeVisible();

  // The shortcut wins over the editor's own Ctrl+K handling.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+K");
  await input.fill("ConfigMap");
  await expect(page.getByRole("option", { name: /^ConfigMap configmaps/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("grid", { name: "ConfigMap resources" })).toBeVisible();
});

test("edits a Resource Type's columns and keeps the layout after reload", async ({ page }) => {
  await page.goto(`/#token=${engineToken}`);
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();
  const sidebar = page.getByRole("complementary", { name: "Resource types" });
  await sidebar.getByRole("button", { name: /^Pod \d+$/ }).click();
  const panel = page.getByRole("tabpanel", { name: "pods" });
  const headers = panel.getByRole("columnheader");
  const columns = panel.getByRole("button", { name: "Columns", exact: true });
  const defaults = ["Name", "Namespace", "Ready", "Status", "Restarts", "Node", "Age"];
  // Read through another client so optimistic rendering cannot stand in for
  // persistence, including when resetting before the page closes.
  const expectSaved = async (expected: string[], resetToDefault = false) => {
    const other = await page.context().newPage();
    try {
      await other.goto(`${page.url()}#token=${engineToken}`);
      await other
        .getByRole("complementary", { name: "Resource types" })
        .getByRole("button", { name: /^Pod \d+$/ })
        .click();
      const otherPanel = other.getByRole("tabpanel", { name: "pods" });
      await expect(otherPanel.getByRole("columnheader")).toHaveText(expected);
      if (resetToDefault) {
        await otherPanel.getByRole("button", { name: "Columns", exact: true }).click();
        await expect(other.getByRole("menuitem", { name: "Reset to default" })).toBeDisabled();
      }
    } finally {
      await other.close();
    }
  };
  const reset = async () => {
    await page.keyboard.press("Escape");
    await columns.click();
    const item = page.getByRole("menuitem", { name: "Reset to default" });
    if (await item.isEnabled()) await item.click();
    else await page.keyboard.press("Escape");
    await expect(headers).toHaveText(defaults);
    await expectSaved(defaults, true);
  };
  // Keep this type at the default before and after the test.
  await reset();
  try {
    await headers.first().focus();
    await headers.first().press("Alt+ArrowLeft");
    await columns.click();
    await expect(page.getByRole("menuitem", { name: "Reset to default" })).toBeDisabled();
    await page.keyboard.press("Escape");

    const other = await page.context().newPage();
    try {
      await other.goto(`${page.url()}#token=${engineToken}`);
      await other
        .getByRole("complementary", { name: "Resource types" })
        .getByRole("button", { name: /^Pod \d+$/ })
        .click();
      const otherHeaders = other.getByRole("tabpanel", { name: "pods" }).getByRole("columnheader");
      await expect(otherHeaders).toHaveText(defaults);

      await columns.click();
      await page.getByRole("menuitemcheckbox", { name: "Namespace", exact: true }).click();
      await expect(
        page.getByRole("menuitemcheckbox", { name: "Namespace", exact: true }),
      ).toHaveAttribute("aria-checked", "false");
      const withoutNamespace = ["Name", "Ready", "Status", "Restarts", "Node", "Age"];
      await expect(headers).toHaveText(withoutNamespace);
      await expect(otherHeaders).toHaveText(withoutNamespace);
      await page.keyboard.press("Escape");
    } finally {
      await other.close();
    }

    const node = panel.getByRole("columnheader", { name: "Node", exact: true });
    const ready = panel.getByRole("columnheader", { name: "Ready", exact: true });
    const start = (await node.boundingBox())!;
    const destination = (await ready.boundingBox())!;
    await node.click();
    await expect(node).toHaveAttribute("aria-sort", "ascending");
    await panel.getByRole("columnheader", { name: "Name", exact: true }).click();

    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(destination.x + 2, destination.y + destination.height / 2);
    await expect(panel.locator("[data-column-drop-marker]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.locator("[data-column-drop-marker]")).toHaveCount(0);
    await page.mouse.up();
    await expect(headers).toHaveText(["Name", "Ready", "Status", "Restarts", "Node", "Age"]);
    await expect(node).toHaveAttribute("aria-sort", "none");

    await node.focus();
    await node.press("Enter");
    await expect(node).toHaveAttribute("aria-sort", "ascending");
    await panel.getByRole("columnheader", { name: "Name", exact: true }).click();
    await expect(node).toHaveAttribute("aria-sort", "none");

    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(destination.x + 2, destination.y + destination.height / 2);
    await expect(panel.locator("[data-column-drop-marker]")).toBeVisible();
    await page.mouse.up();
    await expect(headers).toHaveText(["Name", "Node", "Ready", "Status", "Restarts", "Age"]);
    await expect(node).toHaveAttribute("aria-sort", "none");

    const age = panel.getByRole("columnheader", { name: "Age", exact: true });
    await age.focus();
    await age.press("Alt+ArrowLeft");
    await expect(age).toBeFocused();
    await age.press("Alt+ArrowLeft");
    const edited = ["Name", "Node", "Ready", "Age", "Status", "Restarts"];
    await expect(headers).toHaveText(edited);
    await expect(age).toBeFocused();

    await expectSaved(edited);
    await page.reload();
    await expect(headers).toHaveText(edited);
  } finally {
    await reset();
  }
});
