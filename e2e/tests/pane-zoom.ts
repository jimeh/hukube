import { expect, type Locator, type Page } from "@playwright/test";
import { clusterId, kubectl, kubectlCreate } from "./env.ts";
import { openGoToResource } from "./exec.ts";

const resourceNames = [
  "zoom-draft",
  "zoom-preview",
  "zoom-long-title-with-many-characters",
] as const;
export const zoomPod = "zoom-session";

/** Called only inside leased E2E tests, never by collection or static checks. */
export function createPaneZoomResources(namespace: string) {
  for (const name of resourceNames)
    kubectlCreate({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { namespace, name },
      data: { greeting: "hello" },
    });
  kubectlCreate({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { namespace, name: zoomPod },
    spec: {
      containers: [
        {
          name: "app",
          image: "busybox:1.36",
          command: ["sh", "-c", "i=0; while true; do echo zoom-log-$i; i=$((i+1)); sleep 1; done"],
        },
      ],
    },
  });
  kubectl("-n", namespace, "wait", "--for=condition=Ready", `pod/${zoomPod}`, "--timeout=60s");
}

type StoredDock = {
  grid: { maximizedNode?: unknown };
  panels: Record<string, { title?: string; params?: { uri?: string } }>;
};
type Wire = {
  id?: number;
  type?: string;
  method?: string;
  params?: Record<string, unknown>;
  cols?: number;
  rows?: number;
  data?: unknown;
  event?: unknown;
};

/** Attach before navigation/reload. A matching result, not a sent frame, is the save boundary. */
export function observePaneZoom(page: Page) {
  const saved: StoredDock[] = [];
  const control: Wire[] = [];
  const streams: {
    method?: string;
    params?: Record<string, unknown>;
    sent: Wire[];
    received: Wire[];
    closed: boolean;
  }[] = [];
  page.on("websocket", (socket) => {
    const pending = new Map<number, StoredDock>();
    const stream = {
      sent: [] as Wire[],
      received: [] as Wire[],
      closed: false,
    } as (typeof streams)[number];
    if (socket.url().endsWith("/ws/stream")) streams.push(stream);
    socket.on("close", () => {
      stream.closed = true;
    });
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload) as Wire;
      if (socket.url().endsWith("/ws")) {
        control.push(frame);
        if (frame.method === "settings.put" && frame.params?.["key"] === `workspace/${clusterId}`) {
          const value = frame.params["value"] as { dockview: StoredDock };
          pending.set(frame.id!, value.dockview);
        }
      } else {
        stream.sent.push(frame);
        if (frame.type === "open")
          Object.assign(stream, { method: frame.method, params: frame.params });
      }
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload) as Wire;
      if (socket.url().endsWith("/ws")) {
        if (frame.type === "result" && pending.has(frame.id!)) {
          saved.push(pending.get(frame.id!)!);
          pending.delete(frame.id!);
        }
      } else stream.received.push(frame);
    });
  });
  return {
    saved,
    control,
    streams,
    nextSave: async (after: number, contains?: string) => {
      await expect
        .poll(
          () =>
            saved
              .slice(after)
              .some((layout) => !contains || JSON.stringify(layout).includes(contains)),
          { message: "normal Workspace layout acknowledged by Engine" },
        )
        .toBe(true);
      for (const layout of saved.slice(after))
        expect(layout.grid).not.toHaveProperty("maximizedNode");
    },
  };
}

function tab(page: Page, title: string) {
  return page.locator(".dv-tab").filter({
    has: page.getByRole("button", { name: `Close ${title}`, exact: true, includeHidden: true }),
  });
}
function pane(page: Page, title: string) {
  return page.locator(".dv-groupview").filter({ has: tab(page, title) });
}
async function go(page: Page, namespace: string, type: string, name: string) {
  await openGoToResource(page);
  await page.getByRole("combobox", { name: "Go to Resource" }).fill(`${namespace}/${type}/${name}`);
  await page.getByRole("option", { name: new RegExp(` ${name} ${namespace}$`) }).click();
}

/** Reach the actual control using document order, without a synthetic focus jump. */
async function tabToZoom(page: Page, target: Locator) {
  for (let index = 0; index < 100; index++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(
    `Tab order did not reach the Pane toggle; focused: ${await page.evaluate(() => document.activeElement?.outerHTML)}`,
  );
}

async function assertVisibleFocus(page: Page) {
  expect(
    await page.evaluate(() => {
      const focus = document.activeElement;
      return !!focus && !focus.closest("[hidden], [inert]") && focus.getClientRects().length > 0;
    }),
  ).toBe(true);
}

/** Traverse a complete keyboard cycle, checking the mounted hidden subtree and AX tree. */
async function assertHiddenPaneExcluded(page: Page, hidden: Locator, restore: Locator) {
  await expect(hidden).toHaveCount(1);
  expect(await hidden.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);
  await expect(restore).toBeFocused();
  const visited = new Set<string>();
  let cycled = false;
  for (let index = 0; index < 160; index++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const group = element.closest(".dv-groupview");
      return {
        hidden:
          !!group && (group.getBoundingClientRect().width === 0 || !!group.closest("[inert]")),
        label: element.outerHTML,
      };
    });
    expect(focus.hidden, `Tab reached hidden Pane: ${focus.label}`).toBe(false);
    visited.add(focus.label);
    if (await restore.evaluate((element) => element === document.activeElement)) {
      cycled = true;
      break;
    }
  }
  expect(cycled, "Tab must complete a cycle back to Restore Panes").toBe(true);
  expect(visited.size, "Tab must traverse meaningful visible app controls").toBeGreaterThan(5);
  // Playwright's DOM-derived ariaSnapshot includes inert descendants when the
  // snapshot root is inside them. Inspect Chromium's native AX tree instead.
  const session = await page.context().newCDPSession(page);
  try {
    const index = await hidden.evaluate((element) =>
      Array.from(document.querySelectorAll(".dv-groupview")).indexOf(element),
    );
    const { root } = await session.send("DOM.getDocument");
    const { nodeIds } = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: ".dv-groupview",
    });
    const { nodes } = await session.send("Accessibility.getPartialAXTree", {
      nodeId: nodeIds[index],
      fetchRelatives: false,
    });
    expect(nodes[0]?.ignored, "Chromium must exclude the hidden Pane from its native AX tree").toBe(
      true,
    );
    expect(
      nodes[0]?.ignoredReasons?.some(
        ({ name }) => name === "inertElement" || name === "inertSubtree",
      ),
    ).toBe(true);
  } finally {
    await session.detach();
  }
}

/** Retain real public Monaco objects to detect reconstruction as well as lost draft/selection. */
async function captureDraft(page: Page, editor: Locator) {
  const element = await editor.elementHandle();
  return page.evaluateHandle(async (dom) => {
    interface Model {
      getValue(): string;
      getValueInRange(range: unknown): string;
    }
    interface Editor {
      getDomNode(): HTMLElement;
      getModel(): Model;
      getSelection(): { toString(): string } | null;
    }
    // Custom-scheme Electron resources may not appear in Performance entries.
    const scripts = document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
      'script[src], link[rel="modulepreload"]',
    );
    const urls = new Set([
      ...performance.getEntriesByType("resource").map(({ name }) => name),
      ...Array.from(scripts, (node) => ("src" in node ? node.src : node.href)),
    ]);
    for (const name of urls) {
      if (!name.endsWith(".js")) continue;
      const module = (await import(/* @vite-ignore */ name)) as Record<
        string,
        { editor?: { getEditors?: () => Editor[] } }
      >;
      for (const value of Object.values(module)) {
        const live = value?.editor
          ?.getEditors?.()
          .find((candidate) => candidate.getDomNode() === dom);
        if (live)
          return {
            editor: live,
            model: live.getModel(),
            value: live.getModel().getValue(),
            selection: live.getSelection()?.toString(),
          };
      }
    }
    throw new Error("The Resource's Monaco editor was not found");
  }, element);
}

export async function paneZoomResourceScenario(
  page: Page,
  namespace: string,
  wire: ReturnType<typeof observePaneZoom>,
) {
  const sidebar = page.getByRole("complementary", { name: "Resource types" });
  await sidebar.getByRole("button", { name: /^ConfigMap \d+$/ }).click();
  const list = page.getByRole("tabpanel", { name: "configmaps", exact: true });
  await list.getByRole("textbox", { name: "Filter by name" }).fill("zoom-");
  const row = (name: string) => list.getByRole("row", { name: new RegExp(`${name} ${namespace}`) });
  await row(resourceNames[0]).click();
  const draft = page.getByRole("tabpanel", { name: resourceNames[0], exact: true });
  await draft.getByRole("tab", { name: "YAML", exact: true }).click();
  await draft.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = draft.locator(".monaco-editor:visible");
  await editor.getByRole("textbox", { name: "Resource YAML" }).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n# zoom draft retained");
  await page.keyboard.press("Shift+Home");
  const retained = await captureDraft(page, editor);
  const right = pane(page, resourceNames[0]);
  const header = right.locator(".dv-tabs-and-actions-container");
  const height = (await header.boundingBox())!.height;
  // A hidden Resource must keep its draft/model while its header and edit actions
  // are excluded from both native Tab traversal and the accessibility tree.
  const listPane = pane(page, "configmaps");
  await listPane.getByRole("button", { name: "Zoom Pane" }).click();
  await assertHiddenPaneExcluded(
    page,
    right,
    listPane.getByRole("button", { name: "Restore Panes" }),
  );
  await go(page, namespace, "configmaps", resourceNames[0]);
  await expect(page.getByRole("button", { name: "Restore Panes" })).toHaveCount(0);
  await expect(draft).toBeVisible();
  await assertVisibleFocus(page);
  await tabToZoom(page, right.getByRole("button", { name: "Zoom Pane" }));
  await expect(right.getByRole("button", { name: "Zoom Pane" })).toBeFocused();
  const zoom = right.getByRole("button", { name: "Zoom Pane" });
  await zoom.click();
  const restore = right.getByRole("button", { name: "Restore Panes" });
  await expect(restore).toBeFocused();
  await expect(restore).toHaveAttribute("aria-pressed", "true");
  await expect(list).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Clusters" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(restore).toBeVisible();
  await expect(header).toHaveJSProperty("clientHeight", height);
  // Light/dark and a genuinely narrow dock. Restore must remain outside Tab overflow.
  for (const theme of ["light", "dark"] as const) {
    const toggle = page.getByRole("button", { name: `Switch to ${theme} mode` });
    if (await toggle.count()) await toggle.click();
    for (const width of [1024, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(async () => {
          const box = (await restore.boundingBox())!;
          return box.x + box.width;
        })
        .toBeLessThanOrEqual(width);
      const bounds = (await restore.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(24);
      expect(bounds.height).toBeGreaterThanOrEqual(24);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await restore.focus();
      await page.keyboard.press("Space");
      await expect(zoom).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(restore).toBeFocused();
      expect(await restore.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      expect(await restore.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
        "none",
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(
    await retained.evaluate(({ editor: live, model, value, selection }) => ({
      same: live.getModel() === model,
      draft: live.getModel().getValue() === value,
      selection: live.getSelection()?.toString() === selection,
    })),
  ).toEqual({ same: true, draft: true, selection: true });
  await retained.dispose();
  // Close guards must cancel without losing either zoom or the draft.
  await right.getByRole("button", { name: `Close ${resourceNames[0]}`, exact: true }).click();
  const guard = page.getByRole("alertdialog", { name: /Discard your edits/ });
  await guard.getByRole("button", { name: "Keep editing" }).click();
  await expect(restore).toBeVisible();
  await expect(editor.locator(".view-lines")).toContainText("zoom draft retained");
  await restore.click();
  await row(resourceNames[1]).click();
  const preview = tab(page, resourceNames[1]);
  await expect(preview.locator(".italic")).toHaveCount(1);
  await preview.dblclick();
  await expect(preview.locator(".italic")).toHaveCount(0);
  await row(resourceNames[2]).click();
  await expect(preview).toBeVisible();
  await expect(tab(page, resourceNames[0]).getByLabel("Unsaved edits")).toBeVisible();
  await right.getByRole("button", { name: "Zoom Pane" }).click();
  await page.setViewportSize({ width: 540, height: 900 });
  const narrowRestore = right.getByRole("button", { name: "Restore Panes" });
  await expect
    .poll(async () => {
      const box = (await narrowRestore.boundingBox())!;
      return box.x + box.width;
    })
    .toBeLessThanOrEqual(540);
  const narrowBounds = (await narrowRestore.boundingBox())!;
  expect(narrowBounds.x + narrowBounds.width).toBeLessThanOrEqual(540);
  expect(narrowBounds.width).toBeGreaterThanOrEqual(24);
  await expect(header).toHaveJSProperty("clientHeight", height);
  await page.setViewportSize({ width: 1440, height: 900 });
  await preview.click();
  await expect(right.getByRole("button", { name: "Restore Panes" })).toBeVisible();
  // Reorder by a real drag. Splitting a Tab off accepts the native exit.
  const firstTab = tab(page, resourceNames[0]);
  const firstTabBounds = (await firstTab.boundingBox())!;
  await preview.dragTo(firstTab, {
    targetPosition: { x: firstTabBounds.width / 2, y: firstTabBounds.height / 2 },
  });
  await expect(right.getByRole("button", { name: "Restore Panes" })).toBeVisible();
  const content = right.locator(".dv-content-container");
  const box = (await content.boundingBox())!;
  await preview.dragTo(content, { targetPosition: { x: box.width / 2, y: box.height - 10 } });
  await expect(page.getByRole("button", { name: "Restore Panes" })).toHaveCount(0);
  await expect(page.locator(".dv-groupview:visible")).toHaveCount(3);
  await pane(page, resourceNames[0]).getByRole("button", { name: "Zoom Pane" }).click();
  await go(page, namespace, "configmaps", resourceNames[1]);
  await expect(page.getByRole("button", { name: "Restore Panes" })).toHaveCount(0);
  await expect(page.getByRole("tabpanel", { name: resourceNames[1], exact: true })).toBeVisible();
  await assertVisibleFocus(page);
  await pane(page, resourceNames[0]).getByRole("button", { name: "Zoom Pane" }).click();
  // Mounted Workspace retention while the picker and Settings dialog are used.
  await page.getByLabel("Open a cluster", { exact: true }).click();
  await page.getByRole("link", { name: clusterId, exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore Panes" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Overview definitions" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Restore Panes" })).toBeVisible();
  // Discard only this test's draft, then non-last and last closes use native state.
  await pane(page, resourceNames[0])
    .getByRole("button", { name: `Close ${resourceNames[0]}`, exact: true })
    .click();
  await guard.getByRole("button", { name: "Discard edits" }).click();
  await expect(
    pane(page, resourceNames[2]).getByRole("button", { name: "Restore Panes" }),
  ).toBeVisible();
  const after = wire.saved.length;
  await page.getByRole("button", { name: `Close ${resourceNames[2]}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore Panes" })).toHaveCount(0);
  await wire.nextSave(after, resourceNames[1]);
  const zoomSave = wire.saved.length;
  await pane(page, resourceNames[1]).getByRole("button", { name: "Zoom Pane" }).click();
  await wire.nextSave(zoomSave, resourceNames[1]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Restore Panes" })).toHaveCount(0);
  await expect(page.locator(".dv-groupview:visible")).toHaveCount(2);
}

export async function paneZoomExecScenario(
  page: Page,
  namespace: string,
  wire: ReturnType<typeof observePaneZoom>,
) {
  await page
    .getByRole("complementary", { name: "Resource types" })
    .getByRole("button", { name: /^Pod \d+$/ })
    .click();
  const list = page.getByRole("tabpanel", { name: "pods", exact: true });
  await list.getByRole("textbox", { name: "Filter by name" }).fill(zoomPod);
  await list.getByRole("row", { name: new RegExp(`${zoomPod} ${namespace}`) }).click();
  const pod = page.getByRole("tabpanel", { name: zoomPod, exact: true });
  await pod.getByRole("tab", { name: "Logs", exact: true }).click();
  // Keep this observation Tab when a later sidebar click opens another preview.
  await tab(page, zoomPod).dblclick();
  await expect(pod.locator(".monaco-editor:visible .view-lines")).toContainText("zoom-log-");
  await pod.getByRole("button", { name: "Open an Exec Session", exact: true }).click();
  const session = page.getByRole("tabpanel", { name: `app in ${zoomPod}`, exact: true });
  const input = session.getByRole("textbox", { name: `Exec Session in app of ${zoomPod}` });
  const screen = session.locator(".xterm-rows");
  await expect(screen).toContainText("/ #");
  const title = `app in ${zoomPod}`;
  // Put live Logs in the peer Pane. Zoom, rather than a Tab change, hides them below.
  await tab(page, zoomPod).dragTo(tab(page, "pods"));
  await expect(pod).toBeVisible();
  await expect(session).toBeVisible();
  await tab(page, title).click();
  await go(page, namespace, "configmaps", resourceNames[1]);
  await tab(page, title).click();
  const logEditor = pod.locator(".monaco-editor:visible");
  const logSelection = await captureDraft(page, logEditor);
  const selectedLogText = () =>
    logSelection.evaluate(({ editor, model }) => model.getValueInRange(editor.getSelection()));
  await logEditor.getByRole("textbox").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await expect.poll(selectedLogText).toContain("zoom-log-");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(selectedLogText).toBe("");
  for (let character = 0; character < 10; character++) {
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(selectedLogText).toHaveLength(character + 1);
  }
  await logSelection.dispose();
  const logModel = await captureDraft(page, logEditor);
  expect(
    await logModel.evaluate(({ editor, model }) => model.getValueInRange(editor.getSelection())),
  ).toMatch(/zoom-log-\d/);
  const originalLog = wire.streams
    .filter((stream) => stream.method === "resource.logs" && stream.params?.["name"] === zoomPod)
    .at(-1)!;
  expect(originalLog.closed).toBe(false);
  const logOpens = wire.streams.filter((stream) => stream.method === "resource.logs").length;
  // Only warm-up may retry: the test command below is sent exactly once.
  await expect(async () => {
    await input.focus();
    await input.pressSequentially("stty -echo; ZOOM_COUNT=0; printf 'zoom-%s-ready\\n' warmup");
    await input.press("Enter");
    await expect(screen).toContainText("zoom-warmup-ready", { timeout: 3000 });
  }).toPass();
  const terminal = await session.locator(".xterm").elementHandle();
  const right = pane(page, title);
  const ownStream = wire.streams.find(
    (stream) => stream.method === "pod.exec" && stream.params?.["pod"] === zoomPod,
  )!;
  expect(ownStream).toBeDefined();
  const sessionId = ownStream.params?.["session"];
  const opened = wire.streams.filter((stream) => stream.method === "pod.exec").length;
  const ends = wire.control.filter((frame) => frame.method === "exec.end").length;
  const received = ownStream.received.length;
  const tag = `zoom-${Date.now().toString(36)}`;
  await input.pressSequentially(`ZOOM_COUNT=$((ZOOM_COUNT+1)); printf '\\n%s-%s\\n' '${tag}`);
  // Find is the existing keyboard route out of a live terminal. Tab remains terminal input.
  const mac = await page.evaluate(() => navigator.platform.toLowerCase().includes("mac"));
  await input.press(mac ? "Meta+f" : "Control+Shift+f");
  await expect(session.getByRole("textbox", { name: "Find", exact: true })).toBeFocused();
  await tabToZoom(page, right.getByRole("button", { name: "Zoom Pane" }));
  const after = wire.saved.length;
  const resized = ownStream.sent.filter((frame) => frame.type === "resize").length;
  await page.keyboard.press("Enter");
  await expect(right.getByRole("button", { name: "Restore Panes" })).toBeFocused();
  await wire.nextSave(after, title);
  await expect
    .poll(() => ownStream.sent.filter((frame) => frame.type === "resize").length)
    .toBeGreaterThan(resized);
  // Native serialization and its intermediate dimensions must not become server resizes.
  const zoomSizes = ownStream.sent.filter((frame) => frame.type === "resize").slice(resized);
  expect(zoomSizes).toHaveLength(1);
  for (const size of zoomSizes) {
    expect(size.cols).toBeGreaterThan(1);
    expect(size.rows).toBeGreaterThan(1);
  }
  await input.focus();
  await input.pressSequentially(`' "$ZOOM_COUNT"; printf 'boundary-%s\\n' '${tag}'`);
  await input.press("Enter");
  await expect(screen).toContainText(`boundary-${tag}`);
  const lines = await screen.locator(":scope > div").allTextContents();
  expect(lines.filter((line) => line.trim() === `${tag}-1`)).toHaveLength(1);
  expect(lines.some((line) => line.trim() === `${tag}-2`)).toBe(false);
  // The live terminal and session are the same after the real debounced save.
  expect(await terminal.evaluate((element) => element.isConnected)).toBe(true);
  expect(wire.streams.filter((stream) => stream.method === "pod.exec")).toHaveLength(opened);
  expect(ownStream.closed).toBe(false);
  expect(ownStream.params?.["session"]).toBe(sessionId);
  expect(
    ownStream.received
      .slice(received)
      .filter(
        (frame) =>
          frame.type === "end" ||
          (frame.type === "event" && (frame.event as { reset?: boolean })?.reset),
      ),
  ).toEqual([]);
  expect(wire.control.filter((frame) => frame.method === "exec.end")).toHaveLength(ends);
  // Server size agrees with the final visible terminal, after a completion boundary.
  const final = zoomSizes.at(-1)!;
  await input.pressSequentially(
    `printf 'fit-%s-' '${tag}'; stty size; printf 'fit-done-%s\\n' '${tag}'`,
  );
  await input.press("Enter");
  await expect(screen).toContainText(`fit-done-${tag}`);
  await expect(screen).toContainText(`fit-${tag}-${final.rows} ${final.cols}`);
  expect(await screen.locator(":scope > div").count()).toBe(final.rows);
  // Observe the real ten-second hidden policy, rather than sleeping past it.
  await expect
    .poll(() => originalLog.closed, { message: "zoom-hidden Log Stream paused", timeout: 20_000 })
    .toBe(true);
  // The pause is an observable later boundary for absence of recursive saves or late fits.
  expect(wire.saved).toHaveLength(after + 1);
  expect(ownStream.sent.filter((frame) => frame.type === "resize").slice(resized)).toEqual(
    zoomSizes,
  );
  expect(wire.streams.filter((stream) => stream.method === "resource.logs")).toHaveLength(logOpens);
  await right.getByRole("button", { name: "Restore Panes" }).click();
  await expect(right.getByRole("button", { name: "Zoom Pane" })).toBeFocused();
  await expect
    .poll(() => wire.streams.filter((stream) => stream.method === "resource.logs").length)
    .toBe(logOpens + 1);
  const firstResume = wire.streams.filter((stream) => stream.method === "resource.logs").at(-1)!;
  expect(firstResume.params?.["resume"]).toEqual(
    expect.arrayContaining([expect.objectContaining({ instance: expect.any(String) })]),
  );
  expect(
    await logModel.evaluate(({ editor, model, selection }) => ({
      same: editor.getModel() === model,
      selection: editor.getSelection()?.toString() === selection,
    })),
  ).toEqual({ same: true, selection: true });
  await input.focus();
  await input.pressSequentially(`printf '\\n%s\\n' 'hidden-${tag}`);
  // Hiding the session does not detach it, and hidden resizes stay absent.
  await pane(page, "pods").getByRole("button", { name: "Zoom Pane" }).click();
  await expect(session).toBeHidden();
  await assertVisibleFocus(page);
  const hiddenSizes = ownStream.sent.filter((frame) => frame.type === "resize").length;
  const hiddenSave = wire.saved.length;
  await page
    .getByRole("complementary", { name: "Resource types" })
    .getByRole("button", { name: /^ConfigMap \d+$/ })
    .click();
  await wire.nextSave(hiddenSave, '"configmaps"');
  expect(ownStream.sent.filter((frame) => frame.type === "resize")).toHaveLength(hiddenSizes);
  expect(ownStream.closed).toBe(false);
  await page.getByRole("button", { name: "Restore Panes" }).click();
  await expect(input).toBeVisible();
  expect(await terminal.evaluate((element) => element.isConnected)).toBe(true);
  expect(wire.streams.filter((stream) => stream.method === "resource.logs")).toHaveLength(
    logOpens + 1,
  );
  await input.focus();
  await input.pressSequentially(`'; printf '\\nhidden-boundary-%s\\n' '${tag}'`);
  await input.press("Enter");
  await expect(screen).toContainText(`hidden-boundary-${tag}`);
  expect(
    (await screen.locator(":scope > div").allTextContents()).filter(
      (line) => line.trim() === `hidden-${tag}`,
    ),
  ).toHaveLength(1);
  await expect
    .poll(() => firstResume.closed, { message: "hidden Log Stream paused again", timeout: 20_000 })
    .toBe(true);
  expect(wire.streams.filter((stream) => stream.method === "pod.exec")).toHaveLength(opened);
  expect(
    ownStream.received
      .slice(received)
      .filter(
        (frame) =>
          frame.type === "end" ||
          (frame.type === "event" && (frame.event as { reset?: boolean })?.reset),
      ),
  ).toEqual([]);
  for (const size of ownStream.sent.filter((frame) => frame.type === "resize")) {
    expect(size.cols).toBeGreaterThan(1);
    expect(size.rows).toBeGreaterThan(1);
  }
  // A live-session close cancellation must preserve zoom and session ownership.
  await right.getByRole("button", { name: "Zoom Pane" }).click();
  await right.getByRole("button", { name: `Close ${title}`, exact: true }).click();
  await page
    .getByRole("alertdialog", { name: /End the Exec Session/ })
    .getByRole("button", { name: "Keep session" })
    .click();
  await expect(right.getByRole("button", { name: "Restore Panes" })).toBeVisible();
  expect(wire.control.filter((frame) => frame.method === "exec.end")).toHaveLength(ends);
  await right.getByRole("button", { name: `Close ${title}`, exact: true }).click();
  await page
    .getByRole("alertdialog", { name: /End the Exec Session/ })
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await expect
    .poll(() => wire.control.filter((frame) => frame.method === "exec.end").length)
    .toBe(ends + 1);
  await terminal.dispose();
  await expect(
    pane(page, resourceNames[1]).getByRole("button", { name: "Restore Panes" }),
  ).toBeVisible();
  await go(page, namespace, "pods", zoomPod);
  await expect(page.getByRole("button", { name: "Restore Panes" })).toHaveCount(0);
  await expect(pod.locator(".monaco-editor:visible .view-lines")).toContainText("zoom-log-");
  await expect
    .poll(() => wire.streams.filter((stream) => stream.method === "resource.logs").length)
    .toBe(logOpens + 2);
  const resumed = wire.streams.filter((stream) => stream.method === "resource.logs").at(-1)!;
  expect(resumed.params?.["resume"]).toEqual(
    expect.arrayContaining([expect.objectContaining({ instance: expect.any(String) })]),
  );
  expect(await logModel.evaluate(({ editor, model }) => editor.getModel() === model)).toBe(true);
  await logModel.dispose();
}
