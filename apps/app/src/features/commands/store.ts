import { useSyncExternalStore } from "react";
import { useEngine } from "@hukube/engine-client/react";
import type { EngineClient } from "@hukube/engine-client";
import { commandPlatform } from "@/lib/platform.ts";
import { createKeyboardStore, type KeyboardStore } from "./persistence.ts";
const stores = new WeakMap<EngineClient, KeyboardStore>();
export function useKeybindings() {
  const engine = useEngine();
  let store = stores.get(engine);
  if (!store) {
    store = createKeyboardStore(engine, commandPlatform);
    stores.set(engine, store);
  }
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot) };
}
