import type { Column, Row, Sort } from "@hukube/engine-client";

import { listColumns, type ListColumn } from "./columns.ts";

/** A column's identity and visibility, including cells a Cluster may not serve. */
export interface StoredColumn {
  source: "name" | "namespace" | "age" | "cell";
  name?: string;
  hidden?: boolean;
}

/** The whole ordered layout saved for one Resource Type. */
export interface StoredColumnLayout {
  version: 1;
  columns: StoredColumn[];
}

/** A stored or default layout resolved against this list's available columns. */
export interface ResolvedColumnLayout {
  /** The complete layout for the next edit, including unserved and hidden entries. */
  stored: StoredColumnLayout;
  /** Columns available here, in layout order, including hidden entries. */
  available: ListColumn[];
  /** Columns to render, respecting visibility and the selected Namespace. */
  shown: ListColumn[];
  /** The identity of the shown column that takes spare width, if any. */
  spare: string | undefined;
}

const isEvent = (type: string) => type === "events" || type === "events.events.k8s.io";

/** Source is part of the identity, even when a Cluster calls a cell Name. */
export function columnId(column: StoredColumn): string {
  return column.source === "cell" ? `cell:${column.name}` : column.source;
}

/** Reads version 1 layouts, discarding malformed and repeated entries. */
export function readColumnLayout(value: unknown): StoredColumnLayout | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("columns" in value) ||
    !Array.isArray(value.columns)
  )
    return null;
  const columns: StoredColumn[] = [];
  const seen = new Set<string>();
  for (const entry of value.columns) {
    if (!entry || typeof entry !== "object") continue;
    const { source, name, hidden } = entry;
    if (
      !["name", "namespace", "age", "cell"].includes(source) ||
      (source === "cell" ? typeof name !== "string" : name !== undefined) ||
      (hidden !== undefined && typeof hidden !== "boolean")
    )
      continue;
    const column: StoredColumn = {
      source,
      ...(source === "cell" ? { name } : {}),
      ...(hidden === undefined ? {} : { hidden }),
    };
    const id = columnId(column);
    if (seen.has(id)) continue;
    seen.add(id);
    columns.push(column);
  }
  return { version: 1, columns };
}

/** The type's built-in order and visibility for the columns a Cluster serves. */
export function defaultColumnLayout(
  type: string,
  namespaced: boolean,
  columns: Column[] = [],
): StoredColumnLayout {
  const served = new Map<string, Column>();
  for (const column of columns) {
    if (!served.has(column.name)) served.set(column.name, column);
  }
  const eventNames = ["Last Seen", "Type", "Reason", "Object", "Message"];
  const tunedEvent = isEvent(type) && eventNames.every((name) => served.has(name));
  const tunedPod = type === "pods" && served.has("Node");
  const entries: StoredColumn[] = [];
  const seen = new Set<string>();
  const add = (column: StoredColumn) => {
    const id = columnId(column);
    if (!seen.has(id)) {
      seen.add(id);
      entries.push(column);
    }
  };
  add({ source: "name", ...(tunedEvent ? { hidden: true } : {}) });
  if (namespaced) add({ source: "namespace" });
  if (tunedEvent) {
    for (const name of eventNames) add({ source: "cell", name });
  } else {
    for (const column of served.values()) {
      if (column.priority === 0) add({ source: "cell", name: column.name });
    }
    if (tunedPod) add({ source: "cell", name: "Node" });
  }
  add({ source: "age", ...(tunedEvent ? { hidden: true } : {}) });
  for (const column of served.values()) add({ source: "cell", name: column.name, hidden: true });
  return { version: 1, columns: entries };
}

/** Resolves a list's columns, retaining unserved entries and adding unknown ones. */
export function resolveColumnLayout({
  type,
  namespaced,
  oneNamespace,
  columns,
  rows,
  stored,
}: {
  type: string;
  namespaced: boolean;
  /** Whether exactly one Namespace is chosen, so every row is in the same one. */
  oneNamespace: boolean;
  columns: Column[] | undefined;
  rows: Row[];
  stored: StoredColumnLayout | null;
}): ResolvedColumnLayout {
  const defaults = defaultColumnLayout(type, namespaced, columns);
  const available = new Map<string, ListColumn>([
    ["name", { id: "name", source: "name", name: "Name", numeric: false }],
    ["age", { id: "age", source: "age", name: "Age", numeric: false }],
  ]);
  if (namespaced)
    available.set("namespace", {
      id: "namespace",
      source: "namespace",
      name: "Namespace",
      numeric: false,
    });
  for (const column of listColumns(columns, rows)) available.set(column.id, column);
  const entries = [...(stored ?? defaults).columns];
  const known = new Set(entries.map(columnId));
  for (const [index, column] of defaults.columns.entries()) {
    const id = columnId(column);
    if (known.has(id)) continue;
    const predecessor = defaults.columns.slice(0, index).findLast((c) => known.has(columnId(c)));
    const at = predecessor
      ? entries.findIndex((c) => columnId(c) === columnId(predecessor)) + 1
      : 0;
    entries.splice(at, 0, column);
    known.add(id);
  }
  let shown = entries
    .filter(
      (c) => available.has(columnId(c)) && !c.hidden && (c.source !== "namespace" || !oneNamespace),
    )
    .map((c) => available.get(columnId(c))!);
  if (shown.length === 0) {
    shown = [available.get("name")!];
    const index = entries.findIndex((c) => c.source === "name");
    // Keep the fallback shown in the next saved edit, so showing another column
    // does not unexpectedly hide Name.
    entries[index] = { source: "name" };
  }
  const preferred = isEvent(type) ? "cell:Message" : "name";
  const spare = shown.some((c) => c.id === preferred)
    ? preferred
    : shown.find((c) => c.source === "name")?.id;
  return {
    stored: { version: 1, columns: entries },
    available: entries.flatMap((c) =>
      available.has(columnId(c)) ? [available.get(columnId(c))!] : [],
    ),
    shown,
    spare,
  };
}

/** Changes visibility; returns undefined for no change or hiding the last shown column. */
export function showColumn(
  layout: ResolvedColumnLayout,
  id: string,
  show: boolean,
): StoredColumnLayout | undefined {
  const column = layout.stored.columns.find((c) => columnId(c) === id);
  if (!column || !column.hidden === show) return;
  if (!show && layout.shown.length === 1 && layout.shown[0]?.id === id) return;
  return {
    version: 1,
    columns: layout.stored.columns.map((c) => (columnId(c) === id ? { ...c, hidden: !show } : c)),
  };
}

/**
 * Moves a column to position in the shown list after removing that column.
 * Returns undefined for an unchanged or invalid position, or an unshown column.
 */
export function moveColumnTo(
  layout: ResolvedColumnLayout,
  id: string,
  position: number,
): StoredColumnLayout | undefined {
  const from = layout.shown.findIndex((c) => c.id === id);
  const others = layout.shown.filter((c) => c.id !== id);
  if (from === -1 || position === from || position < 0 || position > others.length) return;
  const entries = layout.stored.columns.filter((c) => columnId(c) !== id);
  const moving = layout.stored.columns.find((c) => columnId(c) === id)!;
  const next = position < from ? others[position] : undefined;
  const previous = others[position - 1];
  const at = next
    ? entries.findIndex((c) => columnId(c) === next.id)
    : previous
      ? entries.findIndex((c) => columnId(c) === previous.id) + 1
      : 0;
  entries.splice(at, 0, moving);
  return { version: 1, columns: entries };
}

/** Moves past the nearest shown column; returns undefined when it cannot move. */
export function moveColumn(
  layout: ResolvedColumnLayout,
  id: string,
  direction: -1 | 1,
): StoredColumnLayout | undefined {
  const index = layout.shown.findIndex((c) => c.id === id);
  return moveColumnTo(layout, id, index + direction);
}

/** The Engine sort for a list column, ascending. */
export function columnSort(column: ListColumn): Sort {
  return column.source === "cell"
    ? { field: "column", column: column.name }
    : { field: column.source };
}

/** Uses the requested sort while its column shows, otherwise name ascending. */
export function shownSort(sort: Sort, shown: ListColumn[]): Sort {
  return shown.some((c) => {
    const by = columnSort(c);
    return by.field === sort.field && by.column === sort.column;
  })
    ? sort
    : { field: "name" };
}
