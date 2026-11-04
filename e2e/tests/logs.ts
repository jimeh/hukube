import { writeFile } from "node:fs/promises";
import type { logReplayFixture } from "../log-replay.ts";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

/** Shared web/desktop check against a finite, known line in the retained buffer. */
export async function assertLogFiltering(panel: Locator) {
  const editor = panel.locator(".monaco-editor");
  const instances = await editor.count();
  const filter = panel.getByRole("button", { name: "Filter", exact: true });
  await filter.click();
  const include = panel.getByRole("textbox", { name: "Include text" });
  await include.fill("COUNTER 1 from");
  await expect(panel.getByText(/^1 of [\d,]+ retained lines match$/)).toBeVisible();
  await expect(include).toBeFocused();
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const find = editor.getByRole("textbox", { name: "Find", exact: true });
  await find.fill("counter 0 from");
  await expect(editor.locator(".matchesCount")).toHaveText("No results");
  await find.fill("counter 1 from");
  await expect(editor.locator(".matchesCount")).toHaveText("1 of 1");
  await find.press("Escape");
  await panel.getByRole("button", { name: "Match case", exact: true }).click();
  await expect(panel.getByText("No matching lines", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  expect(await editor.count()).toBe(instances);
  await filter.click();
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  await expect(filter).toContainText("on");
  await expect(panel.getByText(/^0 of [\d,]+ retained lines match$/)).toBeVisible();
  await panel.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(filter).toBeFocused();
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await expect(panel.getByText("No matching lines", { exact: true })).toBeHidden();
  expect(await editor.count()).toBe(instances);
  // Search the restored projection, rather than relying on which rows are on screen.
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await find.fill("counter 0 from");
  await expect(editor.locator(".matchesCount")).toHaveText("1 of 1");
  await find.fill("counter 1 from");
  await expect(editor.locator(".matchesCount")).toHaveText("1 of 1");
  await find.press("Enter");
  await find.press("Escape");

  // Select backwards from the second line's end to the first line's start.
  // Hiding that end must stop before the third line, then Clear must recover it.
  const input = editor.getByRole("textbox", { name: /^Logs of / });
  await input.press("End");
  await input.press("Shift+Home");
  await input.press("Shift+ArrowUp");
  const original = await copiedSelection(editor);
  expect(original).toContain("counter 0 from");
  expect(original).toContain("counter 1 from");
  expect(original).not.toContain("counter 2 from");
  await filter.click();
  await panel.getByRole("textbox", { name: "Exclude text" }).fill("counter 1 from");
  await expect.poll(() => copiedSelection(editor)).not.toContain("counter 1 from");
  const hidden = await copiedSelection(editor);
  expect(hidden).toContain("counter 0 from");
  expect(hidden).not.toContain("counter 2 from");
  await panel.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect.poll(() => copiedSelection(editor)).toBe(original);
}

/** Observe Monaco's copy payload without depending on the Host's OS clipboard. */
async function copiedSelection(editor: Locator) {
  const result = await editor.getByRole("textbox", { name: /^Logs of / }).evaluate((element) => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return { handled: event.defaultPrevented, text: clipboardData.getData("text/plain") };
  });
  expect(result.handled).toBe(true);
  return result.text;
}

/** Real Engine/Monaco regression, shared by the web and Electron Hosts. */
export async function assertPreviousInterruption(
  page: Page,
  fixture: Awaited<ReturnType<typeof logReplayFixture>>,
  info: TestInfo,
  setZoom = async (factor: number) => {
    await page.evaluate((value) => {
      document.documentElement.style.zoom = value === 1 ? "" : String(value);
    }, factor);
  },
) {
  const persist = async (name: string, attachment: { body: string; contentType: string }) => {
    const artifact = info.outputPath(
      `${name}.${attachment.contentType === "application/json" ? "json" : "txt"}`,
    );
    await writeFile(artifact, attachment.body);
    await info.attach(name, { path: artifact, contentType: attachment.contentType });
  };
  const { clusterId } = await import("./env.ts");
  const { openGoToResource } = await import("./exec.ts");
  await page.getByRole("button", { name: /^Back to / }).click();
  await page.getByRole("button", { name: new RegExp(clusterId) }).click();
  await expect(page.getByText(/Kubernetes v\d/)).toBeVisible();
  await openGoToResource(page);
  await page
    .getByRole("combobox", { name: "Go to Resource" })
    .fill(`${fixture.namespace}/pods/${fixture.name}`);
  await page
    .getByRole("option", { name: new RegExp(`^Pod ${fixture.name} ${fixture.namespace}$`) })
    .click();
  const panel = page.getByRole("tabpanel", { name: fixture.name, exact: true });
  await panel.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(panel.locator(".monaco-editor .view-lines")).toContainText("stable current");
  await expect(panel.getByRole("button", { name: "Previous run" })).toBeEnabled();
  await panel.getByRole("button", { name: "Filter", exact: true }).click();
  const include = panel.getByRole("textbox", { name: "Include text" });
  await include.fill("keep");
  await expect(panel.getByText("No matching lines", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Previous run" }).click();
  const editor = panel.locator(".monaco-editor");
  await expect(panel.getByText("3 of 4 retained lines match")).toBeVisible();
  await expect.poll(() => fixture.evidence.heldAt).toBeGreaterThan(0);
  await expect.poll(() => fixture.evidence.upstreamEnded).toBe(true);
  expect(fixture.evidence.requests).toBe(1);
  await expect(panel.getByRole("button", { name: /^Newest/ })).toBeHidden();
  const bounds = await editor.boundingBox();
  expect(bounds).not.toBeNull();
  const logsBounds = await panel.getByRole("tabpanel", { name: "Logs", exact: true }).boundingBox();
  const rowBounds = await editor.locator(".view-line").first().boundingBox();
  expect(logsBounds).not.toBeNull();
  expect(rowBounds).not.toBeNull();
  // Force a real overflow despite the new editor reservation: six row heights
  // for controls plus the editor cannot display all four model rows at once.
  await page.setViewportSize({
    width: 1440,
    height: Math.ceil(900 - logsBounds!.height + rowBounds!.height * 6),
  });
  await expect.poll(async () => (await monacoSnapshot(editor)).scrollTop).toBeGreaterThan(0);
  await editor.hover();
  await page.mouse.wheel(0, -1000);
  await expect(panel.getByRole("button", { name: /^Newest/ })).toBeVisible();
  await expect.poll(async () => (await monacoSnapshot(editor)).scrollTop).toBe(0);
  const before = await monacoSnapshot(editor);
  expect(before.text).toBe("keep original 1\nkeep original 3\nkeep original 4\n");
  const input = editor.getByRole("textbox", { name: /^Logs of / });
  await input.focus();
  await input.press("ControlOrMeta+A");
  expect(await copiedSelection(editor)).toBe(before.text);
  const hiddenAt = Date.now();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("link", { name: "Log Streams", exact: true }).click();
  const settings = page.getByRole("region", { name: "Log Streams", exact: true });
  const limit = settings.getByLabel("Maximum retained lines", { exact: true });
  await limit.fill("2");
  await limit.press("Enter");
  await expect(settings.locator(":scope > output")).toHaveText("Saved");
  await limit.fill("8");
  await limit.press("Enter");
  await expect(settings.locator(":scope > output")).toHaveText("Saved");
  // The actual product timer is an elapsed-time integration boundary, observed at response close.
  await expect.poll(() => fixture.evidence.closedAt, { timeout: 25_000 }).toBeGreaterThan(0);
  expect(fixture.evidence.closedAt - hiddenAt).toBeGreaterThanOrEqual(10_000);
  await page.getByRole("button", { name: /^Back to / }).click();
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  const stopped = panel.getByText(
    "The Log Stream stopped: reading the previous run was interrupted, so its lines may be incomplete. Try again starts a fresh read and replaces retained lines.",
  );
  await expect(stopped).toBeVisible();
  await expect(panel.getByText("2 of 2 retained lines match")).toBeVisible();
  const retained = "keep original 3\nkeep original 4\n";
  expect(await copiedSelection(editor)).toBe(retained);
  expect(await monacoSnapshot(editor)).toMatchObject({
    model: before.model,
    text: retained,
    selection: retained,
    scrollTop: 0,
  });
  expect(fixture.evidence.requests).toBe(1);
  expect(fixture.evidence.withheld).toBe(1);
  expect(fixture.evidence.errors).toEqual([]);
  await persist("previous-held-boundary", {
    body: JSON.stringify(
      {
        ...fixture.evidence,
        namespace: fixture.namespace,
        scratch: fixture.scratch,
        hiddenAt,
        before,
        retained,
        after: await monacoSnapshot(editor),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  // Keep Find and the EOF selection open at the exact constrained-height regression.
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const layoutFind = editor.getByRole("textbox", { name: "Find", exact: true });
  await layoutFind.fill("original");
  await expect(editor.locator(".matchesCount")).toHaveText(/\d of 2/);
  await input.focus();
  await input.press("ControlOrMeta+A");
  try {
    await setZoom(2);
    const layout = await assertLogLayout(panel, true, info);
    await persist("previous-layout-200-percent", {
      body: JSON.stringify(layout, null, 2),
      contentType: "application/json",
    });
    expect(await copiedSelection(editor)).toBe(retained);
    expect(await monacoSnapshot(editor)).toMatchObject({ model: before.model, text: retained });
    expect(fixture.evidence.requests).toBe(1);
    await page.screenshot({ path: info.outputPath("previous-expanded-find-200-percent.png") });
  } finally {
    // Preference cleanup must remain reachable even when the zoom regression fails.
    await setZoom(1);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await panel.getByRole("button", { name: "Dismiss retention notice" }).click();
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const find = editor.getByRole("textbox", { name: "Find", exact: true });
  await find.fill("keep original");
  await expect(editor.locator(".matchesCount")).toHaveText(/\d of 2/);
  await find.fill("withheld");
  await expect(editor.locator(".matchesCount")).toHaveText("No results");
  await find.press("Escape");
  await include.fill("missing");
  await expect(panel.getByText("No matching lines", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Clear filters", exact: true }).first().click();
  expect((await monacoSnapshot(editor)).text).toBe(retained);
  await include.fill("keep");
  await expect(panel.getByText("2 of 2 retained lines match")).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    await expect(
      page.getByRole("region", { name: "Appearance", exact: true }).locator(":scope > output"),
    ).toHaveText("Saved");
    await page.getByRole("button", { name: /^Back to / }).click();
    for (const width of [1440, 320]) {
      // The canonical 240px Resource sidebar remains visible; width names the log content.
      await page.setViewportSize({ width: width === 320 ? 560 : width, height: 900 });
      await expect(stopped).toBeVisible();
      await assertLogLayout(panel, false, info);
      const retry = panel.getByRole("button", { name: "Try again", exact: true });
      await retry.focus();
      await expect(retry).toBeFocused();
      expect((await monacoSnapshot(editor)).text).toBe(retained);
      expect(fixture.evidence.requests).toBe(1);
      await page.screenshot({ path: info.outputPath(`previous-incomplete-${theme}-${width}.png`) });
      await persist(`previous-incomplete-${theme}-${width}-ax`, {
        body: await panel.ariaSnapshot(),
        contentType: "text/plain",
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Electron supplies native webContents zoom; web exercises CSS zoom.
  for (const theme of ["light", "dark"] as const) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    await expect(
      page.getByRole("region", { name: "Appearance", exact: true }).locator(":scope > output"),
    ).toHaveText("Saved");
    await page.getByRole("button", { name: /^Back to / }).click();
    try {
      for (const factor of [1.25, 2]) {
        await setZoom(factor);
        await expect(stopped).toBeVisible();
        await assertLogLayout(panel, false, info);
        await page.screenshot({
          path: info.outputPath(`previous-incomplete-${theme}-zoom-${factor}.png`),
        });
        await persist(`previous-incomplete-${theme}-zoom-${factor}-ax`, {
          body: await panel.ariaSnapshot(),
          contentType: "text/plain",
        });
      }
    } finally {
      await setZoom(1);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  }
  expect(fixture.evidence.requests).toBe(1);
  await panel.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(panel.locator(".monaco-editor .view-lines")).toContainText(
    "exited: Error, exit code 1",
  );
  await expect(stopped).toBeHidden();
  expect(fixture.evidence.requests).toBe(2);
  await expect(include).toHaveValue("keep");
  await expect(panel.getByText("4 of 5 retained lines match")).toBeVisible();
  const freshEditor = panel.locator(".monaco-editor");
  await expect(panel.getByRole("button", { name: /^Newest/ })).toBeHidden();
  const fresh = await monacoSnapshot(freshEditor);
  expect(fresh.model).not.toBe(before.model);
  expect(fresh.text).toBe(
    "keep original 1\nkeep original 3\nkeep original 4\nkeep withheld 5\n··· the container exited: Error, exit code 1 ···\n",
  );
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /^Back to / }).click();
  await expect(stopped).toBeHidden();
  expect(fixture.evidence.requests).toBe(2);
  await page.screenshot({ path: info.outputPath("previous-completed-dark-wide.png") });
  fixture.holdNextEmpty();
  await panel.getByRole("button", { name: "Previous run" }).click();
  await panel.getByRole("button", { name: "Previous run" }).click();
  await expect.poll(() => fixture.evidence.requests).toBe(3);
  await expect.poll(() => fixture.evidence.upstreamEnded).toBe(true);
  expect(fixture.evidence.forwarded).toBe(0);
  const emptyHiddenAt = Date.now();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect.poll(() => fixture.evidence.closedAt, { timeout: 25_000 }).toBeGreaterThan(0);
  expect(fixture.evidence.closedAt - emptyHiddenAt).toBeGreaterThanOrEqual(10_000);
  await page.getByRole("button", { name: /^Back to / }).click();
  await expect(panel.getByText("Log Stream stopped", { exact: true })).toBeVisible();
  const emptyDescription = panel.getByText(
    "Reading the previous run was interrupted, so its lines may be incomplete. Try again starts a fresh read and replaces retained lines.",
    { exact: true },
  );
  await expect(emptyDescription).toBeVisible();
  await expect(panel.getByText("No matching lines", { exact: true })).toBeHidden();
  await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(panel.locator(".monaco-editor")).toHaveCount(0);
  expect(fixture.evidence.requests).toBe(3);
  for (const theme of ["dark", "light"] as const) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    await expect(
      page.getByRole("region", { name: "Appearance", exact: true }).locator(":scope > output"),
    ).toHaveText("Saved");
    await page.getByRole("button", { name: /^Back to / }).click();
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width: width === 320 ? 560 : width, height: 900 });
      await expect(emptyDescription).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`previous-empty-error-${theme}-${width}.png`),
      });
      await persist(`previous-empty-error-${theme}-${width}-ax`, {
        body: await panel.ariaSnapshot(),
        contentType: "text/plain",
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await persist("previous-empty-boundary", {
    body: JSON.stringify({ ...fixture.evidence, emptyHiddenAt }, null, 2),
    contentType: "application/json",
  });
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(panel.locator(".monaco-editor .view-lines")).toContainText(
    "exited: Error, exit code 1",
  );
  expect(fixture.evidence.requests).toBe(4);
  await persist("previous-replay-boundary", {
    body: JSON.stringify({ ...fixture.evidence, hiddenAt, before, retained, fresh }, null, 2),
    contentType: "application/json",
  });
}

/** Real geometry, native scrolling and focus at the constrained Log Stream height. */
async function assertLogLayout(panel: Locator, findOpen: boolean, info: TestInfo) {
  const editor = panel.locator(".monaco-editor");
  const layout = () =>
    editor.evaluate((element, expectsFind) => {
      const box = element.getBoundingClientRect();
      const line = element.querySelector(".view-line")?.getBoundingClientRect();
      const find = element.querySelector(".find-widget")?.getBoundingClientRect();
      const paneElement = element.closest('[role="tabpanel"]')!;
      const pane = paneElement.getBoundingClientRect();
      // The browser evaluation is serialized without its surrounding scope.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const measure = (node: Element) => {
        const html = node as HTMLElement;
        const style = getComputedStyle(node);
        return {
          tag: node.tagName,
          class: node.className,
          role: node.getAttribute("role"),
          box: node.getBoundingClientRect().toJSON(),
          clientTop: html.clientTop,
          clientLeft: html.clientLeft,
          clientHeight: html.clientHeight,
          scrollHeight: html.scrollHeight,
          scrollTop: html.scrollTop,
          clientWidth: html.clientWidth,
          scrollWidth: html.scrollWidth,
          scrollLeft: html.scrollLeft,
          overflow: style.overflow,
          height: style.height,
          minHeight: style.minHeight,
          flex: style.flex,
        };
      };
      const controls = paneElement.querySelector('[aria-label="Log Stream controls and notices"]');
      return {
        // Space for two payload rows plus EOF, alongside the existing Find widget.
        readable:
          !!line &&
          line.height > 0 &&
          line.width > 0 &&
          (!expectsFind || (!!find && find.height > 0 && find.width > 0)) &&
          box.height >= line.height * 3 + (expectsFind ? find!.height : 0),
        contained:
          box.top >= Math.max(pane.top, 0) &&
          box.bottom <= Math.min(pane.bottom, innerHeight) &&
          box.left >= Math.max(pane.left, 0) &&
          box.right <= Math.min(pane.right, innerWidth),
        sampledAt: Date.now(),
        viewport: { width: innerWidth, height: innerHeight },
        violations: {
          top: Math.max(pane.top, 0) - box.top,
          bottom: box.bottom - Math.min(pane.bottom, innerHeight),
          left: Math.max(pane.left, 0) - box.left,
          right: box.right - Math.min(pane.right, innerWidth),
        },
        editor: box.toJSON(),
        rowHeight: line?.height,
        findHeight: find?.height,
        line: line?.toJSON(),
        find: find?.toJSON(),
        controls: controls && measure(controls),
        pane: pane.toJSON(),
        // Preserve failed geometry too: a boolean alone cannot identify the overflow boundary.
        devicePixelRatio,
        visualViewport: visualViewport && {
          width: visualViewport.width,
          height: visualViewport.height,
          scale: visualViewport.scale,
          offsetTop: visualViewport.offsetTop,
          offsetLeft: visualViewport.offsetLeft,
        },
        ancestors: (() => {
          const result = [];
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            result.push(measure(ancestor));
          }
          return result;
        })(),
      };
    }, findOpen);
  const samples: Awaited<ReturnType<typeof layout>>[] = [];
  try {
    await expect
      .poll(async () => {
        const sample = await layout();
        samples.push(sample);
        return sample;
      })
      .toMatchObject({ readable: true, contained: true });
  } catch (error) {
    // Keep the assertion error even if the page also fails while collecting diagnostics.
    try {
      await info.attach("previous-layout-failure", {
        body: Buffer.from(
          JSON.stringify({ samples, monaco: await monacoSnapshot(editor) }, null, 2),
        ),
        contentType: "application/json",
      });
      await panel.page().screenshot({ path: info.outputPath("previous-layout-failure.png") });
    } catch (diagnosticError) {
      console.warn("Could not save Previous layout diagnostics", diagnosticError);
    }
    throw error;
  }
  const controls = panel.getByRole("region", {
    name: "Log Stream controls and notices",
    exact: true,
  });
  const outsideScroll = () =>
    controls.evaluate((element) => {
      const result: number[] = [];
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement)
        result.push(ancestor.scrollTop);
      return result;
    });
  const originalScroll = await outsideScroll();
  for (const control of [
    controls.getByRole("textbox", { name: "Include text", exact: true }),
    controls.getByRole("textbox", { name: "Exclude text", exact: true }),
    controls.getByRole("button", { name: "Match case", exact: true }),
    controls.getByRole("button", { name: "Clear filters", exact: true }),
    controls.getByRole("button", { name: "Try again", exact: true }),
    controls.getByRole("button", { name: "Dismiss retention notice", exact: true }),
  ]) {
    if (!(await control.count())) continue;
    await control.focus();
    await expect(control).toBeFocused();
    await expect
      .poll(() =>
        control.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const region = element
            .closest('[aria-label="Log Stream controls and notices"]')!
            .getBoundingClientRect();
          return bounds.top >= region.top && bounds.bottom <= region.bottom;
        }),
      )
      .toBe(true);
  }
  if (await controls.evaluate((element) => element.scrollHeight > element.clientHeight)) {
    // Focusing the last action established a real scroll boundary, not a negative blank check.
    await expect.poll(() => controls.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await controls.hover();
    await panel.page().mouse.wheel(0, -1000);
    await expect.poll(() => controls.evaluate((element) => element.scrollTop)).toBe(0);
    await controls.focus();
    await controls.press("End");
    await expect.poll(() => controls.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await controls.press("Home");
    await expect.poll(() => controls.evaluate((element) => element.scrollTop)).toBe(0);
  }
  expect(await outsideScroll()).toEqual(originalScroll);
  return layout();
}

/** Inspect the actual editor/model through Monaco's public API, including EOF selection. */
async function monacoSnapshot(editor: Locator) {
  return editor.evaluate(async (element) => {
    interface Model {
      uri: { toString(): string };
      getValue(): string;
      getValueInRange(range: unknown): string;
    }
    interface Editor {
      getDomNode(): HTMLElement | null;
      getModel(): Model | null;
      getSelection(): unknown;
      getScrollTop(): number;
      getLayoutInfo(): unknown;
      getContainerDomNode(): HTMLElement;
    }
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    // Electron's custom scheme does not populate resource timing. Resolve the
    // already built Monaco module from the entry script's dependency map.
    for (const entryScript of [...document.scripts].filter((script) => script.src)) {
      const code = await fetch(entryScript.src).then((response) => response.text());
      for (const match of code.matchAll(/assets\/monaco-[\w-]+\.js/g))
        resources.push(new URL(`/${match[0]}`, document.baseURI).href);
    }
    for (const name of new Set(resources)) {
      if (!name.endsWith(".js")) continue;
      const module = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
      for (const value of Object.values(module)) {
        const editors = (
          value as { editor?: { getEditors?: () => Editor[] } } | null
        )?.editor?.getEditors?.();
        const found = editors?.find((candidate) => candidate.getDomNode() === element);
        const model = found?.getModel();
        if (found && model)
          return {
            model: model.uri.toString(),
            text: model.getValue(),
            selection: model.getValueInRange(found.getSelection()),
            scrollTop: found.getScrollTop(),
            layout: found.getLayoutInfo(),
            container: found.getContainerDomNode().getBoundingClientRect().toJSON(),
          };
      }
    }
    throw new Error("Real Monaco editor not found");
  });
}
