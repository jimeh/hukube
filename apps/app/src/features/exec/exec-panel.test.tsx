// @vitest-environment jsdom
import type { StreamListener } from "@hukube/engine-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExecPanel } from "./exec-panel.tsx";
import { endSession, useExecSessions, type ExecState } from "./sessions.ts";
import { fakeTerminal } from "./test-terminal.ts";
import { WorkspaceContext, type WorkspaceValue } from "../workspace/workspace-context.tsx";

const mocked = vi.hoisted(() => ({
  object: {
    metadata: { uid: "uid" },
    spec: { containers: [{ name: "app" }] },
    status: { containerStatuses: [{ name: "app", state: { running: {} } }] },
  } as Record<string, unknown>,
  deleted: false,
  connection: "open",
  exec: { allowed: true } as { allowed: boolean; reason?: string },
  streams: [] as StreamListener<"pod.exec">[],
  terminal: undefined as ReturnType<typeof fakeTerminal> | undefined,
}));
vi.mock("@hukube/engine-client/react", () => {
  const engine = {
    onStateChange: () => () => {},
    getState: () => "open",
    request: () => Promise.resolve({ exec: mocked.exec }),
    openStream: (_method: string, _params: unknown, listener: StreamListener<"pod.exec">) => {
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
const api = { id: "exec:id", isVisible: true, isActive: true, close } as unknown as Parameters<
  typeof ExecPanel
>[0]["api"];
const workspace: WorkspaceValue = {
  cluster: "c",
  active: true,
  types: new Map(),
  openList: () => {},
  openResource,
  openExecSession: () => {},
};
function view(state?: ExecState) {
  mocked.terminal = fakeTerminal();
  if (state)
    useExecSessions.setState({
      entries: new Map([
        [params.sessionId, { cluster: "c", params, state, terminal: mocked.terminal.terminal }],
      ]),
    });
  return render(
    <WorkspaceContext value={workspace}>
      <ExecPanel api={api} params={params} />
    </WorkspaceContext>,
  );
}
afterEach(() => {
  cleanup();
  endSession("id");
  close.mockClear();
  openResource.mockClear();
  mocked.deleted = false;
  mocked.connection = "open";
  mocked.streams = [];
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
        "hukube runs sh, and this container has none, which is usual for distroless images. A debug container is the way into one, for example with kubectl debug.",
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
