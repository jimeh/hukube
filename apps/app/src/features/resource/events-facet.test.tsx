// @vitest-environment jsdom

import type { ResourceEvents } from "@hukube/engine-client";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventsBadge, EventsFacet, eventsTabName } from "./events-facet.tsx";
import type { FacetProps } from "./facet-props.ts";

const event = {
  uid: "one",
  type: "Warning",
  reason: "Failed",
  message: "<script>untrusted</script>",
  count: 3,
  lastSeen: new Date(Date.now() - 10_000).toISOString(),
  reporter: "kubelet",
  reporterInstance: "node-1",
};
const populated: ResourceEvents = { events: [event], warnings: 1, total: 1 };
const props: FacetProps = {
  address: { cluster: "c", type: "pods", namespace: "shop", name: "web" },
  kind: "Pod",
  manifest: { stale: false },
  events: { stale: false },
  showing: true,
  controls: null,
};
function show(events: FacetProps["events"], overrides: Partial<FacetProps> = {}) {
  return render(<EventsFacet {...props} {...overrides} events={events} />);
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Events Facet states", () => {
  it.each([false, true])("shows the header and three busy skeleton rows (stale: %s)", (stale) => {
    show({ stale, ...(stale ? { data: populated } : {}) });
    expect(screen.getByRole("region").getAttribute("aria-busy")).toBe("true");
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(1)) expect(within(row).getAllByRole("cell")).toHaveLength(5);
    expect(screen.queryByText(event.message)).toBeNull();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Last seen",
      "Type",
      "Reason",
      "Message",
      "From and count",
    ]);
  });
  it("explains a healthy Resource's empty state", () => {
    show({ stale: false, data: { events: [], total: 0, warnings: 0 } });
    expect(screen.getByText("No recent Events")).toBeDefined();
    expect(
      screen.getByText(
        "A cluster keeps Events for a limited time, usually one hour, so a healthy Pod often has none. New Events appear here as they happen.",
      ),
    ).toBeDefined();
  });
  it("renders populated rows as selectable text with accessible Warning text", () => {
    const { container } = show({ stale: false, data: populated });
    const row = screen.getByRole("row", { name: /Warning Failed/ });
    expect(within(row).getByRole("cell", { name: "Warning" })).toBeDefined();
    expect(within(row).getByText(event.message)).toBeDefined();
    expect(within(row).getByRole("cell", { name: "From kubelet, node-1 · 3 times" })).toBeDefined();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("region").tabIndex).toBe(0);
  });
  it("places the message and details after three metadata cells with accessible headers", () => {
    show({ stale: false, data: populated });
    const row = screen.getByRole("row", { name: /Warning Failed/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual([
      expect.stringMatching(/s$/),
      "Warning",
      "Failed",
      event.message,
      "From kubelet, node-1 · 3 times",
    ]);
    expect(cells[2]?.title).toBe(event.reason);
    expect(screen.getByRole("columnheader", { name: "From and count" }).className).toContain(
      "sr-only",
    );
    expect(screen.getByRole("columnheader", { name: "Message" }).className).toContain("sr-only");
  });
  it("trims the message and preserves its own line breaks", () => {
    show({
      stale: false,
      data: { ...populated, events: [{ ...event, message: "  first line\nsecond line  " }] },
    });
    const cells = within(screen.getByRole("row", { name: /Warning Failed/ })).getAllByRole("cell");
    expect(cells[3]?.textContent).toBe("first line\nsecond line");
  });
  it.each([
    ["kubelet", "node-1", 3, "From kubelet, node-1 · 3 times"],
    ["kubelet", "", 1, "From kubelet"],
    ["", "node-1", 1, "From node-1"],
    ["", "", 2, "2 times"],
    ["", "", 1, ""],
  ])(
    "renders reporter %s, instance %s, and count %s without empty parts",
    (reporter, reporterInstance, count, details) => {
      show({
        stale: false,
        data: { ...populated, events: [{ ...event, reporter, reporterInstance, count }] },
      });
      const cells = within(screen.getByRole("row", { name: /Warning Failed/ })).getAllByRole(
        "cell",
      );
      expect(cells).toHaveLength(5);
      expect(cells[4]?.textContent).toBe(details);
    },
  );
  it.each(["Normal", "__proto__", "constructor"])(
    "renders the untrusted type %s by value",
    (type) => {
      show({ stale: false, data: { ...populated, events: [{ ...event, type }] } });
      expect(screen.getByRole("cell", { name: type })).toBeDefined();
    },
  );
  it.each([true, false])(
    "replaces rows with permission guidance (namespaced: %s)",
    (namespaced) => {
      show(
        { stale: false, data: populated, error: { code: "forbidden", message: "denied" } },
        {
          address: { ...props.address, namespace: namespaced ? "shop" : "" },
          kind: namespaced ? "Pod" : "Node",
        },
      );
      expect(screen.getByText("Not permitted")).toBeDefined();
      expect(
        screen.getByText(
          namespaced
            ? "Your credentials cannot list Events in the shop Namespace."
            : "Showing the Events of a cluster-scoped Resource such as this Node needs permission to list Events in every Namespace.",
        ),
      ).toBeDefined();
      expect(screen.queryByRole("table")).toBeNull();
    },
  );
  it("shows an unavailable notice with no rows, including an empty last value", () => {
    show({
      stale: false,
      data: { events: [], total: 0, warnings: 0 },
      error: { code: "internal", message: "offline" },
    });
    expect(screen.getByText("Events unavailable")).toBeDefined();
    expect(screen.getByText("offline hukube keeps trying.")).toBeDefined();
  });
  it.each([
    ["forbidden", "Not permitted"],
    ["internal", "Events unavailable"],
  ] as const)("shows %s errors while the held value is stale", (code, title) => {
    show({ stale: true, data: populated, error: { code, message: "denied" } });
    expect(screen.getByText(title)).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(event.message)).toBeNull();
  });
  it("keeps rows during a watch failure and clears the error on recovery", () => {
    const view = show({
      stale: false,
      data: populated,
      error: { code: "internal", message: "offline" },
    });
    expect(screen.getByText("Events may be out of date: offline")).toBeDefined();
    expect(screen.getByText(event.message)).toBeDefined();
    view.rerender(<EventsFacet {...props} events={{ stale: false, data: populated }} />);
    expect(screen.queryByText("Events may be out of date: offline")).toBeNull();
  });
  it("keeps held rows and advances ages with the clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(event.lastSeen).getTime() + 10_000);
    show({ stale: false, data: populated });
    await act(async () => vi.advanceTimersByTime(1000));
    const cell = screen.getByTitle(event.lastSeen);
    expect(cell.textContent).toBe("11s");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(cell.textContent).toBe("21s");
  });
  it("shows a partial result below the Engine cap and omits the line for a complete result", () => {
    const view = show({ stale: false, data: { ...populated, total: 2 } });
    expect(screen.getByText("Showing the newest 1 of 2 Events.")).toBeDefined();
    view.rerender(<EventsFacet {...props} events={{ stale: false, data: populated }} />);
    expect(screen.queryByText(/Showing the newest/)).toBeNull();
  });
  it("shows the received count before the cap", () => {
    show({ stale: false, data: { ...populated, total: 1234 } });
    expect(screen.getByText("Showing the newest 1 of 1,234 Events.")).toBeDefined();
  });
});

describe("Events warning badge", () => {
  it("names its warning count and keeps it during a watch failure", () => {
    render(
      <button aria-label={eventsTabName({ ...props, events: { stale: false, data: populated } })}>
        <span>Events</span>
        <EventsBadge
          {...props}
          events={{
            stale: false,
            data: populated,
            error: { code: "internal", message: "offline" },
          }}
        />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Events, 1 warning" })).toBeDefined();
  });
  it("pluralizes multiple warnings", () => {
    expect(
      eventsTabName({ ...props, events: { stale: false, data: { ...populated, warnings: 3 } } }),
    ).toBe("Events, 3 warnings");
  });
  it.each([
    { stale: false },
    { stale: true, data: populated },
    { stale: false, data: populated, error: { code: "forbidden" as const, message: "denied" } },
    { stale: false, data: { ...populated, warnings: 0 } },
  ])("hides the badge for loading, forbidden, or no warnings: %j", (events) => {
    const { container } = render(<EventsBadge {...props} events={events} />);
    expect(container.childElementCount).toBe(0);
  });
});
