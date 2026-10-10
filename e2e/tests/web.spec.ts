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
