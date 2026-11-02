/** First surviving sequence at or after the anchor, otherwise the last row. */
export function sequenceIndex(sequences: readonly number[], sequence: number): number {
  return Math.min(sequenceLowerBound(sequences, sequence), sequences.length - 1);
}

export function sequenceLowerBound(sequences: readonly number[], sequence: number): number {
  let low = 0;
  let high = sequences.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sequences[middle]! < sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** A suffix of the old projection must be an identical prefix of the new one. */
export function sequenceEdits(
  shown: readonly number[],
  next: readonly number[],
): { removed: number; appended: number } | undefined {
  const removed = next.length ? sequenceLowerBound(shown, next[0]!) : shown.length;
  const kept = shown.length - removed;
  if (kept > next.length) return undefined;
  for (let i = 0; i < kept; i++) if (shown[removed + i] !== next[i]) return undefined;
  return { removed, appended: next.length - kept };
}

export interface SequencePosition {
  sequence: number;
  column: number;
  /** The trailing empty model line belongs after the final row's newline. */
  afterRow?: boolean;
}

export function anchorPosition(
  sequences: readonly number[],
  line: number,
  column: number,
): SequencePosition | undefined {
  const sequence = sequences[Math.min(Math.max(0, line - 1), sequences.length - 1)];
  return sequence === undefined
    ? undefined
    : { sequence, column, ...(line > sequences.length ? { afterRow: true } : {}) };
}

export function restorePosition(
  sequences: readonly number[],
  anchor: SequencePosition,
  maxColumn: (line: number) => number,
): { lineNumber: number; column: number } {
  // An after-row endpoint is before the first strictly newer row. Missing
  // ordinary endpoints also stop at the following row's start, never inside it.
  const index = sequenceLowerBound(sequences, anchor.sequence + (anchor.afterRow ? 1 : 0));
  const lineNumber = index + 1;
  return {
    lineNumber,
    column:
      !anchor.afterRow && sequences[index] === anchor.sequence
        ? Math.min(anchor.column, maxColumn(lineNumber))
        : 1,
  };
}

/** The watermark belongs to original arrivals, never the last projected row. */
export function newProjectedRows(sequences: readonly number[], watermark: number): number {
  return sequences.length - sequenceLowerBound(sequences, watermark);
}
