import { expect, test, type Locator, type Page } from "@playwright/test";

import { clusterId, engineToken, kubectl, kubectlCreate } from "./env.ts";

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
  // The marker sits on the edge of a header where a drop would land.
  const expectMarker = (header: Locator, edge: "left" | "right") =>
    expect
      .poll(async () => {
        const marker = await panel.locator("[data-column-drop-marker]").boundingBox();
        const box = await header.boundingBox();
        if (!marker || !box) return Infinity;
        return Math.abs(
          marker.x + marker.width / 2 - (edge === "left" ? box.x : box.x + box.width),
        );
      })
      .toBeLessThan(3);
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
      const y = destination.y + destination.height / 2;
      await page.mouse.move(destination.x + destination.width * 0.75, y, { steps: 12 });
      await expectMarker(type, "right");
      // One move across the middle of the same header takes the marker with it.
      await page.mouse.move(destination.x + destination.width * 0.25, y);
      await expectMarker(type, "left");
    }
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
    // The pointer has not moved since the list began to scroll under it.
    await expectMarker(ports, "right");
    await expect(columns).toBeVisible();
    const customize = (await columns.boundingBox())!;
    const last = (await headers.last().boundingBox())!;
    expect(customize.x + customize.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(customize.x).toBeGreaterThanOrEqual(bounds.x);
    expect(last.x + last.width).toBeLessThanOrEqual(customize.x);
    const lastCell = panel.getByRole("grid").getByRole("row").first().getByRole("gridcell").last();
    const cell = (await lastCell.boundingBox())!;
    expect(cell.x + cell.width).toBeLessThanOrEqual(customize.x);
    await page.mouse.up();
    await expect(headers).toHaveText([...edited.slice(1), "Name"]);
    await expect(panel.locator("[data-column-drop-marker]")).toHaveCount(0);

    // Showing a column that is hidden by default scrolls it into view.
    await scroller.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await columns.click();
    await page.getByRole("menuitemcheckbox", { name: "Selector", exact: true }).click();
    const selector = panel.getByRole("columnheader", { name: "Selector", exact: true });
    await expect
      .poll(async () => {
        const header = await selector.boundingBox();
        const list = await scroller.boundingBox();
        const pinned = await columns.locator("..").boundingBox();
        return (
          !!header &&
          !!list &&
          !!pinned &&
          header.x >= list.x &&
          header.x + header.width <= pinned.x
        );
      })
      .toBe(true);
    await expect(
      page.getByRole("menuitemcheckbox", { name: "Selector", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  } finally {
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.setViewportSize({ width: 1440, height: 900 });
    await reset();
  }
});

test("shows live Resource Events and restores the Facet after reload", async ({ page }) => {
  kubectl("-n", namespace, "create", "configmap", "e2e-events", "--from-literal=value=events");
  await page.goto(`/#token=${engineToken}`);
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();
  await page
    .getByRole("complementary", { name: "Resource types" })
    .getByRole("button", { name: /^ConfigMap \d+$/ })
    .click();
  const list = page.getByRole("tabpanel", { name: "configmaps", exact: true });
  await list.getByRole("textbox", { name: "Filter by name" }).fill("e2e-events");
  await list.getByRole("row", { name: new RegExp(`e2e-events ${namespace}`) }).click();
  const panel = page.getByRole("tabpanel", { name: "e2e-events", exact: true });
  await panel.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(panel.getByText("No recent Events")).toBeVisible();
  const uid = kubectl(
    "-n",
    namespace,
    "get",
    "configmap",
    "e2e-events",
    "-o",
    "jsonpath={.metadata.uid}",
  );
  const reference = { apiVersion: "v1", kind: "ConfigMap", name: "e2e-events", namespace, uid };
  kubectlCreate({
    apiVersion: "v1",
    kind: "Event",
    metadata: { name: "e2e-events-layout", namespace },
    involvedObject: reference,
    reason: "AReasonLongEnoughToTruncateInANarrowPane",
    message:
      "  A long message with ordinary words must wrap below the metadata columns and stay readable in a narrow Pane beside the Resource list.\nThe message keeps this line break.  ",
    source: { component: "layout-reporter", host: "a-long-reporter-instance-for-wrapping" },
    count: 3,
    type: "Normal",
  });
  await expect(panel.getByRole("row", { name: /AReasonLongEnoughToTruncate/ })).toBeVisible();
  const typeColumn = panel.getByRole("columnheader", { name: "Type", exact: true });
  const beforeWarning = (await typeColumn.boundingBox())!;
  kubectlCreate({
    apiVersion: "v1",
    kind: "Event",
    metadata: { name: "e2e-events-warning", namespace },
    involvedObject: reference,
    reason: "FailedScheduling",
    message: "Live warning from e2e",
    type: "Warning",
  });
  await expect(
    panel.getByRole("row", { name: /Warning FailedScheduling.*Live warning from e2e/ }),
  ).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Events, 1 warning", exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const afterWarning = (await typeColumn.boundingBox())!;
      return { x: afterWarning.x, width: afterWarning.width };
    })
    .toEqual({ x: beforeWarning.x, width: beforeWarning.width });
  kubectlCreate({
    apiVersion: "v1",
    kind: "Event",
    metadata: { name: "e2e-events-normal", namespace },
    involvedObject: reference,
    reason: "SameMessage",
    message: "Live warning from e2e",
    type: "Normal",
  });
  await expect(panel.getByRole("row", { name: /Normal SameMessage/ })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });
  await expectEventsLayout(panel);
  await waitForStoredResourceUri(
    page,
    `hukube://resource/v1/${encodeURIComponent(clusterId)}/configmaps/${namespace}/e2e-events#events`,
  );
  await page.reload();
  await expect(panel.getByRole("tab", { name: "Events, 1 warning", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByRole("row", { name: /Warning FailedScheduling/ })).toBeVisible();
  // Enter opens a pinned Resource tab and keeps the Facet the destination Pane shows.
  kubectl("-n", namespace, "create", "configmap", "e2e-events-second");
  await list.getByRole("textbox", { name: "Filter by name" }).fill("e2e-events-second");
  const grid = list.getByRole("grid", { name: "ConfigMap resources" });
  await expect(grid.getByRole("row")).toHaveCount(1);
  const secondRow = list.getByRole("row", { name: new RegExp(`e2e-events-second ${namespace}`) });
  await expect(secondRow).toBeVisible();
  await grid.focus();
  await grid.press("ArrowDown");
  await expect(secondRow).toHaveAttribute("aria-selected", "true");
  await grid.press("Enter");
  const secondPanel = page.getByRole("tabpanel", { name: "e2e-events-second", exact: true });
  await expect(secondPanel.getByRole("tab", { name: "Events", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(secondPanel.getByText("No recent Events")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "e2e-events-second", exact: true }).locator("span").first(),
  ).toHaveCSS("font-style", "normal");
});

// Observe the saved layout without opening a second Workspace, which could
// restore and save an older layout before the first Workspace's save arrives.
async function waitForStoredResourceUri(page: Page, uri: string): Promise<void> {
  const other = await page.context().newPage();
  try {
    await other.goto(`/#token=${engineToken}`);
    await other.evaluate(
      async ({ token, uri: expectedUri, cluster }) => {
        await new Promise<void>((resolve, reject) => {
          let last: unknown;
          const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`, [
            "hukube.v1",
            `hukube.token.${token}`,
          ]);
          const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`Events Facet was not stored; last layout: ${JSON.stringify(last)}`));
          }, 10_000);
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                id: 1,
                type: "subscribe",
                method: "settings.watch",
                params: { key: `workspace/${cluster}` },
              }),
            );
          socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data)) as {
              id: number;
              type: string;
              data?: {
                value?: { dockview?: { panels?: Record<string, { params?: { uri?: string } }> } };
              };
            };
            if (message.id !== 1 || message.type !== "data") return;
            last = message.data?.value;
            const panels = message.data?.value?.dockview?.panels ?? {};
            if (
              Object.values(panels).some((storedPanel) => storedPanel.params?.uri === expectedUri)
            ) {
              clearTimeout(timeout);
              socket.close();
              resolve();
            }
          };
          socket.onerror = () => {
            clearTimeout(timeout);
            socket.close();
            reject(new Error("Layout observer could not connect"));
          };
        });
      },
      {
        token: engineToken,
        cluster: clusterId,
        uri,
      },
    );
  } finally {
    await other.close();
  }
}

// Check the rendered geometry, since jsdom cannot lay out subgrid or wrapped text.
async function expectEventsLayout(panel: Locator): Promise<void> {
  const region = panel.getByRole("region", { name: "Events", exact: true });
  await expect.poll(() => region.evaluate((el) => el.clientWidth)).toBeLessThanOrEqual(360);
  await expect
    .poll(() =>
      region.evaluate((el) => {
        const table = el.querySelector('[role="table"]')!;
        const rows = Array.from(table.querySelectorAll('[role="row"]'));
        const headers = Array.from(rows[0]!.children)
          .slice(0, 3)
          .map((cell) => cell.getBoundingClientRect());
        const aligned = rows.slice(1).every((row) => {
          const cells = Array.from(row.children);
          const metadata = cells.slice(0, 3).map((cell) => cell.getBoundingClientRect());
          const message = cells[3]!;
          const details = cells[4]!;
          const bounds = message.getBoundingClientRect();
          const detailBounds = details.getBoundingClientRect();
          return (
            cells.length === 5 &&
            metadata.every((cell, i) => Math.abs(cell.x - headers[i]!.x) < 1) &&
            Math.abs(bounds.x - metadata[1]!.x) < 1 &&
            Math.abs(bounds.right - metadata[2]!.right) < 1 &&
            bounds.y >= Math.max(...metadata.map((cell) => cell.bottom)) &&
            (!details.textContent ||
              (Math.abs(detailBounds.x - metadata[1]!.x) < 1 &&
                Math.abs(detailBounds.right - metadata[2]!.right) < 1 &&
                detailBounds.y >= bounds.bottom)) &&
            getComputedStyle(message).overflowWrap === "break-word" &&
            getComputedStyle(message).whiteSpace === "pre-wrap"
          );
        });
        const longRow = rows.find((row) =>
          row.textContent?.includes("AReasonLongEnoughToTruncate"),
        )!;
        const reason = longRow.children[2]! as HTMLElement;
        const message = longRow.children[3]! as HTMLElement;
        const details = longRow.children[4]! as HTMLElement;
        const warningRow = rows.find((row) => row.textContent?.includes("FailedScheduling"))!;
        const normalRow = rows.find((row) => row.textContent?.includes("SameMessage"))!;
        const scheduling = warningRow.children[2]! as HTMLElement;
        return {
          noHorizontalScroll: el.scrollWidth === el.clientWidth,
          aligned,
          headersDoNotOverlap: headers.every(
            (cell, i) => i === 0 || cell.x >= headers[i - 1]!.right,
          ),
          messageWraps: message.clientHeight > parseFloat(getComputedStyle(message).lineHeight) * 2,
          detailsWrap: details.clientHeight > parseFloat(getComputedStyle(details).lineHeight),
          messageTrimmed: message.textContent === message.textContent?.trim(),
          reasonTruncatesWithTitle:
            reason.scrollWidth > reason.clientWidth && reason.title === reason.textContent,
          schedulingReasonFits: scheduling.scrollWidth === scheduling.clientWidth,
          equalRowHeights:
            Math.abs(
              warningRow.getBoundingClientRect().height - normalRow.getBoundingClientRect().height,
            ) < 1,
          noEmptyThirdLine: [warningRow, normalRow].every((row) => {
            const lastMessage = row.children[3]!.getBoundingClientRect();
            return (
              !row.children[4]!.textContent &&
              row.getBoundingClientRect().bottom - lastMessage.bottom < 10
            );
          }),
        };
      }),
    )
    .toEqual({
      noHorizontalScroll: true,
      aligned: true,
      headersDoNotOverlap: true,
      messageWraps: true,
      detailsWrap: true,
      messageTrimmed: true,
      reasonTruncatesWithTitle: true,
      schedulingReasonFits: true,
      equalRowHeights: true,
      noEmptyThirdLine: true,
    });
}

test("walks live ownership from a Deployment to its Pod and follows scale-up", async ({ page }) => {
  kubectlCreate({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "e2e-related", namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "e2e-related" } },
      template: {
        metadata: { labels: { app: "e2e-related" } },
        spec: { containers: [{ name: "app", image: "registry.invalid/e2e-related:1" }] },
      },
    },
  });
  await page.goto(`/#token=${engineToken}`);
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();
  await page
    .getByRole("complementary", { name: "Resource types" })
    .getByRole("button", { name: /^Deployment \d+$/ })
    .click();
  const list = page.getByRole("tabpanel", { name: "deployments.apps", exact: true });
  await list.getByRole("textbox", { name: "Filter by name" }).fill("e2e-related");
  await list.getByRole("row", { name: new RegExp(`e2e-related ${namespace}`) }).dblclick();
  const deployment = page.getByRole("tabpanel", { name: "e2e-related", exact: true });
  await deployment.getByRole("tab", { name: /^Related/ }).click();
  const tree = deployment.getByRole("treegrid", { name: "Related Resources" });
  await expect(tree.getByRole("row", { name: /^ReplicaSet e2e-related/ })).toBeVisible();
  const pods = tree.getByRole("row", { name: /^Pod e2e-related/ });
  await expect(pods).toHaveCount(1);
  const podName = await pods.first().locator("[title]").first().getAttribute("title");
  expect(podName).toBeTruthy();
  await pods.first().dblclick();
  const pod = page.getByRole("tabpanel", { name: podName!, exact: true });
  await expect(
    page.getByRole("tab", { name: podName!, exact: true }).locator("span").first(),
  ).toHaveCSS("font-style", "normal");
  await expect(pod.getByRole("tab", { name: /^Related/ })).toHaveAttribute("aria-selected", "true");
  const owners = pod.getByRole("treegrid", { name: "Related Resources" });
  await expect(owners.getByRole("columnheader", { name: "Owned by", exact: true })).toBeVisible();
  await expect(owners.getByRole("row", { name: /^Deployment e2e-related/ })).toBeVisible();
  await expect(owners.getByRole("row", { name: /^ReplicaSet e2e-related/ })).toHaveAttribute(
    "aria-level",
    "2",
  );
  await expect(owners.getByRole("row", { name: /^This Pod e2e-related/ })).toHaveAttribute(
    "aria-level",
    "3",
  );
  await page.getByRole("tab", { name: "e2e-related", exact: true }).click();
  await expect(deployment).toBeVisible();
  kubectl("-n", namespace, "scale", "deployment", "e2e-related", "--replicas=2");
  await expect(pods).toHaveCount(2);
  await expect(
    deployment.getByRole("tab", { name: "Related, 3 Resources", exact: true }),
  ).toBeVisible();
});

test("tails Pod and workload Log Streams, holds scrolling, and keeps editor shortcuts scoped", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const name = "e2e-log-counter";
  kubectlCreate({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            {
              name: "counter",
              image: "busybox:1.36",
              command: [
                "sh",
                "-c",
                'i=0; while [ "$i" -lt 400 ]; do echo "counter $i from $HOSTNAME"; i=$((i+1)); done; while true; do echo "counter $i from $HOSTNAME"; i=$((i+1)); sleep 1; done',
              ],
            },
          ],
        },
      },
    },
  });
  kubectl("-n", namespace, "rollout", "status", `deployment/${name}`, "--timeout=60s");
  const podNames = kubectl(
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    `app=${name}`,
    "-o",
    "jsonpath={.items[*].metadata.name}",
  )
    .trim()
    .split(/\s+/);
  expect(podNames).toHaveLength(2);
  await page.goto(`/#token=${engineToken}`);
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();
  await expect(page.getByText(/Kubernetes v\d/)).toBeVisible();
  const open = async (query: string) => {
    await page.keyboard.press("ControlOrMeta+K");
    await page.getByRole("combobox", { name: "Go to Resource" }).fill(`${namespace}/${query}`);
    await expect(
      page.getByRole("option", { name: new RegExp(query.split("/").at(-1)!) }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
  };
  await open(`pod/${podNames[0]}`);
  const pod = page.getByRole("tabpanel", { name: podNames[0]!, exact: true });
  await pod.getByRole("tab", { name: "Logs", exact: true }).click();
  const editor = pod.locator(".monaco-editor:visible");
  await expect(editor.locator(".view-lines")).toContainText(`from ${podNames[0]}`);
  const newest = pod.getByRole("button", { name: /^Newest/ });
  // Lines arriving, fonts loading, and the Pane settling are not the user scrolling away.
  await expect(newest).toBeHidden();
  await editor.hover();
  await page.mouse.wheel(0, -100_000);
  await expect(newest).toBeVisible();
  const firstVisible = () =>
    editor.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll(".view-line")].find((line) => {
        const rect = line.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      })?.textContent;
    });
  const first = await firstVisible();
  expect(first).toBeTruthy();
  await expect(newest).toHaveText(/Newest · [1-9][\d,]* new/);
  expect(await firstVisible()).toBe(first);
  await newest.click();
  await expect(newest).toBeHidden();
  await expect(editor.locator(".view-lines")).not.toContainText("counter 0 from");

  await pod.getByRole("button", { name: "Timestamps" }).click();
  await expect(editor.locator(".view-lines")).toContainText(/\d{2}:\d{2}:\d{2}\.\d{3}/);
  await pod.getByRole("button", { name: "Wrap", exact: true }).click();
  await expect(pod.getByRole("button", { name: "Wrap", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await assertEditorKeys(page, pod, editor);
  // A log is searched from its newest line: Enter goes to the last match first.
  await pod.getByRole("button", { name: "Search" }).click();
  await editor.getByRole("textbox", { name: /^Find$/ }).fill("counter 1");
  await page.keyboard.press("Enter");
  await expect(editor.locator(".matchesCount")).toHaveText(/^(\d+) of \1$/);
  await page.keyboard.press("Enter");
  await expect(editor.locator(".matchesCount")).not.toHaveText(/^(\d+) of \1$/);
  await page.keyboard.press("Escape");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("counter 0 from");
  await expect(newest).toBeVisible();
  await pod.getByRole("tab", { name: "YAML", exact: true }).click();
  await assertEditorKeys(page, pod, pod.locator(".monaco-editor:visible"));
  expect(await unexpectedEditorKeyBindings(page)).toEqual([]);

  await open(`deployment/${name}`);
  const workload = page.getByRole("tabpanel", { name, exact: true });
  await workload.getByRole("tab", { name: "Logs", exact: true }).click();
  for (const podName of podNames) {
    const origin = podName.slice(name.length + 1);
    await expect(workload.locator(".monaco-editor:visible .view-lines")).toContainText(
      new RegExp(`${origin}.*counter`),
    );
  }
});

async function assertEditorKeys(page: Page, panel: Locator, editor: Locator): Promise<void> {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+F");
  const find = editor.getByRole("textbox", { name: /^Find$/ });
  await expect(find).toBeVisible();
  await find.fill("counter");
  await page.keyboard.press("Escape");
  await expect(find).toBeHidden();
  await expect
    .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByRole("combobox", { name: "Go to Resource" });
  await expect(palette).toBeVisible();
  await expect(palette).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await editor.click();
  await page.evaluate(() => {
    const host = window as Window & { logKeyJ?: boolean };
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
        host.logKeyJ = event.defaultPrevented;
        window.removeEventListener("keydown", listener);
      }
    };
    window.addEventListener("keydown", listener);
  });
  await page.keyboard.press("ControlOrMeta+J");
  expect(await page.evaluate(() => (window as Window & { logKeyJ?: boolean }).logKeyJ)).toBe(false);
  await expect(panel).toBeVisible();
  await panel.locator("header").click();
  await expect
    .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
    .toBe(false);
  await page.evaluate(() => {
    const host = window as Window & { logOutsideFind?: boolean };
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        host.logOutsideFind = event.defaultPrevented;
        window.removeEventListener("keydown", listener);
      }
    };
    window.addEventListener("keydown", listener);
  });
  await page.keyboard.press("ControlOrMeta+F");
  expect(
    await page.evaluate(() => (window as Window & { logOutsideFind?: boolean }).logOutsideFind),
  ).toBe(false);
  await expect(find).toBeHidden();
  await page.keyboard.press("Escape");
}

// What an editor may bind: Monaco's own text navigation, find, and the log
// viewer's versions of find. Anything else a Monaco feature brings along has
// to be removed in apps/app/src/lib/monaco.ts.
const allowedEditorCommands =
  /^(cursor\w*|deleteLeft|deleteRight|removeSecondaryCursors|cancelSelection|undo|redo|tab|outdent|lineBreakInsert|scroll(Page|Line)(Up|Down)|editor\.action\.selectAll|editor\.cancelOperation|actions\.find|editor\.action\.(next|previous)MatchFindAction|toggleFind(CaseSensitive|WholeWord|Regex|InSelection)|closeFindWidget|vs\.editor\.ICodeEditor:\d+:hukube\.logs\.\w+)$/;

/** Lists the commands Monaco has a key for that are not allowed one. */
async function unexpectedEditorKeyBindings(page: Page): Promise<string[]> {
  // Monaco has no public list of its key bindings, so this reads the resolver
  // of a live editor's keybinding service. The app's chunks are imported again
  // to reach the module, which gives the instances the page already runs.
  const bound = await page.evaluate(async () => {
    interface Resolver {
      getKeybindings(): {
        command: string | null;
        resolvedKeybinding?: { getUserSettingsLabel(): string | null };
      }[];
    }
    interface Editor {
      _standaloneKeybindingService?: { _getResolver(): Resolver };
    }
    for (const { name } of performance.getEntriesByType("resource")) {
      if (!name.endsWith(".js")) continue;
      const module = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
      for (const value of Object.values(module)) {
        const editors = (
          value as { editor?: { getEditors?: () => Editor[] } } | null
        )?.editor?.getEditors?.();
        // oxlint-disable-next-line no-underscore-dangle -- Monaco's private names.
        const service = editors?.[0]?._standaloneKeybindingService;
        // oxlint-disable-next-line no-underscore-dangle -- Monaco's private names.
        const resolver = service?._getResolver();
        if (resolver)
          return resolver
            .getKeybindings()
            .map(
              (item) =>
                [
                  item.command ?? "",
                  item.resolvedKeybinding?.getUserSettingsLabel() ?? "",
                ] as const,
            );
      }
    }
    return undefined;
  });
  expect(bound, "Monaco's keybinding service was not found").toBeDefined();
  expect(bound!.length).toBeGreaterThan(20);
  return bound!
    .filter(([command]) => !allowedEditorCommands.test(command))
    .map(([command, keys]) => `${command} (${keys})`);
}
