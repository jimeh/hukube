import { ColumnTypeTimestamp, type Column, type Row } from "@hukube/engine-client";
import { formatAge } from "@hukube/k8s";

/** An available column, from the list itself or the Cluster's Table. */
export interface ListColumn {
  id: string;
  source: "name" | "namespace" | "age" | "cell";
  name: string;
  /** The position of the column's value in each Row's cells. */
  index?: number;
  /** The type of the Column the cells come from. */
  type?: string;
  /** Whether the column holds numbers, which align right. */
  numeric: boolean;
}

/**
 * Column widths in characters, by column identity. A Cluster chooses the names, so
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
 * Every distinct column a Cluster serves, keeping the first cell of a name.
 * A column is numeric when the Cluster declares it so or, because built-in
 * types declare columns of numbers as strings, when every value in rows is a
 * number.
 */
export function listColumns(columns: Column[] | undefined, rows: Row[]): ListColumn[] {
  const shown: ListColumn[] = [];
  const seen = new Set<string>();
  for (const [index, column] of (columns ?? []).entries()) {
    if (seen.has(column.name)) continue;
    seen.add(column.name);
    const values = rows
      .map((row) => row.cells?.[index])
      .filter((v) => v !== null && v !== undefined);
    const numeric =
      column.type === "integer" ||
      column.type === "number" ||
      (values.length > 0 && values.every((v) => typeof v === "number"));
    shown.push({
      id: `cell:${column.name}`,
      source: "cell",
      name: column.name,
      index,
      type: column.type,
      numeric,
    });
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
 * The time in milliseconds a cell of a timestamp column holds, which the
 * Engine read from its Resource. Undefined for any other cell.
 */
export function cellTime(column: { type?: string }, value: unknown): number | undefined {
  if (column.type !== ColumnTypeTimestamp || typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * The text a list shows for one cell at the time now. A timestamp cell shows
 * the age since its time, as kubectl prints ages, and any other cell its text.
 */
export function cellDisplay(column: { type?: string }, value: unknown, now: number): string {
  const time = cellTime(column, value);
  return time === undefined ? cellText(value) : formatAge(new Date(time), new Date(now));
}

/**
 * Widens columns to fit their header and their cells in rows at the time now,
 * up to a limit. Widths never shrink, so columns stay put while a list
 * scrolls and updates. Returns the given widths when nothing grew.
 */
export function growWidths(
  widths: ColumnWidths,
  columns: ListColumn[],
  rows: Row[],
  now: number,
): ColumnWidths {
  let grown: Map<string, number> | undefined;
  for (const column of columns) {
    let width = Math.max(widths.get(column.id) ?? 0, column.name.length + headerExtraChars);
    for (const row of rows) {
      if (width >= maxChars) break;
      const value =
        column.source === "name"
          ? row.name
          : column.index !== undefined && row.cells
            ? cellDisplay(column, row.cells[column.index], now)
            : "";
      width = Math.max(width, value.length);
    }
    width = Math.min(width, maxChars);
    if (width !== widths.get(column.id)) {
      grown ??= new Map(widths);
      grown.set(column.id, width);
    }
  }
  return grown ?? widths;
}

/**
 * The CSS grid columns of a list's header and rows, and the least width they
 * need, including a trailing track for the header action. Character widths
 * use the cells' monospace font.
 */
export function gridLayout(
  columns: ListColumn[],
  widths: ColumnWidths,
  spare: string | undefined,
): { template: string; minWidth: string } {
  // Each track is [what it shrinks to, what it grows to].
  const tracks: [min: string, max: string][] = columns.map((column) => {
    if (column.id === spare) return ["12rem", "2fr"];
    if (column.source === "namespace") return ["8rem", "1fr"];
    if (column.source === "age") return ["5rem", "5rem"];
    const width = `${widths.get(column.id) ?? column.name.length + headerExtraChars}ch`;
    return [width, width];
  });
  // The action stays at the right end, so its track takes the spare width
  // when no column does.
  const flexible = tracks.some(([min, max]) => min !== max);
  tracks.push(["2rem", flexible ? "2rem" : "1fr"]);
  return {
    template: tracks.map(([min, max]) => (min === max ? min : `minmax(${min}, ${max})`)).join(" "),
    // The tracks, the gaps between them, and the padding at both ends.
    minWidth: `calc(${tracks.map(([min]) => min).join(" + ")} + ${(tracks.length + 1) * 0.75}rem)`,
  };
}
