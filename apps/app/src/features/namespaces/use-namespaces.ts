import type { Expr } from "@hukube/engine-client";
import { useSubscription } from "@hukube/engine-client/react";
import { useMemo } from "react";

export interface Namespaces {
  /** Namespace names, sorted. */
  names: string[];
  /** False when the Cluster has more Namespaces than were loaded. */
  complete: boolean;
  /** How many Namespaces match, loaded or not. */
  total: number;
  /** True while the names are for earlier params, such as an older search. */
  stale: boolean;
}

export const namespaceLimit = 1000;

/**
 * The names of a Cluster's first thousand Namespaces, kept live while
 * enabled, or of those whose names contain `search` when it is not empty.
 * Undefined until they load.
 */
export function useNamespaces(
  cluster: string,
  enabled = true,
  search = "",
): Namespaces | undefined {
  const type: Expr = { op: "in", field: "type", values: ["namespaces"] };
  const { data, stale } = useSubscription(
    "resources.query",
    enabled
      ? {
          cluster,
          where: search
            ? { op: "and", args: [type, { op: "contains", field: "name", values: [search] }] }
            : type,
          sort: { field: "name" },
          offset: 0,
          limit: namespaceLimit,
        }
      : undefined,
  );
  return useMemo(
    () =>
      data && {
        names: data.rows.map((r) => r.name),
        complete: data.rows.length === data.total,
        total: data.total,
        stale,
      },
    [data, stale],
  );
}
