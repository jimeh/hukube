import type { ErrorDetail, Setting } from "@hukube/engine-client";
import { afterEach, expect, it, vi } from "vitest";
import { createCommandsStore } from "./commands-store.ts";
function setup() {
  const watches: { closed: boolean; data: (value: unknown) => void; fail: () => void }[] = [];
  const writes: { value: unknown; resolve: () => void; reject: (error: Error) => void }[] = [];
  const client = {
    subscribe: (
      _method: string,
      params: { key: string },
      listener: { data: (setting: Setting) => void; error: (error: ErrorDetail) => void },
    ) => {
      expect(params.key).toBe("exec/commands");
      const watch = {
        closed: false,
        data: (value: unknown) => listener.data({ revision: "", key: params.key, value }),
        fail: () => listener.error({ code: "internal", message: "failed" }),
      };
      watches.push(watch);
      return {
        close: () => {
          watch.closed = true;
        },
        update: () => {},
      };
    },
    request: (_method: string, params: Setting) => {
      expect(params.key).toBe("exec/commands");
      return new Promise<void>((resolve, reject) =>
        writes.push({ value: params.value, resolve, reject }),
      );
    },
  } as unknown as Parameters<typeof createCommandsStore>[0];
  const store = createCommandsStore(client);
  const stop = store.subscribe(() => {});
  return { store, stop, watches, writes };
}
afterEach(() => vi.restoreAllMocks());
it("watches once, reads other windows, and closes after its last listener", () => {
  const s = setup();
  expect(s.store.getSnapshot()).toBeUndefined();
  const stop = s.store.subscribe(() => {});
  expect(s.watches).toHaveLength(1);
  s.watches[0]!.data({
    images: [{ image: "__proto__", command: "python3" }],
    recent: ["python3"],
  });
  expect(s.store.commandFor("__proto__:v2")).toEqual("python3");
  s.stop();
  expect(s.watches[0]!.closed).toBe(false);
  stop();
  expect(s.watches[0]!.closed).toBe(true);
});
it("remembers, replaces, and forgets per repository, preserving other images", async () => {
  const s = setup();
  s.watches[0]!.data({ images: [{ image: "other", command: "ash" }], recent: [] });
  const first = s.store.run("registry:5000/app:tag", "python3", true);
  expect(s.store.commandFor("registry:5000/app@sha256:x")).toEqual("python3");
  s.writes[0]!.resolve();
  await first;
  const next = s.store.run("registry:5000/app:v2", "bash -l", true);
  expect(s.store.commandFor("registry:5000/app:v1")).toEqual("bash -l");
  s.writes[1]!.resolve();
  await next;
  const forgot = s.store.run("registry:5000/app:tag", "", true);
  expect(s.store.commandFor("registry:5000/app")).toBeUndefined();
  expect(s.store.commandFor("other")).toEqual("ash");
  s.writes[2]!.resolve();
  await forgot;
});
it("keeps 100 images by last use and ten unique recent commands newest first", async () => {
  const s = setup();
  s.watches[0]!.data({
    images: Array.from({ length: 100 }, (_, i) => ({ image: `image${i}`, command: `cmd${i}` })),
    recent: Array.from({ length: 10 }, (_, i) => `cmd${i}`),
  });
  const touched = s.store.run("image99:tag", "cmd99");
  s.writes[0]!.resolve();
  await touched;
  const added = s.store.run("new", "new", true);
  expect(s.store.getSnapshot()!.images).toHaveLength(100);
  expect(
    s.store
      .getSnapshot()!
      .images.slice(0, 2)
      .map((entry) => entry.image),
  ).toEqual(["new", "image99"]);
  expect(s.store.commandFor("image98")).toBeUndefined();
  expect(s.store.getSnapshot()!.recent).toEqual([
    "new",
    "cmd99",
    ...Array.from({ length: 8 }, (_, i) => `cmd${i}`),
  ]);
  s.writes[1]!.resolve();
  await added;
  const repeat = s.store.run("else", "cmd2");
  expect(s.store.getSnapshot()!.recent.filter((command) => command === "cmd2")).toHaveLength(1);
  expect(s.store.getSnapshot()!.recent[0]).toEqual("cmd2");
  expect(s.store.commandFor("else")).toBeUndefined();
  s.writes[2]!.resolve();
  await repeat;
});
it("serializes writes from the last local value and rejects delayed watch echoes", async () => {
  const s = setup();
  s.watches[0]!.data(null);
  void s.store.run("a", "a", true);
  const last = s.store.run("b", "b", true);
  expect(s.writes).toHaveLength(1);
  s.watches[0]!.data({ images: [], recent: [] });
  expect(s.store.commandFor("b")).toEqual("b");
  s.writes[0]!.resolve();
  await vi.waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]!.value).toEqual({
    images: [
      { image: "b", command: "b" },
      { image: "a", command: "a" },
    ],
    recent: ["b", "a"],
  });
  s.writes[1]!.resolve();
  await last;
  s.watches[0]!.data(null);
  expect(s.store.commandFor("b")).toEqual("b");
  expect(s.watches[0]!.closed).toBe(true);
  s.watches[1]!.data({ images: [{ image: "remote", command: "x" }], recent: [] });
  const remote = s.store.run("c", "c", true);
  expect(s.store.commandFor("remote")).toEqual("x");
  s.writes[2]!.resolve();
  await remote;
});
it("warns on failure, continues queued writes, and reconciles with a fresh watch", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const s = setup();
  s.watches[0]!.data(null);
  expect(s.store.getSnapshot()).toEqual({ images: [], recent: [] });
  void s.store.run("a", "a", true);
  const last = s.store.run("b", "b", true);
  s.writes[0]!.reject(new Error("failed"));
  await vi.waitFor(() => expect(s.writes).toHaveLength(2));
  s.writes[1]!.resolve();
  await last;
  expect(s.store.commandFor("b")).toBe("b");
  expect(warn).toHaveBeenCalledWith("Could not save Exec Session commands", expect.any(Error));
  s.watches[1]!.data(null);
  expect(s.store.commandFor("b")).toBeUndefined();
});
it("ignores malformed stored entries and does not open a watch after unmount during a write", async () => {
  const s = setup();
  s.watches[0]!.data({
    images: [null, { image: "bad", command: [2] }, { image: "ok", command: "x" }],
    recent: [null, "", [2], "x", "x"],
  });
  expect(s.store.getSnapshot()).toEqual({
    images: [{ image: "ok", command: "x" }],
    recent: ["x"],
  });
  const saved = s.store.run("new", "y", true);
  s.stop();
  s.writes[0]!.resolve();
  await saved;
  expect(s.watches).toHaveLength(1);
});

it("keeps the exact typed line, including literal glob quoting, through settings", async () => {
  const s = setup();
  s.watches[0]!.data(null);
  const line = "  ls '*.log'  ";
  const saved = s.store.run("busybox:tag", line, true);
  expect(s.writes[0]!.value).toEqual({
    images: [{ image: "busybox", command: line }],
    recent: [line],
  });
  s.writes[0]!.resolve();
  await saved;
  s.watches[1]!.data(s.writes[0]!.value);
  expect(s.store.commandFor("busybox:v2")).toBe(line);
  expect(s.store.getSnapshot()!.recent[0]).toBe(line);
});

it("queues a run until the first setting arrives and preserves existing commands", async () => {
  const s = setup();
  const saved = s.store.run("new:tag", "python3", true);
  expect(s.writes).toHaveLength(0);
  s.watches[0]!.data({ images: [{ image: "existing", command: "ash" }], recent: ["ash"] });
  expect(s.writes[0]!.value).toEqual({
    images: [
      { image: "new", command: "python3" },
      { image: "existing", command: "ash" },
    ],
    recent: ["python3", "ash"],
  });
  s.writes[0]!.resolve();
  await saved;
});
it("drops unread runs on watch failure and never writes from the failed read", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const s = setup();
  const queued = s.store.run("new", "python3", true);
  expect(s.writes).toHaveLength(0);
  s.watches[0]!.fail();
  await queued;
  await s.store.run("later", "bash", true);
  expect(s.writes).toHaveLength(0);
  expect(s.store.getSnapshot()).toBeUndefined();
  expect(warn).toHaveBeenCalled();
  s.watches[0]!.data({ images: [{ image: "existing", command: "ash" }], recent: ["ash"] });
  expect(s.writes).toHaveLength(0);
  const saved = s.store.run("valid", "sh -l", true);
  expect(s.writes[0]!.value).toEqual({
    images: [
      { image: "valid", command: "sh -l" },
      { image: "existing", command: "ash" },
    ],
    recent: ["sh -l", "ash"],
  });
  s.writes[0]!.resolve();
  await saved;
});
it("applies multiple unread runs in order to the first setting", async () => {
  const s = setup();
  const first = s.store.run("new", "python3", true);
  const last = s.store.run("other", "bash -l", true);
  expect(s.writes).toHaveLength(0);
  s.watches[0]!.data({ images: [{ image: "existing", command: "ash" }], recent: ["ash"] });
  expect(s.writes).toHaveLength(1);
  expect(s.writes[0]!.value).toEqual({
    images: [
      { image: "other", command: "bash -l" },
      { image: "new", command: "python3" },
      { image: "existing", command: "ash" },
    ],
    recent: ["bash -l", "python3", "ash"],
  });
  s.writes[0]!.resolve();
  await Promise.all([first, last]);
});

it("stops queued writes when the watch fails during a write", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const s = setup();
  s.watches[0]!.data(null);
  const first = s.store.run("a", "ash", true);
  const last = s.store.run("b", "bash", true);
  s.watches[0]!.fail();
  s.writes[0]!.resolve();
  await vi.waitFor(() => expect(s.watches.length > 1 || s.writes.length > 1).toBe(true));
  expect(s.writes).toHaveLength(1);
  await Promise.all([first, last]);
  expect(s.store.getSnapshot()).toBeUndefined();
});

it("removes a missing command from recent commands while keeping image choices", async () => {
  const s = setup();
  const value = { images: [{ image: "busybox", command: "bash -l" }], recent: ["bash -l", "ash"] };
  s.watches[0]!.data(value);
  const removed = s.store.removeRecent("bash -l");
  expect(s.store.getSnapshot()).toEqual({ ...value, recent: ["ash"] });
  expect(s.writes).toHaveLength(1);
  s.writes[0]!.resolve();
  await removed;
});
it("applies a missing-command removal after an unread run in order", async () => {
  const s = setup();
  const run = s.store.run("busybox", "bash -l");
  const removed = s.store.removeRecent("bash -l");
  s.watches[0]!.data({ images: [], recent: ["ash"] });
  expect(s.writes[0]!.value).toEqual({ images: [], recent: ["ash"] });
  s.writes[0]!.resolve();
  await Promise.all([run, removed]);
});
