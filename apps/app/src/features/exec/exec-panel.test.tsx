// @vitest-environment jsdom
import type { Setting, StreamListener } from "@hukube/engine-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExecPanel } from "./exec-panel.tsx";
import { endSession, useExecSessions, type ExecState, type ExecSessionParams } from "./sessions.ts";
import { readSessionTabs, rememberSessionTab } from "./window-tabs.ts";
import { fakeTerminal } from "./test-terminal.ts";
import { WorkspaceContext, type WorkspaceValue } from "../workspace/workspace-context.tsx";

const mocked = vi.hoisted(() => ({
  object: {
    metadata: { uid: "uid" },
    spec: { containers: [{ name: "app", image: "busybox:1.36" }] },
    status: { containerStatuses: [{ name: "app", state: { running: {} } }] },
  } as Record<string, unknown>,
  deleted: false,
  connection: "open",
  exec: { allowed: true } as { allowed: boolean; reason?: string },
  setting: null as unknown,
  saved: [] as unknown[],
  streamParams: [] as unknown[],
  streams: [] as StreamListener<"pod.exec">[],
  terminal: undefined as ReturnType<typeof fakeTerminal> | undefined,
}));
vi.mock("@hukube/engine-client/react", () => {
  const engine = {
    onStateChange: () => () => {},
    getState: () => "open",
    request: (method: string, params: unknown) => {
      if (method === "settings.put") {
        mocked.saved.push(params);
        mocked.setting = (params as Setting).value;
        return Promise.resolve();
      }
      return Promise.resolve({ exec: mocked.exec });
    },
    subscribe: (
      _method: string,
      _params: unknown,
      listener: { data: (setting: Setting) => void },
    ) => {
      let closed = false;
      const value = mocked.setting;
      queueMicrotask(() => {
        if (!closed) listener.data({ revision: "", key: "exec/commands", value });
      });
      return {
        close: () => {
          closed = true;
        },
        update: () => {},
      };
    },
    openStream: (_method: string, _params: unknown, listener: StreamListener<"pod.exec">) => {
      mocked.streamParams.push(_params);
      mocked.streams.push(listener);
      listener.state?.("connecting");
      return { close: () => {}, write: () => {}, resize: () => {} };
    },
  };
  return {
    useSubscription: () => ({
      stale: false,
      data: { object: mocked.object, deleted: mocked.deleted },
    }),
    useConnectionState: () => mocked.connection,
    useEngine: () => engine,
  };
});
vi.mock("@/lib/xterm.ts", () => ({ createExecTerminal: () => mocked.terminal!.terminal }));
const params = { sessionId: "id", namespace: "ns", pod: "web", uid: "uid", container: "app" };
const close = vi.fn<() => void>();
const openResource = vi.fn<WorkspaceValue["openResource"]>();
const updateParameters = vi.fn<(params: ExecSessionParams) => void>();
const setTitle = vi.fn<(title: string) => void>();
const api = {
  updateParameters,
  setTitle,
  id: "exec:id",
  isVisible: true,
  isActive: true,
  close,
} as unknown as Parameters<typeof ExecPanel>[0]["api"];
const workspace: WorkspaceValue = {
  cluster: "c",
  active: true,
  types: new Map(),
  openList: () => {},
  openResource,
  openExecSession: () => {},
};
const renderPanel = (current: ExecSessionParams) => (
  <WorkspaceContext value={workspace}>
    <ExecPanel api={api} params={current} />
  </WorkspaceContext>
);
function view(state?: ExecState, initialParams: ExecSessionParams = params) {
  mocked.terminal = fakeTerminal();
  if (state)
    useExecSessions.setState({
      entries: new Map([
        [
          params.sessionId,
          { cluster: "c", params: initialParams, state, terminal: mocked.terminal.terminal },
        ],
      ]),
    });
  const rendered = render(renderPanel(initialParams));
  updateParameters.mockImplementation((next) => rendered.rerender(renderPanel(next)));
  return rendered;
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  Object.assign(api, { isVisible: true, isActive: true });
  endSession("id");
  close.mockClear();
  openResource.mockClear();
  mocked.deleted = false;
  mocked.connection = "open";
  mocked.streams = [];
  mocked.saved = [];
  mocked.setting = null;
  mocked.streamParams = [];
  updateParameters.mockReset();
  setTitle.mockClear();
  mocked.exec = { allowed: true };
  delete mocked.object["metadata"];
  mocked.object["metadata"] = { uid: "uid" };
});

it("shows gone with no stream until Start a new session is pressed", async () => {
  view({ phase: "gone" });
  expect(screen.getByText("This session is gone")).toBeDefined();
  expect(
    screen.getByText(
      "The Engine no longer has it. It ended, the Engine restarted, or it was told to exit after 10 minutes with no window attached.",
    ),
  ).toBeDefined();
  expect(screen.getByText("Gone")).toBeDefined();
  expect(mocked.streams).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
  expect(await screen.findByText("Starting…")).toBeDefined();
  await vi.waitFor(() => expect(mocked.streams).toHaveLength(1));
});
it("shows the waiting notice and cancels by closing the Tab", () => {
  view({ phase: "waiting" });
  expect(screen.getByText("Waiting")).toBeDefined();
  expect(screen.getByText("Waiting for a free stream")).toBeDefined();
  expect(
    screen.getByText(
      "hukube runs 8 Log Streams and Exec Sessions at a time in a window. This session starts when one of them closes.",
    ),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
});
it.each<[ExecState, string]>([
  [{ phase: "ended", reason: "complete", exitCode: 3 }, "The process exited with code 3."],
  [{ phase: "ended", reason: "stopped" }, "The container stopped, which ended the session."],
  [{ phase: "ended", reason: "deleted" }, "The Pod was deleted, which ended the session."],
  [
    {
      phase: "ended",
      reason: "error",
      error: { code: "unavailable", reason: "ConnectionLost", message: "timeout" },
    },
    "The session lost its connection to the Cluster: timeout",
  ],
  [
    {
      phase: "ended",
      reason: "error",
      error: { code: "unavailable", reason: "EngineStopped", message: "The Engine shut down." },
    },
    "The Engine shut down, which ended the session. Its shell was told to exit.",
  ],
])("shows the end state %j", (state, copy) => {
  view(state);
  expect(screen.getByText("Ended")).toBeDefined();
  expect(screen.getByText(copy)).toBeDefined();
  expect(!!screen.queryByRole("button", { name: "Start again" })).toBe(
    state.phase === "ended" && state.reason !== "deleted",
  );
  expect(mocked.terminal!.terminal.attach).toHaveBeenCalledOnce();
});
it.each<[ExecState, string, string]>([
  [
    {
      phase: "failed",
      reason: "error",
      error: { code: "forbidden", message: "Role read-only cannot use pods/exec" },
    },
    "Not permitted",
    "Role read-only cannot use pods/exec",
  ],
  [
    {
      phase: "failed",
      reason: "error",
      error: {
        code: "forbidden",
        message: "The Engine is running read-only. Exec Sessions are disabled.",
      },
    },
    "The Engine is read-only",
    "The Engine is running read-only. Exec Sessions are disabled.",
  ],
  [
    {
      phase: "failed",
      reason: "error",
      error: {
        code: "not_found",
        reason: "NoShell",
        message: "exec: sh: executable file not found",
      },
    },
    "No shell in this container",
    "exec: sh: executable file not found",
  ],
  [
    { phase: "failed", reason: "deleted" },
    "The Pod is gone",
    "It was deleted or replaced before the session could start.",
  ],
  [
    {
      phase: "failed",
      reason: "error",
      error: { code: "not_found", message: "container nope is not valid for pod web" },
    },
    "The session could not start",
    "container nope is not valid for pod web",
  ],
  [
    { phase: "failed", reason: "error", error: { code: "unavailable", message: "Cannot start" } },
    "The session could not start",
    "Cannot start",
  ],
])("shows the failure state %j", (state, title, copy) => {
  view(state);
  expect(screen.getByText(title)).toBeDefined();
  expect(screen.queryAllByText(copy || "No description").length > 0).toBe(!!copy);
  expect(
    !!screen.queryByText(
      (_text, element) =>
        element?.textContent ===
        "hukube's default shell needs sh, and this container has none. You can run a program the image contains instead, below, or use a debug container, for example with kubectl debug.",
    ),
  ).toBe(title === "No shell in this container");
  expect(!!screen.queryByRole("button", { name: "Try again" })).toBe(
    title === "The session could not start" || title === "The Pod is gone",
  );
});
it("shows starting, live, and terminating, opens the Pod in its Pane, and keeps the run on remount", () => {
  const rendered = view({ phase: "starting" });
  expect(screen.getByText("Starting…")).toBeDefined();
  act(() =>
    useExecSessions.setState((store) => ({
      entries: new Map(store.entries).set("id", {
        ...store.entries.get("id")!,
        state: { phase: "live" },
      }),
    })),
  );
  expect(screen.queryByText("Starting…")).toBeNull();
  mocked.object["metadata"] = { uid: "uid", deletionTimestamp: "now" };
  rendered.rerender(
    <WorkspaceContext value={workspace}>
      <ExecPanel api={api} params={params} />
    </WorkspaceContext>,
  );
  expect(screen.getByText("Terminating")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "web" }));
  expect(openResource).toHaveBeenCalledWith(
    { type: "pods", namespace: "ns", name: "web" },
    { pane: "exec:id" },
  );
  const terminal = mocked.terminal!.terminal;
  rendered.unmount();
  render(
    <WorkspaceContext value={workspace}>
      <ExecPanel api={api} params={params} />
    </WorkspaceContext>,
  );
  expect(terminal.attach).toHaveBeenCalledTimes(2);
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(terminal.reset).not.toHaveBeenCalled();
  expect(mocked.streams).toHaveLength(0);
});
it("hides restart for a replacement Pod and disables it while reconnecting", async () => {
  mocked.connection = "reconnecting";
  const rendered = view({ phase: "ended", reason: "complete", exitCode: 0 });
  const button = screen.getByRole("button", { name: "Start again" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.focus(button);
  expect(await screen.findByText("Reconnecting to the Engine")).toBeDefined();
  mocked.object["metadata"] = { uid: "replacement" };
  rendered.rerender(
    <WorkspaceContext value={workspace}>
      <ExecPanel api={api} params={params} />
    </WorkspaceContext>,
  );
  expect(screen.queryByRole("button", { name: "Start again" })).toBeNull();
});
it("finds next and previous matches, reports the count, and restores focus on Escape", async () => {
  view({ phase: "live" });
  const fake = mocked.terminal!;
  fireEvent.click(screen.getByRole("button", { name: "Find in scrollback" }));
  const input = screen.getByRole("textbox", { name: "Find" });
  expect(document.activeElement).toBe(input);
  // Nothing is found, and nothing is reported, until there is something to find.
  expect(screen.queryByText("No results")).toBeNull();
  fireEvent.change(input, { target: { value: "hello" } });
  // Finding starts from the newest output, as in a terminal.
  expect(fake.terminal.find).toHaveBeenCalledWith("hello", "older", true);
  act(() => fake.results(2, 17));
  expect(screen.getByText("3 of 17")).toBeDefined();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(fake.terminal.find).toHaveBeenLastCalledWith("hello", "older");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(fake.terminal.find).toHaveBeenLastCalledWith("hello", "newer");
  fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
  expect(fake.terminal.find).toHaveBeenLastCalledWith("hello", "older");
  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  expect(fake.terminal.find).toHaveBeenLastCalledWith("hello", "newer");
  // Asking to find again, with the bar open, returns to its field.
  screen.getByRole("button", { name: "Next match" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Find in scrollback" }));
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull();
  expect(fake.terminal.clearSearch).toHaveBeenCalled();
  expect(fake.terminal.focus).toHaveBeenCalled();
  // The query is kept, and found again, when the bar opens the next time.
  fireEvent.click(screen.getByRole("button", { name: "Find in scrollback" }));
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Find" }).value).toBe("hello");
  expect(fake.terminal.find).toHaveBeenLastCalledWith("hello", "older", true);
});

it("moves focus to Start again when a focused session ends", () => {
  view({ phase: "live" });
  const fake = mocked.terminal!;
  const field = document.createElement("textarea");
  fake.terminal.element.append(field);
  field.focus();
  expect(document.activeElement).toBe(field);
  act(() =>
    useExecSessions.setState({
      entries: new Map([
        [
          params.sessionId,
          {
            cluster: "c",
            params,
            state: { phase: "ended", reason: "complete", exitCode: 0 },
            terminal: fake.terminal,
          },
        ],
      ]),
    }),
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start again" }));
});

const change = (state: ExecState) =>
  act(() =>
    useExecSessions.setState((store) => ({
      entries: new Map(store.entries).set("id", { ...store.entries.get("id")!, state }),
    })),
  );

it("shows attaching, reconnecting, and elsewhere without replacing the terminal area", () => {
  const rendered = view({ phase: "attaching" });
  expect(screen.getByText("Attaching…")).toBeDefined();
  const area = mocked.terminal!.terminal.element.parentElement!;
  const body = area.parentElement!;
  expect(area.classList.contains("isolate")).toBe(true);
  change({ phase: "live" });
  const badge = screen.getByText("Live");
  const slot = [...badge.classList].find((name) => name.startsWith("w-["));
  change({ phase: "reconnecting" });
  expect(
    [...screen.getByText("Reconnecting…").classList].find((name) => name.startsWith("w-[")),
  ).toBe(slot);
  expect(
    screen
      .getByText(
        "Reconnecting to the Engine. The session keeps running, and the Engine keeps its recent output.",
      )
      .classList.contains("absolute"),
  ).toBe(true);
  const reconnecting = screen.getByText(
    "Reconnecting to the Engine. The session keeps running, and the Engine keeps its recent output.",
  );
  expect(reconnecting.classList.contains("bg-background")).toBe(true);
  expect(reconnecting.classList.contains("border-t")).toBe(true);
  expect(mocked.terminal!.terminal.element.parentElement).toBe(area);
  change({ phase: "elsewhere" });
  expect(screen.getByText("Not attached")).toBeDefined();
  expect(
    screen.getByText(
      "An Exec Session shows in one window at a time. Using it here detaches the other window.",
    ),
  ).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Use it here" }).closest(".absolute")?.parentElement,
  ).toBe(body);
  expect(mocked.terminal!.terminal.element.parentElement).toBe(area);
  const card = screen.getByRole("button", { name: "Use it here" }).closest(".bg-popover")!;
  expect(card).not.toBeNull();
  expect(card.classList.contains("border")).toBe(true);
  expect(card.classList.contains("rounded-md")).toBe(true);
  expect(card.classList.contains("w-full")).toBe(true);
  expect(card.classList.contains("min-w-0")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use it here" }));
  expect(screen.getByText("Attaching…")).toBeDefined();
  rendered.unmount();
});

it("keeps output for gone sessions and offers a new session with its disabled reason", async () => {
  mocked.connection = "reconnecting";
  view({ phase: "live" });
  act(() =>
    useExecSessions.setState((store) => ({
      entries: new Map(store.entries).set("id", {
        ...store.entries.get("id")!,
        hasOutput: true,
        state: { phase: "gone" },
      }),
    })),
  );
  expect(
    screen.getByText(
      "This session is gone. It ended, the Engine restarted, or it was told to exit after 10 minutes with no window attached.",
    ),
  ).toBeDefined();
  expect(mocked.terminal!.terminal.element.isConnected).toBe(true);
  const button = screen.getByRole("button", { name: "Start a new session" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.focus(button);
  expect(await screen.findByText("Reconnecting to the Engine")).toBeDefined();
});

it("shows the too-many-sessions notice and retry button", () => {
  view({
    phase: "failed",
    reason: "error",
    error: { code: "unavailable", reason: "TooManySessions", message: "full" },
  });
  expect(screen.getByText("Not started")).toBeDefined();
  expect(screen.getByText("Too many Exec Sessions")).toBeDefined();
  expect(
    screen.getByText("The Engine runs at most 64 at a time. End one and try again."),
  ).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});

it.each(["gone", "elsewhere"] as const)(
  "moves focus from a focused terminal when it becomes %s",
  (phase) => {
    view({ phase: "live" });
    const field = document.createElement("textarea");
    mocked.terminal!.terminal.element.append(field);
    field.focus();
    act(() =>
      useExecSessions.setState((store) => ({
        entries: new Map(store.entries).set("id", {
          ...store.entries.get("id")!,
          state: { phase },
        }),
      })),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: phase === "gone" ? "Start a new session" : "Use it here",
      }),
    );
  },
);

it("shows skipped output over the terminal and Dismiss hides it through later output", async () => {
  view({ phase: "gone" });
  fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
  await vi.waitFor(() => expect(mocked.streams).toHaveLength(1));
  act(() =>
    mocked.streams[0]!.event({ offset: 4096, cols: 80, rows: 24, reset: true, skipped: 2048 }),
  );
  const message =
    "2.0 KiB of earlier output is not shown. The Engine keeps only a session's most recent output.";
  const notice = await screen.findByText(message);
  const overlay = notice.closest("output")!;
  expect(overlay.classList.contains("absolute")).toBe(true);
  expect(overlay.classList.contains("bg-background")).toBe(true);
  expect(overlay.classList.contains("border-t")).toBe(true);
  const area = mocked.terminal!.terminal.element.parentElement;
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await act(async () => {
    await mocked.streams[0]!.data(new TextEncoder().encode("more"));
  });
  expect(screen.queryByText(message)).toBeNull();
  act(() =>
    mocked.streams[0]!.event({ offset: 8192, cols: 80, rows: 24, reset: true, skipped: 4096 }),
  );
  expect(
    await screen.findByText("4.0 KiB of output was skipped because this window was not keeping up"),
  ).toBeDefined();
  act(() => mocked.terminal!.type());
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  expect(mocked.terminal!.terminal.element.parentElement).toBe(area);
});

it("forgets and disposes a waiting start when Cancel closes its Tab", () => {
  rememberSessionTab("c", { params, title: "waiting" });
  view({ phase: "waiting" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(useExecSessions.getState().entries.has("id")).toBe(false);
  expect(mocked.terminal!.terminal.dispose).toHaveBeenCalledOnce();
  expect(readSessionTabs("c")).toEqual([]);
});

it("runs a command from the no-shell notice in the same Tab after committing its header", async () => {
  view({
    phase: "failed",
    reason: "error",
    error: { code: "not_found", reason: "NoShell", message: "no sh" },
  });
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Command" });
  expect(document.activeElement).toBe(field);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.change(field, { target: { value: "/pause -v" } });
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  // Refit is the ordering boundary: the stream can only open after it returns.
  mocked.terminal!.terminal.refit.mockImplementation(async () => {
    expect(screen.getByText("Command")).toBeDefined();
    expect(screen.getByText("/pause -v")).toBeDefined();
    expect(setTitle).toHaveBeenCalledWith("pause: app in web");
    expect(mocked.streams).toHaveLength(0);
  });
  fireEvent.submit(field.closest("form")!);
  await vi.waitFor(() => expect(mocked.streams).toHaveLength(1));
  expect(updateParameters).toHaveBeenCalledWith({ ...params, commandLine: "/pause -v" });
  expect(useExecSessions.getState().entries.get("id")?.params.sessionId).toBe("id");
  expect(mocked.streamParams[0]).toMatchObject({ command: ["/pause", "-v"] });
  expect(mocked.saved).toContainEqual({
    key: "exec/commands",
    value: { images: [{ image: "busybox", command: "/pause -v" }], recent: ["/pause -v"] },
  });
  // A reload that restores the Tab from this window's record runs the new command's title.
  expect(readSessionTabs("c")).toEqual([
    { params: { ...params, commandLine: "/pause -v", preview: false }, title: "pause: app in web" },
  ]);
});
it("keeps a Tab's command line in the window's record, and drops a Tab whose line cannot be kept", () => {
  rememberSessionTab("c", { params: { ...params, commandLine: "sh -l" }, title: "sh: app in web" });
  expect(readSessionTabs("c")[0]?.params.commandLine).toBe("sh -l");
  // Restored without its line, the Tab would start the default shell instead.
  rememberSessionTab("c", { params: { ...params, commandLine: "x".repeat(4097) }, title: "x" });
  expect(readSessionTabs("c")).toEqual([]);
});
it("prefills a missing chosen command and names its program", () => {
  const commandLine = "/usr/bin/python3 -q";
  view(
    {
      phase: "failed",
      reason: "error",
      error: { code: "not_found", reason: "CommandNotFound", message: "python3 missing" },
    },
    { ...params, commandLine },
  );
  expect(screen.getByText("python3 is not in this container")).toBeDefined();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Command" }).value).toBe(
    commandLine,
  );
  expect(screen.getByText("python3 missing")).toBeDefined();
});

it("records reuse of a command when a gone session's Tab explicitly starts again", async () => {
  // A restored Tab attaches by itself (ADR-0026); one whose session is gone offers to start.
  view({ phase: "gone" }, { ...params, commandLine: "sh -l" });
  fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
  await vi.waitFor(() => expect(mocked.streams).toHaveLength(1));
  expect(mocked.saved).toContainEqual({
    key: "exec/commands",
    value: expect.objectContaining({ recent: expect.arrayContaining(["sh -l"]) }),
  });
  expect(mocked.streamParams[0]).toMatchObject({ command: ["sh", "-l"] });
});

it("does not remember a missing command that was only tried once", async () => {
  view(
    {
      phase: "failed",
      reason: "error",
      error: { code: "not_found", reason: "CommandNotFound", message: "no bash" },
    },
    { ...params, commandLine: "bash -l" },
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false"),
  );
  expect(screen.queryByRole("button", { name: "Use the default shell" })).toBeNull();
});
it("identifies a remembered missing command and forgets it when using the default shell", async () => {
  mocked.setting = { images: [{ image: "busybox", command: "bash -l" }], recent: ["ash"] };
  view(
    {
      phase: "failed",
      reason: "error",
      error: { code: "not_found", reason: "CommandNotFound", message: "no bash" },
    },
    { ...params, commandLine: "bash -l" },
  );
  expect(await screen.findByText("You chose", { exact: false })).toBeDefined();
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Use the default shell" }));
  await vi.waitFor(() => expect(mocked.streams).toHaveLength(1));
  expect(updateParameters).toHaveBeenCalledWith({ ...params, commandLine: "" });
  expect(setTitle).toHaveBeenCalledWith("app in web");
  expect(mocked.streamParams[0]).not.toHaveProperty("command");
  expect(mocked.saved).toContainEqual({
    key: "exec/commands",
    value: { images: [], recent: ["ash"] },
  });
});
it.each(["NoShell", "CommandNotFound"])(
  "offers recent commands in the %s notice",
  async (reason) => {
    mocked.setting = { images: [], recent: ["python3"] };
    view({
      phase: "failed",
      reason: "error",
      error: { code: "not_found", reason, message: "missing" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "python3" }));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Command" }).value).toBe(
      "python3",
    );
  },
);
it.each([
  [false, true],
  [true, false],
])("does not focus a failed notice with visible=%s selected=%s", (visible, selected) => {
  Object.assign(api, { isVisible: visible, isActive: selected });
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  view({
    phase: "failed",
    reason: "error",
    error: { code: "not_found", reason: "NoShell", message: "missing" },
  });
  expect(document.activeElement).toBe(other);
  Object.assign(api, { isVisible: true, isActive: true });
  other.remove();
});
