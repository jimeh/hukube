// @vitest-environment jsdom
import type { EngineClient, StreamEnd, StreamListener } from "@hukube/engine-client";
import { afterEach, expect, it, vi } from "vitest";
import {
  disposeClusterSessions,
  disposeSession,
  startSession,
  useExecSessions,
} from "./sessions.ts";
import { fakeTerminal } from "./test-terminal.ts";

const params = {
  sessionId: "constructor",
  namespace: "ns",
  pod: "web",
  uid: "uid",
  container: "__proto__",
};
function setup() {
  const fake = fakeTerminal();
  const streams: {
    listener: StreamListener<"pod.exec">;
    close: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
  }[] = [];
  const openStream = vi.fn<
    (
      method: string,
      params: unknown,
      listener: StreamListener<"pod.exec">,
    ) => {
      close: () => void;
      write: (bytes: Uint8Array) => void;
      resize: (cols: number, rows: number) => void;
      pause: () => void;
      resume: () => void;
    }
  >((_method, _params, listener) => {
    const stream = {
      listener,
      close: vi.fn<() => void>(),
      write: vi.fn<(bytes: Uint8Array) => void>(),
      resize: vi.fn<(cols: number, rows: number) => void>(),
      pause: vi.fn<() => void>(),
      resume: vi.fn<() => void>(),
    };
    streams.push(stream);
    return stream;
  });
  const engine = { openStream } as unknown as EngineClient;
  const start = () => startSession(engine, "c", params, async () => fake.terminal);
  const sid = params.sessionId;
  const state = () => useExecSessions.getState().entries.get(sid)?.state;
  return { ...fake, streams, engine, openStream, start, state };
}
afterEach(() => {
  for (const id of useExecSessions.getState().entries.keys()) disposeSession(id);
});

it("starts at once, waits when the stream does, and stays starting until output", async () => {
  const s = setup();
  await s.start();
  expect(s.state()).toEqual({ phase: "starting" });
  s.streams[0]!.listener.state?.("waiting");
  expect(s.state()).toEqual({ phase: "waiting" });
  s.streams[0]!.listener.state?.("connecting");
  expect(s.state()).toEqual({ phase: "starting" });
  s.streams[0]!.listener.state?.("open");
  expect(s.state()).toEqual({ phase: "starting" });
  s.streams[0]!.listener.state?.("waiting");
  expect(s.state()).toEqual({ phase: "waiting" });
  void s.streams[0]!.listener.data(new Uint8Array([42]));
  expect(s.state()).toEqual({ phase: "live" });
  expect(s.openStream.mock.calls[0]?.[1]).toMatchObject({
    cols: 80,
    rows: 24,
    container: "__proto__",
    uid: "uid",
  });
});

it.each<StreamEnd>([
  { reason: "complete", exitCode: 0 },
  { reason: "complete", exitCode: 3 },
  { reason: "stopped" },
  { reason: "deleted" },
  { reason: "error", error: { code: "unavailable", reason: "ConnectionLost", message: "timeout" } },
])("retains the end reason after output: %j", async (end) => {
  const s = setup();
  await s.start();
  void s.streams[0]!.listener.data(new Uint8Array([42]));
  s.streams[0]!.listener.end(end);
  expect(s.state()).toEqual({ phase: "ended", ...end });
  expect(s.terminal.setEnded).toHaveBeenLastCalledWith(true);
  s.data("ignored");
  expect(s.streams[0]!.write).not.toHaveBeenCalled();
});

it("ends a lost stream even before output and distinguishes a start failure", async () => {
  const s = setup();
  await s.start();
  s.streams[0]!.listener.state?.("lost");
  expect(s.state()).toEqual({ phase: "ended", reason: "lost" });
  await s.start();
  s.streams[1]!.listener.end({
    reason: "error",
    error: { code: "not_found", reason: "NoShell", message: "no sh" },
  });
  expect(s.state()).toMatchObject({ phase: "failed", error: { reason: "NoShell" } });
});

it("acknowledges only after the terminal write callback, encodes input, resizes, and shows dropped output", async () => {
  const s = setup();
  await s.start();
  const listener = s.streams[0]!.listener;
  let acknowledged = false;
  const consumption = Promise.resolve(listener.data(new Uint8Array([1, 2]))).then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  s.terminal.write.mock.calls[0]![1]!();
  await consumption;
  expect(acknowledged).toBe(true);
  s.data("é");
  s.binary("\xff\x80");
  s.resize(100, 40);
  expect(s.streams[0]!.write.mock.calls.map(([bytes]) => [...(bytes as Uint8Array)])).toEqual([
    [195, 169],
    [255, 128],
  ]);
  expect(s.streams[0]!.resize).toHaveBeenCalledWith(100, 40);
  listener.gap({ bytes: 1_258_291, records: 0 });
  expect(s.terminal.write).toHaveBeenLastCalledWith(
    "\x1b[0m\r\n\x1b[2m[hukube: 1.2 MiB of output was dropped because this window was not keeping up]\x1b[0m\r\n",
  );
  listener.inputDropped?.(1 << 20);
  expect(s.terminal.write).toHaveBeenLastCalledWith(
    "\r\n\x1b[2m[hukube: 1.0 MiB of input was not sent, because the process is not reading and too much is already waiting]\x1b[0m\r\n",
  );
});

it("attaches twice without another stream, ignores duplicate starts, resets on restart, and disposes on close", async () => {
  const s = setup();
  await s.start();
  const first = document.createElement("div");
  const second = document.createElement("div");
  s.terminal.attach(first, true)();
  s.terminal.attach(second, true);
  await s.start();
  s.streams[0]!.listener.state?.("connecting");
  await s.start();
  void s.streams[0]!.listener.data(new Uint8Array([42]));
  await s.start();
  expect(s.openStream).toHaveBeenCalledOnce();
  s.streams[0]!.listener.end({ reason: "complete", exitCode: 3 });
  await s.start();
  expect(s.openStream).toHaveBeenCalledTimes(2);
  expect(s.streams[0]!.close).toHaveBeenCalledOnce();
  expect(s.terminal.reset).toHaveBeenCalledTimes(2);
  s.streams[1]!.listener.state?.("connecting");
  s.streams[0]!.listener.state?.("lost");
  expect(s.state()).toEqual({ phase: "starting" });
  disposeClusterSessions("other");
  expect(s.state()).toBeDefined();
  disposeClusterSessions("c");
  expect(s.streams[1]!.close).toHaveBeenCalledOnce();
  expect(s.terminal.dispose).toHaveBeenCalledOnce();
  expect(s.state()).toBeUndefined();
});

it("disposes a terminal loaded after its Tab was closed without opening a stream", async () => {
  const s = setup();
  let loaded!: (terminal: typeof s.terminal) => void;
  const start = startSession(
    s.engine,
    "c",
    params,
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  disposeSession(params.sessionId);
  loaded(s.terminal);
  await start;
  expect(s.terminal.dispose).toHaveBeenCalledOnce();
  expect(s.openStream).not.toHaveBeenCalled();
});

it("waits for old output to drain before opening the next stream", async () => {
  const s = setup();
  await s.start();
  s.streams[0]!.listener.end({ reason: "complete", exitCode: 0 });
  let reset!: () => void;
  s.terminal.reset.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        reset = resolve;
      }),
  );
  const restart = s.start();
  await Promise.resolve();
  expect(s.openStream).toHaveBeenCalledOnce();
  reset();
  await restart;
  expect(s.openStream).toHaveBeenCalledTimes(2);
});

it("treats a Pod that is gone before any output as a failure to start", async () => {
  const s = setup();
  await s.start();
  s.streams[0]!.listener.end({ reason: "deleted" });
  expect(s.state()).toEqual({ phase: "failed", reason: "deleted" });
});

it("opens the stream once the terminal has its size, or after a wait without one", async () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    let sized: (() => void) | undefined;
    s.terminal.ready = new Promise<void>((resolve) => {
      sized = resolve;
    });
    const started = s.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(s.terminal.reset).toHaveBeenCalled();
    expect(s.openStream).not.toHaveBeenCalled();
    s.terminal.cols = 132;
    s.terminal.rows = 43;
    sized?.();
    await started;
    expect(s.openStream.mock.calls[0]?.[1]).toMatchObject({ cols: 132, rows: 43 });

    // A terminal that is never sized, as in a hidden panel, starts at its default size.
    disposeSession(params.sessionId);
    const hidden = setup();
    hidden.terminal.ready = new Promise<void>(() => {});
    const waiting = hidden.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(hidden.openStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(hidden.openStream.mock.calls[0]?.[1]).toMatchObject({ cols: 80, rows: 24 });
  } finally {
    vi.useRealTimers();
  }
});
