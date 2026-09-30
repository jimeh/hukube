import { useEngine } from "@hukube/engine-client/react";
import type { DockviewApi } from "dockview-react";
import { useEffect } from "react";

import { persistLayout } from "./layout-persistence.ts";

/** Persists a Cluster's Workspace layout in the Engine while it is open. */
export function useLayoutPersistence(api: DockviewApi | undefined, cluster: string): void {
  const client = useEngine();
  useEffect(() => {
    if (!api) return;
    return persistLayout(client, api, `workspace/${cluster}`);
  }, [api, client, cluster]);
}
