import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FromWorker, ToWorker } from "./worker-protocol.ts";
import { WorkerEngineClient } from "./worker-client.ts";

class FakeWorker {
  static latest: FakeWorker;
  sent: ToWorker[] = [];
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  constructor() {
    FakeWorker.latest = this;
  }
  postMessage(msg: ToWorker) {
    this.sent.push(msg);
  }
  terminate() {}
  receive(msg: FromWorker) {
    this.onmessage?.(new MessageEvent("message", { data: msg }));
  }
}

beforeEach(() => vi.stubGlobal("Worker", FakeWorker));
afterEach(() => vi.unstubAllGlobals());

describe("WorkerEngineClient", () => {
  it("drops data and errors that crossed an update at the Worker boundary", () => {
    const client = new WorkerEngineClient({ url: "http://localhost", token: "t" });
    const worker = FakeWorker.latest;
    worker.receive({ kind: "state", state: "open" });
    const data = vi.fn<(value: unknown) => void>(),
      error = vi.fn<(value: unknown) => void>();
    const sub = client.subscribe("settings.watch", { key: "a" }, { data, error });
    const message = worker.sent[1]!;
    expect(message.kind).toBe("subscribe");
    if (message.kind !== "subscribe") throw new Error("missing subscribe");
    const id = message.id;
    worker.receive({ kind: "data", id, count: 0, data: { key: "a", value: 1 } });
    sub.update({ key: "b" });
    worker.receive({ kind: "data", id, count: 0, data: { key: "a", value: 2 } });
    worker.receive({ kind: "error", id, count: 0, error: { code: "internal", message: "old" } });
    expect(data.mock.calls).toEqual([[{ key: "a", value: 1 }]]);
    expect(error).not.toHaveBeenCalled();
    expect(worker.sent[2]).toEqual({ kind: "update", id, count: 1, params: { key: "b" } });
    worker.receive({ kind: "data", id, count: 1, data: { key: "b", value: 3 } });
    worker.receive({
      kind: "error",
      id,
      count: 1,
      error: { code: "internal", message: "current" },
    });
    expect(data).toHaveBeenLastCalledWith({ key: "b", value: 3 });
    expect(error).toHaveBeenCalledWith({ code: "internal", message: "current" });
    sub.close();
    worker.receive({ kind: "data", id, count: 1, data: { key: "b", value: 4 } });
    expect(data).toHaveBeenCalledTimes(2);
    sub.update({ key: "c" });
    expect(worker.sent.at(-1)).toEqual({ kind: "unsubscribe", id });
  });

  it("relays the outdated state", () => {
    const client = new WorkerEngineClient({ url: "http://localhost", token: "t" });
    const changed = vi.fn<() => void>();
    client.onStateChange(changed);
    FakeWorker.latest.receive({ kind: "state", state: "outdated" });
    expect(client.getState()).toBe("outdated");
    expect(changed).toHaveBeenCalledOnce();
    client.close();
    expect(client.getState()).toBe("closed");
  });
});

it("acknowledges stream bytes after the main-thread data listener returns", () => {
  const client = new WorkerEngineClient({ url: "http://localhost", token: "t" });
  const worker = FakeWorker.latest;
  worker.receive({ kind: "state", state: "open" });
  const data = vi.fn<() => void>(() => {
    expect(worker.sent.filter((message) => message.kind === "stream-ack")).toHaveLength(0);
  });
  const stream = client.openStream(
    "resource.logs",
    { cluster: "c", type: "pods", name: "p", uid: "u" },
    { data, event: vi.fn<() => void>(), gap: vi.fn<() => void>(), end: vi.fn<() => void>() },
  );
  const message = worker.sent[1]!;
  if (message.kind !== "stream-open") throw new Error("missing stream-open");
  worker.receive({ kind: "stream-data", id: message.id, data: [], bytes: 42, token: 1 });
  expect(data).toHaveBeenCalledOnce();
  expect(worker.sent.at(-1)).toEqual({ kind: "stream-ack", id: message.id, token: 1, bytes: 42 });
  data.mockImplementation(() => {});
  worker.receive({ kind: "stream-data", id: message.id, data: [], bytes: 20, token: 2 });
  expect(worker.sent.at(-1)).toEqual({ kind: "stream-ack", id: message.id, token: 2, bytes: 62 });
  stream.pause();
  stream.resume();
  stream.close();
  worker.receive({ kind: "stream-data", id: message.id, data: [], bytes: 20, token: 3 });
  expect(data).toHaveBeenCalledTimes(2);
  expect(worker.sent.at(-1)).toEqual({ kind: "stream-close", id: message.id });
});

it("exposes structured errors and client-only disconnected errors", async () => {
  const client = new WorkerEngineClient({ url: "http://localhost", token: "t" });
  const worker = FakeWorker.latest;
  worker.receive({ kind: "state", state: "open" });
  const promise = client.request("clusters.list", undefined);
  const error = {
    code: "invalid" as const,
    message: "invalid",
    reason: "Invalid",
    causes: [{ field: "spec.replicas", message: "negative" }],
  };
  worker.receive({ kind: "failure", id: 1, error });
  await expect(promise).rejects.toMatchObject(error);
  const disconnected = client.request("clusters.list", undefined);
  worker.receive({ kind: "failure", id: 2, error: { code: "disconnected", message: "lost" } });
  await expect(disconnected).rejects.toMatchObject({ code: "disconnected" });
  client.close();
});

it("sends cancellation, ignores the late answer, and cleans up finished requests", async () => {
  const client = new WorkerEngineClient({ url: "http://localhost", token: "t" });
  const worker = FakeWorker.latest;
  worker.receive({ kind: "state", state: "open" });
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    client.request("clusters.list", undefined, { signal: aborted.signal }),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(worker.sent).toHaveLength(1);
  const controller = new AbortController();
  const promise = client.request("clusters.list", undefined, { signal: controller.signal });
  controller.abort();
  expect(worker.sent.at(-1)).toEqual({ kind: "cancel", id: 1 });
  await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  worker.receive({ kind: "result", id: 1, data: [] });
  const active = new AbortController();
  const complete = client.request("clusters.list", undefined, { signal: active.signal });
  worker.receive({ kind: "result", id: 2, data: [] });
  await expect(complete).resolves.toEqual([]);
  active.abort();
  expect(worker.sent.at(-1)?.kind).toBe("request");
  const closed = client.request("clusters.list", undefined, {
    signal: new AbortController().signal,
  });
  client.close();
  await expect(closed).rejects.toMatchObject({ code: "disconnected" });
});

it.each(["connecting", "reconnecting", "outdated", "closed"] as const)(
  "sends nothing while %s",
  async (state) => {
    const client = new WorkerEngineClient({ url: "http://localhost", token: "t" });
    const worker = FakeWorker.latest;
    worker.receive({ kind: "state", state });
    await expect(client.request("clusters.list", undefined)).rejects.toMatchObject({
      code: "not_connected",
    });
    expect(worker.sent.map((message) => message.kind)).toEqual(["connect"]);
    client.close();
  },
);
