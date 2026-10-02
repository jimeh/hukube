import { describe, expect, it } from "vitest";

import { listQuery, rowAt, windowFor } from "./query-window.ts";

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
