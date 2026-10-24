import { describe, expect, it } from "vitest";

import { listQuery, rowAt, rowUri, selectedIndex, windowFor } from "./query-window.ts";

describe("windowFor", () => {
  it.each([
    [0, 40, { offset: 0, limit: 200 }],
    [99, 130, { offset: 0, limit: 300 }],
    [250, 290, { offset: 100, limit: 300 }],
  ])("covers rows %i to %i with a margin", (first, last, want) => {
    const w = windowFor(first, last);
    expect(w).toEqual(want);
    expect(w.offset).toBeLessThanOrEqual(first);
    expect(w.offset + w.limit).toBeGreaterThan(last);
  });

  it("does not change while scrolling within a block", () => {
    expect(windowFor(210, 250)).toEqual(windowFor(230, 270));
  });
});

describe("rowAt", () => {
  const result = {
    total: 500,
    offset: 100,
    rows: [{ uid: "a", type: "pods", name: "a", createdAt: "" }],
  };
  it("maps list indexes into the window", () => {
    expect(rowAt(result, 100)?.uid).toBe("a");
    expect(rowAt(result, 99)).toBeUndefined();
    expect(rowAt(result, 101)).toBeUndefined();
    expect(rowAt(undefined, 0)).toBeUndefined();
  });
});

const row = (type: string, name: string) => ({
  uid: name,
  type,
  namespace: "default",
  name,
  createdAt: "",
});
const key = (type: string, name: string) => rowUri("c", row(type, name));

describe("selectedIndex", () => {
  // Both Event types serve the same Event under the same name.
  const result = {
    total: 500,
    offset: 100,
    rows: [row("events", "a"), row("events.events.k8s.io", "b"), row("events", "b")],
  };

  it("follows the selected Resource to where the window holds it", () => {
    expect(selectedIndex(result, "c", { key: key("events", "b"), index: 100 })).toBe(102);
    expect(selectedIndex(result, "c", { key: key("events.events.k8s.io", "b"), index: 7 })).toBe(
      101,
    );
  });

  it("keeps the last known index while the window does not hold the Resource", () => {
    expect(selectedIndex(result, "c", { key: key("events", "z"), index: 7 })).toBe(7);
    expect(selectedIndex(undefined, "c", { key: key("events", "b"), index: 7 })).toBe(7);
  });

  it("keeps the index of a row that had not loaded when it was selected", () => {
    expect(selectedIndex(result, "c", { key: undefined, index: 101 })).toBe(101);
  });
});

describe("listQuery", () => {
  const type = { op: "in", field: "type", values: ["pods"] };

  it("omits blank filters", () => {
    expect(listQuery("pods", { namespace: null, name: " ", selector: "  " })).toEqual({
      op: "and",
      args: [type],
    });
  });

  it("adds each filter that is set, trimmed", () => {
    expect(
      listQuery("pods", { namespace: "default", name: " web ", selector: " app=web " }),
    ).toEqual({
      op: "and",
      args: [
        type,
        { op: "in", field: "namespace", values: ["default"] },
        { op: "contains", field: "name", values: ["web"] },
        { op: "selector", values: ["app=web"] },
      ],
    });
  });
});
