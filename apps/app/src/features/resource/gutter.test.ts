import { expect, it } from "vitest";
import { gutterChanges, replacement } from "./gutter.ts";
it.each([
  ["a\n", "a\nb\n", [{ kind: "added", line: 2, count: 1 }]],
  ["a\nb\n", "z\nb\n", [{ kind: "modified", line: 1, count: 1 }]],
  ["a\nb\n", "b\n", [{ kind: "deleted", line: 1, count: 1, before: true }]],
  ["a\nb\n", "a\n", [{ kind: "deleted", line: 1, count: 1, before: false }]],
  [
    "a\nb\nc\n",
    "x\ny\n",
    [
      { kind: "modified", line: 1, count: 2 },
      { kind: "deleted", line: 2, count: 1, before: false },
    ],
  ],
  ["a\n", "", [{ kind: "deleted", line: 1, count: 1, before: true }]],
  ["", "a\n", [{ kind: "added", line: 1, count: 1 }]],
])("maps add/modify/delete and BOF/EOF/mixed hunks %s -> %s", (before, after, expected) =>
  expect(gutterChanges(before, after).changes).toEqual(expected),
);
it("normalizes CRLF to Monaco lines but retains final-newline changes", () => {
  expect(gutterChanges("a\r\n", "a\n").changes).toEqual([]);
  expect(gutterChanges("a", "a\n").changes).toHaveLength(1);
});
it("keeps input intact and reports bounded size/edit work", () => {
  expect(gutterChanges("a", "b", { size: 1, timeout: 1, maxEditLength: 1 }).limited).toBe(true);
  expect(
    gutterChanges("a\nb\n", "x\ny\n", { size: 100, timeout: 10, maxEditLength: 0 }).limited,
  ).toBe(true);
});
it("finds the smallest replacement range", () =>
  expect(replacement("before old after", "before new after")).toEqual({
    start: 7,
    end: 10,
    text: "new",
  }));
