// @vitest-environment jsdom

import type {
  Related,
  RelatedParams,
  ResourceData,
  ResourceEvents,
  ResourceEventsParams,
} from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import { formatResourceUri } from "@hukube/k8s";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceContext, type WorkspaceValue } from "../workspace/workspace-context.tsx";
import { UnsavedGuard } from "../edit/unsaved-guard.tsx";
import { guardPanel, useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { ResourcePanel } from "./resource-panel.tsx";

const state = vi.hoisted(() => ({
  client: {
    request: () => Promise.resolve({ edit: { allowed: true }, delete: { allowed: true } }),
    onStateChange: () => () => {},
    getState: () => "open",
  },
  manifest: { stale: false } as SubscriptionState<ResourceData>,
  events: { stale: false } as SubscriptionState<ResourceEvents>,
  related: { stale: false } as SubscriptionState<Related>,
  relatedParams: [] as (RelatedParams | undefined)[],
  eventParams: [] as (ResourceEventsParams | undefined)[],
}));
vi.mock("@hukube/engine-client/react", () => ({
  useEngine: () => state.client,
  useConnectionState: () => "open",
  useSubscription: (method: string, params: ResourceEventsParams | undefined) => {
    if (method === "resource.get") return state.manifest;
    if (method === "resource.related") {
      state.relatedParams.push(params);
      return state.related;
    }
    if (method !== "resource.events") return { stale: false };
    state.eventParams.push(params);
    return state.events;
  },
}));
vi.mock("./logs-facet.tsx", () => ({
  LogsFacet: ({ visible }: { visible: boolean }) => (
    <div data-testid="logs-visible">{String(visible)}</div>
  ),
}));
vi.mock("./yaml-editor.tsx", () => ({
  default: ({
    value,
    editing,
    onChange,
  }: {
    value: string;
    editing?: boolean;
    onChange?: (text: string) => void;
  }) => (
    <div>
      YAML editor
      {editing && (
        <textarea
          aria-label="Test YAML"
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      )}
    </div>
  ),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
  state.manifest = { stale: false };
  state.events = { stale: false };
  state.eventParams = [];
  state.related = { stale: false };
  state.relatedParams = [];
});

it("keeps the last Manifest and a Deleted badge across Facets, or marks never-found Resources", async () => {
  const address = { cluster: "c", type: "pods", namespace: "ns", name: "web" };
  const api = { updateParameters: vi.fn<() => void>() } as unknown as DockviewPanelApi;
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  const panel = (facet?: "yaml" | "events") => (
    <WorkspaceContext value={workspace}>
      <ResourcePanel
        api={api}
        params={{ uri: formatResourceUri({ ...address, facet }), preview: true }}
      />
    </WorkspaceContext>
  );
  state.manifest = { stale: false, data: { object: { metadata: { uid: "uid" } } } };
  const view = render(panel());
  await act(async () => {});
  state.manifest = { stale: false, data: { deleted: true } };
  view.rerender(panel("events"));
  expect(screen.getByText("Deleted")).toBeDefined();
  view.rerender(panel("yaml"));
  expect(screen.getByText("Deleted")).toBeDefined();
  expect(screen.getByText("YAML editor")).toBeDefined();
  cleanup();
  render(panel("events"));
  expect(screen.getByText("Not found")).toBeDefined();
});

it("chooses a Facet with complete params and keeps YAML mounted without its controls", async () => {
  const address = { cluster: "c", type: "pods", namespace: "ns", name: "web" };
  state.manifest = { stale: false, data: { object: { metadata: { uid: "uid" } } } };
  const updateParameters = vi.fn<(params: object) => void>();
  const api = { updateParameters } as unknown as DockviewPanelApi;
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  const panel = (facet?: "yaml" | "events") => (
    <WorkspaceContext value={workspace}>
      <ResourcePanel
        api={api}
        params={{ uri: formatResourceUri({ ...address, facet }), preview: true }}
      />
    </WorkspaceContext>
  );
  const view = render(panel());
  await act(async () => {});
  fireEvent.click(screen.getByRole("tab", { name: "Events" }));
  expect(updateParameters).toHaveBeenCalledWith({
    uri: formatResourceUri({ ...address, facet: "events" }),
    preview: true,
  });
  view.rerender(panel("events"));
  expect(screen.getByText("YAML editor")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Show managed fields" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  expect(updateParameters).toHaveBeenLastCalledWith({
    uri: formatResourceUri({ ...address, facet: "yaml" }),
    preview: true,
  });
});

function subscriptionPanel(type = "pods") {
  const address = { cluster: "c", type, namespace: "ns", name: "web" };
  const api = { updateParameters: vi.fn<() => void>() } as unknown as DockviewPanelApi;
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  return (
    <WorkspaceContext value={workspace}>
      <ResourcePanel api={api} params={{ uri: formatResourceUri(address), preview: true }} />
    </WorkspaceContext>
  );
}

function receivedEventParams() {
  const calls = state.eventParams.splice(0);
  expect(calls.length).toBeGreaterThan(0);
  return calls;
}

it("passes no Events params before the Manifest answers", () => {
  render(subscriptionPanel());
  for (const call of receivedEventParams()) expect(call).toBeUndefined();
});

it("passes the Manifest UID, follows recreation, and keeps it after deletion", () => {
  const address = { cluster: "c", type: "pods", namespace: "ns", name: "web" };
  state.manifest = { stale: false, data: { object: { metadata: { uid: "first" } } } };
  const view = render(subscriptionPanel());
  for (const call of receivedEventParams()) expect(call).toEqual({ ...address, uid: "first" });
  state.manifest = { stale: false, data: { object: { metadata: { uid: "recreated" } } } };
  view.rerender(subscriptionPanel());
  for (const call of receivedEventParams()) expect(call).toEqual({ ...address, uid: "recreated" });
  state.manifest = { stale: false, data: { deleted: true } };
  view.rerender(subscriptionPanel());
  for (const call of receivedEventParams()) expect(call).toEqual({ ...address, uid: "recreated" });
});

it.each(["events", "events.events.k8s.io"])("passes no Events params for %s Resources", (type) => {
  state.manifest = { stale: false, data: { object: { metadata: { uid: "event" } } } };
  render(subscriptionPanel(type));
  for (const call of receivedEventParams()) expect(call).toBeUndefined();
});

it("subscribes to Related for the whole tab and requests cells only while showing it", () => {
  const address = { cluster: "c", type: "pods", namespace: "ns", name: "web" };
  const api = {
    id: "source",
    updateParameters: vi.fn<() => void>(),
  } as unknown as DockviewPanelApi;
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  const panel = (facet: "yaml" | "events" | "related") => (
    <WorkspaceContext value={workspace}>
      <ResourcePanel
        api={api}
        params={{ uri: formatResourceUri({ ...address, facet }), preview: true }}
      />
    </WorkspaceContext>
  );
  const view = render(panel("yaml"));
  const initial = state.relatedParams.splice(0);
  expect(initial.length).toBeGreaterThan(0);
  for (const params of initial) expect(params).toEqual({ ...address, cells: false });
  view.rerender(panel("related"));
  const showing = state.relatedParams.splice(0);
  expect(showing.length).toBeGreaterThan(0);
  expect(showing.every((params) => params?.cells === true)).toBe(true);
  view.rerender(panel("events"));
  const hidden = state.relatedParams.splice(0);
  expect(hidden.length).toBeGreaterThan(0);
  expect(hidden.every((params) => params?.cells === false)).toBe(true);
});

it("offers every Facet in More Facets only while overflowing and changes the URI", async () => {
  const observers: { callback: () => void; elements: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        this.observer = { callback, elements: [] };
        observers.push(this.observer);
      }
      observer: { callback: () => void; elements: Element[] };
      observe(element: Element) {
        this.observer.elements.push(element);
      }
      disconnect() {}
    },
  );
  state.related = { stale: true, data: { found: true, total: 12, sections: [], types: [] } };
  state.events = { stale: false, data: { events: [], warnings: 1, total: 1 } };
  const updateParameters = vi.fn<(params: object) => void>();
  const api = { id: "source", updateParameters } as unknown as DockviewPanelApi;
  const address = {
    cluster: "c",
    type: "pods",
    namespace: "ns",
    name: "web",
    facet: "related" as const,
  };
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  const { container } = render(
    <WorkspaceContext value={workspace}>
      <ResourcePanel api={api} params={{ uri: formatResourceUri(address), preview: true }} />
    </WorkspaceContext>,
  );
  expect(screen.queryByRole("button", { name: "More Facets" })).toBeNull();
  const scroller = container.querySelector<HTMLDivElement>(".overflow-x-auto")!;
  Object.defineProperties(scroller, {
    scrollWidth: { configurable: true, value: 300 },
    clientWidth: { configurable: true, value: 100 },
  });
  Object.defineProperty(screen.getByRole("tablist", { name: "Facets" }), "scrollWidth", {
    configurable: true,
    value: 300,
  });
  scroller.getBoundingClientRect = () => ({ left: 0, right: 100 }) as DOMRect;
  screen.getByRole("tab", { name: "Related, 12 Resources" }).getBoundingClientRect = () =>
    ({ left: 200, right: 280 }) as DOMRect;
  act(() => observers.find((observer) => observer.elements.includes(scroller))!.callback());
  expect(scroller.scrollLeft).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "More Facets" }));
  const choices = await screen.findAllByRole("menuitemradio");
  expect(
    choices.map((element) => element.getAttribute("aria-label") ?? element.textContent),
  ).toEqual(["YAML", "Logs", "Events, 1 warning", "Related, 12 Resources"]);
  expect(
    screen
      .getByRole("menuitemradio", { name: "Related, 12 Resources" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Events, 1 warning" }));
  expect(updateParameters).toHaveBeenLastCalledWith({
    uri: formatResourceUri({ ...address, facet: "events" }),
    preview: true,
  });
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 400 });
  act(() => observers.find((observer) => observer.elements.includes(scroller))!.callback());
  expect(screen.queryByRole("button", { name: "More Facets" })).toBeNull();
});

function measuredSwitcher() {
  const observers: { callback: () => void; elements: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        this.observer = { callback, elements: [] };
        observers.push(this.observer);
      }
      observer: { callback: () => void; elements: Element[] };
      observe(element: Element) {
        this.observer.elements.push(element);
      }
      disconnect() {}
    },
  );
  const { container, rerender } = render(subscriptionPanel());
  const scroller = container.querySelector<HTMLDivElement>(".overflow-x-auto")!;
  // jsdom rejects calc() in mask gradients, so retain the style React assigns.
  Object.defineProperty(scroller.style, "maskImage", {
    configurable: true,
    writable: true,
    value: "",
  });
  const tabs = screen.getByRole("tablist", { name: "Facets" });
  Object.defineProperty(tabs, "scrollWidth", { configurable: true, value: 300 });
  scroller.parentElement!.style.columnGap = "8px";
  const resize = (width: number) => {
    Object.defineProperties(scroller, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: width },
    });
    act(() => observers.find((observer) => observer.elements.includes(scroller))!.callback());
  };
  return { scroller, resize, update: () => rerender(subscriptionPanel()) };
}

it("fades only the hidden edges of the Facet scroller on measure and scroll", () => {
  const { scroller, resize, update } = measuredSwitcher();
  resize(100);
  expect(scroller.style.maskImage).toBe(
    "linear-gradient(to right, black, black calc(100% - 12px), transparent)",
  );
  scroller.getBoundingClientRect = () => ({ left: 0, right: 100 }) as DOMRect;
  screen.getByRole("tab", { name: "YAML" }).getBoundingClientRect = () =>
    ({ left: -scroller.scrollLeft, right: 45 - scroller.scrollLeft }) as DOMRect;
  scroller.scrollLeft = 50;
  fireEvent.scroll(scroller);
  expect(scroller.scrollLeft).toBe(50);
  // A live update renders the same Facets again and must not undo the scroll.
  update();
  expect(scroller.scrollLeft).toBe(50);
  expect(scroller.style.maskImage).toBe(
    "linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)",
  );
  scroller.scrollLeft = 199;
  fireEvent.scroll(scroller);
  expect(scroller.style.maskImage).toBe(
    "linear-gradient(to right, transparent, black 12px, black)",
  );
  scroller.scrollLeft = 0;
  resize(300);
  expect(scroller.style.maskImage).toBe("");
});

it("shows and hides More Facets at the same width excluding its button and gap", () => {
  const { resize } = measuredSwitcher();
  resize(300);
  expect(screen.queryByRole("button", { name: "More Facets" })).toBeNull();
  resize(299);
  Object.defineProperty(screen.getByRole("button", { name: "More Facets" }), "offsetWidth", {
    configurable: true,
    value: 32,
  });
  resize(259);
  expect(screen.getByRole("button", { name: "More Facets" })).toBeDefined();
  resize(260);
  expect(screen.queryByRole("button", { name: "More Facets" })).toBeNull();
  resize(300);
  expect(screen.queryByRole("button", { name: "More Facets" })).toBeNull();
  resize(299);
  expect(screen.getByRole("button", { name: "More Facets" })).toBeDefined();
});

describe("a double-click on a related Resource", () => {
  const pod = { cluster: "c", type: "pods", namespace: "ns", name: "web" };
  const openResource = vi.fn<WorkspaceValue["openResource"]>();
  const tab = (id: string, address: typeof pod & { type: string }, facet: "yaml" | "related") => (
    <WorkspaceContext
      value={{
        cluster: "c",
        active: true,
        types: new Map(),
        openExecSession: () => {},
        openList: vi.fn<() => void>(),
        openResource,
      }}
    >
      <ResourcePanel
        api={{ id, updateParameters: vi.fn<() => void>() } as unknown as DockviewPanelApi}
        params={{ uri: formatResourceUri({ ...address, facet }), preview: true }}
      />
    </WorkspaceContext>
  );
  // The first click, on a Pod's row in a Deployment's Related Facet, opens the Pod.
  const clickRow = () => {
    state.manifest = { stale: false, data: { object: { metadata: { uid: "uid" } } } };
    state.related = {
      stale: false,
      data: {
        found: true,
        total: 1,
        types: [],
        sections: [
          {
            relationship: "owns",
            direction: "out",
            total: 1,
            rows: [
              {
                depth: 0,
                status: "found",
                kind: "Pod",
                type: "pods",
                namespace: "ns",
                name: "web",
              },
            ],
          },
        ],
      },
    };
    render(tab("source", { ...pod, type: "deployments.apps" }, "related"));
    fireEvent.click(screen.getByRole("row", { name: /Pod web/ }), { detail: 1 });
    expect(openResource).toHaveBeenLastCalledWith(
      { type: "pods", namespace: "ns", name: "web" },
      { preview: true, pane: "source" },
    );
    cleanup();
    openResource.mockClear();
  };
  afterEach(() => {
    vi.useRealTimers();
    openResource.mockClear();
  });

  it("makes a regular tab of what the first click opened, whichever Facet the second lands in", async () => {
    clickRow();
    // The Pod's tab was already open on its YAML Facet, so the second click lands there.
    render(tab("opened", pod, "yaml"));
    await act(async () => {});
    fireEvent.click(screen.getByText("YAML editor"), { detail: 2 });
    expect(openResource).toHaveBeenCalledTimes(1);
    expect(openResource).toHaveBeenLastCalledWith(
      { type: "pods", namespace: "ns", name: "web" },
      { preview: false, pane: "opened" },
    );
    // The burst's further clicks open nothing, and neither does a double-click with nothing before it.
    fireEvent.click(screen.getByText("YAML editor"), { detail: 3 });
    fireEvent.click(screen.getByText("YAML editor"), { detail: 2 });
    expect(openResource).toHaveBeenCalledTimes(1);
  });

  it("forgets what a click opened after a single click elsewhere, or after a moment", async () => {
    clickRow();
    render(tab("opened", pod, "yaml"));
    await act(async () => {});
    fireEvent.click(screen.getByText("YAML editor"), { detail: 1 });
    fireEvent.click(screen.getByText("YAML editor"), { detail: 2 });
    expect(openResource).not.toHaveBeenCalled();
    cleanup();
    vi.useFakeTimers();
    clickRow();
    vi.advanceTimersByTime(5000);
    render(tab("opened", pod, "yaml"));
    fireEvent.click(screen.getByRole("tablist", { name: "Facets" }), { detail: 2 });
    expect(openResource).not.toHaveBeenCalled();
  });
});

it("keeps a custom Resource's Logs entry after Pod ownership disappears and passes combined visibility", () => {
  const address = { cluster: "c", type: "constructor", namespace: "ns", name: "custom" };
  state.manifest = { stale: false, data: { object: { metadata: { uid: "uid" } } } };
  let visibility: ((event: { isVisible: boolean }) => void) | undefined;
  const api = {
    id: "custom",
    isVisible: true,
    updateParameters: vi.fn<() => void>(),
    onDidVisibilityChange: (listener: typeof visibility) => {
      visibility = listener;
      return { dispose: vi.fn<() => void>() };
    },
  } as unknown as DockviewPanelApi;
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  const panel = (active = true, facet: "logs" | "yaml" = "logs") => (
    <WorkspaceContext value={{ ...workspace, active }}>
      <ResourcePanel api={api} params={{ uri: formatResourceUri({ ...address, facet }) }} />
    </WorkspaceContext>
  );
  const view = render(panel());
  expect(screen.queryByRole("tab", { name: "Logs" })).toBeNull();
  state.related = {
    stale: false,
    data: {
      found: true,
      total: 1,
      types: [],
      sections: [
        {
          relationship: "owns",
          direction: "out",
          total: 1,
          rows: [{ depth: 1, status: "found", kind: "Pod", type: "pods", name: "p" }],
        },
      ],
    },
  };
  view.rerender(panel());
  expect(screen.getByRole("tab", { name: "Logs" })).toBeDefined();
  expect(screen.getByTestId("logs-visible").textContent).toBe("true");
  state.related = { stale: false, data: { found: true, total: 0, types: [], sections: [] } };
  view.rerender(panel());
  expect(screen.getByRole("tab", { name: "Logs" })).toBeDefined();
  act(() => visibility?.({ isVisible: false }));
  expect(screen.getByTestId("logs-visible").textContent).toBe("false");
  act(() => visibility?.({ isVisible: true }));
  view.rerender(panel(false));
  expect(screen.getByTestId("logs-visible").textContent).toBe("false");
  view.rerender(panel(true, "yaml"));
  expect(screen.getByTestId("logs-visible").textContent).toBe("false");
});

it("pins Edit, preserves unsaved YAML across Facets and live changes, and guards close and deletion", async () => {
  const api = {
    id: "edit",
    updateParameters: vi.fn<(params: object) => void>(),
  } as unknown as DockviewPanelApi;
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  const address = { cluster: "c", type: "configmaps", namespace: "ns", name: "web" };
  const panel = (facet: "yaml" | "events" = "yaml") => (
    <WorkspaceContext value={workspace}>
      <ResourcePanel
        api={api}
        params={{ uri: formatResourceUri({ ...address, facet }), preview: true }}
      />
      <UnsavedGuard />
    </WorkspaceContext>
  );
  const object = {
    kind: "ConfigMap",
    metadata: { name: "web", uid: "u", resourceVersion: "1" },
    data: { greeting: "hello" },
  };
  state.manifest = { stale: false, data: { object } };
  const view = render(panel());
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(api.updateParameters).toHaveBeenLastCalledWith({
    uri: formatResourceUri({ ...address, facet: "yaml" }),
    preview: false,
  });
  const text = await screen.findByRole("textbox", { name: "Test YAML" });
  const mine = (text as HTMLTextAreaElement).value + "# mine\n";
  fireEvent.change(text, { target: { value: mine } });
  expect(useUnsavedEdits.getState().entries.get("edit")?.read()).toBe(mine);
  view.rerender(panel("events"));
  view.rerender(panel());
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Test YAML" }).value).toBe(mine);
  state.manifest = { stale: false, data: { object: { ...object, data: { greeting: "cluster" } } } };
  view.rerender(panel());
  expect(screen.getByText(/changed on the Cluster while you were editing/)).toBeDefined();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Test YAML" }).value).toBe(mine);
  const close = vi.fn<() => void>();
  act(() => guardPanel("edit", close));
  expect(await screen.findByRole("alertdialog")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(close).not.toHaveBeenCalled();
  state.manifest = { stale: false, data: { deleted: true } };
  view.rerender(panel());
  expect(screen.getByText(/was deleted on the Cluster while you were editing/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Copy YAML" })).toBeDefined();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Test YAML" }).value).toBe(mine);
  expect(screen.getByRole("button", { name: "Review changes" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Discard edits" }).at(-1)!);
  expect(useUnsavedEdits.getState().entries.size).toBe(0);
});

it("updates a clean editor when the live editable Manifest changes", async () => {
  const api = { id: "clean", updateParameters: vi.fn<() => void>() } as unknown as DockviewPanelApi;
  const workspace = {
    cluster: "c",
    active: true,
    types: new Map(),
    openExecSession: () => {},
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  };
  const panel = () => (
    <WorkspaceContext value={workspace}>
      <ResourcePanel
        api={api}
        params={{
          uri: formatResourceUri({
            cluster: "c",
            type: "configmaps",
            namespace: "ns",
            name: "web",
          }),
        }}
      />
    </WorkspaceContext>
  );
  state.manifest = {
    stale: false,
    data: { object: { metadata: { uid: "u" }, data: { key: "first" } } },
  };
  const view = render(panel());
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByRole("textbox", { name: "Test YAML" });
  state.manifest = {
    stale: false,
    data: { object: { metadata: { uid: "u" }, data: { key: "second" } } },
  };
  view.rerender(panel());
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Test YAML" }).value).toContain(
    "second",
  );
  expect(useUnsavedEdits.getState().entries.size).toBe(0);
});
