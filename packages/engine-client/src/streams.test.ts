import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EngineConnection, type SocketLike } from "./connection.ts";
import { Hash, ExecInputFrame, ExecInputWindow, type StreamClientMessage } from "./protocol.gen.ts";
import type { StreamListener } from "./client.ts";
import { streamInputPendingLimit } from "./streams.ts";
import { frame, status, source } from "./log-test-fixtures.ts";

class Socket implements SocketLike {
  sent: StreamClientMessage[] = [];
  binary: Uint8Array[] = [];
  binaryType = "";
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onmessage: SocketLike["onmessage"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(value: string | Uint8Array<ArrayBuffer>) {
    if (value instanceof Uint8Array) {
      this.binary.push(value);
      return;
    }
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

const execParams = {
  cluster: "c",
  namespace: "ns",
  pod: "web",
  uid: "uid",
  container: "main",
  cols: 80,
  rows: 24,
};
const execListener = (): StreamListener<"pod.exec"> => ({
  event: () => {},
  data: () => {},
  gap: () => {},
  end: () => {},
  state: vi.fn<() => void>(),
});

it("refuses and reports input beyond what may wait for a process that is not reading", async () => {
  const conn = connect();
  const dropped = vi.fn<(bytes: number) => void>();
  const stream = conn.openStream("pod.exec", execParams, {
    ...execListener(),
    inputDropped: dropped,
  });
  await Promise.resolve();
  const socket = sockets[1]!;
  socket.hello();
  const mebibyte = 1 << 20;
  // Nothing is acknowledged, so only the window leaves and the rest waits.
  for (let count = 0; count < streamInputPendingLimit / mebibyte; count++)
    stream.write(new Uint8Array(mebibyte));
  expect(dropped).not.toHaveBeenCalled();
  stream.write(new Uint8Array(mebibyte));
  expect(dropped).toHaveBeenCalledExactlyOnceWith(mebibyte);
  const sent = () => socket.binary.reduce((total, input) => total + input.byteLength - 1, 0);
  expect(sent()).toBe(ExecInputWindow);
  // What was accepted is still sent whole once the process reads again.
  for (let acked = 0; acked < streamInputPendingLimit; acked = sent())
    socket.receive({ type: "ack", bytes: sent() });
  expect(sent()).toBe(streamInputPendingLimit);
  // And there is room for more.
  stream.write(new Uint8Array(mebibyte));
  expect(dropped).toHaveBeenCalledOnce();
  conn.close();
});

it("sends a 1 MiB paste in order within the acknowledged input window", async () => {
  const conn = connect();
  const stream = conn.openStream("pod.exec", execParams, execListener());
  await Promise.resolve();
  const socket = sockets[1]!;
  const input = Uint8Array.from({ length: 1 << 20 }, (_, index) => index % 251);
  stream.write(input);
  stream.resize(132, 43);
  expect(socket.binary).toHaveLength(0);
  socket.hello();
  expect(socket.sent).toEqual([
    { type: "open", method: "pod.exec", params: execParams },
    { type: "resize", cols: 132, rows: 43 },
  ]);
  let received = 0;
  let count = 0;
  while (received < input.length) {
    const batch = socket.binary.slice(count);
    expect(batch.length).toBeGreaterThan(0);
    let bytes = 0;
    for (const inputFrame of batch) {
      expect(inputFrame[0]).toBe(0);
      expect(inputFrame.byteLength - 1).toBeLessThanOrEqual(ExecInputFrame);
      expect(inputFrame.subarray(1)).toEqual(
        input.subarray(received + bytes, received + bytes + inputFrame.byteLength - 1),
      );
      bytes += inputFrame.byteLength - 1;
    }
    expect(bytes).toBe(ExecInputWindow);
    count = socket.binary.length;
    received += bytes;
    socket.receive({ type: "ack", bytes: received });
  }
  expect(received).toBe(input.length);
  const before = sockets.length;
  stream.pause();
  expect(sockets).toHaveLength(before);
  stream.resize(100, 30);
  expect(socket.sent.at(-1)).toEqual({ type: "resize", cols: 100, rows: 30 });
  conn.close();
});

it("loses an opened Exec Session without starting a second shell, but retries before open", async () => {
  const conn = connect();
  const observe = execListener();
  const stream = conn.openStream("pod.exec", execParams, observe);
  await Promise.resolve();
  sockets[1]!.close();
  await vi.advanceTimersByTimeAsync(100);
  expect(sockets).toHaveLength(3);
  const socket = sockets[2]!;
  socket.hello();
  socket.close();
  expect(observe.state).toHaveBeenLastCalledWith("lost");
  stream.resume();
  stream.write(new Uint8Array([42]));
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(3);
  expect(socket.binary).toHaveLength(0);
  conn.close();
});

it("delivers Exec bytes and acknowledges only contiguous settled listeners, including rejection", async () => {
  const conn = connect();
  const observe = execListener();
  const resolves: (() => void)[] = [];
  const data: Uint8Array[] = [];
  observe.data = (bytes) => {
    data.push(bytes);
    return new Promise<void>((resolve) => resolves.push(resolve));
  };
  conn.openStream("pod.exec", execParams, observe);
  await Promise.resolve();
  const socket = sockets[1]!;
  socket.hello();
  socket.receive(new Uint8Array([1, 255, 0, 128]).buffer);
  socket.receive(new Uint8Array([1, 42]).buffer);
  expect(data).toEqual([new Uint8Array([255, 0, 128]), new Uint8Array([42])]);
  const acks = () => socket.sent.filter((message) => message.type === "ack");
  resolves[1]!();
  await Promise.resolve();
  expect(acks()).toEqual([]);
  resolves[0]!();
  await Promise.resolve();
  expect(acks()).toEqual([{ type: "ack", bytes: 6 }]);
  observe.data = () => Promise.reject(new Error("parser failure"));
  socket.receive(new Uint8Array([1, 3]).buffer);
  await Promise.resolve();
  expect(acks().at(-1)).toEqual({ type: "ack", bytes: 8 });
  observe.data = () => {
    throw new Error("listener failure");
  };
  socket.receive(new Uint8Array([1, 5]).buffer);
  expect(acks().at(-1)).toEqual({ type: "ack", bytes: 10 });
  conn.close();
});

it("shares the eight socket cap between sessions and Log Streams", async () => {
  const conn = connect();
  const sessions = Array.from({ length: 8 }, () =>
    conn.openStream("pod.exec", execParams, execListener()),
  );
  const observe = listener();
  conn.openStream("resource.logs", params, observe);
  await Promise.resolve();
  expect(sockets).toHaveLength(9);
  expect(observe.state).toHaveBeenLastCalledWith("waiting");
  sessions[0]!.pause();
  expect(sockets).toHaveLength(9);
  sessions[0]!.close();
  expect(sockets).toHaveLength(10);
  conn.close();
});
