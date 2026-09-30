import type { Cluster } from "@hukube/engine-client";
import { useConnectionState, useEngine } from "@hukube/engine-client/react";
import { useCallback, useEffect, useState } from "react";

interface ClustersState {
  clusters?: Cluster[];
  error?: string;
  reload: () => void;
}

/** The Clusters in the Engine's kubeconfig, loaded once connected. */
export function useClusters(): ClustersState {
  const client = useEngine();
  const connection = useConnectionState();
  const [state, setState] = useState<Omit<ClustersState, "reload">>({});

  const reload = useCallback(() => {
    client.request("clusters.list", undefined).then(
      (clusters) => setState({ clusters }),
      (err: unknown) => setState({ error: err instanceof Error ? err.message : String(err) }),
    );
  }, [client]);

  useEffect(() => {
    if (connection === "open") reload();
  }, [connection, reload]);

  return { ...state, reload };
}
