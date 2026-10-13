// @vitest-environment jsdom

import type { ResourceData, ResourceEvents } from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import { formatResourceUri } from "@hukube/k8s";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";

import { WorkspaceContext } from "../workspace/workspace-context.tsx";
import { ResourcePanel } from "./resource-panel.tsx";

const state = vi.hoisted(() => ({
  manifest: { stale: false } as SubscriptionState<ResourceData>,
  events: { stale: false } as SubscriptionState<ResourceEvents>,
}));
vi.mock("@hukube/engine-client/react", () => ({
  useSubscription: (method: string) => (method === "resource.get" ? state.manifest : state.events),
}));
vi.mock("./yaml-editor.tsx", () => ({ default: () => <div>YAML editor</div> }));

afterEach(() => {
  cleanup();
  state.manifest = { stale: false };
  state.events = { stale: false };
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
