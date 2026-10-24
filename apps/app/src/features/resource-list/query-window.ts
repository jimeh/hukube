import type { Expr, QueryResult, Row } from "@hukube/engine-client";
import { formatResourceUri, type TypeKey } from "@hukube/k8s";

const block = 100;

/**
 * The window of rows to subscribe to for the visible range [first, last].
 * Windows are aligned to blocks with a block of margin on each side, so
 * scrolling only changes the subscription when it nears the window's edge.
 */
export function windowFor(first: number, last: number): { offset: number; limit: number } {
  const offset = Math.max(0, (Math.floor(first / block) - 1) * block);
  const end = (Math.floor(last / block) + 2) * block;
  return { offset, limit: end - offset };
}

/** The row at a list index, if the current window holds it. */
export function rowAt(result: QueryResult | undefined, index: number): Row | undefined {
  if (!result || index < result.offset) return undefined;
  return result.rows[index - result.offset];
}

/** The Resource URI of a row, which keeps rows of different types apart. */
export function rowUri(cluster: string, row: Row): string {
  return formatResourceUri({
    cluster,
    type: row.type,
    namespace: row.namespace ?? "",
    name: row.name,
  });
}

/** A selected row: its Resource URI, once it has loaded, and its last known index. */
export interface ListSelection {
  key: string | undefined;
  index: number;
}

/**
 * The list index of a selection. Rows that arrive above it and a new sort move
 * its Resource, so this is where the window holds that Resource, or else the
 * last known index.
 */
export function selectedIndex(
  result: QueryResult | undefined,
  cluster: string,
  selection: ListSelection,
): number {
  if (result && selection.key !== undefined) {
    const at = result.rows.findIndex((row) => rowUri(cluster, row) === selection.key);
    if (at !== -1) return result.offset + at;
  }
  return selection.index;
}

export interface ListFilters {
  /** Whether the type is namespaced; Namespaces narrow only a namespaced type. */
  namespaced: boolean;
  /** Only Resources in these Namespaces, or in every Namespace when empty. */
  namespaces: readonly string[];
  /** Text the name must contain, case-insensitively. */
  name: string;
  /** A Kubernetes label selector, such as `app=web,tier!=db`. */
  selector: string;
}

/** The Query for one Resource Type, narrowed by any filters that are set. */
export function listQuery(type: TypeKey, filters: ListFilters): Expr {
  const args: Expr[] = [{ op: "in", field: "type", values: [type] }];
  if (filters.namespaced && filters.namespaces.length > 0)
    args.push({
      op: "in",
      field: "namespace",
      values: [...new Set(filters.namespaces)].toSorted(),
    });
  const name = filters.name.trim();
  if (name) args.push({ op: "contains", field: "name", values: [name] });
  const selector = filters.selector.trim();
  if (selector) args.push({ op: "selector", values: [selector] });
  return { op: "and", args };
}
