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
    remote: (next: unknown, deliver = true) => {
      value = next;
      revision += "r";
      if (deliver) emit();
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
it.each([
  [
    { version: 2 },
    "This Hukube version cannot read these app preferences. Update Hukube, then retry.",
  ],
  [{ version: 1, logStreams: { maxLines: 0 } }, "invalid value for Maximum retained lines"],
  [{ version: 1, appearance: null }, "invalid value for Appearance"],
  [{ version: 1, logStreams: { wrap: "yes" } }, "invalid value for Wrap"],
])(
  "explains unreadable snapshot %j, refuses writes and resets, retains state/drafts, and recovers on retry",
  async (invalid, explanation) => {
    const h = harness({ version: 1, appearance: { theme: "light" }, logStreams: { maxLines: 12 } });
    await ready(h);
    h.store.edit("maxLines", "27");
    const confirmed = h.store.getSnapshot();
    h.remote(invalid);
    expect(h.store.getSnapshot().error).toContain(explanation);
    expect(h.store.getSnapshot().error).toContain("Your saved preferences have not been changed.");
    expect(h.store.getSnapshot().error).not.toMatch(/invalid_type|invalid_value|\[\s*\{/);
    h.store.commit(["maxLines"]);
    h.store.reset("logStreams");
    expect(h.puts).toHaveLength(0);
    expect(h.store.getSnapshot()).toMatchObject({
      fresh: false,
      raw: confirmed.raw,
      values: confirmed.values,
      drafts: confirmed.drafts,
    });
    h.read(true);
    h.store.retry();
    expect(h.store.getSnapshot().fresh).toBe(false);
    h.remote(confirmed.raw);
    await ready(h);
    expect(h.store.getSnapshot().error).toBeUndefined();
    expect(h.store.getSnapshot().drafts.maxLines?.value).toBe("27");
    h.read(false);
    h.store.commit(["maxLines"]);
    await saved(h, "maxLines");
    expect(h.store.getSnapshot().values.maxLines).toBe(27);
  },
);
it("explains an initially unreadable snapshot without loading defaults or writing a reset", async () => {
  const h = harness({ version: 2 }, "light");
  await vi.waitFor(() =>
    expect(h.store.getSnapshot().error).toContain("Update Hukube, then retry."),
  );
  h.store.reset("appearance");
  expect(h.store.getSnapshot()).toMatchObject({ loaded: false, fresh: false, drafts: {} });
  expect(h.puts).toHaveLength(0);
  h.remote({ version: 1, appearance: { theme: "dark" } });
  await ready(h);
  expect(h.puts).toHaveLength(0);
});
it("preserves Engine IO and network error messages", async () => {
  const h = harness();
  await ready(h);
  h.watches[0]!.listener.error({ code: "internal", message: "disk read failed" });
  expect(h.store.getSnapshot().error).toBe("Cannot load app preferences: disk read failed");
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

it.each([
  ["maxLines", "1"],
  ["maxCharacters", "1"],
  ["maxDecorations", "1"],
  ["wrap", false],
  ["timestamps", true],
] as const)(
  "reset supersedes unsent %s without trimming a real document or losing unrelated fields",
  async (field, value) => {
    const { LogDocument } = await import("../logs/log-document.ts");
    const h = harness({
      version: 1,
      future: 9,
      appearance: { future: 8 },
      logStreams: { future: 7 },
    });
    await ready(h);
    const doc = new LogDocument("pods");
    doc.append(
      ["one", "two", "three"].map((text) => ({
        source: 1,
        time: 1,
        text,
        spans: [[0, 1, 1, -1, 0]],
      })),
    );
    const stop = h.store.subscribe(() => {
      const v = h.store.getSnapshot().values;
      doc.updateBudgets({
        lines: v.maxLines,
        characters: v.maxCharacters,
        decorations: v.maxDecorations,
      });
      doc.timestamps(v.timestamps);
    });
    h.connection("reconnecting");
    h.store.change(field, value);
    h.store.change("theme", "light");
    h.store.reset("logStreams");
    expect(h.puts).toHaveLength(0);
    h.connection("open");
    await saved(h, "maxLines");
    expect(h.puts).toHaveLength(2);
    expect(h.puts[0]!.value).toEqual({
      version: 1,
      future: 9,
      appearance: { future: 8, theme: "light" },
      logStreams: { future: 7 },
    });
    expect(h.value()).toEqual({
      version: 1,
      future: 9,
      appearance: { future: 8, theme: "light" },
      logStreams: {
        future: 7,
        maxLines: 50000,
        maxCharacters: 32000000,
        maxDecorations: 200000,
        wrap: true,
        timestamps: false,
      },
    });
    expect(doc.rows.map((row) => row.text)).toEqual(["one", "two", "three"]);
    expect(doc.evictedLines).toBe(0);
    stop();
  },
);

it("preserves the remaining atomic reset group when a later commit or discard overlaps one field", async () => {
  for (const action of ["commit", "discard"] as const) {
    const h = harness({
      version: 1,
      logStreams: { maxLines: 10, maxCharacters: 100, wrap: false, timestamps: true, future: 4 },
    });
    await ready(h);
    h.connection("reconnecting");
    h.store.reset("logStreams");
    if (action === "commit") h.store.change("maxLines", "20");
    else h.store.discard(["maxLines"]);
    h.connection("open");
    await saved(h, "timestamps");
    if (action === "commit") await saved(h, "maxLines");
    expect(h.puts.map((p) => (p.value as { logStreams: unknown }).logStreams)).toEqual([
      {
        maxLines: 10,
        maxCharacters: 32000000,
        maxDecorations: 200000,
        wrap: true,
        timestamps: false,
        future: 4,
      },
      ...(action === "commit"
        ? [
            {
              maxLines: 20,
              maxCharacters: 32000000,
              maxDecorations: 200000,
              wrap: true,
              timestamps: false,
              future: 4,
            },
          ]
        : []),
    ]);
    expect(h.store.getSnapshot().values.maxLines).toBe(action === "commit" ? 20 : 10);
  }
});

it.each(["discard", "supersede"] as const)(
  "%s abandons active unsent retries for unknown unwritten, written, successful and conflict outcomes",
  async (action) => {
    for (const outcome of ["unwritten", "written", "success", "conflict"] as const) {
      const h = harness({ version: 1, future: 1, logStreams: { maxLines: 30, extra: 2 } });
      await ready(h);
      vi.useFakeTimers();
      const pending = Promise.withResolvers<void>();
      h.write(() => pending.promise);
      h.store.change("maxLines", "10");
      expect(h.puts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.store.getSnapshot().drafts.maxLines?.status).toBe("Not saved");
      if (action === "discard") h.store.discard(["maxLines"]);
      else h.store.change("maxLines", "20");
      expect(h.puts).toHaveLength(1);
      if (outcome === "written" || outcome === "success") h.remote(h.puts[0]!.value);
      h.write();
      if (outcome === "success") pending.resolve();
      else
        pending.reject(
          new EngineRequestError({
            code: outcome === "conflict" ? "conflict" : "disconnected",
            message: outcome,
          }),
        );
      await vi.runAllTimersAsync();
      expect(
        h.puts.map((p) => (p.value as { logStreams: { maxLines: number } }).logStreams.maxLines),
      ).toEqual(action === "discard" ? [10] : [10, 20]);
      expect(h.store.getSnapshot().values.maxLines).toBe(
        action === "supersede" ? 20 : outcome === "written" || outcome === "success" ? 10 : 30,
      );
      expect(h.store.getSnapshot().raw).toMatchObject({ future: 1, logStreams: { extra: 2 } });
      const draft = h.store.getSnapshot().drafts.maxLines;
      expect(
        draft && { value: draft.value, status: draft.status, conflict: draft.conflict },
      ).toEqual(
        action === "discard" ? undefined : { value: "20", status: "Saved", conflict: false },
      );
      vi.useRealTimers();
    }
  },
);

it.each(["discard", "supersede"] as const)(
  "%s survives failed readback recovery without reviving obsolete fields and still recognizes a landed predecessor",
  async (action) => {
    for (const landed of [false, true]) {
      const h = harness({ version: 1, logStreams: { maxLines: 30 } });
      await ready(h);
      vi.useFakeTimers();
      const pending = Promise.withResolvers<void>();
      h.write(() => pending.promise);
      h.store.change("maxLines", "10");
      expect(h.puts).toHaveLength(1);
      if (action === "discard") h.store.discard(["maxLines"]);
      else h.store.change("maxLines", "20");
      h.read(true);
      if (landed) h.remote(h.puts[0]!.value);
      h.write();
      pending.reject(new EngineRequestError({ code: "disconnected", message: "unknown" }));
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.store.getSnapshot().fresh).toBe(false);
      expect(h.puts).toHaveLength(1);
      h.read(false);
      h.store.retry();
      await vi.runAllTimersAsync();
      expect(
        h.puts.map((p) => (p.value as { logStreams: { maxLines: number } }).logStreams.maxLines),
      ).toEqual(action === "discard" ? [10] : [10, 20]);
      expect(h.store.getSnapshot().values.maxLines).toBe(
        action === "supersede" ? 20 : landed ? 10 : 30,
      );
      vi.useRealTimers();
    }
  },
);

it("keeps real remote conflicts and valid sent ownership when newer typing is invalid or uncommitted", async () => {
  const h = harness({ version: 1, logStreams: { maxLines: 30 } });
  await ready(h);
  const pending = Promise.withResolvers<void>();
  h.write(() => pending.promise);
  h.store.change("maxLines", "10");
  h.store.edit("maxLines", "");
  h.store.commit(["maxLines"]);
  h.write();
  pending.reject(new EngineRequestError({ code: "disconnected", message: "unknown" }));
  await vi.waitFor(() => expect(h.puts).toHaveLength(2));
  expect(
    h.puts.map((p) => (p.value as { logStreams: { maxLines: number } }).logStreams.maxLines),
  ).toEqual([10, 10]);
  await vi.waitFor(() => expect(h.store.getSnapshot().values.maxLines).toBe(10));
  expect(h.store.getSnapshot().drafts.maxLines).toMatchObject({ value: "", status: "Not saved" });
  h.store.change("maxLines", "20");
  await saved(h, "maxLines");
  h.connection("reconnecting");
  h.store.change("maxLines", "25");
  h.remote({ version: 1, logStreams: { maxLines: 22 } });
  h.connection("open");
  await vi.waitFor(() => expect(h.store.getSnapshot().drafts.maxLines?.conflict).toBe(true));
  expect(h.puts).toHaveLength(3);
});

it.each(["100", " 100 ", "00100"])(
  "reconciles equal typed numeric draft %j without writing or losing raw text",
  async (text) => {
    const h = harness();
    await ready(h);
    h.store.edit("maxLines", text);
    h.remote({ version: 1, logStreams: { maxLines: 100 } });
    expect(h.store.getSnapshot().drafts.maxLines).toMatchObject({
      value: text,
      conflict: false,
      status: "Not saved",
    });
    h.store.commit(["maxLines"]);
    await saved(h, "maxLines");
    expect(h.puts).toHaveLength(0);
  },
);

it.each(["", " ", "1e2", "100.", "0"])(
  "preserves invalid numeric draft %j and real remote conflict",
  async (text) => {
    const h = harness();
    await ready(h);
    h.store.edit("maxLines", text);
    h.remote({ version: 1, logStreams: { maxLines: 100 } });
    h.store.commit(["maxLines"]);
    expect(h.store.getSnapshot().drafts.maxLines).toMatchObject({
      value: text,
      status: "Not saved",
      conflict: true,
    });
    expect(h.puts).toHaveLength(0);
  },
);

it.each(["discard", "supersede"] as const)(
  "%s of one active reset field preserves the other reset fields as one retry after unknown unwritten outcome",
  async (action) => {
    const h = harness({
      version: 1,
      future: 1,
      appearance: { theme: "light", extra: 2 },
      logStreams: {
        maxLines: 30,
        maxCharacters: 100,
        maxDecorations: 100,
        wrap: false,
        timestamps: true,
        extra: 3,
      },
    });
    await ready(h);
    const pending = Promise.withResolvers<void>();
    h.write(() => pending.promise);
    h.store.reset("logStreams");
    expect(h.puts).toHaveLength(1);
    if (action === "discard") h.store.discard(["maxLines"]);
    else h.store.change("maxLines", "20");
    h.write();
    pending.reject(new EngineRequestError({ code: "disconnected", message: "unknown" }));
    await saved(h, "timestamps");
    if (action === "supersede") await saved(h, "maxLines");
    expect(h.puts.map((p) => p.value)).toEqual([
      {
        version: 1,
        future: 1,
        appearance: { theme: "light", extra: 2 },
        logStreams: {
          maxLines: 50000,
          maxCharacters: 32000000,
          maxDecorations: 200000,
          wrap: true,
          timestamps: false,
          extra: 3,
        },
      },
      {
        version: 1,
        future: 1,
        appearance: { theme: "light", extra: 2 },
        logStreams: {
          maxLines: 30,
          maxCharacters: 32000000,
          maxDecorations: 200000,
          wrap: true,
          timestamps: false,
          extra: 3,
        },
      },
      ...(action === "supersede"
        ? [
            {
              version: 1,
              future: 1,
              appearance: { theme: "light", extra: 2 },
              logStreams: {
                maxLines: 20,
                maxCharacters: 32000000,
                maxDecorations: 200000,
                wrap: true,
                timestamps: false,
                extra: 3,
              },
            },
          ]
        : []),
    ]);
  },
);

it("does not falsely settle an equal numeric successor while a preceding write/readback remains unresolved", async () => {
  const h = harness();
  await ready(h);
  const pending = Promise.withResolvers<void>();
  h.write(() => pending.promise);
  h.store.change("maxLines", "100");
  h.store.edit("maxLines", " 00100 ");
  h.remote(h.puts[0]!.value);
  h.store.commit(["maxLines"]);
  expect(h.store.getSnapshot().drafts.maxLines).toMatchObject({
    value: " 00100 ",
    conflict: false,
    status: "Not saved",
  });
  h.read(true);
  pending.resolve();
  await vi.waitFor(() => expect(h.watches).toHaveLength(2));
  expect(h.store.getSnapshot().drafts.maxLines?.status).toBe("Not saved");
  h.read(false);
  h.emit();
  await saved(h, "maxLines");
  expect(h.puts).toHaveLength(1);
});

it("does not advance a superseding intent over a real remote same-field change after a sent predecessor", async () => {
  const h = harness({ version: 1, logStreams: { maxLines: 30 } });
  await ready(h);
  const pending = Promise.withResolvers<void>();
  h.write(() => pending.promise);
  h.store.change("maxLines", "10");
  h.store.change("maxLines", "20");
  h.remote({ version: 1, logStreams: { maxLines: 15 } });
  pending.reject(new EngineRequestError({ code: "disconnected", message: "unknown" }));
  await vi.waitFor(() =>
    expect(h.store.getSnapshot().drafts.maxLines?.error).toContain("another window"),
  );
  expect(h.store.getSnapshot().drafts.maxLines).toMatchObject({
    value: "20",
    status: "Not saved",
    conflict: true,
  });
  expect(h.puts).toHaveLength(1);
  expect(h.store.getSnapshot().values.maxLines).toBe(15);
});

it("never applies an obsolete unwritten reduction to a real document after read failure and discard", async () => {
  const { LogDocument } = await import("../logs/log-document.ts");
  const h = harness({ version: 1, logStreams: { maxLines: 30 } });
  await ready(h);
  const doc = new LogDocument("pods");
  doc.append(Array.from({ length: 25 }, (_, i) => ({ source: 1, time: 1, text: String(i) })));
  const confirmed: unknown[] = [];
  const stop = h.store.subscribe(() => {
    const snapshot = h.store.getSnapshot();
    confirmed.push(snapshot.values.maxLines);
    doc.updateBudgets({ ...doc.budgets, lines: snapshot.values.maxLines });
  });
  const pending = Promise.withResolvers<void>();
  h.write(() => pending.promise);
  h.store.change("maxLines", "10");
  expect(h.puts).toHaveLength(1);
  h.read(true);
  pending.reject(new EngineRequestError({ code: "disconnected", message: "unknown" }));
  await vi.waitFor(() => expect(h.watches).toHaveLength(2));
  h.watches.at(-1)!.listener.error({ code: "internal", message: "read failed" });
  await vi.waitFor(() => expect(h.store.getSnapshot().drafts.maxLines?.status).toBe("Not saved"));
  h.store.discard(["maxLines"]);
  h.read(false);
  h.write();
  h.store.retry();
  await ready(h);
  h.store.change("maxLines", "20");
  await saved(h, "maxLines");
  expect(h.puts.map((p) => p.value)).toEqual([
    { version: 1, appearance: {}, logStreams: { maxLines: 10 } },
    { version: 1, appearance: {}, logStreams: { maxLines: 20 } },
  ]);
  expect(confirmed).not.toContain(10);
  expect(doc.rows).toHaveLength(20);
  expect(doc.rows[0]!.sequence).toBe(5);
  expect(h.store.getSnapshot().raw).toEqual({
    version: 1,
    appearance: {},
    logStreams: { maxLines: 20 },
  });
  stop();
});

it.each(["success", "unknown written", "unknown unwritten", "refused"] as const)(
  "keeps discarded sent evidence unconfirmed until %s reconciles",
  async (outcome) => {
    const h = harness({ version: 1, logStreams: { maxLines: 80 } });
    await ready(h);
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    h.write(() => pending.promise);
    h.store.change("maxLines", "1");
    expect(h.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    h.store.discard(["maxLines"]);
    expect(h.store.getSnapshot()).toMatchObject({
      values: { maxLines: 80 },
      drafts: {},
      unconfirmed: ["maxLines"],
    });
    // The original watch can still report the old matching value while the put is unresolved.
    h.emit();
    expect(h.store.getSnapshot()).toMatchObject({ unconfirmed: ["maxLines"] });
    h.read(true);
    if (outcome === "success" || outcome === "unknown written") h.remote(h.puts[0]!.value, false);
    if (outcome === "success") pending.resolve();
    else
      pending.reject(
        new EngineRequestError({
          code: outcome === "refused" ? "internal" : "disconnected",
          message: outcome,
        }),
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getSnapshot().drafts).toEqual({});
    expect(h.puts).toHaveLength(1);
    expect(h.watches).toHaveLength(outcome === "refused" ? 1 : 2);
    expect(h.store.getSnapshot()).toMatchObject({
      unconfirmed: outcome === "refused" ? [] : ["maxLines"],
      fresh: outcome === "refused",
      values: { maxLines: 80 },
    });
    h.read(false);
    h.emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getSnapshot()).toMatchObject({
      unconfirmed: [],
      fresh: true,
      values: { maxLines: outcome === "unknown unwritten" || outcome === "refused" ? 80 : 1 },
    });
    expect(h.puts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["error", "timeout", "disconnect"] as const)(
  "retains discarded certainty through fresh readback %s and reconnects without another put",
  async (failure) => {
    const h = harness({ version: 1, logStreams: { maxLines: 80 } });
    await ready(h);
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    h.write(() => pending.promise);
    h.store.change("maxLines", "1");
    h.store.discard(["maxLines"]);
    h.read(true);
    h.remote(h.puts[0]!.value, false);
    pending.reject(new EngineRequestError({ code: "disconnected", message: "unknown" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.watches).toHaveLength(2);
    if (failure === "error")
      h.watches.at(-1)!.listener.error({ code: "internal", message: "read failed" });
    else {
      if (failure === "disconnect") h.connection("reconnecting");
      await vi.advanceTimersByTimeAsync(10000);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getSnapshot()).toMatchObject({
      fresh: false,
      unconfirmed: ["maxLines"],
      drafts: {},
      values: { maxLines: 80 },
    });
    h.store.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getSnapshot()).toMatchObject({ unconfirmed: ["maxLines"] });
    h.read(false);
    h.connection("open");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getSnapshot()).toMatchObject({
      fresh: true,
      unconfirmed: [],
      drafts: {},
      values: { maxLines: 1 },
    });
    expect(h.puts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retains sent certainty across a newer generation and an early matching watch without losing the draft", async () => {
  const h = harness({ version: 1, logStreams: { maxLines: 80 } });
  await ready(h);
  vi.useFakeTimers();
  const pending = Promise.withResolvers<void>();
  h.write(() => pending.promise);
  h.store.change("maxLines", "1");
  h.store.change("maxLines", "2");
  h.remote(h.puts[0]!.value);
  expect(h.store.getSnapshot()).toMatchObject({
    unconfirmed: ["maxLines"],
    drafts: { maxLines: { value: "2", status: "Not saved" } },
  });
  h.read(true);
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.store.getSnapshot()).toMatchObject({
    unconfirmed: ["maxLines"],
    drafts: { maxLines: { value: "2", status: "Not saved" } },
  });
  expect(h.puts).toHaveLength(1);
  h.write();
  h.read(false);
  h.emit();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.store.getSnapshot()).toMatchObject({
    unconfirmed: [],
    values: { maxLines: 2 },
    drafts: { maxLines: { value: "2", status: "Saved", conflict: false } },
  });
  expect(h.puts).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
