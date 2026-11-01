import { expect, it } from "vitest";
import {
  anchorPosition,
  newProjectedRows,
  restorePosition,
  sequenceEdits,
  sequenceIndex,
} from "./log-editor-sequences.ts";

it("diffs sparse append and head pruning, including no surviving rows, without interpreting gaps as arrivals", () => {
  expect(sequenceEdits([1, 5, 9], [5, 9, 20])).toEqual({ removed: 1, appended: 1 });
  expect(sequenceEdits([1, 5], [20, 30])).toEqual({ removed: 2, appended: 2 });
  expect(sequenceEdits([], [4, 8])).toEqual({ removed: 0, appended: 2 });
  expect(sequenceEdits([4, 8], [])).toEqual({ removed: 2, appended: 0 });
  expect(sequenceEdits([1, 5, 9], [1, 9])).toBeUndefined();
  expect(sequenceEdits([5, 9], [1, 5, 9])).toBeUndefined();
});

it("anchors both selection endpoints and top rows by sequence across append, pruning and rewrites, clamping columns", () => {
  const start = anchorPosition([2, 5, 10], 2, 19)!;
  const end = anchorPosition([2, 5, 10], 3, 2)!;
  expect(restorePosition([5, 10, 30], start, () => 8)).toEqual({ lineNumber: 1, column: 8 });
  expect(restorePosition([5, 10, 30], end, () => 8)).toEqual({ lineNumber: 2, column: 2 });
  expect(restorePosition([2, 10], start, () => 30)).toEqual({ lineNumber: 2, column: 19 });
  expect(restorePosition([2], end, () => 1)).toEqual({ lineNumber: 1, column: 1 });
  expect(anchorPosition([], 1, 1)).toBeUndefined();
  expect(sequenceIndex([2, 5, 10], 6)).toBe(2);
  expect(sequenceIndex([2, 5, 10], 100)).toBe(2);
  expect(sequenceIndex([2, 5, 10], 0)).toBe(0);
  // Empty projections keep the caller's old anchor, so all/no/all restores it.
  expect(restorePosition([2, 5, 10], start, () => 30)).toEqual({ lineNumber: 2, column: 19 });
});

it("counts Newest against the original next-sequence watermark despite filter changes, hidden tails and eviction", () => {
  const watermark = 10; // Original rows 0..9 had arrived when following stopped.
  expect(newProjectedRows([1, 5], watermark)).toBe(0);
  expect(newProjectedRows([1, 5, 9], watermark)).toBe(0);
  expect(newProjectedRows([1, 5, 12, 90], watermark)).toBe(2);
  expect(newProjectedRows([90], watermark)).toBe(1);
  expect(newProjectedRows([], watermark)).toBe(0);
});

it("preserves the trailing newline endpoint across unchanged projections, append and head eviction", () => {
  const end = anchorPosition([2, 5, 10], 4, 1)!;
  expect(restorePosition([2, 5, 10], end, () => 20)).toEqual({ lineNumber: 4, column: 1 });
  expect(restorePosition([2, 5, 10, 30], end, () => 20)).toEqual({ lineNumber: 4, column: 1 });
  expect(restorePosition([5, 10, 30], end, () => 20)).toEqual({ lineNumber: 3, column: 1 });
});

it("keeps after-row affinity through rewrite and empty projection recovery with the same removal fallback", () => {
  const end = anchorPosition([2, 5, 10], 4, 1)!;
  expect(restorePosition([2, 5, 10], end, () => 3)).toEqual({ lineNumber: 4, column: 1 });
  expect(restorePosition([2, 5], end, () => 20)).toEqual({ lineNumber: 3, column: 1 });
  expect(restorePosition([2, 30, 40], end, () => 20)).toEqual({ lineNumber: 3, column: 1 });
  expect(anchorPosition([], 1, 1)).toBeUndefined();
  expect(restorePosition([2, 5, 10], end, () => 20)).toEqual({ lineNumber: 4, column: 1 });
});

it("distinguishes a caret at the final row start from one after its newline", () => {
  const start = anchorPosition([2, 5, 10], 3, 1)!;
  const after = anchorPosition([2, 5, 10], 4, 1)!;
  expect(restorePosition([5, 10, 30], start, () => 20)).toEqual({ lineNumber: 2, column: 1 });
  expect(restorePosition([5, 10, 30], after, () => 20)).toEqual({ lineNumber: 3, column: 1 });
});
