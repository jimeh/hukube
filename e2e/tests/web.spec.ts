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
  await sidebar.getByRole("button", { name: /^Service \d+$/ }).click();
  const panel = page.getByRole("tabpanel", { name: "services" });
  const headers = panel.getByRole("columnheader");
  const columns = panel.getByRole("button", { name: "Customize columns", exact: true });
  const defaults = ["Name", "Namespace", "Type", "Cluster-IP", "External-IP", "Port(s)", "Age"];
  // Read through another client so optimistic rendering cannot stand in for
  // persistence, including when resetting before the page closes.
  const expectSaved = async (expected: string[], resetToDefault = false) => {
    const other = await page.context().newPage();
    try {
      await other.goto(`${page.url()}#token=${engineToken}`);
      await other
        .getByRole("complementary", { name: "Resource types" })
        .getByRole("button", { name: /^Service \d+$/ })
        .click();
      const otherPanel = other.getByRole("tabpanel", { name: "services" });
      await expect(otherPanel.getByRole("columnheader")).toHaveText(expected);
      if (resetToDefault) {
        await otherPanel.getByRole("button", { name: "Customize columns", exact: true }).click();
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
    // A drag that ends where it started stores nothing.
    const name = (await headers.first().boundingBox())!;
    await page.mouse.move(name.x + name.width / 2, name.y + name.height / 2);
    await page.mouse.down();
    await page.mouse.move(name.x + name.width / 2 + 20, name.y + name.height / 2, { steps: 8 });
    await expect(panel.locator("[data-column-drop-marker]")).toBeVisible();
    await page.mouse.up();
    await expect(headers).toHaveText(defaults);
    await expect(headers.first()).toHaveAttribute("aria-sort", "ascending");
    await columns.click();
    await expect(page.getByRole("menuitem", { name: "Reset to default" })).toBeDisabled();
    await page.keyboard.press("Escape");

    const other = await page.context().newPage();
    try {
      await other.goto(`${page.url()}#token=${engineToken}`);
      await other
        .getByRole("complementary", { name: "Resource types" })
        .getByRole("button", { name: /^Service \d+$/ })
        .click();
      const otherHeaders = other
        .getByRole("tabpanel", { name: "services" })
        .getByRole("columnheader");
      await expect(otherHeaders).toHaveText(defaults);

      await columns.click();
      await page.getByRole("menuitemcheckbox", { name: "Namespace", exact: true }).click();
      await expect(
        page.getByRole("menuitemcheckbox", { name: "Namespace", exact: true }),
      ).toHaveAttribute("aria-checked", "false");
      const withoutNamespace = ["Name", "Type", "Cluster-IP", "External-IP", "Port(s)", "Age"];
      await expect(headers).toHaveText(withoutNamespace);
      await expect(otherHeaders).toHaveText(withoutNamespace);
      await page.keyboard.press("Escape");
    } finally {
      await other.close();
    }

    const externalIP = panel.getByRole("columnheader", { name: "External-IP", exact: true });
    const type = panel.getByRole("columnheader", { name: "Type", exact: true });
    const press = (await externalIP.boundingBox())!;
    await page.mouse.move(press.x + press.width / 2, press.y + press.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(externalIP).toHaveAttribute("aria-sort", "ascending");
    await panel.getByRole("columnheader", { name: "Name", exact: true }).click();

    {
      const start = (await externalIP.boundingBox())!;
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      const destination = (await type.boundingBox())!;
      await page.mouse.move(destination.x + 2, destination.y + destination.height / 2, {
        steps: 12,
      });
    }
    await expect(type.locator("..").locator("[data-column-drop-marker]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.locator("[data-column-drop-marker]")).toHaveCount(0);
    await page.mouse.up();
    await expect(headers).toHaveText([
      "Name",
      "Type",
      "Cluster-IP",
      "External-IP",
      "Port(s)",
      "Age",
    ]);
    await expect(externalIP).toHaveAttribute("aria-sort", "none");

    await externalIP.focus();
    await externalIP.press("Enter");
    await expect(externalIP).toHaveAttribute("aria-sort", "ascending");
    await panel.getByRole("columnheader", { name: "Name", exact: true }).click();
    await expect(externalIP).toHaveAttribute("aria-sort", "none");

    {
      const start = (await externalIP.boundingBox())!;
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      const destination = (await type.boundingBox())!;
      await page.mouse.move(destination.x + 2, destination.y + destination.height / 2, {
        steps: 12,
      });
    }
    await expect(type.locator("..").locator("[data-column-drop-marker]")).toBeVisible();
    await page.mouse.up();
    await expect(headers).toHaveText([
      "Name",
      "External-IP",
      "Type",
      "Cluster-IP",
      "Port(s)",
      "Age",
    ]);
    await expect(externalIP).toHaveAttribute("aria-sort", "none");

    await externalIP.click();
    await expect(externalIP).toHaveAttribute("aria-sort", "ascending");
    await externalIP.press("Space");
    await expect(externalIP).toHaveAttribute("aria-sort", "descending");
    await expect(panel.locator("[data-column-drop-marker]")).toHaveCount(0);
    await panel.getByRole("columnheader", { name: "Name", exact: true }).click();

    await externalIP.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Sort descending", exact: true }).click();
    await expect(externalIP).toHaveAttribute("aria-sort", "descending");
    await externalIP.click({ button: "right" });
    const namespaceItem = page.getByRole("menuitemcheckbox", { name: "Namespace", exact: true });
    await namespaceItem.click();
    await expect(namespaceItem).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("columnheader", { name: "Namespace", exact: true })).toBeVisible();
    await externalIP.click({ button: "right" });
    await namespaceItem.click();
    await expect(namespaceItem).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("columnheader", { name: "Namespace", exact: true })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");

    const age = panel.getByRole("columnheader", { name: "Age", exact: true });
    await age.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move left" }).click();
    await expect(headers).toHaveText([
      "Name",
      "External-IP",
      "Type",
      "Cluster-IP",
      "Age",
      "Port(s)",
    ]);
    await age.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move left" }).click();
    const edited = ["Name", "External-IP", "Type", "Age", "Cluster-IP", "Port(s)"];
    await expect(headers).toHaveText(edited);

    await expectSaved(edited);
    await page.reload();
    await expect(headers).toHaveText(edited);

    // Scroll to a column that was outside the list when the drag started.
    await page.setViewportSize({ width: 760, height: 900 });
    const scroller = panel.locator(".overflow-auto");
    await expect
      .poll(async () => {
        const rect = (await scroller.boundingBox())!;
        return rect.x + rect.width;
      })
      .toBeLessThanOrEqual(760);
    const bounds = (await scroller.boundingBox())!;
    const ports = panel.getByRole("columnheader", { name: "Port(s)", exact: true });
    expect((await ports.boundingBox())!.x).toBeGreaterThan(bounds.x + bounds.width);
    const scrollTop = await scroller.evaluate((element) => element.scrollTop);
    const first = (await headers.first().boundingBox())!;
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 4, first.y + first.height / 2, { steps: 16 });
    await expect(panel.locator("[data-column-drop-marker]")).toBeVisible();
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollWidth - element.clientWidth - element.scrollLeft,
        ),
      )
      .toBeLessThanOrEqual(1);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    await expect(columns).toBeVisible();
    const customize = (await columns.boundingBox())!;
    const last = (await headers.last().boundingBox())!;
    expect(customize.x + customize.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(customize.x).toBeGreaterThanOrEqual(bounds.x);
    expect(last.x + last.width).toBeLessThanOrEqual(customize.x);
    const lastCell = panel.getByRole("grid").getByRole("row").first().getByRole("gridcell").last();
    const cell = (await lastCell.boundingBox())!;
    expect(cell.x + cell.width).toBeLessThanOrEqual(customize.x);
    const end = (await ports.boundingBox())!;
    await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(headers).toHaveText([...edited.slice(1), "Name"]);
    await expect(panel.locator("[data-column-drop-marker]")).toHaveCount(0);
  } finally {
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.setViewportSize({ width: 1440, height: 900 });
    await reset();
  }
});
