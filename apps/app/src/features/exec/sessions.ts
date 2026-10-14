import {
  EngineRequestError,
  ExecReasonSessionGone,
  ExecReasonTooManySessions,
  type EngineClient,
  type EngineStream,
  type ExecParams,
  type StreamEnd,
} from "@hukube/engine-client";
import { create } from "zustand";
import type * as TerminalModule from "@/lib/xterm.ts";

export type ExecSessionParams = Omit<
  ExecParams,
  "cluster" | "cols" | "rows" | "command" | "session" | "window" | "start" | "takeover" | "resume"
> & {
  sessionId: string;
  preview?: boolean;
};
export type ExecState =
  | { phase: "waiting"; attaching?: boolean }
  | { phase: "starting" | "attaching" | "live" | "reconnecting" | "elsewhere" | "gone" }
  | {
      phase: "ended";
      reason: StreamEnd["reason"];
      exitCode?: number;
      error?: StreamEnd["error"];
    }
  | { phase: "failed"; reason: StreamEnd["reason"]; error?: StreamEnd["error"] };

export interface ExecTerminal {
  element: HTMLElement;
  /** Resolves when the terminal has been sized to its panel for the first time. */
  ready: Promise<void>;
  sized: boolean;
  readonly inputHeld: boolean;
  size(cols: number, rows: number): void;
  holdInput(held: boolean): void;
  setAttached(attached: boolean): void;
  restoreOptions(): void;
  cols: number;
  rows: number;
  write(data: Uint8Array | string, done?: () => void): void;
  reset(): void | Promise<void>;
  dispose(): void;
  setEnded(ended: boolean): void;
  focus(): void;
  attach(body: HTMLElement, visible: boolean): () => void;
  /** Sizes the terminal to its panel as it is now laid out. */
  refit(): Promise<void>;
  theme(): void;
  onData(fn: (data: string) => void): () => void;
  onUserInput(fn: () => void): () => void;
  onBinary(fn: (data: string) => void): () => void;
  onResize(fn: (size: { cols: number; rows: number }) => void): () => void;
  hasSelection(): boolean;
  copy(): void;
  paste(text: string): void;
  selectAll(): void;
  clear(): void;
  onFind(fn: () => void): () => void;
  /** Finds from the current match towards older or newer output. */
  find(text: string, direction: "older" | "newer", incremental?: boolean): void;
  clearSearch(): void;
  onSearchResults(fn: (result: { resultIndex: number; resultCount: number }) => void): () => void;
}

export interface ExecSession {
  cluster: string;
  params: ExecSessionParams;
  state: ExecState;
  terminal?: ExecTerminal;
  stream?: EngineStream;
  engine?: EngineClient;
  hasOutput?: boolean;
  skippedNotice?: string;
  synced?: boolean;
  offset?: number;
}
interface Sessions {
  entries: ReadonlyMap<string, ExecSession>;
}
export const useExecSessions = create<Sessions>(() => ({ entries: new Map() }));
const cleanups = new Map<string, () => void>();
const dismissals = new Map<string, () => void>();
const runs = new Map<string, object>();
let terminalModule: Promise<typeof TerminalModule> | undefined;
const terminalFactory = async () => {
  terminalModule ??= import("@/lib/xterm.ts").catch((error: unknown) => {
    terminalModule = undefined;
    throw error;
  });
  return (await terminalModule).createExecTerminal();
};
// A session whose panel is not showing cannot size its terminal. It starts at
// the terminal's default size after this long.
const readyTimeoutMs = 1000;
let windowId: string | undefined;
function execWindowId(): string {
  if (!windowId) {
    windowId = sessionStorage.getItem("hukube.exec.window") ?? sessionId();
    sessionStorage.setItem("hukube.exec.window", windowId);
  }
  return windowId;
}

export function sessionId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** Whether closing this Tab must end the session the window holds. */
export function holdsSession(session: ExecSession | undefined): boolean {
  const state = session?.state;
  return (
    !!state &&
    (["starting", "attaching", "live", "reconnecting"].includes(state.phase) ||
      (state.phase === "waiting" && !!state.attaching))
  );
}
function amount(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function put(id: string, session: ExecSession) {
  useExecSessions.setState((store) => ({ entries: new Map(store.entries).set(id, session) }));
}
const chains = new Map<string, Promise<void>>();

export function startSession(
  engine: EngineClient,
  cluster: string,
  params: ExecSessionParams,
  makeTerminal: () => Promise<ExecTerminal> = terminalFactory,
): Promise<void> {
  const previous = useExecSessions.getState().entries.get(params.sessionId);
  if (holdsSession(previous) || previous?.state.phase === "waiting") return Promise.resolve();
  return openSession(engine, cluster, params, "start", makeTerminal);
}

export function attachSession(
  engine: EngineClient,
  cluster: string,
  params: ExecSessionParams,
  makeTerminal: () => Promise<ExecTerminal> = terminalFactory,
): Promise<void> {
  if (useExecSessions.getState().entries.has(params.sessionId)) return Promise.resolve();
  return openSession(engine, cluster, params, "attach", makeTerminal);
}

export function takeSession(
  engine: EngineClient,
  cluster: string,
  params: ExecSessionParams,
): Promise<void> {
  if (useExecSessions.getState().entries.get(params.sessionId)?.state.phase !== "elsewhere")
    return Promise.resolve();
  return openSession(engine, cluster, params, "take", terminalFactory);
}

async function openSession(
  engine: EngineClient,
  cluster: string,
  params: ExecSessionParams,
  intent: "start" | "attach" | "take",
  makeTerminal: () => Promise<ExecTerminal>,
): Promise<void> {
  const id = params.sessionId;
  const previous = useExecSessions.getState().entries.get(id);
  previous?.stream?.close();
  cleanups.get(id)?.();
  cleanups.delete(id);
  const session: ExecSession = {
    cluster,
    params,
    engine,
    state: { phase: intent === "start" ? "starting" : "attaching" },
    terminal: previous?.terminal,
    hasOutput: intent === "take" && !!previous?.hasOutput,
    synced: intent === "take" && !!previous?.synced,
    offset: intent === "take" ? previous?.offset : undefined,
  };
  put(id, session);
  dismissals.set(id, () => {
    if (!session.skippedNotice) return;
    session.skippedNotice = undefined;
    put(id, { ...session });
  });
  const run = {};
  runs.set(id, run);
  const current = () => runs.get(id) === run;
  let replaying = false;
  let pendingControls = 0;
  let attached = false;
  const publish = (state: ExecState) => {
    if (!current()) return;
    session.state = state;
    if (state.phase !== "live") session.skippedNotice = undefined;
    const over = ["ended", "failed", "gone"].includes(state.phase);
    session.terminal?.setEnded(over);
    session.terminal?.setAttached(attached && !over && state.phase !== "elsewhere");
    session.terminal?.holdInput(
      pendingControls > 0 || replaying || !attached || state.phase !== "live",
    );
    put(id, { ...session });
    if (intent === "take" && state.phase === "live" && !replaying && pendingControls === 0)
      focusTakenSession();
  };
  let focusPending = intent === "take";
  const focusTakenSession = () => {
    if (!focusPending) return;
    focusPending = false;
    session.terminal?.focus();
  };
  let terminal: ExecTerminal;
  try {
    terminal = session.terminal ?? (await makeTerminal());
  } catch (error) {
    publish({
      phase: "failed",
      reason: "error",
      error: { code: "internal", message: String(error) },
    });
    return;
  }
  if (!current()) {
    if (!session.terminal) terminal.dispose();
    return;
  }
  session.terminal = terminal;
  terminal.element.dataset["execSession"] = id;
  terminal.element.setAttribute(
    "aria-label",
    `Exec Session in ${params.container} of ${params.pod}`,
  );
  terminal.holdInput(true);
  terminal.setAttached(false);
  await chains.get(id);
  if (!current()) return;
  if (intent === "start") await terminal.reset();
  if (!current()) return;
  terminal.setEnded(false);
  put(id, { ...session });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    terminal.ready,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, readyTimeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (intent === "start" && previous?.terminal) await terminal.refit();
  if (!current()) return;
  let position = 0;
  let replayUntil = 0;
  let firstOnSocket = true;
  let chain = Promise.resolve();
  const enqueue = (work: () => void | Promise<void>) => {
    chain = chain.then(() => {
      if (current()) return work();
    });
    chains.set(id, chain);
    return chain;
  };
  const write = (bytes: Uint8Array | string) =>
    new Promise<void>((done) => terminal.write(bytes, done));
  const releaseInput = () => {
    replaying = position < replayUntil;
    terminal.holdInput(
      pendingControls > 0 || replaying || !attached || session.state.phase !== "live",
    );
    if (session.state.phase === "live" && !replaying && pendingControls === 0 && attached)
      focusTakenSession();
  };
  const stream = engine.openStream(
    "pod.exec",
    {
      cluster,
      session: id,
      window: execWindowId(),
      ...(intent === "start" ? { start: true } : {}),
      ...(intent === "take"
        ? { takeover: true, ...(session.offset !== undefined ? { resume: session.offset } : {}) }
        : {}),
      namespace: params.namespace,
      pod: params.pod,
      uid: params.uid,
      container: params.container,
      ...(intent === "start" || terminal.sized ? { cols: terminal.cols, rows: terminal.rows } : {}),
    },
    {
      event: (sync) => {
        if (!current()) return;
        pendingControls++;
        // Stop queries and typed input even while an earlier write is still parsing.
        replaying = true;
        terminal.holdInput(true);
        void enqueue(async () => {
          if (!terminal.sized) terminal.size(sync.cols, sync.rows);
          const skipped = !session.synced
            ? `${amount(sync.skipped ?? 0)} of earlier output is not shown. The Engine keeps only a session's most recent output.`
            : firstOnSocket
              ? `${amount(sync.skipped ?? 0)} of output was skipped while this window was disconnected`
              : `${amount(sync.skipped ?? 0)} of output was skipped because this window was not keeping up`;
          if (sync.reset) {
            await write("\x18\x1bc");
            terminal.restoreOptions();
            if (sync.skipped) {
              await write(`\x1b[2m[hukube: ${skipped}]\x1b[0m\r\n`);
              session.skippedNotice = skipped;
            }
            if (sync.restore) await write(sync.restore);
          }
          position = sync.offset;
          session.offset = position;
          replayUntil = sync.offset + (sync.replay ?? 0);
          session.synced = true;
          firstOnSocket = false;
          attached = true;
          session.hasOutput ||= sync.offset > 0 || (sync.replay ?? 0) > 0;
          publish({
            phase: session.hasOutput ? "live" : intent === "start" ? "starting" : "attaching",
          });
          pendingControls--;
          releaseInput();
        });
      },
      state: (state) => {
        if (!current()) return;
        const detached = ["waiting", "connecting", "reconnecting"].includes(state);
        if (detached) pendingControls++;
        if (["waiting", "connecting", "reconnecting"].includes(state)) {
          attached = false;
          terminal.holdInput(true);
          terminal.setAttached(false);
        }
        void enqueue(() => {
          if (detached) {
            pendingControls--;
            attached = false;
          }
          if (state === "waiting")
            publish({ phase: "waiting", attaching: intent !== "start" || !!session.synced });
          else if (state === "connecting" || state === "reconnecting") {
            firstOnSocket = true;
            publish({
              phase: session.synced
                ? "reconnecting"
                : intent === "start"
                  ? "starting"
                  : "attaching",
            });
          }
        });
      },
      data: (bytes) =>
        enqueue(async () => {
          session.hasOutput = true;
          publish({ phase: "live" });
          await write(bytes);
          position += bytes.byteLength;
          session.offset = position;
          releaseInput();
        }),
      gap: () => {},
      inputDropped: (bytes) => {
        void enqueue(() =>
          write(`\r\n\x1b[2m[hukube: ${amount(bytes)} of input was not sent]\x1b[0m\r\n`),
        );
      },
      end: (end) => {
        if (!current()) return;
        pendingControls++;
        terminal.holdInput(true);
        void enqueue(() => {
          pendingControls--;
          attached = false;
          publish(
            end.reason === "detached"
              ? { phase: "elsewhere" }
              : end.error?.reason === ExecReasonSessionGone
                ? { phase: "gone" }
                : end.error?.reason === ExecReasonTooManySessions ||
                    ((end.reason === "error" || end.reason === "deleted") && !session.hasOutput)
                  ? { phase: "failed", ...end }
                  : { phase: "ended", ...end },
          );
        });
      },
    },
  );
  session.stream = stream;
  const input = (bytes: Uint8Array) => {
    if (
      current() &&
      pendingControls === 0 &&
      attached &&
      !replaying &&
      session.state.phase === "live"
    )
      stream.write(bytes);
  };
  cleanups.set(id, () => offs.forEach((off) => off()));
  const offs = [
    terminal.onUserInput(() => {
      if (!current() || !session.skippedNotice) return;
      session.skippedNotice = undefined;
      put(id, { ...session });
    }),
    terminal.onData((text) => input(new TextEncoder().encode(text))),
    terminal.onBinary((text) => input(Uint8Array.from(text, (char) => char.charCodeAt(0)))),
    terminal.onResize(({ cols, rows }) => {
      if (current() && holdsSession(session)) stream.resize(cols, rows);
    }),
  ];
  put(id, { ...session });
  if (intent === "start") terminal.focus();
}

function removeSession(id: string): ExecSession | undefined {
  const session = useExecSessions.getState().entries.get(id);
  runs.delete(id);
  dismissals.delete(id);
  chains.delete(id);
  cleanups.get(id)?.();
  cleanups.delete(id);
  useExecSessions.setState((store) => {
    const entries = new Map(store.entries);
    entries.delete(id);
    return { entries };
  });
  session?.stream?.close();
  session?.terminal?.dispose();
  return session;
}

function sendEnd(engine: EngineClient, cluster: string, session: string): void {
  let sending = false;
  let finished = false;
  let opens = 0;
  const off = engine.onStateChange(() => {
    if (engine.getState() === "open") {
      opens++;
      void send();
    }
  });
  const send = async () => {
    if (sending || finished) return;
    sending = true;
    const before = opens;
    try {
      await engine.request("exec.end", { cluster, session });
      finished = true;
    } catch (error) {
      finished = !(
        error instanceof EngineRequestError &&
        ["not_connected", "disconnected"].includes(error.code)
      );
    } finally {
      sending = false;
      if (finished) off();
      else if (opens !== before && engine.getState() === "open") void send();
    }
  };
  void send();
}

export function endSession(id: string): void {
  const session = useExecSessions.getState().entries.get(id);
  const held = holdsSession(session);
  removeSession(id);
  if (held && session?.engine) sendEnd(session.engine, session.cluster, id);
}

/** Removing a panel without a user close detaches its session. */
export function detachSession(id: string): void {
  removeSession(id);
}

/** Closing a Workspace detaches before dockview removes its session panels. */
export function detachClusterSessions(cluster: string): void {
  for (const [id, session] of useExecSessions.getState().entries)
    if (session.cluster === cluster) detachSession(id);
}

export function dismissSkippedNotice(id: string): void {
  dismissals.get(id)?.();
}
