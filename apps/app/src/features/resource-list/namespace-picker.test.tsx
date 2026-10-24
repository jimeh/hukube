// @vitest-environment jsdom
import type {
  EngineClient,
  QueryParams,
  QueryResult,
  ResourceType,
  SubscriptionListener,
  TypeState,
} from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { TooltipProvider } from "@hukube/ui/components/tooltip";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WorkspaceContext } from "@/features/workspace/workspace-context.tsx";

import { NamespacePicker } from "./namespace-picker.tsx";

interface FakeSubscription {
  params: QueryParams;
  listener: SubscriptionListener<QueryResult>;
  closed: boolean;
}

let subscriptions: FakeSubscription[] = [];
const client = {
  subscribe: (
    _method: string,
    params: QueryParams,
    listener: SubscriptionListener<QueryResult>,
  ) => {
    const sub: FakeSubscription = { params, listener, closed: false };
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
  getState: () => "open",
  onStateChange: () => () => {},
} as unknown as EngineClient;

const open = () => subscriptions.filter((sub) => !sub.closed);
/** The open subscription for the unfiltered Namespace list. */
const listing = () => open().find((sub) => sub.params.where?.op === "in");
/** The open subscription searching Namespaces by name, if any. */
const searching = () => open().find((sub) => sub.params.where?.op === "and");
const result = (names: string[], total = names.length): QueryResult => ({
  total,
  offset: 0,
  rows: names.map((name) => ({ uid: name, type: "namespaces", name, createdAt: "" })),
});
const respond = (sub: FakeSubscription | undefined, data: QueryResult) => {
  if (!sub) throw new Error("no subscription to respond to");
  act(() => sub.listener.data(data));
};

const namespaceType = (state: TypeState): ResourceType => ({
  key: "namespaces",
  group: "",
  version: "v1",
  resource: "namespaces",
  kind: "Namespace",
  namespaced: false,
  verbs: ["list", "watch"],
  state,
  count: 0,
});

function Harness({
  initial = [],
  state,
  active = true,
  onChange,
}: {
  initial?: string[];
  state?: TypeState;
  active?: boolean;
  onChange?: (value: string[]) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <EngineProvider client={client}>
      <TooltipProvider>
        <WorkspaceContext
          value={{
            cluster: "c",
            active,
            types: new Map(state ? [["namespaces", namespaceType(state)]] : []),
            openList: () => {},
            openResource: () => {},
            openExecSession: () => {},
          }}
        >
          <NamespacePicker
            value={value}
            onChange={(next) => {
              onChange?.(next);
              setValue(next);
            }}
          />
        </WorkspaceContext>
      </TooltipProvider>
    </EngineProvider>
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Namespace" });
async function openPopup() {
  fireEvent.click(trigger());
  return screen.findByRole("dialog", { name: "Namespaces" });
}
// Base UI's Status appends a word joiner so a repeated message is announced again.
const status = (popup: HTMLElement) =>
  popup.querySelector('[data-slot="combobox-status"]')?.textContent?.replaceAll("\u2060", "");
const options = (popup: HTMLElement) =>
  within(popup)
    .queryAllByRole("option")
    .map((option) => option.textContent);

beforeEach(() => {
  // jsdom has no layout, and the virtualized rows render only in a list that has a size.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(288);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  subscriptions = [];
});

it("says Namespaces are loading and keeps All namespaces and the chosen ones usable", async () => {
  const onChange = vi.fn<(value: string[]) => void>();
  render(<Harness initial={["shop"]} state="syncing" onChange={onChange} />);
  const popup = await openPopup();
  expect(status(popup)).toBe("Loading namespaces…");
  expect(options(popup)).toEqual(["All namespaces", "shop"]);
  fireEvent.click(within(popup).getByRole("option", { name: "All namespaces" }));
  expect(onChange).toHaveBeenLastCalledWith([]);
});

it.each([
  ["forbidden" as const, "Your credentials cannot list Namespaces."],
  ["failed" as const, "Could not list Namespaces."],
])("says when Namespaces are %s and marks no chosen one as not found", async (state, text) => {
  render(<Harness initial={["shop"]} state={state} />);
  respond(listing(), result([]));
  const popup = await openPopup();
  expect(status(popup)).toBe(text);
  expect(options(popup)).toEqual(["All namespaces", "shop"]);
});

it("marks a chosen Namespace the complete list lacks as not found", async () => {
  render(<Harness initial={["gone", "shop"]} state="ready" />);
  respond(listing(), result(["alpha", "shop"]));
  const popup = await openPopup();
  expect(status(popup)).toBe("");
  expect(options(popup)).toEqual(["All namespaces", "goneNot found", "shop", "alpha"]);
});

it("searches the Engine only while filtering a Cluster with more Namespaces than were loaded", async () => {
  render(<Harness state="ready" />);
  const loaded = Array.from({ length: 1000 }, (_, i) => `ns-${String(i).padStart(4, "0")}`);
  respond(listing(), result(loaded, 1432));
  const popup = await openPopup();
  expect(status(popup)).toBe("Showing 1,000 of 1,432 namespaces. Type to search the rest.");
  expect(searching()).toBeUndefined();

  const input = within(popup).getByRole("combobox", { name: "Filter namespaces" });
  fireEvent.change(input, { target: { value: "sho" } });
  expect(searching()?.params.where).toEqual({
    op: "and",
    args: [
      { op: "in", field: "type", values: ["namespaces"] },
      { op: "contains", field: "name", values: ["sho"] },
    ],
  });
  expect(status(popup)).toBe("Searching…");

  respond(
    searching(),
    result(
      Array.from({ length: 1000 }, (_, i) => `shop-${i}`),
      1210,
    ),
  );
  expect(status(popup)).toBe("Showing 1,000 of 1,210 matches. Type more to narrow them down.");

  fireEvent.change(input, { target: { value: "shop-1" } });
  expect(searching()?.params.where?.args?.[1]?.values).toEqual(["shop-1"]);
  expect(status(popup)).toBe("Searching…");
  respond(searching(), result(["shop-1", "shop-10"]));
  expect(status(popup)).toBe("");
  expect(options(popup)).toEqual(["shop-1", "shop-10"]);

  fireEvent.change(input, { target: { value: "" } });
  expect(searching()).toBeUndefined();
});

it("filters a complete list without searching the Engine", async () => {
  render(<Harness state="ready" />);
  respond(listing(), result(["alpha", "payments", "shop"]));
  const popup = await openPopup();
  fireEvent.change(within(popup).getByRole("combobox", { name: "Filter namespaces" }), {
    target: { value: "s" },
  });
  expect(options(popup)).toEqual(["payments", "shop"]);
  expect(searching()).toBeUndefined();
  expect(subscriptions).toHaveLength(1);
});

it("closes the popup when its Workspace stops being active", async () => {
  const view = render(<Harness state="ready" />);
  respond(listing(), result(["shop"]));
  await openPopup();
  view.rerender(<Harness state="ready" active={false} />);
  await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Namespaces" })).toBeNull());
});

it("returns to All namespaces from × and moves focus to the trigger", async () => {
  const onChange = vi.fn<(value: string[]) => void>();
  render(<Harness initial={["payments", "shop"]} state="ready" onChange={onChange} />);
  expect(trigger().textContent).toBe("payments+1 and 1 more");
  const clear = screen.getByRole("button", { name: "Show all namespaces" });
  clear.focus();
  fireEvent.click(clear);
  expect(onChange).toHaveBeenCalledWith([]);
  expect(screen.queryByRole("button", { name: "Show all namespaces" })).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(trigger().textContent).toBe("All namespaces");
});
