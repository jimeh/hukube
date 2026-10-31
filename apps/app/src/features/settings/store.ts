import { useEngine } from "@hukube/engine-client/react";
import type { EngineClient } from "@hukube/engine-client";
import { useSyncExternalStore } from "react";
import { createPreferenceStore } from "./preferences.ts";
const stores = new WeakMap<EngineClient, ReturnType<typeof createPreferenceStore>>();
export function getPreferenceStore(engine: EngineClient) {
  let store = stores.get(engine);
  if (!store) {
    let legacy: "light" | "dark" | undefined;
    try {
      const value = localStorage.getItem("hukube.theme");
      if (value === "light" || value === "dark") legacy = value;
    } catch {
      /* Storage may be unavailable. */
    }
    store = createPreferenceStore(engine, legacy, () => {
      try {
        localStorage.removeItem("hukube.theme");
      } catch {
        /* Engine remains authoritative. */
      }
    });
    stores.set(engine, store);
  }
  return store;
}
export function usePreferences() {
  const store = getPreferenceStore(useEngine());
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot) };
}
