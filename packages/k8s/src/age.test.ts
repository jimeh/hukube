import { describe, expect, it } from "vitest";

import { formatAge } from "./age.ts";

const now = new Date("2026-06-01T00:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("formatAge", () => {
  // Expected values match kubectl's HumanDuration at each boundary.
  it.each([
    [-5, "0s"],
    [0, "0s"],
    [119, "119s"],
    [120, "2m"],
    [9 * 60 + 5, "9m5s"],
    [10 * 60 + 5, "10m"],
    [179 * 60, "179m"],
    [3 * 3600 + 5 * 60, "3h5m"],
    [8 * 3600, "8h"],
    [47 * 3600, "47h"],
    [48 * 3600 + 3600, "2d1h"],
    [8 * 86400, "8d"],
    [729 * 86400, "729d"],
    [2 * 365 * 86400 + 3 * 86400, "2y3d"],
    [9 * 365 * 86400, "9y"],
  ])("%is ago is %s", (seconds, want) => {
    expect(formatAge(ago(seconds), now)).toBe(want);
  });
});
