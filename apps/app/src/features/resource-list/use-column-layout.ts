import { useEngine } from "@hukube/engine-client/react";
import { useMemo, useSyncExternalStore } from "react";

import { createColumnLayoutStore } from "./column-layout-store.ts";

/** Watches and edits a Resource Type's layout for this list's lifetime. */
export function useColumnLayout(type: string) {
  const client = useEngine();
  const store = useMemo(() => createColumnLayoutStore(client, type), [client, type]);
  const stored = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { stored, put: store.put };
}
