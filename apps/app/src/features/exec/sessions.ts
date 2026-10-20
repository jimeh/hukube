import {
  ExecReasonCommandNotFound,
  type EngineClient,
  type EngineStream,
  type ExecParams,
  type StreamEnd,
} from "@hukube/engine-client";
import { getCommandsStore } from "./commands-store.ts";
import { create } from "zustand";
import { commandRefusalText, parseCommand } from "./command.ts";

export type ExecSessionParams = Omit<ExecParams, "cluster" | "cols" | "rows" | "command"> & {
  /** The line as typed, split only when a session starts. */
  commandLine?: string;
  sessionId: string;
  preview?: boolean;
};
export type ExecState =
  | { phase: "waiting" | "starting" | "live" }
  | {
      phase: "ended";
      reason: StreamEnd["reason"] | "lost";
      exitCode?: number;
      error?: StreamEnd["error"];
    }
  | { phase: "failed"; reason: StreamEnd["reason"]; error?: StreamEnd["error"] };

export interface ExecTerminal {
  element: HTMLElement;
  /** Resolves when the terminal has been sized to its panel for the first time. */
  ready: Promise<void>;
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
}
interface Sessions {
  entries: ReadonlyMap<string, ExecSession>;
}
export const useExecSessions = create<Sessions>(() => ({ entries: new Map() }));
const cleanups = new Map<string, () => void>();
const runs = new Map<string, object>();
const terminalFactory = async () => (await import("@/lib/xterm.ts")).createExecTerminal();
// A session whose panel is not showing cannot size its terminal. It starts at
// the terminal's default size after this long.
const readyTimeoutMs = 1000;

export function sessionId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function isRunning(session: ExecSession | undefined): boolean {
  return session?.state.phase === "starting" || session?.state.phase === "live";
}
function mebibytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function put(id: string, session: ExecSession) {
  useExecSessions.setState((store) => ({ entries: new Map(store.entries).set(id, session) }));
}

/** Only opening or explicitly starting again creates a stream. Attaching a view does not. */
export async function startSession(
  engine: EngineClient,
  cluster: string,
  params: ExecSessionParams,
  makeTerminal: () => Promise<ExecTerminal> = terminalFactory,
): Promise<void> {
  const id = params.sessionId;
  const previous = useExecSessions.getState().entries.get(id);
  if (isRunning(previous) || previous?.state.phase === "waiting") return;
  previous?.stream?.close();
  cleanups.get(id)?.();
  cleanups.delete(id);
  const session: ExecSession = {
    cluster,
    params,
    state: { phase: "starting" },
    terminal: previous?.terminal,
  };
  put(id, session);
  const run = {};
  runs.set(id, run);
  const current = () => runs.get(id) === run;
  const publish = (state: ExecState) => {
    if (!current()) return;
    session.state = state;
    session.terminal?.setEnded(state.phase === "ended" || state.phase === "failed");
    put(id, { ...session });
  };
  const parsed = parseCommand(params.commandLine ?? "");
  if (parsed.error !== undefined) {
    publish({
      phase: "failed",
      reason: "error",
      error: { code: "bad_request", message: commandRefusalText(parsed.error) },
    });
    return;
  }
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
  await terminal.reset();
  if (!current()) return;
  terminal.setEnded(false);
  put(id, { ...session });
  // The session starts at the terminal's real size, because a resize just
  // after the start makes a shell print its prompt again.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    terminal.ready,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, readyTimeoutMs);
    }),
  ]);
  clearTimeout(timer);
  // Starting again changes the panel's layout, and with it the terminal's size.
  if (previous?.terminal) await terminal.refit();
  if (!current()) return;
  let output = false;
  const stream = engine.openStream(
    "pod.exec",
    {
      cluster,
      namespace: params.namespace,
      pod: params.pod,
      uid: params.uid,
      container: params.container,
      ...(parsed.command.length ? { command: parsed.command } : {}),
      cols: terminal.cols,
      rows: terminal.rows,
    },
    {
      event: () => {},
      state: (state) => {
        if (state === "lost") publish({ phase: "ended", reason: "lost" });
        else if (state === "waiting") publish({ phase: "waiting" });
        else if (["connecting", "reconnecting", "open"].includes(state) && !output) {
          publish({ phase: "starting" });
        }
      },
      data: (bytes) => {
        if (!current()) return;
        if (!output) {
          output = true;
          publish({ phase: "live" });
        }
        return new Promise<void>((done) => terminal.write(bytes, done));
      },
      gap: ({ bytes }) => {
        // The reset first ends an escape sequence the gap may have cut short,
        // so the notice is not read as part of it.
        if (current())
          terminal.write(
            `\x1b[0m\r\n\x1b[2m[hukube: ${mebibytes(bytes)} of output was dropped because this window was not keeping up]\x1b[0m\r\n`,
          );
      },
      inputDropped: (bytes) => {
        if (current())
          terminal.write(
            `\r\n\x1b[2m[hukube: ${mebibytes(bytes)} of input was not sent, because the process is not reading and too much is already waiting]\x1b[0m\r\n`,
          );
      },
      end: (end) => {
        if (!current()) return;
        if (end.error?.reason === ExecReasonCommandNotFound && params.commandLine) {
          const commands = getCommandsStore(engine);
          // The stream outlives its panel. Keep a watch until this correction is saved.
          const stop = commands.subscribe(() => {});
          void commands.removeRecent(params.commandLine).finally(stop);
        }
        publish(
          (end.reason === "error" || end.reason === "deleted") && !output
            ? { phase: "failed", ...end }
            : { phase: "ended", ...end },
        );
      },
    },
  );
  session.stream = stream;
  const input = (bytes: Uint8Array) => {
    if (current() && isRunning(useExecSessions.getState().entries.get(id))) stream.write(bytes);
  };
  const offs = [
    terminal.onData((text) => input(new TextEncoder().encode(text))),
    terminal.onBinary((text) => input(Uint8Array.from(text, (char) => char.charCodeAt(0)))),
    terminal.onResize(({ cols, rows }) => {
      if (current() && isRunning(useExecSessions.getState().entries.get(id)))
        stream.resize(cols, rows);
    }),
  ];
  cleanups.set(id, () => offs.forEach((off) => off()));
  put(id, { ...session });
  terminal.focus();
}

export function disposeSession(id: string): void {
  const session = useExecSessions.getState().entries.get(id);
  runs.delete(id);
  cleanups.get(id)?.();
  cleanups.delete(id);
  useExecSessions.setState((store) => {
    const entries = new Map(store.entries);
    entries.delete(id);
    return { entries };
  });
  session?.stream?.close();
  session?.terminal?.dispose();
}
export function disposeClusterSessions(cluster: string): void {
  for (const [id, session] of useExecSessions.getState().entries)
    if (session.cluster === cluster) disposeSession(id);
}
