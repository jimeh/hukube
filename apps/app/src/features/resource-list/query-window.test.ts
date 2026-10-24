import { describe, expect, it } from "vitest";

import {
  listQuery,
  rowAt,
  rowUri,
  selectedIndex,
  selectionAt,
  steppedIndex,
  windowFor,
  type ListSelection,
} from "./query-window.ts";

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
const selection = (type: string, name: string, index: number): ListSelection => ({
  key: key(type, name),
  address: { type, namespace: "default", name },
  index,
});
const unloaded = (index: number): ListSelection => ({
  key: undefined,
  address: undefined,
  index,
});

describe("selection", () => {
  // Both Event types serve the same Event under the same name.
  const result = {
    total: 500,
    offset: 100,
    rows: [row("events", "a"), row("events.events.k8s.io", "b"), row("events", "b")],
  };

  it("selects a loaded row's Resource, and an unloaded row by its index", () => {
    expect(selectionAt(result, "c", 102)).toEqual(selection("events", "b", 102));
    expect(selectionAt(result, "c", 99)).toEqual(unloaded(99));
  });

  it("shows a Resource where the window holds it, and steps from there", () => {
    expect(selectedIndex(result, "c", selection("events", "b", 100))).toBe(102);
    expect(selectedIndex(result, "c", selection("events.events.k8s.io", "b", 7))).toBe(101);
    expect(steppedIndex(selection("events", "a", 100), 100, 1, 500)).toBe(101);
    expect(steppedIndex(selection("events", "a", 100), 100, -1, 500)).toBe(99);
    expect(steppedIndex(selection("events", "a", 499), 499, 1, 500)).toBeUndefined();
    expect(steppedIndex(selection("events", "a", 0), 0, -1, 500)).toBeUndefined();
  });

  it("shows no row for a Resource the window does not hold, and steps from its last index", () => {
    // Scrolled away, filtered out, or deleted: another Resource is at its index.
    const away = selection("events", "z", 101);
    expect(selectedIndex(result, "c", away)).toBeUndefined();
    expect(selectedIndex(undefined, "c", away)).toBeUndefined();
    expect(steppedIndex(away, undefined, 1, 500)).toBe(102);
    expect(steppedIndex(away, undefined, -1, 500)).toBe(100);
    // Clamped to a list that has shrunk, or ends at the last index.
    expect(steppedIndex(away, undefined, -1, 3)).toBe(2);
    expect(steppedIndex(selection("events", "z", 0), undefined, -1, 3)).toBe(0);
    expect(steppedIndex(away, undefined, 1, 0)).toBeUndefined();
  });

  it("shows a row chosen before it loaded at its index until it loads", () => {
    expect(selectedIndex(result, "c", unloaded(99))).toBe(99);
    expect(selectedIndex(undefined, "c", unloaded(99))).toBe(99);
    expect(steppedIndex(unloaded(99), 99, 1, 500)).toBe(100);
    expect(steppedIndex(unloaded(99), 99, -1, 500)).toBe(98);
  });

  it("shows no row for a row chosen before it loaded once the list ends before it", () => {
    // Deletions can shrink the list before the chosen row arrives.
    const shrunk = { total: 3, offset: 0, rows: [row("events", "a")] };
    expect(selectedIndex(shrunk, "c", unloaded(99))).toBeUndefined();
    expect(steppedIndex(unloaded(99), undefined, -1, 3)).toBe(2);
    expect(steppedIndex(unloaded(99), undefined, 1, 3)).toBe(2);
  });

  it("starts at the first row when nothing is selected", () => {
    expect(steppedIndex(undefined, undefined, 1, 500)).toBe(0);
    expect(steppedIndex(undefined, undefined, -1, 500)).toBeUndefined();
    expect(steppedIndex(undefined, undefined, 1, 0)).toBeUndefined();
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
