import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EngineConnection, type SocketLike } from "./connection.ts";
import { Hash, type StreamClientMessage } from "./protocol.gen.ts";
import type { StreamListener } from "./client.ts";
import { frame, status, source } from "./log-test-fixtures.ts";

class Socket implements SocketLike {
  sent: StreamClientMessage[] = [];
  binaryType = "";
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onmessage: SocketLike["onmessage"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(value: string) {
    this.sent.push(JSON.parse(value) as StreamClientMessage);
  }
  close() {
    this.onclose?.(new CloseEvent("close"));
  }
  receive(data: unknown) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: data instanceof ArrayBuffer ? data : JSON.stringify(data),
      }),
    );
  }
  hello(hash = Hash) {
    this.onopen?.(new Event("open"));
    this.receive({ type: "hello", hello: { protocol: hash } });
  }
}
let sockets: Socket[];
const params = { cluster: "c", type: "pods", name: "web", uid: "uid" };
const listener = (): StreamListener<"resource.logs"> => ({
  state: vi.fn<() => void>(),
  event: vi.fn<() => void>(),
  data: vi.fn<() => void>(),
  gap: vi.fn<() => void>(),
  end: vi.fn<() => void>(),
});
const connect = () =>
  new EngineConnection({
    url: "http://localhost",
    token: "t",
    retryDelaysMs: [100],
    createSocket: (url, protocols) => {
      const socket = new Socket(url, protocols);
      sockets.push(socket);
      return socket;
    },
  });
beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("checks hello, opens with params, and delivers events gaps and end in order", async () => {
  const conn = connect();
  const seen: string[] = [];
  const observe = listener();
  observe.event = () => seen.push("event");
  observe.gap = () => seen.push("gap");
  observe.end = () => seen.push("end");
  conn.openStream("resource.logs", params, observe);
  await Promise.resolve();
  const socket = sockets[1]!;
  expect(socket.url).toBe("ws://localhost/ws/stream");
  expect(socket.protocols).toEqual(["hukube.stream.v1", "hukube.token.t"]);
  expect(socket.sent).toEqual([]);
  socket.hello();
  expect(socket.sent[0]).toEqual({
    type: "open",
    method: "resource.logs",
    params: { ...params, resume: [] },
  });
  socket.receive({ type: "event", event: status });
  socket.receive({ type: "gap", gap: { bytes: 4, records: 2 } });
  socket.receive({ type: "end", end: { reason: "complete" } });
  expect(seen).toEqual(["event", "gap", "end"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(sockets).toHaveLength(2);
  conn.close();
});
it("ends a wrong hash or missing hello without retry", async () => {
  for (const wrong of [true, false]) {
    const conn = connect();
    const observe = listener();
    conn.openStream("resource.logs", params, observe);
    await Promise.resolve();
    const socket = sockets.at(-1)!;
    if (wrong) socket.hello("wrong");
    else socket.onopen?.(new Event("open"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(observe.end).toHaveBeenCalledWith(expect.objectContaining({ reason: "error" }));
    expect(conn.getState()).toBe("outdated");
    expect(socket.sent).toEqual([]);
    const count = sockets.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(count);
    conn.close();
  }
});
it("reconnects with cursors and stable source numbers after loss but never after end", async () => {
  const conn = connect();
  const observe = listener();
  conn.openStream("resource.logs", params, observe);
  await Promise.resolve();
  let socket = sockets[1]!;
  socket.hello();
  socket.receive({ type: "event", event: status });
  socket.receive(frame());
  socket.close();
  expect(observe.state).toHaveBeenLastCalledWith("reconnecting");
  await vi.advanceTimersByTimeAsync(99);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  socket = sockets[2]!;
  socket.hello();
  expect(socket.sent[0]?.params).toMatchObject({
    resume: [{ podUid: "uid", container: "constructor", instance: "run1", time: "1234567890" }],
  });
  socket.receive({ type: "event", event: { ...status, sources: [{ ...source, id: 8 }] } });
  socket.receive(frame(8));
  expect(observe.data).toHaveBeenLastCalledWith([{ source: 0, time: 1234, text: "line" }]);
  socket.receive({ type: "end", end: { reason: "deleted" } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(3);
  conn.close();
});
it("caps sockets at eight, removes waiting streams, and resumes paused cursors first come first served", async () => {
  const conn = connect();
  const observers = Array.from({ length: 10 }, listener);
  const streams = observers.map((observe) => conn.openStream("resource.logs", params, observe));
  await Promise.resolve();
  expect(sockets).toHaveLength(9);
  expect(observers[8]!.state).toHaveBeenLastCalledWith("waiting");
  streams[8]!.close();
  const first = sockets[1]!;
  first.hello();
  first.receive({ type: "event", event: status });
  first.receive(frame());
  streams[0]!.pause();
  expect(sockets).toHaveLength(10);
  expect(observers[9]!.state).toHaveBeenLastCalledWith("connecting");
  streams[0]!.resume();
  expect(observers[0]!.state).toHaveBeenLastCalledWith("waiting");
  streams[1]!.close();
  expect(sockets).toHaveLength(11);
  const resumed = sockets.at(-1)!;
  resumed.hello();
  expect(resumed.sent[0]?.params).toMatchObject({ resume: [{ time: "1234567890" }] });
  conn.close();
});
it("acknowledges exact binary frame totals only after consumption and ignores old socket acknowledgements", async () => {
  const conn = connect();
  const consume: (() => void)[] = [];
  const observe = listener();
  const stream = conn.openStream("resource.logs", params, observe, (_data, _bytes, acknowledge) =>
    consume.push(acknowledge),
  );
  await Promise.resolve();
  const socket = sockets[1]!;
  socket.hello();
  socket.receive({ type: "event", event: status });
  socket.receive(frame());
  socket.receive(frame(7, 0, 0n, "longer"));
  expect(socket.sent).toHaveLength(1);
  consume[0]!();
  expect(socket.sent.at(-1)).toEqual({ type: "ack", bytes: 20 });
  consume[1]!();
  expect(socket.sent.at(-1)).toEqual({ type: "ack", bytes: 42 });
  stream.pause();
  stream.resume();
  const next = sockets.at(-1)!;
  next.hello();
  consume[1]!();
  expect(next.sent).toHaveLength(1);
  conn.close();
});

it("holds back a stream that was paused before its first socket opened", async () => {
  const connection = connect();
  const before = sockets.length;
  const stream = connection.openStream("resource.logs", params, listener());
  stream.pause();
  await Promise.resolve();
  expect(sockets).toHaveLength(before);
  stream.resume();
  expect(sockets).toHaveLength(before + 1);
});
