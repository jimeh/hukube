// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelProps,
  type SerializedDockview,
} from "dockview-react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Setting } from "@hukube/engine-client";
import { bindPaneInteractivity } from "./pane-interactivity.ts";
import { PaneHeaderActions } from "./pane-header-actions.tsx";
import { persistLayout } from "./layout-persistence.ts";
import { openPanel, type ResourcePanelParams } from "./dock.ts";
import { guardPanel, useUnsavedEdits } from "../edit/unsaved-edits.ts";

const interactivity: (() => void)[] = [];
let mounted = 0;
let unmounted = 0;
function Content({ api }: IDockviewPanelProps) {
  useEffect(() => {
    mounted++;
    return () => {
      unmounted++;
    };
  }, []);
  return <textarea aria-label={api.id} defaultValue={`draft ${api.id}`} />;
}
const components = { resource: Content };
const tabComponents = { tab: () => <span>Tab</span> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mounted = unmounted = 0;
});
afterEach(() => {
  interactivity.splice(0).forEach((dispose) => dispose());
  cleanup();
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps zoom and the draft on close cancellation, then accepts native last-Tab close", async () => {
  const { api, add } = view();
  const first = add("a");
  add("b", "a", "right");
  useUnsavedEdits.getState().set("a", { cluster: "c", label: "ConfigMap a", read: () => "draft" });
  fireEvent.click(control(first.group));
  const button = control(first.group, "Restore Panes");
  act(() => guardPanel(first.id, () => first.api.close()));
  expect(useUnsavedEdits.getState().guard?.title).toContain("Discard your edits");
  act(() => useUnsavedEdits.getState().dismiss());
  expect(api.getPanel("a")).toBe(first);
  expect(first.group.api.isMaximized()).toBe(true);
  expect(document.activeElement).toBe(button);
  act(() => guardPanel(first.id, () => first.api.close()));
  act(() => useUnsavedEdits.getState().guard!.proceed());
  expect(api.getPanel("a")).toBeUndefined();
  expect(api.activePanel?.api.isVisible).toBe(true);
  expect(api.groups.every((group) => !group.api.isMaximized())).toBe(true);
});
function view() {
  let api!: DockviewApi;
  const rendered = render(
    <DockviewReact
      components={components}
      tabComponents={tabComponents}
      rightHeaderActionsComponent={PaneHeaderActions}
      onReady={(event) => {
        api = event.api;
        api.layout(1200, 800);
        interactivity.push(bindPaneInteractivity(api));
      }}
    />,
  );
  const add = (id: string, reference?: string, direction?: "right" | "below") => {
    let panel!: ReturnType<DockviewApi["addPanel"]>;
    act(() => {
      panel = api.addPanel({
        id,
        component: "resource",
        tabComponent: "tab",
        params: { uri: id },
        ...(reference
          ? { position: { referencePanel: reference, ...(direction ? { direction } : {}) } }
          : {}),
      });
    });
    act(() => api.layout(1200, 800));
    return panel;
  };
  return { api, add, ...rendered };
}
function control(group: DockviewApi["groups"][number], name = "Zoom Pane") {
  return within(group.element).getByRole("button", { name });
}
async function settle() {
  await act(async () => {});
}

it("uses native state for empty, single, multi-Tab, and native-maximized single Panes", async () => {
  const { api, add } = view();
  expect(api.groups).toHaveLength(0);
  const first = add("a");
  add("b", "a");
  expect(within(first.group.element).queryByRole("button", { name: "Zoom Pane" })).toBeNull();
  act(() => first.group.api.maximize());
  await settle();
  const restore = control(first.group, "Restore Panes");
  expect(restore.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(restore);
  expect(first.group.api.isMaximized()).toBe(false);
  expect(within(first.group.element).queryByRole("button")).toBeNull();
});

it("toggles actual native state, retains button focus and drafts, and follows external exits", async () => {
  const { api, add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  const field = within(first.group.element).getByRole<HTMLTextAreaElement>("textbox", {
    name: "a",
  });
  field.value = "unsaved draft";
  field.setSelectionRange(2, 8);
  await settle();
  const button = control(first.group);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  await settle();
  expect(first.group.api.isMaximized()).toBe(true);
  expect(second.group.api.isVisible).toBe(false);
  expect(second.api.isVisible).toBe(false);
  expect(document.activeElement).toBe(button);
  expect(control(first.group, "Restore Panes")).toBe(button);
  expect(field.value).toBe("unsaved draft");
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 8]);
  fireEvent.click(button);
  await settle();
  expect(second.api.isVisible).toBe(true);
  expect(document.activeElement).toBe(button);
  act(() => first.group.api.maximize());
  await settle();
  act(() => second.api.setActive());
  await settle();
  expect(first.group.api.isMaximized()).toBe(false);
  expect(control(first.group)).toBe(button);
  expect(mounted).toBe(2);
  expect(unmounted).toBe(0);
  expect(api.panels).toHaveLength(2);
});

it("moves focus out of newly hidden content on an external native maximize", async () => {
  const { add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  within(second.group.element).getByRole("textbox").focus();
  act(() => first.group.api.maximize());
  await settle();
  expect(second.group.api.isVisible).toBe(false);
  expect(document.activeElement).toBe(control(first.group, "Restore Panes"));
});

it("excludes floating groups and updates when groups move, disappear, and load", async () => {
  const { api, add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  act(() => api.addFloatingGroup(second.group));
  await settle();
  expect(within(second.group.element).queryByRole("button", { name: "Zoom Pane" })).toBeNull();
  expect(within(first.group.element).queryByRole("button", { name: "Zoom Pane" })).toBeNull();
  act(() => second.group.api.moveTo({ group: first.group, position: "right" }));
  await settle();
  expect(control(first.group)).toBeDefined();
  const saved = api.toJSON();
  act(() => second.api.close());
  expect(within(first.group.element).queryByRole("button", { name: "Zoom Pane" })).toBeNull();
  act(() => api.fromJSON(saved));
  expect(control(api.getPanel("a")!.group)).toBeDefined();
});

it("preserves nested split sizes and current edits through real debounced serialization and disposal", async () => {
  const { api, add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  const third = add("c", "b", "below");
  act(() => {
    first.group.api.setSize({ width: 340 });
    second.group.api.setSize({ height: 270 });
  });
  const ordinary = api.toJSON();
  let deliver!: (setting: Setting) => void;
  const request = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
  const client = {
    request,
    subscribe: (_method: unknown, _params: unknown, listener: { data: typeof deliver }) => {
      deliver = listener.data;
      return { close() {} };
    },
  } as unknown as Parameters<typeof persistLayout>[0];
  const dispose = persistLayout(client, api, "workspace/c");
  act(() => deliver({ revision: "", key: "workspace/c", value: null }));
  const fromJSON = vi.spyOn(api, "fromJSON");
  const clear = vi.spyOn(api, "clear");
  const maximize = vi.spyOn(first.group.api, "maximize");
  const exit = vi.spyOn(first.group.api, "exitMaximized");
  fireEvent.click(control(first.group));
  const button = control(first.group, "Restore Panes");
  act(() => first.api.updateParameters({ uri: "a/yaml", preview: false, draft: "kept" }));
  await settle();
  act(() => {
    vi.advanceTimersByTime(399);
  });
  expect(request).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(request).toHaveBeenCalledOnce();
  const value = (
    request.mock.calls[0] as unknown as [string, { value: { dockview: SerializedDockview } }]
  )[1].value.dockview;
  expect(value.grid).toEqual(ordinary.grid);
  expect(value.grid).not.toHaveProperty("maximizedNode");
  expect(value.panels["a"]?.params).toMatchObject({ uri: "a/yaml", preview: false, draft: "kept" });
  expect(first.group.api.isMaximized()).toBe(true);
  expect(second.api.isVisible).toBe(false);
  expect(third.api.isVisible).toBe(false);
  expect(document.activeElement).toBe(button);
  expect(maximize).toHaveBeenCalledOnce();
  expect(exit).not.toHaveBeenCalled();
  expect(fromJSON).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  expect(request).toHaveBeenCalledOnce();
  act(() => third.api.updateParameters({ uri: "c/logs" }));
  await settle();
  act(dispose);
  expect(request).toHaveBeenCalledTimes(2);
  act(() => first.group.api.exitMaximized());
  expect(api.toJSON().grid).toEqual(ordinary.grid);
  expect(mounted).toBe(3);
  expect(unmounted).toBe(0);
});

it.each([true, false])(
  "hides peer Tabs on %s active entry and after native serialization",
  async (active) => {
    const { api, add } = view();
    const first = add("a");
    const second = add("b", "a", "right");
    if (active) act(() => first.api.setActive());
    const visibility: boolean[] = [];
    const listener = second.api.onDidVisibilityChange((event) => visibility.push(event.isVisible));
    fireEvent.click(control(first.group));
    await settle();
    expect(second.api.isVisible).toBe(false);
    expect(visibility).toEqual([false]);
    act(() => {
      api.toJSON();
    });
    await settle();
    // The native serializer emits intermediate events; consumers must finish hidden.
    expect(second.api.isVisible).toBe(false);
    expect(first.api.isVisible).toBe(true);
    expect(first.group.api.isMaximized()).toBe(true);
    listener.dispose();
  },
);

it("saves resized underlying geometry while zoomed and restores that geometry", async () => {
  const { api, add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  add("c", "b", "below");
  act(() => {
    first.group.api.setSize({ width: 340 });
    second.group.api.setSize({ height: 270 });
  });
  const before = api.toJSON();
  fireEvent.click(control(first.group));
  act(() => api.layout(900, 600));
  const zoomed = api.toJSON();
  expect(zoomed.grid.width).toBe(900);
  expect(zoomed.grid.height).toBe(600);
  expect(zoomed.grid).not.toEqual(before.grid);
  fireEvent.click(control(first.group, "Restore Panes"));
  const { maximizedNode: _zoom, ...grid } = zoomed.grid as typeof zoomed.grid & {
    maximizedNode?: unknown;
  };
  expect(api.toJSON().grid).toEqual(grid);
  expect(first.api.isVisible).toBe(true);
  expect(second.api.isVisible).toBe(true);
});

it("disposes header subscriptions on unmount while the native Workspace remains live", async () => {
  const { api, add } = view();
  const first = add("a");
  add("b", "a", "right");
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const events = [
    "onDidMaximizedGroupChange",
    "onDidAddGroup",
    "onDidRemoveGroup",
    "onDidMovePanel",
    "onDidLayoutFromJSON",
    "onDidLayoutChange",
  ] as const;
  const tracked = new Proxy(api, {
    get(target, name) {
      if (events.some((event) => event === name))
        return (listener: () => void) => {
          const subscription = target[name as (typeof events)[number]](listener);
          const dispose = vi.fn<() => void>(() => subscription.dispose());
          disposals.push(dispose);
          return { dispose };
        };
      return Reflect.get(target, name);
    },
  });
  const trackedGroup = new Proxy(first.group.api, {
    get(target, name) {
      if (name === "onDidLocationChange")
        return (listener: () => void) => {
          const subscription = target.onDidLocationChange(listener);
          const dispose = vi.fn<() => void>(() => subscription.dispose());
          disposals.push(dispose);
          return { dispose };
        };
      return Reflect.get(target, name);
    },
  });
  const header = render(
    <PaneHeaderActions
      api={trackedGroup}
      containerApi={tracked}
      group={first.group}
      panels={first.group.panels}
      activePanel={first.group.activePanel}
      isGroupActive={first.group.api.isActive}
      headerPosition="top"
    />,
  );
  await settle();
  expect(disposals).toHaveLength(events.length + 1);
  header.unmount();
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
  act(() => first.group.api.maximize());
  expect(first.group.api.isMaximized()).toBe(true);
});

it("keeps zoom independent in two mounted Workspaces and retains it while hidden", async () => {
  const first = view();
  const a = first.add("a");
  first.add("b", "a", "right");
  const second = view();
  const c = second.add("c");
  second.add("d", "c", "below");
  fireEvent.click(control(a.group));
  expect(c.group.api.isMaximized()).toBe(false);
  first.container.hidden = true;
  fireEvent.click(control(c.group));
  expect(a.group.api.isMaximized()).toBe(true);
  expect(c.group.api.isMaximized()).toBe(true);
  second.container.hidden = true;
  first.container.hidden = false;
  await settle();
  expect(control(a.group, "Restore Panes").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(control(a.group, "Restore Panes"));
  expect(a.group.api.isMaximized()).toBe(false);
  expect(c.group.api.isMaximized()).toBe(true);
  expect(mounted).toBe(4);
  expect(unmounted).toBe(0);
});

it("uses native openPanel, close, move and split semantics without stranding hidden Tabs", async () => {
  const { api, add } = view();
  const assertInteractivity = () => {
    for (const group of api.groups)
      expect(group.element.hasAttribute("inert")).toBe(!group.api.isVisible);
  };
  const first = add("a");
  const second = add("b", "a", "right");
  const open = (id: string, pane?: string, beside?: string) =>
    act(() =>
      openPanel<ResourcePanelParams>(api, {
        id,
        component: "resource",
        title: id,
        params: { uri: id },
        preview: true,
        ...(pane ? { pane } : {}),
        ...(beside ? { beside } : {}),
      }),
    );
  fireEvent.click(control(first.group));
  await settle();
  assertInteractivity();
  open("preview", "a");
  expect(first.group.api.isMaximized()).toBe(true);
  expect(second.api.isVisible).toBe(false);
  open("replacement", "a");
  expect(api.getPanel("preview")).toBeUndefined();
  act(() => api.getPanel("replacement")!.api.close());
  expect(first.group.api.isMaximized()).toBe(true);
  expect(second.api.isVisible).toBe(false);
  open("b");
  await settle();
  assertInteractivity();
  expect(first.group.api.isMaximized()).toBe(false);
  expect(second.api.isVisible).toBe(true);
  fireEvent.click(control(first.group));
  await settle();
  assertInteractivity();
  open("beside", undefined, "a");
  assertInteractivity();
  expect(first.group.api.isMaximized()).toBe(false);
  fireEvent.click(control(first.group));
  await settle();
  assertInteractivity();
  const split = add("split", "a", "below");
  assertInteractivity();
  expect(first.group.api.isMaximized()).toBe(false);
  fireEvent.click(control(first.group));
  await settle();
  assertInteractivity();
  act(() => split.api.moveTo({ group: second.group }));
  assertInteractivity();
  expect(first.group.api.isMaximized()).toBe(false);
  fireEvent.click(control(first.group));
  await settle();
  assertInteractivity();
  act(() => first.api.close());
  expect(api.groups.every((group) => !group.api.isMaximized())).toBe(true);
  assertInteractivity();
  expect(api.activePanel?.api.isVisible).toBe(true);
});

it.each([true, false])(
  "makes native-hidden Panes inert on %s active entry without replacing content",
  async (active) => {
    const { api, add } = view();
    const first = add("a");
    const second = add("b", "a", "right");
    const field = within(second.group.element).getByRole<HTMLTextAreaElement>("textbox");
    field.value = "retained draft";
    field.setSelectionRange(2, 7);
    if (active) act(() => first.api.setActive());
    fireEvent.click(control(first.group));
    expect(second.group.api.isVisible).toBe(false);
    expect(second.group.element.hasAttribute("inert")).toBe(true);
    expect(first.group.element.hasAttribute("inert")).toBe(false);
    const button = control(first.group, "Restore Panes");
    act(() => {
      api.toJSON();
    });
    expect(second.group.element.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(button);
    act(() => second.api.setActive());
    expect(second.group.element.hasAttribute("inert")).toBe(false);
    expect(within(second.group.element).getByRole("textbox")).toBe(field);
    expect(field.value).toBe("retained draft");
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 7]);
    expect(mounted).toBe(2);
    expect(unmounted).toBe(0);
  },
);

it("initializes already hidden groups and releases only its own inertness on disposal", () => {
  const { api, add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  const third = add("c", "b", "below");
  interactivity.pop()!();
  third.group.element.setAttribute("inert", "");
  act(() => first.group.api.maximize());
  const dispose = bindPaneInteractivity(api);
  expect(second.group.element.hasAttribute("inert")).toBe(true);
  expect(third.group.element.hasAttribute("inert")).toBe(true);
  dispose();
  expect(second.group.element.hasAttribute("inert")).toBe(false);
  expect(third.group.element.hasAttribute("inert")).toBe(true);
  act(() => {
    first.group.api.exitMaximized();
    first.group.api.maximize();
  });
  expect(second.group.element.hasAttribute("inert")).toBe(false);
});

it("keeps ancestor recovery inertness and does not steal focus from another Workspace", async () => {
  const { api, add, container } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  container.setAttribute("inert", "");
  act(() => first.group.api.maximize());
  expect(second.group.element.hasAttribute("inert")).toBe(true);
  act(() => {
    api.toJSON();
  });
  act(() => first.group.api.exitMaximized());
  expect(second.group.element.hasAttribute("inert")).toBe(false);
  expect(container.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(other);
  container.removeAttribute("inert");
  other.remove();
  await settle();
});

it("repairs external maximize focus even when native inert blurs before the maximize notification", async () => {
  const { add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  const field = within(second.group.element).getByRole<HTMLTextAreaElement>("textbox");
  field.focus();
  // jsdom has no native inert focus behavior. Reproduce the browser's blur at
  // the attribute write, before Dockview delivers its maximize notification.
  const setAttribute = second.group.element.setAttribute.bind(second.group.element);
  const blur = vi.spyOn(second.group.element, "setAttribute").mockImplementation((name, value) => {
    setAttribute(name, value);
    if (name === "inert") field.blur();
  });
  act(() => first.group.api.maximize());
  await settle();
  expect(blur).toHaveBeenCalledWith("inert", "");
  expect(second.group.element.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(control(first.group, "Restore Panes"));
  blur.mockRestore();
});

it("disposes removed and reloaded group subscriptions and binds their replacements", () => {
  const { api, add } = view();
  const first = add("a");
  const second = add("b", "a", "right");
  interactivity.pop()!();
  const disposals: ReturnType<typeof vi.fn>[] = [];
  for (const group of api.groups) {
    const event = group.api.onDidVisibilityChange;
    vi.spyOn(group.api, "onDidVisibilityChange").mockImplementation((listener) => {
      const subscription = event(listener);
      const dispose = vi.fn<() => void>(() => subscription.dispose());
      disposals.push(dispose);
      return { dispose };
    });
  }
  const dispose = bindPaneInteractivity(api);
  const saved = api.toJSON();
  act(() => second.api.close());
  expect(disposals[1]).toHaveBeenCalledOnce();
  act(() => api.fromJSON(saved));
  expect(disposals[0]).toHaveBeenCalledOnce();
  const restored = api.getPanel("a")!;
  const peer = api.getPanel("b")!;
  act(() => restored.group.api.maximize());
  expect(peer.group.element.hasAttribute("inert")).toBe(true);
  dispose();
  expect(peer.group.element.hasAttribute("inert")).toBe(false);
  expect(disposals.every((entry) => entry.mock.calls.length === 1)).toBe(true);
  act(() => {
    restored.group.api.exitMaximized();
    restored.group.api.maximize();
  });
  expect(peer.group.element.hasAttribute("inert")).toBe(false);
  expect(first).not.toBe(restored);
});
