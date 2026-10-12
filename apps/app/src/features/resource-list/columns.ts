import type { Column, Row } from "@hukube/engine-client";

/** A column a list shows between a Resource's name and its age. */
export interface ListColumn {
  name: string;
  /** The position of the column's value in each Row's cells. */
  index: number;
  /** Whether the column holds numbers, which align right. */
  numeric: boolean;
}

/**
 * Column widths in characters, by column name. A Cluster chooses the names, so
 * this is a Map: an object would answer for `constructor` or `__proto__`.
 */
export type ColumnWidths = ReadonlyMap<string, number>;

/** What a cell without a value shows, as in `kubectl get`. */
export const noValue = "<none>";

/** The widest a column grows to fit its cells; longer cells are cut short. */
const maxChars = 48;
/** Room a header needs beside its label for the sort arrow. */
const headerExtraChars = 3;

/**
 * The columns a list shows: the ones `kubectl get` shows without `-o wide`.
 * A column is numeric when the Cluster declares it so or, because built-in
 * types declare columns of numbers as strings, when every value in rows is a
 * number.
 */
export function listColumns(columns: Column[] | undefined, rows: Row[]): ListColumn[] {
  const shown: ListColumn[] = [];
  for (const [index, column] of (columns ?? []).entries()) {
    if (column.priority > 0) continue;
    const values = rows
      .map((row) => row.cells?.[index])
      .filter((v) => v !== null && v !== undefined);
    const numeric =
      column.type === "integer" ||
      column.type === "number" ||
      (values.length > 0 && values.every((v) => typeof v === "number"));
    shown.push({ name: column.name, index, numeric });
  }
  return shown;
}

/** The text a list shows for one cell. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return noValue;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Widens columns to fit their header and their cells in rows, up to a limit.
 * Widths never shrink, so columns stay put while a list scrolls and updates.
 * Returns the given widths when nothing grew.
 */
export function growWidths(widths: ColumnWidths, columns: ListColumn[], rows: Row[]): ColumnWidths {
  let grown: Map<string, number> | undefined;
  for (const column of columns) {
    let width = Math.max(widths.get(column.name) ?? 0, column.name.length + headerExtraChars);
    for (const row of rows) {
      if (width >= maxChars) break;
      if (row.cells) width = Math.max(width, cellText(row.cells[column.index]).length);
    }
    width = Math.min(width, maxChars);
    if (width !== widths.get(column.name)) {
      grown ??= new Map(widths);
      grown.set(column.name, width);
    }
  }
  return grown ?? widths;
}

/**
 * The CSS grid columns of a list's header and rows, and the least width they
 * need. Both are measured in `ch`, so the element they style must use the
 * cells' monospace font.
 */
export function gridLayout(
  showNamespace: boolean,
  columns: ListColumn[],
  widths: ColumnWidths,
): { template: string; minWidth: string } {
  // Each track is [what it shrinks to, what it grows to].
  const tracks: [min: string, max: string][] = [["12rem", "2fr"]];
  if (showNamespace) tracks.push(["8rem", "1fr"]);
  for (const column of columns) {
    const width = `${widths.get(column.name) ?? column.name.length + headerExtraChars}ch`;
    tracks.push([width, width]);
  }
  tracks.push(["5rem", "5rem"]);
  return {
    template: tracks.map(([min, max]) => (min === max ? min : `minmax(${min}, ${max})`)).join(" "),
    // The tracks, the gaps between them, and the padding at both ends.
    minWidth: `calc(${tracks.map(([min]) => min).join(" + ")} + ${(tracks.length + 1) * 0.75}rem)`,
  };
}
