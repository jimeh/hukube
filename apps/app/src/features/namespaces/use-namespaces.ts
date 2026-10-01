import { useSubscription } from "@hukube/engine-client/react";
import { useMemo } from "react";

/**
 * The names of a Cluster's Namespaces, sorted, kept live while enabled.
 * Undefined until they load.
 */
export function useNamespaces(cluster: string, enabled = true): string[] | undefined {
  const { data } = useSubscription(
    "resources.query",
    enabled
      ? {
          cluster,
          where: { op: "in", field: "type", values: ["namespaces"] },
          sort: { field: "name" },
          offset: 0,
          limit: 1000,
        }
      : undefined,
  );
  return useMemo(() => data?.rows.map((r) => r.name), [data]);
}
