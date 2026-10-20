import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SocketLike } from "./connection.ts";
import { Hash, type ClientMessage, type ServerMessage } from "./protocol.gen.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

class FakeSocket implements SocketLike {
  static latest: FakeSocket;
  sent: ClientMessage[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor() {
    FakeSocket.latest = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close() {
    this.onclose?.(new CloseEvent("close"));
  }
  open() {
    this.onopen?.(new Event("open"));
    this.receive({ id: 0, type: "hello", hello: { protocol: Hash } });
  }
  receive(message: ServerMessage) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

let scope: {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage: ReturnType<typeof vi.fn<(message: FromWorker) => void>>;
};

function send(message: ToWorker) {
  scope.onmessage!(new MessageEvent("message", { data: message }));
}

function subscribe() {
  send({ kind: "connect", endpoint: { url: "http://localhost", token: "t" } });
  const socket = FakeSocket.latest;
  socket.open();
  expect(scope.postMessage).toHaveBeenCalledWith({ kind: "state", state: "open" });
  send({ kind: "subscribe", id: 7, method: "settings.watch", params: { key: "a" } });
  expect(socket.sent).toEqual([
    { id: 1, type: "subscribe", method: "settings.watch", params: { key: "a" }, rev: 0 },
  ]);
  return socket;
}

beforeEach(async () => {
  vi.resetModules();
  scope = { onmessage: null, postMessage: vi.fn<(message: FromWorker) => void>() };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("WebSocket", FakeSocket);
  await import("./worker.ts");
});
afterEach(() => {
  send({ kind: "close" });
  vi.unstubAllGlobals();
});

describe("connection Worker", () => {
  it("relays initial subscription data with count zero", () => {
    const socket = subscribe();
    const data = { key: "a", value: 1 };
    socket.receive({ id: 1, type: "data", rev: 0, data });
    expect(scope.postMessage).toHaveBeenLastCalledWith({ kind: "data", id: 7, count: 0, data });
  });

  it("sends updates and stamps current data and errors with the main thread's count", () => {
    const socket = subscribe();
    send({ kind: "update", id: 7, count: 3, params: { key: "b" } });
    expect(socket.sent[1]).toEqual({ id: 1, type: "update", params: { key: "b" }, rev: 1 });

    const data = { key: "b", value: 2 };
    socket.receive({ id: 1, type: "data", rev: 1, data });
    expect(scope.postMessage).toHaveBeenLastCalledWith({ kind: "data", id: 7, count: 3, data });
    const error = { code: "internal" as const, message: "current" };
    socket.receive({ id: 1, type: "error", rev: 1, error });
    expect(scope.postMessage).toHaveBeenLastCalledWith({ kind: "error", id: 7, count: 3, error });
  });

  it("does not post socket data or errors for a superseded revision", () => {
    const socket = subscribe();
    send({ kind: "update", id: 7, count: 3, params: { key: "b" } });
    expect(socket.sent[1]).toMatchObject({ type: "update", rev: 1 });
    scope.postMessage.mockClear();

    socket.receive({ id: 1, type: "data", rev: 0, data: { key: "a", value: 1 } });
    socket.receive({ id: 1, type: "error", rev: 0, error: { code: "internal", message: "old" } });
    expect(scope.postMessage).not.toHaveBeenCalled();
  });
});
