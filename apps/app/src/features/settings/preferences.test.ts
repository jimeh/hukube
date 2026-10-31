import { afterEach, expect, it, vi } from "vitest";
import { EngineRequestError, type EngineClient, type Setting } from "@hukube/engine-client";
import {
  createPreferenceStore,
  defaults,
  maximums,
  numericValue,
  preferenceSchema,
  type PreferenceStore,
} from "./preferences.ts";
const stores: PreferenceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});
function harness(initial: unknown = null, legacy?: "light" | "dark") {
  let value = initial,
    revision = initial === null ? "" : "initial",
    state = "open";
  let holdRead = false;
  let write: ((params: { value: unknown; ifRevision: string }) => Promise<void>) | undefined;
  const watches: {
    closed: boolean;
    listener: { data(value: Setting): void; error(error: { code: string; message: string }): void };
  }[] = [];
  const stateListeners = new Set<() => void>();
  const puts: { value: unknown; ifRevision: string }[] = [];
  const emit = () => {
    for (const watch of watches)
      if (!watch.closed) watch.listener.data({ key: "app/preferences", value, revision });
  };
  const client = {
    getState: () => state,
    onStateChange: (fn: () => void) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    subscribe: (
      _method: string,
      _params: unknown,
      listener: (typeof watches)[number]["listener"],
    ) => {
      const watch = { closed: false, listener };
      watches.push(watch);
      queueMicrotask(() => {
        if (!holdRead && !watch.closed) listener.data({ key: "app/preferences", value, revision });
      });
      return {
        close: () => {
          watch.closed = true;
        },
        update() {},
      };
    },
    request: async (_method: string, params: (typeof puts)[number]) => {
      puts.push(params);
      if (write) return write(params);
      if (params.ifRevision !== revision)
        throw new EngineRequestError({ code: "conflict", message: "changed" });
      value = params.value;
      revision += "x";
      return {};
    },
  } as unknown as EngineClient;
  const retired = vi.fn<() => void>();
  const store = createPreferenceStore(client, legacy, retired);
  stores.push(store);
  return {
    store,
    puts,
    watches,
    retired,
    value: () => value,
    emit,
    remote: (next: unknown) => {
      value = next;
      revision += "r";
      emit();
    },
    read: (held: boolean) => {
      holdRead = held;
    },
    write: (fn?: typeof write) => {
      write = fn;
    },
    connection: (next: string) => {
      state = next;
      for (const fn of stateListeners) fn();
    },
  };
}
async function ready(h: ReturnType<typeof harness>) {
  await vi.waitFor(() => expect(h.store.getSnapshot().fresh).toBe(true));
}
async function saved(h: ReturnType<typeof harness>, field: keyof typeof defaults) {
  await vi.waitFor(() => expect(h.store.getSnapshot().drafts[field]?.status).toBe("Saved"));
}
it("validates missing fields, defaults, numeric syntax, both bounds and supported unknown properties", () => {
  expect(preferenceSchema.parse({ version: 1, future: 42 })).toMatchObject({ future: 42 });
  for (const [field, max] of Object.entries(maximums)) {
    expect(numericValue(field as keyof typeof maximums, " 001 ")).toBe(1);
    expect(numericValue(field as keyof typeof maximums, String(max))).toBe(max);
    for (const text of [
      "",
      " ",
      "-1",
      "+1",
      "1.0",
      "1e2",
      "1,000",
      "0",
      String(max + 1),
      "9999999999999999999999",
    ])
      expect(() => numericValue(field as keyof typeof maximums, text)).toThrow(/./);
  }
  for (const value of [
    { version: 2 },
    { version: 1, appearance: null },
    { version: 1, logStreams: { wrap: null } },
    { version: 1, logStreams: { maxLines: 1.5 } },
  ])
    expect(() => preferenceSchema.parse(value)).toThrow(/./);
});
it("waits for a validated read, uses explicit empty CAS, commits only valid submitted fields and requires readback", async () => {
  const h = harness();
  h.read(true);
  h.store.change("wrap", false);
  expect(h.puts).toHaveLength(0);
  h.read(false);
  h.emit();
  await ready(h);
  h.store.edit("maxLines", "");
  h.store.change("timestamps", true);
  await saved(h, "timestamps");
  expect(Object.keys(h.store.getSnapshot().drafts).toSorted()).toEqual([
    "maxLines",
    "timestamps",
    "wrap",
  ]);
  expect(h.store.getSnapshot().drafts.wrap).toMatchObject({ value: false, status: "Not saved" });
  expect(h.puts[0]!.ifRevision).toBe("");
  expect(h.value()).toEqual({ version: 1, appearance: {}, logStreams: { timestamps: true } });
  expect(h.store.getSnapshot().values.maxLines).toBe(50000);
  h.read(true);
  h.store.change("wrap", false);
  await vi.waitFor(() => expect(h.puts).toHaveLength(2));
  expect(h.store.getSnapshot().drafts.wrap?.status).toBe("Saving");
  h.read(false);
  h.emit();
  await saved(h, "wrap");
});
it("merges disjoint remote fields and unknown properties, preserves same-field conflicts and explicitly rebases keep mine", async () => {
  const h = harness({ version: 1, future: 4, logStreams: { wrap: true, extra: "kept" } });
  await ready(h);
  h.store.edit("maxLines", "12");
  h.remote({
    version: 1,
    future: 4,
    appearance: { theme: "light" },
    logStreams: { wrap: false, extra: "kept" },
  });
  h.store.commit(["maxLines"]);
  await saved(h, "maxLines");
  expect(h.value()).toMatchObject({
    future: 4,
    appearance: { theme: "light" },
    logStreams: { maxLines: 12, wrap: false, extra: "kept" },
  });
  h.store.edit("maxLines", "13");
  h.remote({ version: 1, logStreams: { maxLines: 14 } });
  h.store.commit(["maxLines"]);
  expect(h.store.getSnapshot().drafts.maxLines).toMatchObject({ value: "13", conflict: true });
  expect(h.puts).toHaveLength(1);
  h.store.commit(["maxLines"], true);
  await saved(h, "maxLines");
  expect(h.store.getSnapshot().values.maxLines).toBe(13);
});
it("keeps runtime confirmed on disk failure and reset failure; discards only unsent drafts", async () => {
  const h = harness({
    version: 1,
    logStreams: { maxLines: 100000 },
    appearance: { theme: "light" },
  });
  await ready(h);
  h.write(async () => {
    throw new EngineRequestError({ code: "internal", message: "disk full" });
  });
  h.store.reset("logStreams");
  await vi.waitFor(() => expect(h.store.getSnapshot().drafts.maxLines?.error).toBe("disk full"));
  expect(h.store.getSnapshot().values.maxLines).toBe(100000);
  expect(h.store.getSnapshot().values.theme).toBe("light");
  h.store.discard(["maxLines"]);
  expect(h.store.getSnapshot().drafts.maxLines).toBeUndefined();
});
it("invalidates freshness immediately on loss, ignores replaced callbacks and reconciles committed work after reconnect", async () => {
  const h = harness();
  await ready(h);
  const old = h.watches[0]!;
  h.connection("reconnecting");
  expect(h.store.getSnapshot().fresh).toBe(false);
  h.store.change("maxLines", "3");
  expect(h.puts).toHaveLength(0);
  old.listener.data({
    key: "app/preferences",
    revision: "old",
    value: { version: 1, logStreams: { maxLines: 1 } },
  });
  expect(h.store.getSnapshot().values.maxLines).toBe(50000);
  h.connection("open");
  await saved(h, "maxLines");
  expect(h.store.getSnapshot().values.maxLines).toBe(3);
});
it("times out presentation without cancelling or duplicating sent writes and preserves newer drafts", async () => {
  const h = harness();
  await ready(h);
  vi.useFakeTimers();
  let finish!: () => void;
  h.write(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  h.store.change("maxLines", "3");
  expect(h.puts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.store.getSnapshot().drafts.maxLines?.error).toContain("outcome not confirmed");
  h.store.edit("maxLines", "4");
  h.store.commit(["maxLines"]);
  expect(h.puts).toHaveLength(1);
  h.remote(h.puts[0]!.value);
  h.write();
  finish();
  await vi.runAllTimersAsync();
  expect(h.store.getSnapshot().drafts.maxLines?.value).toBe("4");
  expect(h.puts).toHaveLength(2);
});
it("migrates only an explicit legacy choice after readback, merges other fields, and adopts an Engine theme", async () => {
  const h = harness({ version: 1, logStreams: { maxLines: 3 } }, "light");
  await saved(h, "theme");
  expect(h.store.getSnapshot().values).toMatchObject({ theme: "light", maxLines: 3 });
  expect(h.retired).toHaveBeenCalled();
  const existing = harness({ version: 1, appearance: { theme: "dark" } }, "light");
  await ready(existing);
  expect(existing.puts).toHaveLength(0);
  expect(existing.store.getSnapshot().values.theme).toBe("dark");
  const absent = harness();
  await ready(absent);
  expect(absent.puts).toHaveLength(0);
  expect(absent.store.getSnapshot().values).toEqual(defaults);
});
it("blocks writes after malformed/future snapshots while retaining last known runtime", async () => {
  const h = harness({ version: 1, appearance: { theme: "light" } });
  await ready(h);
  h.remote({ version: 2 });
  h.store.change("wrap", false);
  expect(h.puts).toHaveLength(0);
  expect(h.store.getSnapshot().values.theme).toBe("light");
  expect(h.store.getSnapshot().error).toContain("Cannot load");
});
it("reconciles an unknown written outcome, retries a settled unwritten outcome, and detects superseded readback", async () => {
  const written = harness();
  await ready(written);
  written.write(async (params) => {
    written.remote(params.value);
    throw new EngineRequestError({ code: "disconnected", message: "lost answer" });
  });
  written.store.change("wrap", false);
  await saved(written, "wrap");
  expect(written.puts).toHaveLength(1);
  const unwritten = harness();
  await ready(unwritten);
  unwritten.write(async () => {
    unwritten.write();
    throw new EngineRequestError({ code: "disconnected", message: "lost answer" });
  });
  unwritten.store.change("wrap", false);
  await saved(unwritten, "wrap");
  expect(unwritten.puts).toHaveLength(2);
  const replaced = harness({ version: 1, logStreams: { maxLines: 5 } });
  await ready(replaced);
  replaced.write(async () => {
    replaced.remote({ version: 1, logStreams: { maxLines: 7 } });
  });
  replaced.store.change("maxLines", "6");
  await vi.waitFor(() =>
    expect(replaced.store.getSnapshot().drafts.maxLines).toMatchObject({
      status: "Not saved",
      conflict: true,
      value: "6",
    }),
  );
});
it("bounds contention retries and resets known fields atomically without removing unknown or other-section fields", async () => {
  const h = harness({
    version: 1,
    future: 1,
    appearance: { theme: "light", future: 2 },
    logStreams: { maxLines: 3, future: 4 },
  });
  await ready(h);
  h.store.reset("logStreams");
  await saved(h, "maxLines");
  expect(h.puts).toHaveLength(1);
  expect(h.value()).toEqual({
    version: 1,
    future: 1,
    appearance: { theme: "light", future: 2 },
    logStreams: {
      maxLines: 50000,
      maxCharacters: 32000000,
      maxDecorations: 200000,
      wrap: true,
      timestamps: false,
      future: 4,
    },
  });
  h.write(async () => {
    h.remote({ ...(h.value() as object), unrelated: Math.random() });
    throw new EngineRequestError({ code: "conflict", message: "race" });
  });
  h.store.change("maxLines", "5");
  await vi.waitFor(() =>
    expect(h.store.getSnapshot().drafts.maxLines?.error).toContain("kept changing"),
  );
  expect(h.puts).toHaveLength(5);
});
it("does not mark a resolved put Saved before a fresh validated readback", async () => {
  const h = harness();
  await ready(h);
  h.read(true);
  h.store.change("wrap", false);
  await vi.waitFor(() => expect(h.puts).toHaveLength(1));
  expect(h.store.getSnapshot().drafts.wrap?.status).toBe("Saving");
  h.read(false);
  h.emit();
  await saved(h, "wrap");
});
it("adopts another window's explicit theme during migration and keeps failed migration retryable", async () => {
  const race = harness(null, "light");
  race.write(async () => {
    race.remote({ version: 1, appearance: { theme: "dark" }, logStreams: { maxLines: 42 } });
    throw new EngineRequestError({ code: "conflict", message: "another migration won" });
  });
  await ready(race);
  await vi.waitFor(() => expect(race.puts).toHaveLength(1));
  await vi.waitFor(() => expect(race.store.getSnapshot().drafts.theme).toBeUndefined());
  expect(race.store.getSnapshot().values).toMatchObject({ theme: "dark", maxLines: 42 });
  expect(race.retired).toHaveBeenCalled();
  const failed = harness(null, "light");
  failed.write(async () => {
    throw new EngineRequestError({ code: "internal", message: "disk full" });
  });
  await vi.waitFor(() => expect(failed.store.getSnapshot().drafts.theme?.error).toBe("disk full"));
  expect(failed.retired).not.toHaveBeenCalled();
  failed.write();
  failed.store.commit(["theme"]);
  await saved(failed, "theme");
  expect(failed.retired).toHaveBeenCalled();
});
it("blocks writes after an initial read failure and requires a validated retry", async () => {
  const h = harness();
  h.read(true);
  h.watches[0]!.listener.error({ code: "internal", message: "cannot read preferences" });
  h.store.change("wrap", false);
  expect(h.puts).toHaveLength(0);
  expect(h.store.getSnapshot().loaded).toBe(false);
  h.read(false);
  h.store.retry();
  await ready(h);
  expect(h.puts).toHaveLength(0);
  h.store.commit(["wrap"]);
  await saved(h, "wrap");
});
it("keeps a section reset atomic on conflict and requires a newly confirmed reset against the current section", async () => {
  const h = harness({ version: 1, appearance: { theme: "light" }, logStreams: { maxLines: 3 } });
  await ready(h);
  h.write(async () => {
    h.remote({ version: 1, appearance: { theme: "light" }, logStreams: { maxLines: 7 } });
    throw new EngineRequestError({ code: "conflict", message: "reset raced" });
  });
  h.store.reset("logStreams");
  await vi.waitFor(() =>
    expect(h.store.getSnapshot().drafts.maxLines).toMatchObject({
      status: "Not saved",
      conflict: true,
      reset: "logStreams",
      value: "50000",
    }),
  );
  expect(h.store.getSnapshot().values.maxLines).toBe(7);
  expect(h.puts).toHaveLength(1);
  h.write();
  h.store.reset("logStreams");
  await saved(h, "maxLines");
  expect(h.store.getSnapshot().values).toMatchObject({ maxLines: 50000, theme: "light" });
  expect(h.puts).toHaveLength(2);
});
it("retains a timed-out readback intent and reconciles it without a duplicate put after fresh data arrives", async () => {
  const h = harness();
  await ready(h);
  vi.useFakeTimers();
  h.read(true);
  h.store.change("wrap", false);
  await Promise.resolve();
  expect(h.puts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.store.getSnapshot().drafts.wrap).toMatchObject({ status: "Not saved" });
  expect(h.store.getSnapshot().drafts.wrap?.error).toContain("outcome not confirmed");
  h.read(false);
  h.emit();
  await vi.runAllTimersAsync();
  expect(h.store.getSnapshot().drafts.wrap?.status).toBe("Saved");
  expect(h.puts).toHaveLength(1);
});
