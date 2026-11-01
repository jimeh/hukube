// @vitest-environment jsdom
import type {
  EngineClient,
  QueryParams,
  QueryResult,
  ResourceType,
  Row,
  SubscriptionListener,
} from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { TooltipProvider } from "@hukube/ui/components/tooltip";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WorkspaceContext, type WorkspaceValue } from "@/features/workspace/workspace-context.tsx";

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
    if (method === "settings.watch") {
      let closed = false;
      queueMicrotask(() => {
        if (!closed)
          (listener as unknown as SubscriptionListener<{ value: null }>).data({ value: null });
      });
      return {
        update: () => {},
        close: () => {
          closed = true;
        },
      };
    }
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
  type = "services",
  panelId = `list:${type}`,
  openResource = () => {},
}: {
  types: ResourceType[];
  namespaces?: string[];
  type?: string;
  panelId?: string;
  openResource?: WorkspaceValue["openResource"];
}) {
  return (
    <EngineProvider client={client}>
      <TooltipProvider>
        <WorkspaceContext
          value={{
            cluster: "c",
            active: true,
            types: new Map(types.map((resourceType) => [resourceType.key, resourceType])),
            openList: () => {},
            openResource,
            openExecSession: () => {},
          }}
        >
          <ResourceListPanel
            panelId={panelId}
            type={type}
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
  // jsdom has no layout; give the real virtualizer a measured viewport.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(288);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

const eventTypes = ["events", "events.events.k8s.io"];
const lastSeenColumns = [{ name: "Last Seen", type: "timestamp", priority: 0 }];
const withoutCells = (row: Row) => ({ ...row, cells: undefined });
const selectedNames = (grid: HTMLElement) =>
  within(grid)
    .queryAllByRole("row", { selected: true })
    .map((row) => within(row).getAllByRole("gridcell")[0]?.textContent);

async function renderEvents(type: string) {
  const eventRow = (name: string, hour: number): Row => ({
    uid: name,
    type,
    namespace: "shop",
    name,
    createdAt: "2026-11-01T00:00:00Z",
    cells: [`2026-11-01T0${hour}:00:00Z`],
  });
  const alpha = eventRow("Alpha", 1);
  const bravo = eventRow("Bravo", 3);
  const charlie = eventRow("Charlie", 4);
  const delta = eventRow("Delta", 5);
  const openResource = vi.fn<WorkspaceValue["openResource"]>();
  const panelId = `list:${type}`;
  render(
    <Harness
      types={[{ ...services, key: type, resource: "events", kind: "Event" }]}
      type={type}
      panelId={panelId}
      openResource={openResource}
    />,
  );
  const publish = (
    rows: Row[],
    table: Pick<QueryResult, "columns"> = { columns: lastSeenColumns },
  ) => {
    const subs = queries(type);
    expect(subs).toHaveLength(1);
    respond(subs, { total: rows.length, offset: 0, rows, ...table });
  };
  publish([charlie, bravo, alpha]);
  const grid = screen.getByRole("grid", { name: "Event resources" });
  await within(grid).findByRole("row", { name: /Charlie/ });
  expect(queries(type)[0]?.params.sort).toEqual({ field: "column", column: "Last Seen" });
  return { grid, publish, openResource, panelId, alpha, bravo, charlie, delta };
}

it.each(
  eventTypes.flatMap((type) => [
    { type, order: "Table first" },
    { type, order: "metadata first" },
  ]),
)("keeps the last complete position after deletion ($type, $order)", async ({ type, order }) => {
  const { grid, publish, openResource, panelId, alpha, bravo, charlie, delta } =
    await renderEvents(type);
  fireEvent.click(within(grid).getByRole("row", { name: /Charlie/ }));
  expect(selectedNames(grid)).toEqual(["Charlie"]);
  if (order === "Table first") {
    // Table deletion sorts the still-indexed Resource last until metadata catches up.
    publish([bravo, alpha, { ...charlie, cells: undefined }]);
  }
  expect(selectedNames(grid)).toEqual(["Charlie"]);
  publish([bravo, alpha]);
  expect(selectedNames(grid)).toEqual([]);
  publish([bravo, alpha, { ...delta, cells: undefined }]);
  expect(selectedNames(grid)).toEqual([]);
  publish([delta, bravo, alpha]);
  expect(selectedNames(grid)).toEqual([]);

  openResource.mockClear();
  fireEvent.keyDown(grid, { key: "Enter" });
  expect(openResource).toHaveBeenCalledExactlyOnceWith(
    { type, namespace: "shop", name: "Charlie" },
    { preview: false, beside: panelId },
  );
  fireEvent.keyDown(grid, { key: "ArrowDown" });
  expect(selectedNames(grid)).toEqual(["Bravo"]);
});

it.each(eventTypes)("resumes remembering the position when cells return (%s)", async (type) => {
  const { grid, publish, alpha, bravo, charlie, delta } = await renderEvents(type);
  fireEvent.click(within(grid).getByRole("row", { name: /Charlie/ }));
  publish([bravo, alpha, { ...charlie, cells: undefined }]);
  expect(selectedNames(grid)).toEqual(["Charlie"]);
  publish([bravo, { ...charlie, cells: ["2026-11-01T02:00:00Z"] }, alpha]);
  expect(selectedNames(grid)).toEqual(["Charlie"]);
  publish([bravo, alpha]);
  publish([delta, bravo, alpha]);
  expect(selectedNames(grid)).toEqual([]);
  fireEvent.keyDown(grid, { key: "ArrowDown" });
  expect(selectedNames(grid)).toEqual(["Alpha"]);
});

it.each([
  { label: "null sort value", cells: [null] },
  { label: "absent optional sort value", cells: [] },
])("remembers a complete cells array with $label", async ({ cells }) => {
  const { grid, publish, alpha, bravo, charlie, delta } = await renderEvents("events");
  fireEvent.click(within(grid).getByRole("row", { name: /Charlie/ }));
  publish([bravo, alpha, { ...charlie, cells }]);
  expect(selectedNames(grid)).toEqual(["Charlie"]);
  publish([bravo, alpha]);
  publish([delta, bravo, alpha]);
  expect(selectedNames(grid)).toEqual([]);
  fireEvent.keyDown(grid, { key: "ArrowDown" });
  expect(selectedNames(grid)).toEqual(["Alpha"]);
});

it.each(eventTypes)(
  "remembers name-order fallback positions when columns are absent (%s)",
  async (type) => {
    const { grid, publish, alpha, bravo, charlie, delta } = await renderEvents(type);
    fireEvent.click(within(grid).getByRole("row", { name: /Charlie/ }));
    // Last Seen remains requested, but without Table columns the Engine orders by name.
    publish([alpha, bravo, charlie].map(withoutCells), {});
    expect(queries(type)[0]?.params.sort).toEqual({ field: "column", column: "Last Seen" });
    expect(selectedNames(grid)).toEqual(["Charlie"]);
    publish([alpha, bravo].map(withoutCells), {});
    publish([alpha, bravo, delta].map(withoutCells), {});
    expect(selectedNames(grid)).toEqual([]);
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(selectedNames(grid)).toEqual(["Bravo"]);
  },
);

it.each(eventTypes)(
  "keeps identity through arrivals and re-sorts, then clears it on filtering (%s)",
  async (type) => {
    const { grid, publish, openResource, alpha, bravo, charlie, delta } = await renderEvents(type);
    fireEvent.click(within(grid).getByRole("row", { name: /Bravo/ }));
    publish([delta, charlie, bravo, alpha]);
    expect(selectedNames(grid)).toEqual(["Bravo"]);

    fireEvent.click(screen.getByRole("columnheader", { name: "Last Seen" }));
    expect(queries(type)[0]?.params.sort).toEqual({
      field: "column",
      column: "Last Seen",
      desc: true,
    });
    publish([alpha, bravo, charlie, delta]);
    expect(selectedNames(grid)).toEqual(["Bravo"]);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(selectedNames(grid)).toEqual(["Charlie"]);

    openResource.mockClear();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter by name" }), {
      target: { value: "Bravo" },
    });
    expect(selectedNames(grid)).toEqual([]);
    publish([bravo]);
    expect(selectedNames(grid)).toEqual([]);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(openResource).not.toHaveBeenCalled();
  },
);
