import type { ErrorDetail, Setting } from "@hukube/engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createColumnLayoutStore } from "./column-layout-store.ts";
import type { StoredColumnLayout } from "./column-layout.ts";

const layout = (hidden = false): StoredColumnLayout => ({
  version: 1,
  columns: [{ source: "name", hidden }],
});
const moved: StoredColumnLayout = { version: 1, columns: [{ source: "age" }, { source: "name" }] };

interface Watch {
  key: string;
  closed: boolean;
  deliver: (value: unknown) => void;
  fail: () => void;
}

/** A store over a fake Engine client that records every watch and write. */
function setup(type = "pods") {
  const watches: Watch[] = [];
  const writes: { params: Setting; resolve: () => void; reject: (error: Error) => void }[] = [];
  const client = {
    subscribe: (
      _method: string,
      params: { key: string },
      listener: { data: (s: Setting) => void; error: (e: ErrorDetail) => void },
    ) => {
      const watch: Watch = {
        key: params.key,
        closed: false,
        deliver: (value) => listener.data({ key: params.key, value }),
        fail: () => listener.error({ code: "internal", message: "watch failed" }),
      };
      watches.push(watch);
      return { update: () => {}, close: () => (watch.closed = true) };
    },
    request: (_method: string, params: Setting) =>
      new Promise<void>((resolve, reject) => writes.push({ params, resolve, reject })),
  } as unknown as Parameters<typeof createColumnLayoutStore>[0];
  const store = createColumnLayoutStore(client, type);
  // What a list would show: the snapshot as of the store's last notification.
  let shown = store.getSnapshot();
  const stop = store.subscribe(() => (shown = store.getSnapshot()));
  return { store, watches, writes, stop, shown: () => shown };
}
afterEach(() => vi.restoreAllMocks());

describe("column layout store", () => {
  it("knows nothing until the first value, and watches the type while open", () => {
    const s = setup("constructor");
    expect(s.shown()).toBeUndefined();
    expect(s.watches.map((w) => w.key)).toEqual(["columns/constructor"]);
    s.watches[0]!.deliver(layout());
    expect(s.shown()).toEqual(layout());
    s.stop();
    expect(s.watches[0]!.closed).toBe(true);
  });

  it("uses the default for a missing or invalid value", () => {
    const s = setup();
    s.watches[0]!.deliver(null);
    expect(s.shown()).toBeNull();
    s.watches[0]!.deliver({ version: 2, columns: [] });
    expect(s.shown()).toBeNull();
  });

  it("warns and uses the default when the watch fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.watches[0]!.fail();
    expect(s.shown()).toBeNull();
    expect(warn).toHaveBeenCalledWith("Could not read the column layout", expect.anything());
  });

  it("keeps an edit on show when the watch fails during its write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.watches[0]!.deliver(null);
    const saved = s.store.put(layout());
    s.watches[0]!.fail();
    expect(s.shown()).toEqual(layout());
    s.writes[0]!.resolve();
    await saved;

    // The watch it replaced no longer counts, whatever it reports.
    warn.mockClear();
    s.watches[0]!.fail();
    expect(warn).not.toHaveBeenCalled();
    expect(s.shown()).toEqual(layout());
  });

  it("follows another client's value while it is not writing", () => {
    const s = setup();
    s.watches[0]!.deliver(null);
    s.watches[0]!.deliver(layout(true));
    expect(s.shown()).toEqual(layout(true));
  });

  it("shows an edit at once, and after its write shows what a new watch reports", async () => {
    const s = setup();
    s.watches[0]!.deliver(null);
    const saved = s.store.put(layout());
    expect(s.shown()).toEqual(layout());
    expect(s.writes.map((w) => w.params)).toEqual([{ key: "columns/pods", value: layout() }]);

    s.writes[0]!.resolve();
    await saved;
    // The write settled before anything came back: the edit stays on show.
    expect(s.shown()).toEqual(layout());
    expect(s.watches.map((w) => w.closed)).toEqual([true, false]);

    s.watches[1]!.deliver(layout());
    expect(s.shown()).toEqual(layout());
  });

  it("sends one write at a time, and only the latest edit made meanwhile", async () => {
    const s = setup();
    s.watches[0]!.deliver(null);
    void s.store.put(layout());
    void s.store.put(layout(true));
    const saved = s.store.put(moved);
    expect(s.writes).toHaveLength(1);
    expect(s.shown()).toEqual(moved);

    s.writes[0]!.resolve();
    await vi.waitFor(() => expect(s.writes).toHaveLength(2));
    expect(s.writes.map((w) => w.params.value)).toEqual([layout(), moved]);
    // The watch is replaced once, after the last write, not after each one.
    expect(s.watches).toHaveLength(1);

    s.writes[1]!.resolve();
    await saved;
    expect(s.watches).toHaveLength(2);
    expect(s.shown()).toEqual(moved);
  });

  // During a write the store cannot tell an echo of its own earlier edit from
  // another client's value, or either from a value older than the write.
  it.each([
    ["an earlier edit of its own", layout()],
    ["another client's value", moved],
  ])("does not show %s that arrives during a write", async (_what, arriving) => {
    const s = setup();
    s.watches[0]!.deliver(null);
    const first = s.store.put(layout());
    s.writes[0]!.resolve();
    await first;
    s.watches[1]!.deliver(layout());

    const second = s.store.put(layout(true));
    s.watches[1]!.deliver(arriving);
    expect(s.shown()).toEqual(layout(true));
    s.writes[1]!.resolve();
    await second;
    expect(s.shown()).toEqual(layout(true));
  });

  it("keeps the later of two quick edits through the earlier one's late echo", async () => {
    const s = setup();
    s.watches[0]!.deliver(null);
    const seen: unknown[] = [];
    const stop = s.store.subscribe(() => seen.push(s.shown()));

    const first = s.store.put(layout());
    s.writes[0]!.resolve();
    await first;
    // The second edit is made before the first one has come back.
    const second = s.store.put(layout(true));
    s.watches[1]!.deliver(layout());
    s.writes[1]!.resolve();
    await second;
    // The echo can also arrive after both writes, on a watch already replaced.
    s.watches[1]!.deliver(layout());
    expect(s.shown()).toEqual(layout(true));

    s.watches[2]!.deliver(layout(true));
    expect(s.shown()).toEqual(layout(true));
    expect(seen.slice(1)).toEqual(seen.slice(1).map(() => layout(true)));
    stop();
  });

  it("shows another client's later value once its own writes have settled", async () => {
    const s = setup();
    s.watches[0]!.deliver(null);
    const first = s.store.put(layout());
    const second = s.store.put(layout(true));
    s.writes[0]!.resolve();
    await vi.waitFor(() => expect(s.writes).toHaveLength(2));
    // Another client writes the value this store wrote first, after its second.
    s.watches[0]!.deliver(layout());
    s.writes[1]!.resolve();
    await Promise.all([first, second]);
    expect(s.shown()).toEqual(layout(true));

    s.watches[1]!.deliver(layout());
    expect(s.shown()).toEqual(layout());
  });

  it("warns when a write fails, then shows what the Engine still holds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.watches[0]!.deliver(layout());
    const saved = s.store.put(layout(true));
    s.writes[0]!.reject(new Error("failed"));
    await saved;
    expect(warn).toHaveBeenCalledWith("Could not save the column layout", expect.any(Error));

    s.watches[1]!.deliver(layout());
    expect(s.shown()).toEqual(layout());
  });

  it("still sends the waiting edit after a failed write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.watches[0]!.deliver(null);
    void s.store.put(layout());
    const saved = s.store.put(layout(true));
    s.writes[0]!.reject(new Error("failed"));
    await vi.waitFor(() => expect(s.writes).toHaveLength(2));
    expect(s.writes[1]!.params.value).toEqual(layout(true));
    s.writes[1]!.resolve();
    await saved;
    expect(s.shown()).toEqual(layout(true));
  });

  it("resets by writing null", async () => {
    const s = setup();
    s.watches[0]!.deliver(layout());
    const saved = s.store.put(null);
    expect(s.shown()).toBeNull();
    expect(s.writes[0]!.params).toEqual({ key: "columns/pods", value: null });
    s.writes[0]!.resolve();
    await saved;
    s.watches[1]!.deliver(null);
    expect(s.shown()).toBeNull();
  });

  it("opens no watch for a list that closed during its write", async () => {
    const s = setup();
    s.watches[0]!.deliver(null);
    const saved = s.store.put(layout());
    s.stop();
    s.writes[0]!.resolve();
    await saved;
    expect(s.watches).toHaveLength(1);

    let seen: unknown;
    const stop = s.store.subscribe(() => (seen = s.store.getSnapshot()));
    expect(s.watches).toHaveLength(2);
    s.watches[1]!.deliver(layout(true));
    expect(seen).toEqual(layout(true));
    stop();
  });
});
