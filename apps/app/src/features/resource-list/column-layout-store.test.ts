import type { Setting, ErrorDetail } from "@hukube/engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createColumnLayoutStore } from "./column-layout-store.ts";
import type { StoredColumnLayout } from "./column-layout.ts";

const layout = (hidden = false): StoredColumnLayout => ({
  version: 1,
  columns: [{ source: "name", hidden }],
});
function setup(type = "pods") {
  let listener: { data: (s: Setting) => void; error: (e: ErrorDetail) => void };
  const writes: { params: Setting; resolve: () => void; reject: (error: Error) => void }[] = [];
  const close = vi.fn<() => void>();
  const subscribe = vi.fn<
    (
      _method: string,
      _params: unknown,
      next: typeof listener,
    ) => { update: () => void; close: () => void }
  >((_method: string, _params: unknown, next: typeof listener) => {
    listener = next;
    return { update: () => {}, close };
  });
  const client = {
    subscribe,
    request: (_method: string, params: Setting) =>
      new Promise<void>((resolve, reject) => writes.push({ params, resolve, reject })),
  } as unknown as Parameters<typeof createColumnLayoutStore>[0];
  const store = createColumnLayoutStore(client, type);
  const changed = vi.fn<() => void>();
  const stop = store.subscribe(changed);
  return {
    store,
    writes,
    subscribe,
    close,
    changed,
    stop,
    deliver: (value: unknown) => listener.data({ key: `columns/${type}`, value }),
    error: () => listener.error({ code: "internal", message: "watch failed" }),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("column layout store", () => {
  it("knows nothing until the first value, and watches the type while open", () => {
    const s = setup("constructor");
    expect(s.store.getSnapshot()).toBeUndefined();
    expect(s.subscribe).toHaveBeenCalledWith(
      "settings.watch",
      { key: "columns/constructor" },
      expect.anything(),
    );
    s.deliver(layout());
    expect(s.store.getSnapshot()).toEqual(layout());
    s.stop();
    expect(s.close).toHaveBeenCalledOnce();
  });
  it("uses the default for a missing or invalid value", () => {
    const s = setup();
    s.deliver(null);
    expect(s.store.getSnapshot()).toBeNull();
    s.deliver({ version: 2, columns: [] });
    expect(s.store.getSnapshot()).toBeNull();
  });
  it("warns and uses the default when the watch fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.error();
    expect(s.store.getSnapshot()).toBeNull();
    expect(warn).toHaveBeenCalledWith("Could not read the column layout", expect.anything());
  });
  it("shows an edit immediately, ignores earlier values during its write, and accepts its echo", async () => {
    const s = setup();
    s.deliver(null);
    const pending = s.store.put(layout());
    expect(s.store.getSnapshot()).toEqual(layout());
    expect(s.writes[0]?.params).toEqual({ key: "columns/pods", value: layout() });
    s.deliver(null);
    expect(s.store.getSnapshot()).toEqual(layout());
    s.deliver(layout());
    s.writes[0]!.resolve();
    await pending;
    expect(s.store.getSnapshot()).toEqual(layout());
    s.deliver(layout(true));
    expect(s.store.getSnapshot()).toEqual(layout(true));
  });
  it("accepts another client's value after the write settles even without an echo", async () => {
    const s = setup();
    s.deliver(null);
    const pending = s.store.put(layout());
    s.writes[0]!.resolve();
    await pending;
    s.deliver(layout(true));
    expect(s.store.getSnapshot()).toEqual(layout(true));
  });
  it("keeps the latest quick edit through older echoes and an older failed write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.deliver(null);
    const first = s.store.put(layout());
    const second = s.store.put(layout(true));
    s.deliver(layout());
    expect(s.store.getSnapshot()).toEqual(layout(true));
    s.writes[0]!.reject(new Error("failed"));
    await first;
    expect(s.store.getSnapshot()).toEqual(layout(true));
    s.deliver(layout(true));
    s.writes[1]!.resolve();
    await second;
    expect(s.store.getSnapshot()).toEqual(layout(true));
  });
  it("accepts another client's value after the latest echo while writes are still in flight", async () => {
    const s = setup();
    s.deliver(null);
    const first = s.store.put(layout());
    const second = s.store.put(layout(true));
    s.deliver(layout(true));
    s.deliver(layout());
    expect(s.store.getSnapshot()).toEqual(layout());
    s.writes[0]!.resolve();
    s.writes[1]!.resolve();
    await Promise.all([first, second]);
    s.deliver(null);
    expect(s.store.getSnapshot()).toBeNull();
  });
  it("shows another client's value received during a write once it settles without an echo", async () => {
    const s = setup();
    s.deliver(null);
    const pending = s.store.put(layout());
    s.deliver(layout(true));
    expect(s.store.getSnapshot()).toEqual(layout());
    s.writes[0]!.resolve();
    await pending;
    expect(s.store.getSnapshot()).toEqual(layout(true));
  });
  it("keeps the later edit through an earlier echo, settlement, and the later echo", async () => {
    const s = setup();
    s.deliver(null);
    const snapshots: unknown[] = [];
    const first = s.store.put(layout());
    const second = s.store.put(layout(true));
    const stop = s.store.subscribe(() => snapshots.push(s.store.getSnapshot()));
    s.deliver(layout());
    expect(s.store.getSnapshot()).toEqual(layout(true));
    s.deliver(layout(true));
    s.writes[1]!.resolve();
    await second;
    s.writes[0]!.resolve();
    await first;
    expect(s.store.getSnapshot()).toEqual(layout(true));
    expect(snapshots).not.toContainEqual(layout());
    stop();
  });
  it("recognizes an echo regardless of key order and an explicit hidden false", async () => {
    const s = setup();
    s.deliver(null);
    const pending = s.store.put({ version: 1, columns: [{ source: "name" }] });
    s.deliver({ columns: [{ hidden: false, source: "name" }], version: 1 });
    s.deliver(layout(true));
    expect(s.store.getSnapshot()).toEqual(layout(true));
    s.writes[0]!.resolve();
    await pending;
    expect(s.store.getSnapshot()).toEqual(layout(true));
  });
  it("uses the default if a watch fails after an optimistic edit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.deliver(layout());
    const pending = s.store.put(layout(true));
    s.error();
    expect(s.store.getSnapshot()).toBeNull();
    s.writes[0]!.resolve();
    await pending;
  });
  it("warns and drops a failed optimistic edit back to the stored value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup();
    s.deliver(layout());
    const pending = s.store.put(layout(true));
    s.writes[0]!.reject(new Error("failed"));
    await pending;
    expect(s.store.getSnapshot()).toEqual(layout());
    expect(warn).toHaveBeenCalledWith("Could not save the column layout", expect.any(Error));
  });
  it("resets optimistically and writes null", async () => {
    const s = setup();
    s.deliver(layout());
    const pending = s.store.put(null);
    expect(s.store.getSnapshot()).toBeNull();
    expect(s.writes[0]?.params).toEqual({ key: "columns/pods", value: null });
    s.deliver(layout());
    expect(s.store.getSnapshot()).toBeNull();
    s.deliver(null);
    s.writes[0]!.resolve();
    await pending;
    expect(s.store.getSnapshot()).toBeNull();
  });
});
