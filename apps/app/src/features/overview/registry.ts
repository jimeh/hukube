import type { EngineClient, Setting } from "@hukube/engine-client";
import { useEngine } from "@hukube/engine-client/react";
import { useSyncExternalStore } from "react";
import { isRecord } from "../edit/yaml.ts";
import { bundledDefinitions } from "./bundled.ts";
import { parseDefinition, registryLimit, type Definition } from "./definition.ts";

export interface Registry {
  version: 1;
  entries: Record<string, unknown>;
}
export interface RegistrySnapshot {
  status: "loading" | "ready" | "error";
  definitions: ReadonlyMap<string, Definition>;
  errors: ReadonlyMap<string, string>;
  registry?: Registry;
  revision?: string;
  error?: string;
}
export class EntryConflict extends Error {
  constructor() {
    super("This definition changed in another window. Review it and confirm replacement again.");
  }
}
function decode(value: unknown): Registry {
  if (value === null) return { version: 1, entries: {} };
  if (new TextEncoder().encode(JSON.stringify(value)).length > registryLimit)
    throw new Error("Stored Overview registry exceeds 2 MiB.");
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !isRecord(value["entries"]) ||
    Object.keys(value).some((k) => !["version", "entries"].includes(k))
  )
    throw new Error(
      "Stored Overview registry is malformed or uses an unsupported version. It has not been overwritten.",
    );
  return { version: 1, entries: value["entries"] };
}
function snapshot(setting: Setting): RegistrySnapshot {
  const registry = decode(setting.value);
  const definitions = new Map(bundledDefinitions);
  const errors = new Map<string, string>();
  for (const [key, source] of Object.entries(registry.entries)) {
    try {
      if (typeof source !== "string")
        throw new Error("Stored definition must be YAML source text.");
      const definition = parseDefinition(source);
      if (definition.resourceType !== key)
        throw new Error("Stored match does not agree with resourceType.");
      definitions.set(key, definition);
    } catch (error) {
      errors.set(key, String(error));
    }
  }
  return { status: "ready", definitions, errors, registry, revision: setting.revision };
}
export function createRegistryStore(
  client: Pick<EngineClient, "subscribe" | "request" | "getState" | "onStateChange">,
) {
  const key = "overview/definitions";
  let current: RegistrySnapshot = {
    status: "loading",
    definitions: bundledDefinitions,
    errors: new Map(),
  };
  const listeners = new Set<() => void>();
  let watch: { close(): void } | undefined;
  let epoch = 0;
  let freshSnapshot = false;
  let stopState: (() => void) | undefined;
  let readWaiters: { resolve(value: RegistrySnapshot): void; reject(error: unknown): void }[] = [];
  const show = (next: RegistrySnapshot) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown) => {
    freshSnapshot = false;
    show({
      ...current,
      status: "error",
      error: String(error),
    });
    for (const waiter of readWaiters.splice(0)) waiter.reject(error);
  };
  const open = () => {
    watch?.close();
    const generation = ++epoch;
    freshSnapshot = false;
    if (current.status === "loading") show({ ...current, error: undefined });
    watch = client.subscribe(
      "settings.watch",
      { key },
      {
        data: (setting) => {
          if (generation !== epoch) return;
          try {
            const next = snapshot(setting);
            freshSnapshot = true;
            show(next);
            for (const waiter of readWaiters.splice(0)) waiter.resolve(next);
          } catch (error) {
            fail(error);
          }
        },
        error: (error) => {
          if (generation === epoch) fail(error.message);
        },
      },
    );
  };
  const fresh = (): Promise<RegistrySnapshot> =>
    new Promise((resolve, reject) => {
      readWaiters.push({ resolve, reject });
      open();
    });
  let queue = Promise.resolve();
  const change = (type: string, source: string | undefined, observed: unknown): Promise<void> => {
    const run = async () => {
      let state = current;
      if (!freshSnapshot && state.registry) state = await fresh();
      if (state.status !== "ready" || !state.registry || state.revision === undefined)
        throw new Error("Load the persisted definitions successfully before saving.");
      for (let attempt = 0; attempt < 4; attempt++) {
        const actual = Object.hasOwn(state.registry!.entries, type)
          ? state.registry!.entries[type]
          : undefined;
        if (actual !== observed) throw new EntryConflict();
        const entries = Object.fromEntries(
          Object.entries(state.registry!.entries).filter(([k]) => k !== type),
        );
        if (source !== undefined) entries[type] = source;
        const value = { version: 1 as const, entries };
        decode(value);
        try {
          await client.request("settings.put", { key, value, ifRevision: state.revision! });
          await fresh();
          return;
        } catch (error) {
          const code = isRecord(error) ? error["code"] : undefined;
          if (!["conflict", "disconnected", "unavailable"].includes(String(code))) throw error;
          state = await fresh();
          const requested = Object.hasOwn(state.registry!.entries, type)
            ? state.registry!.entries[type]
            : undefined;
          if (code !== "conflict" && requested === source) return;
        }
      }
      throw new Error(
        "Definitions kept changing in other windows. Review the current registry and try again.",
      );
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!watch) {
        open();
        let previous = client.getState();
        stopState = client.onStateChange(() => {
          const next = client.getState();
          if (next === "open" && previous !== "open") open();
          previous = next;
        });
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          watch?.close();
          watch = undefined;
          epoch++;
          stopState?.();
          for (const waiter of readWaiters.splice(0))
            waiter.reject(new Error("Definition manager closed."));
        }
      };
    },
    retry: open,
    install: (source: string, observed: unknown) => {
      const d = parseDefinition(source);
      return change(d.resourceType, source, observed);
    },
    remove: (type: string, observed: unknown) => change(type, undefined, observed),
  };
}
const stores = new WeakMap<EngineClient, ReturnType<typeof createRegistryStore>>();
export function getRegistryStore(engine: EngineClient) {
  let store = stores.get(engine);
  if (!store) {
    store = createRegistryStore(engine);
    stores.set(engine, store);
  }
  return store;
}
export function useRegistry() {
  const store = getRegistryStore(useEngine());
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot) };
}
