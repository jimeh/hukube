import { expect, it } from "vitest";
import { EngineRequestError, type EngineClient, type Setting } from "@hukube/engine-client";
import { createRegistryStore, EntryConflict } from "./registry.ts";
import { bundledSources } from "./bundled.ts";
const widget = (type: string) =>
  `version: 1\nresourceType: ${type}\ntitle: Custom\nsections:\n  - id: main\n    title: Main\n    fields:\n      - {id: value, type: field, label: Value, path: [spec, value], format: text, edit: {type: string}}\n`;
function harness(value: unknown = null) {
  let revision = value === null ? "" : "1";
  let stored = value;
  const watches: {
    closed: boolean;
    listener: {
      data(setting: Setting): void;
      error(error: { code: string; message: string }): void;
    };
  }[] = [];
  let beforeWrite: (() => void) | undefined;
  let lost = false;
  let failure = false;
  let hold = false;
  let connection = "open";
  const stateListeners = new Set<() => void>();
  const puts: { value: unknown; ifRevision?: string }[] = [];
  const client = {
    subscribe: (
      _method: string,
      _params: unknown,
      listener: (typeof watches)[number]["listener"],
    ) => {
      const watch = { closed: false, listener };
      watches.push(watch);
      queueMicrotask(() => {
        if (!hold && !watch.closed)
          listener.data({ key: "overview/definitions", value: stored, revision });
      });
      return {
        close: () => {
          watch.closed = true;
        },
        update: () => {},
      };
    },
    request: async (_method: string, params: (typeof puts)[number]) => {
      puts.push(params);
      beforeWrite?.();
      beforeWrite = undefined;
      if (failure) throw new Error("disk full");
      if (params.ifRevision !== revision)
        throw new EngineRequestError({ code: "conflict", message: "changed" });
      stored = params.value;
      revision = String(Number(revision) + 1);
      if (lost) {
        lost = false;
        throw new EngineRequestError({ code: "disconnected", message: "lost answer" });
      }
      return {};
    },
    getState: () => connection,
    onStateChange: (fn: () => void) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
  } as unknown as EngineClient;
  const store = createRegistryStore(client);
  const stop = store.subscribe(() => {});
  const ready = async () => {
    await Promise.resolve();
    expect(store.getSnapshot().status).toBe("ready");
  };
  return {
    store,
    stop,
    ready,
    puts,
    watches,
    value: () => stored,
    concurrent: (entries: Record<string, unknown>) => {
      beforeWrite = () => {
        stored = { version: 1, entries };
        revision += "x";
      };
    },
    lose: () => {
      lost = true;
    },
    hold: () => {
      hold = true;
    },
    fail: () => {
      failure = true;
    },
    reconnect: (next: unknown) => {
      stored = next;
      connection = "reconnecting";
      for (const fn of stateListeners) fn();
      connection = "open";
      for (const fn of stateListeners) fn();
    },
  };
}
it("disables writes before a successful read and never overwrites malformed state", async () => {
  const h = harness({ version: 2, entries: {} });
  await expect(h.store.install(widget("widgets.test.dev"), undefined)).rejects.toThrow(/Load/);
  await Promise.resolve();
  expect(h.store.getSnapshot().status).toBe("error");
  expect(h.puts).toEqual([]);
  h.stop();
});
it("CAS on unset uses an explicit empty revision and fresh conflict reads preserve unrelated imports", async () => {
  const h = harness();
  await h.ready();
  h.concurrent({ "others.test.dev": widget("others.test.dev") });
  await h.store.install(widget("widgets.test.dev"), undefined);
  expect(h.puts[0]!.ifRevision).toBe("");
  expect(h.watches[0]!.closed).toBe(true);
  expect((h.value() as { entries: object }).entries).toEqual({
    "widgets.test.dev": widget("widgets.test.dev"),
    "others.test.dev": widget("others.test.dev"),
  });
  h.stop();
});
it("requires new explicit intent for same-entry replacement and removal races", async () => {
  const source = widget("widgets.test.dev");
  const newer = source.replace("Custom", "Newer");
  for (const remove of [false, true]) {
    const h = harness({ version: 1, entries: { "widgets.test.dev": source } });
    await h.ready();
    h.concurrent({ "widgets.test.dev": newer });
    await expect(
      remove
        ? h.store.remove("widgets.test.dev", source)
        : h.store.install(source.replace("Custom", "Mine"), source),
    ).rejects.toBeInstanceOf(EntryConflict);
    expect((h.value() as { entries: object }).entries).toEqual({ "widgets.test.dev": newer });
    h.stop();
  }
});
it("recognizes a lost write answer through a reopened watch and serializes local operations", async () => {
  const h = harness();
  await h.ready();
  h.lose();
  await Promise.all([
    h.store.install(widget("first.test.dev"), undefined),
    h.store.install(widget("second.test.dev"), undefined),
  ]);
  expect(Object.keys((h.value() as { entries: object }).entries)).toEqual([
    "first.test.dev",
    "second.test.dev",
  ]);
  expect(h.watches.length).toBeGreaterThan(2);
  h.stop();
});
it("retains errors and source when saving fails; bad entries do not disable built-ins", async () => {
  const h = harness({ version: 1, entries: { "broken.test.dev": "bad yaml" } });
  await h.ready();
  expect(h.store.getSnapshot().definitions.size).toBe(14);
  expect(h.store.getSnapshot().errors.has("broken.test.dev")).toBe(true);
  h.fail();
  await expect(h.store.install(widget("widgets.test.dev"), undefined)).rejects.toThrow("disk full");
  expect((h.value() as { entries: object }).entries).toEqual({ "broken.test.dev": "bad yaml" });
  h.stop();
});
it("custom definitions override bundled matches, removal restores them, and reconnect reloads", async () => {
  const source = bundledSources["configmaps"]!.replace("ConfigMap", "Custom ConfigMap");
  const h = harness();
  await h.ready();
  await h.store.install(source, undefined);
  expect(h.store.getSnapshot().definitions.get("configmaps")!.title).toBe("Custom ConfigMap");
  await h.store.remove("configmaps", source);
  expect(h.store.getSnapshot().definitions.get("configmaps")!.title).toBe("ConfigMap");
  h.reconnect({ version: 1, entries: { "widgets.test.dev": widget("widgets.test.dev") } });
  await h.ready();
  expect(h.store.getSnapshot().definitions.has("widgets.test.dev")).toBe(true);
  h.stop();
});

it("retains the settled snapshot during refresh and reports readback errors", async () => {
  const h = harness();
  await h.ready();
  const previous = h.store.getSnapshot();
  h.store.retry();
  expect(h.store.getSnapshot().status).toBe("ready");
  expect(h.store.getSnapshot().definitions).toBe(previous.definitions);
  expect(h.store.getSnapshot().registry).toBe(previous.registry);
  h.watches.at(-1)!.listener.error({ code: "unavailable", message: "refresh failed" });
  expect(h.store.getSnapshot().error).toContain("refresh failed");
  expect(h.store.getSnapshot().definitions).toBe(previous.definitions);
  h.stop();
});

it("waits for actual save readback and rejects its failure while retaining the display snapshot", async () => {
  for (const failure of [false, true]) {
    const h = harness();
    await h.ready();
    const previous = h.store.getSnapshot();
    h.hold();
    let settled = false;
    const source = widget("widgets.test.dev");
    const saving = h.store.install(source, undefined);
    void saving.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // The reopened watch is an observable boundary after the put completed.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.watches).toHaveLength(2);
    expect(h.store.getSnapshot()).toBe(previous);
    h.watches[0]!.listener.data({ key: "overview/definitions", value: null, revision: "" });
    await Promise.resolve();
    expect(settled).toBe(false);
    const outcome = saving.then(
      () => undefined,
      (error) => String(error),
    );
    if (failure)
      h.watches.at(-1)!.listener.error({ code: "unavailable", message: "readback failed" });
    else
      h.watches.at(-1)!.listener.data({
        key: "overview/definitions",
        value: { version: 1, entries: { "widgets.test.dev": source } },
        revision: "1",
      });
    expect(await outcome).toBe(failure ? "readback failed" : undefined);
    expect(h.store.getSnapshot().error).toBe(failure ? "readback failed" : undefined);
    expect(h.store.getSnapshot().definitions.has("widgets.test.dev")).toBe(!failure);
    h.stop();
  }
});
