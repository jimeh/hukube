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
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WorkspaceContext } from "../workspace/workspace-context.tsx";
import { ResourcePanel } from "./resource-panel.tsx";

const state = vi.hoisted(() => ({
  manifest: { stale: false } as SubscriptionState<ResourceData>,
  events: { stale: false } as SubscriptionState<ResourceEvents>,
  related: { stale: false } as SubscriptionState<Related>,
  relatedParams: [] as (RelatedParams | undefined)[],
  eventParams: [] as (ResourceEventsParams | undefined)[],
}));
vi.mock("@hukube/engine-client/react", () => ({
  useSubscription: (method: string, params: ResourceEventsParams | undefined) => {
    if (method === "resource.get") return state.manifest;
    if (method === "resource.related") {
      state.relatedParams.push(params);
      return state.related;
    }
    state.eventParams.push(params);
    return state.events;
  },
}));
vi.mock("./yaml-editor.tsx", () => ({ default: () => <div>YAML editor</div> }));

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
    types: new Map(),
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
    types: new Map(),
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
    types: new Map(),
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
    types: new Map(),
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
    types: new Map(),
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
  scroller.getBoundingClientRect = () => ({ left: 0, right: 100 }) as DOMRect;
  screen.getByRole("tab", { name: "Related, 12 Resources" }).getBoundingClientRect = () =>
    ({ left: 200, right: 280 }) as DOMRect;
  act(() => observers.find((observer) => observer.elements.includes(scroller))!.callback());
  expect(scroller.scrollLeft).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "More Facets" }));
  const choices = await screen.findAllByRole("menuitemradio");
  expect(
    choices.map((element) => element.getAttribute("aria-label") ?? element.textContent),
  ).toEqual(["YAML", "Events, 1 warning", "Related, 12 Resources"]);
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
