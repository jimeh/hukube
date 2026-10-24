import type { Expr, QueryResult, Row } from "@hukube/engine-client";
import { formatResourceUri, type ResourceAddress, type TypeKey } from "@hukube/k8s";

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

/** The address of a row's Resource, as `openResource` takes it. */
export function rowAddress(row: Row): Omit<ResourceAddress, "cluster"> {
  return { type: row.type, namespace: row.namespace ?? "", name: row.name };
}

/** The Resource URI of a row, which keeps rows of different types apart. */
export function rowUri(cluster: string, row: Row): string {
  return formatResourceUri({ cluster, ...rowAddress(row) });
}

/**
 * A selected row: its Resource URI and address, once its row has loaded, and
 * the list index it was selected at or the window last held it at. The address
 * opens the Resource while the window does not hold it.
 */
export interface ListSelection {
  key: string | undefined;
  address: Omit<ResourceAddress, "cluster"> | undefined;
  index: number;
}

/** A selection of the row at a list index, which has no Resource until it loads. */
export function selectionAt(
  result: QueryResult | undefined,
  cluster: string,
  index: number,
): ListSelection {
  const row = rowAt(result, index);
  return row
    ? { key: rowUri(cluster, row), address: rowAddress(row), index }
    : { key: undefined, address: undefined, index };
}

/**
 * The list index of the row that shows a selection. Rows that arrive above it
 * and a new sort move its Resource, so this is where the window holds that
 * Resource. A row selected before it loaded shows at its index while the list
 * reaches it. Otherwise no row shows it: the Resource is scrolled out of the
 * window, filtered out, or deleted, and the row now at its last index is
 * another Resource.
 */
export function selectedIndex(
  result: QueryResult | undefined,
  cluster: string,
  selection: ListSelection,
): number | undefined {
  if (selection.key === undefined)
    return !result || selection.index < result.total ? selection.index : undefined;
  if (!result) return undefined;
  const at = result.rows.findIndex((row) => rowUri(cluster, row) === selection.key);
  return at === -1 ? undefined : result.offset + at;
}

/**
 * The list index an arrow key selects, `step` rows from the shown selection,
 * or undefined if the selection stays. A selection no row shows moves from its
 * last index, clamped to the list, which may have shrunk since.
 */
export function steppedIndex(
  selection: ListSelection | undefined,
  selected: number | undefined,
  step: number,
  total: number,
): number | undefined {
  if (selection && selected === undefined)
    return total === 0 ? undefined : Math.min(Math.max(selection.index + step, 0), total - 1);
  const index = (selected ?? -1) + step;
  return index >= 0 && index < total ? index : undefined;
}

export interface ListFilters {
  /** Only Resources in this Namespace, or every Namespace when null. */
  namespace: string | null;
  /** Text the name must contain, case-insensitively. */
  name: string;
  /** A Kubernetes label selector, such as `app=web,tier!=db`. */
  selector: string;
}

/** The Query for one Resource Type, narrowed by any filters that are set. */
export function listQuery(type: TypeKey, filters: ListFilters): Expr {
  const args: Expr[] = [{ op: "in", field: "type", values: [type] }];
  if (filters.namespace) args.push({ op: "in", field: "namespace", values: [filters.namespace] });
  const name = filters.name.trim();
  if (name) args.push({ op: "contains", field: "name", values: [name] });
  const selector = filters.selector.trim();
  if (selector) args.push({ op: "selector", values: [selector] });
  return { op: "and", args };
}
