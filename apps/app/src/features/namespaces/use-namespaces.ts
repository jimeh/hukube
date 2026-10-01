import { useSubscription } from "@hukube/engine-client/react";
import { useMemo } from "react";

export interface Namespaces {
  /** Namespace names, sorted. */
  names: string[];
  /** False when the Cluster has more Namespaces than were loaded. */
  complete: boolean;
}

const limit = 1000;

/**
 * The names of a Cluster's first thousand Namespaces, kept live while
 * enabled. Undefined until they load.
 */
export function useNamespaces(cluster: string, enabled = true): Namespaces | undefined {
  const { data } = useSubscription(
    "resources.query",
    enabled
      ? {
          cluster,
          where: { op: "in", field: "type", values: ["namespaces"] },
          sort: { field: "name" },
          offset: 0,
          limit,
        }
      : undefined,
  );
  return useMemo(
    () =>
      data && {
        names: data.rows.map((r) => r.name),
        complete: data.rows.length === data.total,
      },
    [data],
  );
}
