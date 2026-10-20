import { useEngine } from "@hukube/engine-client/react";
import { useSyncExternalStore } from "react";
import { getCommandsStore } from "./commands-store.ts";

export function useCommands() {
  const store = getCommandsStore(useEngine());
  const commands = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { commands, commandFor: store.commandFor, run: store.run };
}
