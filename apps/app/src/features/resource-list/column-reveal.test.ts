import { describe, expect, it } from "vitest";

import { columnRevealDelta } from "./column-reveal.ts";

describe("columnRevealDelta", () => {
  const viewport = { left: 100, right: 900 };
  const menu = { left: 700, right: 920 };

  it("leaves a fully visible column alone, even beneath a menu", () => {
    expect(columnRevealDelta({ left: 100, right: 900 }, viewport, menu)).toBe(0);
    expect(columnRevealDelta({ left: 720, right: 800 }, viewport, menu)).toBe(0);
  });

  it("centers a clipped column in the viewport without a menu", () => {
    expect(columnRevealDelta({ left: 880, right: 1000 }, viewport, undefined)).toBe(440);
    expect(columnRevealDelta({ left: 20, right: 140 }, viewport, undefined)).toBe(-420);
  });

  it("centers beside a menu when there is room on either side", () => {
    expect(columnRevealDelta({ left: 880, right: 1000 }, viewport, menu)).toBe(540);
    expect(columnRevealDelta({ left: 20, right: 140 }, viewport, { left: 80, right: 300 })).toBe(
      -520,
    );
  });

  it("uses the whole viewport when neither side can fit the column", () => {
    expect(columnRevealDelta({ left: 850, right: 1050 }, viewport, { left: 200, right: 800 })).toBe(
      450,
    );
  });
});
