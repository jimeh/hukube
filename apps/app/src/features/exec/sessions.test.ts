// @vitest-environment jsdom
import { EngineRequestError, type EngineClient, type StreamListener } from "@hukube/engine-client";
import { Terminal } from "@xterm/headless";
import { afterEach, expect, it, vi } from "vitest";
import {
  attachSession,
  detachClusterSessions,
  dismissSkippedNotice,
  endSession,
  holdsSession,
  startSession,
  takeSession,
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
const sync = { offset: 0, cols: 80, rows: 24 };
const state = () => useExecSessions.getState().entries.get(params.sessionId)?.state;
const changed = async (call: () => void) => {
  const previous = useExecSessions.getState().entries.get(params.sessionId);
  call();
  await vi.waitFor(() =>
    expect(useExecSessions.getState().entries.get(params.sessionId)).not.toBe(previous),
  );
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
      listener: StreamListener<"pod.exec">;
      close: () => void;
      write: (bytes: Uint8Array) => void;
      resize: (cols: number, rows: number) => void;
      pause: () => void;
      resume: () => void;
    }
  >((_method: string, _params: unknown, listener: StreamListener<"pod.exec">) => {
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
  let connection = "open";
  const listeners = new Set<() => void>();
  const request = vi.fn<EngineClient["request"]>().mockResolvedValue(undefined);
  const engine = {
    openStream,
    request,
    getState: () => connection,
    onStateChange: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as EngineClient;
  const start = () => startSession(engine, "c", params, async () => fake.terminal);
  const attach = () => attachSession(engine, "c", params, async () => fake.terminal);

  const listener = () => {
    const current = streams.at(-1)!.listener;
    return {
      ...current,
      event: (event: Parameters<typeof current.event>[0]) => changed(() => current.event(event)),
      state: (next: Parameters<NonNullable<typeof current.state>>[0]) =>
        changed(() => current.state?.(next)),
      end: (end: Parameters<typeof current.end>[0]) => changed(() => current.end(end)),
      inputDropped: async (bytes: number) => {
        const before = fake.terminal.write.mock.calls.length;
        current.inputDropped?.(bytes);
        await vi.waitFor(() =>
          expect(fake.terminal.write.mock.calls.length).toBeGreaterThan(before),
        );
      },
    };
  };
  const data = (text: string) => listener().data(new TextEncoder().encode(text));
  return {
    ...fake,
    engine,
    streams,
    openStream,
    request,
    start,
    attach,
    state,
    listener,
    output: data,
    connection: (next: string) => {
      connection = next;
      for (const fn of listeners) fn();
    },
  };
}
afterEach(() => {
  detachClusterSessions("c");
  vi.useRealTimers();
});

it("starts once at the terminal's size and stays starting until the first output", async () => {
  const s = setup();
  await s.start();
  await s.start();
  expect(s.openStream).toHaveBeenCalledOnce();
  expect(s.openStream.mock.calls[0]![1]).toMatchObject({
    session: params.sessionId,
    start: true,
    cols: 80,
    rows: 24,
    container: "__proto__",
  });
  await s.listener().state?.("waiting");
  expect(s.state()).toEqual({ phase: "waiting", attaching: false });
  expect(holdsSession(useExecSessions.getState().entries.get(params.sessionId))).toBe(false);
  await s.listener().state?.("connecting");
  await s.listener().event(sync);
  expect(s.state()).toEqual({ phase: "starting" });
  await s.output("prompt");
  expect(s.state()).toEqual({ phase: "live" });
  s.data("é");
  s.binary("\xff\x80");
  s.resize(100, 40);
  expect(s.streams[0]!.write.mock.calls.map(([bytes]) => [...bytes])).toEqual([
    [195, 169],
    [255, 128],
  ]);
  expect(s.streams[0]!.resize).toHaveBeenCalledWith(100, 40);
});

it("attaches without start or an unsized terminal's defaults and takes the sync's size", async () => {
  vi.useFakeTimers();
  const s = setup();
  s.terminal.sized = false;
  s.terminal.ready = new Promise(() => {});
  const attaching = s.attach();
  await vi.advanceTimersByTimeAsync(999);
  expect(s.openStream).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await attaching;
  expect(s.openStream.mock.calls[0]![1]).not.toHaveProperty("start");
  expect(s.openStream.mock.calls[0]![1]).not.toHaveProperty("cols");
  await s.listener().state?.("waiting");
  expect(holdsSession(useExecSessions.getState().entries.get(params.sessionId))).toBe(true);
  await s.listener().state?.("connecting");
  await s.listener().event({ ...sync, cols: 132, rows: 43, offset: 10 });
  expect(s.terminal.size).toHaveBeenCalledWith(132, 43);
  expect(s.state()).toEqual({ phase: "live" });
});

it("attaches with a measured size and never resizes it from a sync", async () => {
  const s = setup();
  s.terminal.cols = 132;
  s.terminal.rows = 43;
  await s.attach();
  await s.attach();
  expect(s.openStream).toHaveBeenCalledOnce();
  expect(s.openStream.mock.calls[0]![1]).toMatchObject({ cols: 132, rows: 43 });
  await s.listener().event({ ...sync, replay: 4 });
  expect(s.state()).toEqual({ phase: "live" });
  expect(s.terminal.size).not.toHaveBeenCalled();
});

it("orders reset, notice, restore, data, and end and acknowledges only parsed data", async () => {
  const s = setup();
  await s.attach();
  const callbacks: (() => void)[] = [];
  s.terminal.write.mockImplementation((_bytes, done) => {
    if (done) callbacks.push(done);
  });
  const synced = s
    .listener()
    .event({ ...sync, reset: true, skipped: 2048, restore: "restore", replay: 4 });
  let acknowledged = false;
  const data = Promise.resolve(s.output("data")).then(() => {
    acknowledged = true;
  });
  const ended = s.listener().end({ reason: "complete", exitCode: 3 });
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  expect(s.terminal.write.mock.calls[0]![0]).toBe("\x18\x1bc");
  callbacks.shift()!();
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  expect(s.terminal.write.mock.calls[1]![0]).toBe(
    "\x1b[2m[hukube: 2.0 KiB of earlier output is not shown. The Engine keeps only a session's most recent output.]\x1b[0m\r\n",
  );
  callbacks.shift()!();
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  expect(s.terminal.write.mock.calls[2]![0]).toBe("restore");
  callbacks.shift()!();
  await synced;
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  expect(acknowledged).toBe(false);
  expect(s.state()?.phase).toBe("live");
  callbacks.shift()!();
  await data;
  await ended;
  expect(acknowledged).toBe(true);
  expect(s.state()).toEqual({ phase: "ended", reason: "complete", exitCode: 3 });
  expect(s.terminal.restoreOptions).toHaveBeenCalledOnce();
});

it("prints the distinct disconnected and slow-window skipped notices", async () => {
  const s = setup();
  await s.start();
  await s.listener().event(sync);
  await s.output("prompt");
  await s.listener().state?.("reconnecting");
  expect(s.state()?.phase).toBe("reconnecting");
  s.data("discarded");
  expect(s.streams[0]!.write).not.toHaveBeenCalled();
  await s.listener().event({ ...sync, offset: 2000000, reset: true, skipped: 1258291 });
  await s.listener().event({ ...sync, offset: 3000000, reset: true, skipped: 2048 });
  expect(s.terminal.write.mock.calls.map(([bytes]) => bytes)).toContain(
    "\x1b[2m[hukube: 1.2 MiB of output was skipped while this window was disconnected]\x1b[0m\r\n",
  );
  expect(s.terminal.write.mock.calls.map(([bytes]) => bytes)).toContain(
    "\x1b[2m[hukube: 2.0 KiB of output was skipped because this window was not keeping up]\x1b[0m\r\n",
  );
  await s.listener().inputDropped?.(1 << 20);
  expect(s.terminal.write.mock.calls.at(-1)![0]).toContain("1.0 MiB of input was not sent");
});

it("suppresses replayed queries and keys, then answers live queries with a real terminal", async () => {
  const s = setup();
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const emitted = vi.fn<(text: string) => void>();
  terminal.onData(emitted);
  s.terminal.write.mockImplementation((bytes, done) => terminal.write(bytes, done));
  s.terminal.holdInput.mockImplementation((held) => {
    terminal.options.disableStdin = held;
  });
  s.terminal.onData = (fn) => {
    const off = terminal.onData(fn);
    return () => off.dispose();
  };
  s.terminal.dispose.mockImplementation(() => terminal.dispose());
  await s.attach();
  const query = "\x1b[6n\x1b[c";
  await s.listener().event({ ...sync, replay: query.length });
  terminal.input("typed during replay");
  await s.output(query);
  expect(s.streams[0]!.write).not.toHaveBeenCalled();
  expect(emitted).not.toHaveBeenCalled();
  await s.output(query);
  const answers = s.streams[0]!.write.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes));
  expect(answers).toEqual(["\x1b[1;1R", "\x1b[?1;2c"]);
  terminal.input("live key");
  expect(new TextDecoder().decode(s.streams[0]!.write.mock.calls.at(-1)![0])).toBe("live key");
});

it("maps final ends without reconnecting and restarts only when the user asks", async () => {
  const s = setup();
  await s.attach();
  await s
    .listener()
    .end({ reason: "error", error: { code: "not_found", reason: "SessionGone", message: "gone" } });
  expect(s.state()).toEqual({ phase: "gone" });
  await s.attach();
  expect(s.openStream).toHaveBeenCalledOnce();
  await s.start();
  expect(s.openStream.mock.calls[1]![1]).toMatchObject({ session: params.sessionId, start: true });
  await s.listener().end({
    reason: "error",
    error: { code: "unavailable", reason: "TooManySessions", message: "full" },
  });
  expect(s.state()?.phase).toBe("failed");
  await s.start();
  await s.listener().end({ reason: "deleted" });
  expect(s.state()?.phase).toBe("failed");
  await s.start();
  await s.listener().event({ ...sync, offset: 20 });
  await s
    .listener()
    .end({ reason: "error", error: { code: "unavailable", message: "lost Cluster" } });
  expect(s.state()?.phase).toBe("ended");
  let reset!: () => void;
  s.terminal.reset.mockImplementation(
    () =>
      new Promise<void>((done) => {
        reset = done;
      }),
  );
  const before = s.openStream.mock.calls.length;
  const restarting = s.start();
  await vi.waitFor(() => expect(reset).toBeDefined());
  expect(s.openStream).toHaveBeenCalledTimes(before);
  reset();
  await restarting;
  expect(s.openStream).toHaveBeenCalledTimes(before + 1);
});

it("takes an elsewhere session without resetting the terminal or starting a process", async () => {
  const s = setup();
  await s.attach();
  await s.listener().event({ ...sync, offset: 10 });
  await s.output("parsed");
  await s.listener().end({ reason: "detached" });
  expect(s.state()?.phase).toBe("elsewhere");
  expect(s.terminal.setEnded).toHaveBeenLastCalledWith(false);
  expect(s.terminal.setAttached).toHaveBeenLastCalledWith(false);
  await takeSession(s.engine, "c", params);
  expect(s.openStream.mock.calls[1]![1]).toMatchObject({
    takeover: true,
    resume: 16,
    session: params.sessionId,
  });
  expect(s.openStream.mock.calls[1]![1]).not.toHaveProperty("start");
  expect(s.terminal.reset).not.toHaveBeenCalled();
  s.streams[0]!.listener.event({ ...sync, offset: 30 });
  expect(s.state()?.phase).toBe("attaching");
  expect(s.terminal.focus).not.toHaveBeenCalled();
  await s.listener().event({ ...sync, offset: 10, replay: 4 });
  expect(s.terminal.focus).not.toHaveBeenCalled();
  await s.output("tail");
  expect(s.terminal.focus).toHaveBeenCalledTimes(1);
});

it("detaches a Workspace without ending sessions and ends a held Tab once", async () => {
  const s = setup();
  await s.attach();
  detachClusterSessions("other");
  expect(s.state()).toBeDefined();
  detachClusterSessions("c");
  endSession(params.sessionId);
  expect(s.request).not.toHaveBeenCalled();
  expect(s.terminal.dispose).toHaveBeenCalledOnce();
  expect(s.streams[0]!.close).toHaveBeenCalledOnce();
  await s.start();
  endSession(params.sessionId);
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledOnce());
  expect(s.request).toHaveBeenCalledWith("exec.end", { cluster: "c", session: params.sessionId });
});

it("retries unreachable end requests on open and drops other errors", async () => {
  for (const code of ["not_connected", "disconnected", "forbidden"] as const) {
    const s = setup();
    s.request.mockRejectedValueOnce(new EngineRequestError({ code, message: "failed" }));
    await s.attach();
    endSession(params.sessionId);
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledOnce());
    s.connection("reconnecting");
    s.connection("open");
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(code === "forbidden" ? 1 : 2));
    s.connection("open");
    expect(s.request).toHaveBeenCalledTimes(code === "forbidden" ? 1 : 2);
  }
});

it("does not end waiting starts, gone, failed, ended, or elsewhere sessions", async () => {
  const s = setup();
  for (const phase of ["waiting", "gone", "failed", "ended", "elsewhere"] as const) {
    await s.attach();
    useExecSessions.setState((store) => ({
      entries: new Map(store.entries).set(params.sessionId, {
        ...store.entries.get(params.sessionId)!,
        state: phase === "failed" || phase === "ended" ? { phase, reason: "complete" } : { phase },
      }),
    }));
    endSession(params.sessionId);
  }
  expect(s.request).not.toHaveBeenCalled();
});

it("disposes a terminal loaded after its Tab closes without opening a stream", async () => {
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
  endSession(params.sessionId);
  loaded(s.terminal);
  await start;
  expect(s.terminal.dispose).toHaveBeenCalledOnce();
  expect(s.openStream).not.toHaveBeenCalled();
});

it.each([
  [
    "first attachment",
    "2.0 KiB of earlier output is not shown. The Engine keeps only a session's most recent output.",
  ],
  ["disconnected", "2.0 KiB of output was skipped while this window was disconnected"],
  ["slow window", "2.0 KiB of output was skipped because this window was not keeping up"],
])(
  "keeps a visible skipped notice for %s, dismisses it on typing, and shows later skips",
  async (kind, message) => {
    const s = setup();
    await s.attach();
    if (kind !== "first attachment") {
      await s.listener().event(sync);
      await s.output("prompt");
    }
    if (kind === "disconnected") await s.listener().state("reconnecting");
    await s.listener().event({ ...sync, offset: 4096, reset: true, skipped: 2048 });
    const notice = () => useExecSessions.getState().entries.get(params.sessionId)?.skippedNotice;
    expect(notice()).toBe(message);
    dismissSkippedNotice(params.sessionId);
    await s.output("more");
    expect(notice()).toBeUndefined();
    await s.listener().event({ ...sync, offset: 8192, reset: true, skipped: 4096 });
    expect(notice()).toBe("4.0 KiB of output was skipped because this window was not keeping up");
    s.type();
    expect(notice()).toBeUndefined();
    await s.listener().event({ ...sync, offset: 16384, reset: true, skipped: 8192 });
    expect(notice()).toContain("8.0 KiB");
    await s.listener().state("reconnecting");
    expect(notice()).toBeUndefined();
  },
);

it("splits the kept command line at each start and sends argv to pod.exec", async () => {
  const s = setup();
  const chosen = { ...params, commandLine: "sh -c 'echo $((6*7))'" };
  await startSession(s.engine, "c", chosen, async () => s.terminal);
  expect(s.openStream.mock.calls[0]?.[1]).toMatchObject({ command: ["sh", "-c", "echo $((6*7))"] });
  expect(useExecSessions.getState().entries.get(params.sessionId)?.params).toEqual(chosen);
  s.streams[0]!.listener.end({ reason: "complete", exitCode: 0 });
  // The store handles an end in order with the output before it.
  await vi.waitFor(() =>
    expect(useExecSessions.getState().entries.get(params.sessionId)?.state.phase).toBe("ended"),
  );
  await startSession(s.engine, "c", chosen, async () => s.terminal);
  expect(s.openStream.mock.calls[1]?.[1]).toMatchObject({ command: ["sh", "-c", "echo $((6*7))"] });
});
it("never sends or re-parses the command line when attaching or taking over", async () => {
  const s = setup();
  const chosen = { ...params, commandLine: "a | b" };
  await attachSession(s.engine, "c", chosen, async () => s.terminal);
  expect(s.openStream).toHaveBeenCalledOnce();
  expect(s.openStream.mock.calls[0]?.[1]).not.toHaveProperty("command");
  expect(s.openStream.mock.calls[0]?.[1]).not.toHaveProperty("start");
  expect(useExecSessions.getState().entries.get(params.sessionId)?.params).toEqual(chosen);
  await s.listener().event({ ...sync, offset: 10 });
  await s.listener().end({ reason: "detached" });
  expect(s.state()?.phase).toBe("elsewhere");
  await takeSession(s.engine, "c", chosen);
  expect(s.openStream).toHaveBeenCalledTimes(2);
  for (const key of ["command", "start", "run"])
    expect(s.openStream.mock.calls[1]?.[1]).not.toHaveProperty(key);
  expect(s.state()?.phase).toBe("attaching");
});
it("gives each start its own run, which a retried socket repeats", async () => {
  const s = setup();
  const chosen = { ...params, commandLine: "touch /marker" };
  await startSession(s.engine, "c", chosen, async () => s.terminal);
  const first = (s.openStream.mock.calls[0]![1] as { run?: string }).run;
  expect(first).toMatch(/^[0-9a-f]{32}$/);
  s.streams[0]!.listener.end({ reason: "complete", exitCode: 0 });
  await vi.waitFor(() => expect(s.state()?.phase).toBe("ended"));
  await startSession(s.engine, "c", chosen, async () => s.terminal);
  const second = (s.openStream.mock.calls[1]![1] as { run?: string }).run;
  expect(second).toMatch(/^[0-9a-f]{32}$/);
  expect(second).not.toBe(first);
});
it("fails an invalid stored line before creating a terminal or stream", async () => {
  const s = setup();
  const make = vi.fn<() => Promise<typeof s.terminal>>(async () => s.terminal);
  await startSession(s.engine, "c", { ...params, commandLine: "a | b" }, make);
  expect(s.state()).toEqual({
    phase: "failed",
    reason: "error",
    error: {
      code: "bad_request",
      message: "The | operator needs a shell. To use one, write sh -c '…'.",
    },
  });
  expect(make).not.toHaveBeenCalled();
  expect(s.openStream).not.toHaveBeenCalled();
});

it("removes CommandNotFound from recents even without a mounted panel", async () => {
  const s = setup();
  const writes: unknown[] = [];
  const engine = Object.assign(s.engine, {
    subscribe: (
      _method: string,
      _params: unknown,
      listener: { data: (setting: unknown) => void },
    ) => {
      queueMicrotask(() => listener.data({ value: { images: [], recent: ["bash -l", "ash"] } }));
      return { close: () => {} };
    },
    request: (_method: string, setting: unknown) => {
      writes.push(setting);
      return Promise.resolve();
    },
  });
  await startSession(engine, "c", { ...params, commandLine: "bash -l" }, async () => s.terminal);
  s.streams[0]!.listener.end({
    reason: "error",
    error: { code: "not_found", reason: "CommandNotFound", message: "no bash" },
  });
  await vi.waitFor(() =>
    expect(writes).toContainEqual({ key: "exec/commands", value: { images: [], recent: ["ash"] } }),
  );
});
