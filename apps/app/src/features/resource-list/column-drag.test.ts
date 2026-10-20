import { describe, expect, it } from "vitest";

import { dropEdge, dropPosition, headerCollision } from "./column-drag.ts";

function collision(id: string, left: number, x: number, y = 24) {
  const bounds = { left, right: left + 100, top: 10, bottom: 38 };
  return headerCollision({
    droppable: {
      id,
      shape: {
        boundingRectangle: bounds,
        center: { x: left + 50, y: 24 },
        containsPoint: (point: { x: number; y: number }) =>
          point.x >= bounds.left &&
          point.x <= bounds.right &&
          point.y >= bounds.top &&
          point.y <= bounds.bottom,
      },
    },
    dragOperation: { position: { current: { x, y } } },
  } as Parameters<typeof headerCollision>[0]);
}

describe("headerCollision", () => {
  it("prefers the header under the pointer", () => {
    expect(collision("first", 0, 60)!.priority).toBeGreaterThan(
      collision("last", 112, 60)!.priority,
    );
  });

  it.each([-40, 400])("prefers the nearest end when the pointer is at %i", (x) => {
    const first = collision("first", 0, x)!;
    const last = collision("last", 112, x)!;
    expect(first.value > last.value).toBe(x < 0);
  });

  it.each([9, 39, 200])("accepts no header when the pointer is vertically outside at %i", (y) => {
    expect(collision("first", 0, 60, y)).toBeNull();
    expect(collision("last", 112, 400, y)).toBeNull();
  });

  it("accepts the row's vertical edges", () => {
    expect(collision("first", 0, -40, 10)).not.toBeNull();
    expect(collision("last", 112, 400, 38)).not.toBeNull();
  });
});

describe("dropEdge", () => {
  const header = { left: 100, right: 200 };
  it.each([
    [40, "left"],
    [149, "left"],
    [150, "right"],
    [260, "right"],
  ] as const)("takes the nearer edge of the header for a pointer at %i", (x, edge) => {
    expect(dropEdge(x, header)).toBe(edge);
  });
});

// Positions are those `moveColumnTo` takes: among the shown columns without
// the one being moved.
describe("dropPosition", () => {
  const shown = ["a", "b", "c", "d"];
  it.each([
    ["a", "c", "left", 1],
    ["a", "c", "right", 2],
    ["a", "d", "right", 3],
    ["d", "b", "left", 1],
    ["d", "b", "right", 2],
    ["d", "a", "left", 0],
    // Either edge of a neighbor that faces the column is where it already is.
    ["b", "c", "left", 1],
    ["b", "a", "right", 1],
  ] as const)("drops %s at the %s edge of %s", (source, target, edge, position) => {
    expect(dropPosition(shown, source, target, edge)).toBe(position);
  });

  it.each([
    ["b", "b"],
    ["b", "constructor"],
    ["__proto__", "b"],
  ])("has no position for %s dropped on %s", (source, target) => {
    expect(dropPosition(shown, source, target, "left")).toBeUndefined();
  });
});
