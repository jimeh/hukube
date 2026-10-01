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

/** The Query for one Resource Type, optionally narrowed by namespace and name. */
export function listQuery(type: TypeKey, namespace: string | null, name: string): Expr {
  const args: Expr[] = [{ op: "in", field: "type", values: [type] }];
  if (namespace) args.push({ op: "in", field: "namespace", values: [namespace] });
  if (name.trim()) args.push({ op: "contains", field: "name", values: [name.trim()] });
  return { op: "and", args };
}
