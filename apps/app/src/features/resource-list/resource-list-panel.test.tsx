// @vitest-environment jsdom
import type {
  EngineClient,
  QueryParams,
  QueryResult,
  ResourceType,
  SubscriptionListener,
} from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { TooltipProvider } from "@hukube/ui/components/tooltip";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WorkspaceContext } from "@/features/workspace/workspace-context.tsx";

import { ResourceListPanel } from "./resource-list-panel.tsx";

const { FakeResizeObserver } = vi.hoisted(() => {
  const observer = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // The column headers' drag-and-drop reads ResizeObserver when it loads.
  vi.stubGlobal("ResizeObserver", observer);
  return { FakeResizeObserver: observer };
});

interface FakeSubscription {
  method: string;
  params: QueryParams;
  listener: SubscriptionListener<QueryResult>;
  closed: boolean;
}

let subscriptions: FakeSubscription[] = [];
const client = {
  subscribe: (method: string, params: QueryParams, listener: SubscriptionListener<QueryResult>) => {
    const sub: FakeSubscription = { method, params, listener, closed: false };
    subscriptions.push(sub);
    return {
      update: (next: QueryParams) => {
        sub.params = next;
      },
      close: () => {
        sub.closed = true;
      },
    };
  },
  request: () => Promise.resolve(undefined),
  getState: () => "open",
  onStateChange: () => () => {},
} as unknown as EngineClient;

const queries = (type: string) =>
  subscriptions.filter(
    (sub) =>
      !sub.closed &&
      sub.method === "resources.query" &&
      JSON.stringify(sub.params.where).includes(`"values":["${type}"]`),
  );
const result = (type: string, names: string[]): QueryResult => ({
  total: names.length,
  offset: 0,
  rows: names.map((name) => ({ uid: name, type, name, createdAt: "" })),
});
const respond = (subs: FakeSubscription[], data: QueryResult) =>
  act(() => {
    for (const sub of subs) sub.listener.data(data);
  });

const services: ResourceType = {
  key: "services",
  group: "",
  version: "v1",
  resource: "services",
  kind: "Service",
  namespaced: true,
  verbs: ["list", "watch"],
  state: "ready",
  count: 0,
};

const namespacesType: ResourceType = {
  ...services,
  key: "namespaces",
  resource: "namespaces",
  kind: "Namespace",
  namespaced: false,
};

function Harness({
  types,
  namespaces = ["shop"],
}: {
  types: ResourceType[];
  namespaces?: string[];
}) {
  return (
    <EngineProvider client={client}>
      <TooltipProvider>
        <WorkspaceContext
          value={{
            cluster: "c",
            active: true,
            types: new Map(types.map((type) => [type.key, type])),
            openList: () => {},
            openResource: () => {},
            openExecSession: () => {},
          }}
        >
          <ResourceListPanel
            panelId="list:services"
            type="services"
            namespaces={namespaces}
            onNamespacesChange={() => {}}
            onInteract={() => {}}
          />
        </WorkspaceContext>
      </TooltipProvider>
    </EngineProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  subscriptions = [];
});

it("keeps the Namespace popup open with its filter while the Resource Types reload", async () => {
  const view = render(<Harness types={[services]} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Namespace" }));
  const popup = await screen.findByRole("dialog", { name: "Namespaces" });
  const input = within(popup).getByRole("combobox", { name: "Filter namespaces" });
  fireEvent.change(input, { target: { value: "team-b" } });

  // A restarted Engine lists no Resource Types until its discovery completes.
  view.rerender(<Harness types={[]} />);
  view.rerender(<Harness types={[services]} />);

  expect(screen.getByRole("dialog", { name: "Namespaces" })).toBe(popup);
  expect(input).toHaveProperty("value", "team-b");
  expect(document.activeElement).toBe(input);
});

it("says the chosen Namespace is not found, looking the Namespaces up only for an empty list", () => {
  render(<Harness types={[services, namespacesType]} namespaces={["gone"]} />);
  // The Namespace control's own list.
  expect(queries("namespaces")).toHaveLength(1);
  respond(queries("services"), result("services", ["web"]));
  expect(queries("namespaces")).toHaveLength(1);

  respond(queries("services"), result("services", []));
  expect(queries("namespaces")).toHaveLength(2);
  expect(screen.getByText("No Service resources in gone")).toBeTruthy();
  respond(queries("namespaces"), result("namespaces", ["shop"]));
  expect(screen.getByText("gone not found")).toBeTruthy();
});
