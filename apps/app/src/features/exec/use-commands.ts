import type { EngineClient } from "@hukube/engine-client";
import { useEngine } from "@hukube/engine-client/react";
import { useSyncExternalStore } from "react";
import { createCommandsStore } from "./commands-store.ts";

const stores = new WeakMap<EngineClient, ReturnType<typeof createCommandsStore>>();
export function useCommands() {
  const engine = useEngine();
  let store = stores.get(engine);
  if (!store) {
    store = createCommandsStore(engine);
    stores.set(engine, store);
  }
  const commands = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { commands, commandFor: store.commandFor, run: store.run };
}
