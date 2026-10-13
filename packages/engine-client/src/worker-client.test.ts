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
