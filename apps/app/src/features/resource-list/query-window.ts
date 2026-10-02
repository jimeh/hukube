import type { Expr, QueryResult, Row } from "@hukube/engine-client";
import type { TypeKey } from "@hukube/k8s";

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
