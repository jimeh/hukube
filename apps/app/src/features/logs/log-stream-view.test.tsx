// @vitest-environment jsdom
import type {
  EngineClient,
  LogStreamParams,
  LogStreamStatus,
  StreamListener,
} from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useImperativeHandle } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogDocument } from "./log-document.ts";
import type { LogEditorHandle } from "./log-editor.tsx";
import LogStreamView, { type LogStreamViewProps } from "./log-stream-view.tsx";
import { PreferenceRuntime } from "../settings/preference-runtime.tsx";
import { getPreferenceStore } from "../settings/store.ts";
import { useLogSettings } from "./log-settings.ts";

const search = vi.hoisted(() => vi.fn<() => void>());
function StandInEditor({
  document,
  label,
  wrap,
  ref,
}: {
  document: LogDocument;
  label: string;
  wrap: boolean;
  ref: React.Ref<LogEditorHandle>;
}) {
  useImperativeHandle(ref, () => ({ search }));
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Stand-in records the editor document as visible text.
    <div role="textbox" aria-label={label} data-wrap={wrap}>
      {document.rows.map((row) => (
        <p key={row.sequence}>{row.text}</p>
      ))}
    </div>
  );
}
vi.mock("./log-editor.tsx", () => ({ default: StandInEditor }));
let opened: {
  params: LogStreamParams;
  listener: StreamListener<"resource.logs">;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}[];
const engine = {
  openStream: (
    _method: string,
    params: LogStreamParams,
    listener: StreamListener<"resource.logs">,
  ) => {
    const handle = {
      params,
      listener,
      pause: vi.fn<() => void>(),
      resume: vi.fn<() => void>(),
      close: vi.fn<() => void>(),
    };
    opened.push(handle);
    return handle;
  },
} as unknown as EngineClient;
const props: LogStreamViewProps = {
  target: { cluster: "c", type: "pods", namespace: "ns", name: "web" },
  kind: "Pod",
  uid: "uid",
  exists: true,
  visible: true,
};
const source = {
  id: 0,
  pod: "web",
  podUid: "uid",
  container: "constructor",
  instance: "run",
  state: "running" as const,
};
const ready: LogStreamStatus = {
  ready: true,
  sources: [source],
  containers: [{ name: "constructor", kind: "container" }],
  pods: 1,
  followed: 1,
  loaded: 1,
};
const mount = (override: Partial<LogStreamViewProps> = {}) =>
  render(
    <EngineProvider client={engine}>
      <LogStreamView {...props} {...override} />
    </EngineProvider>,
  );
const latest = () => opened.at(-1)!;
const event = (status = ready) => {
  act(() => {
    void latest().listener.event(status);
  });
};
const line = (text = "hello") =>
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: new Date(2026, 9, 13, 1, 2, 3, 4).getTime(), text },
      ]),
  );
beforeEach(() => {
  opened = [];
  vi.useFakeTimers();
  // The fixture's lines are from this day. A line from another day shows its date.
  vi.setSystemTime(new Date(2026, 9, 13, 12));
  search.mockClear();
  useLogSettings.setState({
    timestamps: false,
    wrap: true,
    maxLines: 50000,
    maxCharacters: 32000000,
    maxDecorations: 200000,
    loaded: true,
    saveStatus: "",
    saveError: undefined,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows loading, not found, no Pods, waiting, quiet, and no-source states with disabled loading controls", () => {
  mount({ uid: undefined, exists: undefined });
  expect(screen.getByLabelText("Loading Log Stream")).toBeDefined();
  expect(opened).toHaveLength(0);
  for (const name of ["Timestamps", "Wrap", "Search"])
    expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
  cleanup();
  mount({ uid: undefined, exists: false });
  expect(screen.getByText("Not found")).toBeDefined();
  expect(
    screen.getByText("No Pod named web exists right now. Its logs appear here if it is created."),
  ).toBeDefined();
  cleanup();
  mount({ target: { ...props.target, type: "deployments.apps" }, kind: "Deployment" });
  event({ ...ready, ready: false, sources: [], pods: 0 });
  expect(screen.getByLabelText("Loading Log Stream")).toBeDefined();
  event({ ...ready, sources: [], pods: 0 });
  expect(screen.getByText("No Pods")).toBeDefined();
  expect(
    screen.getByText("This Deployment owns no Pods right now. Lines appear here when it does."),
  ).toBeDefined();
  cleanup();
  mount();
  event({
    ...ready,
    sources: [{ ...source, state: "waiting", reason: "ImagePullBackOff", message: "bad image" }],
  });
  expect(screen.getByText("Waiting for the container to start")).toBeDefined();
  expect(screen.getByText(/constructor: ImagePullBackOff/).textContent).toContain("bad image");
  event({
    ...ready,
    sources: Array.from({ length: 4 }, (_, id) => ({
      ...source,
      id,
      container: `c${id}`,
      state: "waiting",
    })),
  });
  expect(screen.getByText("Waiting for containers to start")).toBeDefined();
  expect(screen.getByText(/and 1 more/)).toBeDefined();
  event();
  expect(screen.getByText("No log lines yet")).toBeDefined();
  expect(
    screen.getByText("constructor has not printed anything. Lines appear here as it does."),
  ).toBeDefined();
  event({ ...ready, sources: [] });
  expect(
    screen.getByText("These containers have not printed anything. Lines appear here as they do."),
  ).toBeDefined();
});
it("shows retained lines with stopped containers, unreadable logs, Pod limits, reconnects, and queued streams", () => {
  mount();
  event();
  line();
  event({
    ...ready,
    sources: [
      {
        ...source,
        state: "waiting",
        reason: "CrashLoopBackOff",
        message: "backing off",
        error: "Cluster unavailable",
      },
    ],
    pods: 134,
    followed: 20,
    loaded: 20,
  });
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  // The kubelet's message can be a paragraph, so it is the notice's title.
  expect(
    screen.getByText("constructor is not running: CrashLoopBackOff.").parentElement?.title,
  ).toBe("backing off");
  expect(
    screen.getByText(
      "Cannot read the logs of constructor: Cluster unavailable. hukube keeps trying.",
    ),
  ).toBeDefined();
  expect(
    screen.getByText("Showing the 20 newest of 134 Pods. Open a Pod to see its own logs."),
  ).toBeDefined();
  event({
    ...ready,
    sources: [
      { ...source, state: "waiting", error: "first" },
      { ...source, id: 1, error: "second" },
    ],
  });
  expect(screen.getByText("1 of 2 containers is not running.")).toBeDefined();
  expect(
    screen.getByText("Cannot read the logs of 2 containers. hukube keeps trying.").parentElement
      ?.title,
  ).toBe("first");
  // Fewer Pods are read than exist for a moment whenever Pods come and go.
  event({ ...ready, pods: 4, followed: 3, loaded: 3 });
  expect(screen.queryByText(/newest of/)).toBeNull();
  act(() => latest().listener.state?.("reconnecting"));
  expect(screen.getByText("Connection to the Engine lost. Reconnecting…")).toBeDefined();
  expect(screen.getByRole("textbox").textContent).toBe("constructor hello");
  act(() => latest().listener.state?.("waiting"));
  expect(screen.getByText(/Waiting for a free stream/)).toBeDefined();
  cleanup();
  mount();
  act(() => latest().listener.state?.("waiting"));
  expect(screen.getByText("Waiting for a free stream")).toBeDefined();
});
it("shows final errors and retries only on a button, with or without retained lines", () => {
  mount();
  act(() =>
    latest().listener.end({
      reason: "error",
      error: { code: "forbidden", message: "No permission" },
    }),
  );
  expect(screen.getByText("Not permitted")).toBeDefined();
  expect(screen.getByText("No permission")).toBeDefined();
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(opened).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(opened).toHaveLength(2);
  event();
  line();
  act(() =>
    latest().listener.end({
      reason: "error",
      error: { code: "forbidden", message: "No permission" },
    }),
  );
  expect(screen.getByText("Not permitted: No permission")).toBeDefined();
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  act(() =>
    latest().listener.end({ reason: "error", error: { code: "internal", message: "Failed" } }),
  );
  expect(screen.getByText("The Log Stream stopped: Failed.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});
it("opens on existence, pauses at ten hidden seconds, resumes, and closes on unmount", () => {
  const view = mount({ exists: false, uid: undefined });
  expect(opened).toHaveLength(0);
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  expect(opened).toHaveLength(1);
  event();
  line();
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  act(() => {
    vi.advanceTimersByTime(9999);
  });
  expect(latest().pause).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(latest().pause).toHaveBeenCalledOnce();
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  expect(latest().resume).toHaveBeenCalled();
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  view.unmount();
  expect(latest().close).toHaveBeenCalledOnce();
});
it("keeps deleted lines until Show its logs starts the new UID", () => {
  const view = mount();
  event();
  line();
  act(() => latest().listener.end({ reason: "deleted" }));
  expect(
    screen.getByText("This Pod was deleted. These are the last lines it printed."),
  ).toBeDefined();
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} uid="new" />
    </EngineProvider>,
  );
  expect(screen.getByText("This Pod was deleted and created again.")).toBeDefined();
  expect(opened).toHaveLength(1);
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  fireEvent.click(screen.getByRole("button", { name: "Show its logs" }));
  expect(latest().params.uid).toBe("new");
  expect(screen.queryByRole("textbox")).toBeNull();
});
it("shares display toggles, enables previous only after a restart, searches, and clears on selection changes", async () => {
  mount();
  event();
  line();
  // One container is shown as its name, with nothing to choose.
  expect(screen.queryByRole("combobox", { name: "Container" })).toBeNull();
  expect(screen.getByTitle("constructor").textContent).toBe("constructor");
  expect(screen.getByRole("button", { name: "Previous run" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Timestamps" }));
  expect(screen.getByRole("textbox").textContent).toContain("01:02:03.004");
  fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
  expect(screen.getByRole("textbox").getAttribute("data-wrap")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(search).toHaveBeenCalledOnce();
  event({
    ...ready,
    sources: [{ ...source, previous: true }],
    containers: [
      { name: "constructor", kind: "container" },
      { name: "__proto__", kind: "init" },
      { name: "debug", kind: "ephemeral" },
    ],
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Container" }));
  expect(screen.getByText("Init containers")).toBeDefined();
  expect(screen.getByText("Ephemeral containers")).toBeDefined();
  fireEvent.pointerDown(screen.getByRole("option", { name: "__proto__" }));
  fireEvent.click(screen.getByRole("option", { name: "__proto__" }));
  expect(latest().params.container).toBe("__proto__");
  expect(screen.queryByRole("textbox")).toBeNull();
  // The choice replaced the toolbar, and the control that made it keeps focus.
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Container" }));
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  expect(latest().params.previous).toBe(true);
  event();
  expect(screen.getByText("No previous run")).toBeDefined();
  expect(screen.getByRole("button", { name: "Previous run" }).hasAttribute("disabled")).toBe(false);
  // The Engine sends a run's lines before it says it is ready.
  const restarted = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...restarted, ready: false });
  line("old");
  event(restarted);
  // Timestamps are still on from the toggle above.
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old");
  expect(screen.getByText("The previous run of constructor.")).toBeDefined();
  // A second socket sends the run again, and its lines replace the first's
  // once they arrive, not before.
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...ready, ready: false, sources: [] });
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old");
  event({ ...restarted, ready: false });
  line("old again");
  event(restarted);
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old again");
  act(() => latest().listener.end({ reason: "complete" }));
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(opened).toHaveLength(3);
});
it("renders ordered drop, join, leave and record markers with merged origins", () => {
  mount({ target: { ...props.target, type: "deployments.apps" }, kind: "Deployment" });
  event();
  line();
  const other = { ...source, id: 1, pod: "web-b", podUid: "uid2" };
  event({ ...ready, sources: [source, other], pods: 2, followed: 2, loaded: 2 });
  act(
    () =>
      void latest().listener.data([
        { source: 1, time: 0, text: "next" },
        { source: 0, time: 0, text: "", gap: true },
        { source: 1, time: 0, text: "Error, exit code 1", exited: true },
      ]),
  );
  act(() => latest().listener.gap({ bytes: 1_000_000, records: 12340 }));
  event({ ...ready, sources: [other] });
  expect(screen.getByRole("textbox").textContent).toBe(
    "web hello··· following Pod web-b ···web-b next··· web: some lines may be missing ······ web-b exited: Error, exit code 1 ······ 12,340 lines dropped: they arrived faster than they could be shown ······ Pod web is gone ···",
  );
});

it("does not report a completed init container as not running", () => {
  mount();
  const init = { ...source, id: 1, container: "setup", state: "terminated" as const };
  const withInit = (exitCode: number): LogStreamStatus => ({
    ...ready,
    sources: [source, { ...init, exitCode, reason: exitCode ? "Error" : "Completed" }],
    containers: [...ready.containers, { name: "setup", kind: "init" }],
  });
  event(withInit(1));
  line();
  expect(screen.getByText("1 of 2 containers is not running.")).toBeDefined();
  event(withInit(0));
  expect(screen.queryByText(/not running/)).toBeNull();
});

it("opens no stream for a view that has not been shown yet", () => {
  const view = mount({ visible: false });
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(opened).toHaveLength(0);
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  expect(opened).toHaveLength(1);
});

it("says that a previous run's logs are gone instead of promising lines", () => {
  mount();
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...ready, sources: [{ ...source, previous: true, error: "unable to retrieve" }] });
  act(() => latest().listener.end({ reason: "complete" }));
  expect(screen.getByText("No lines from the previous run")).toBeDefined();
  expect(screen.getByText("Its logs are no longer available: unable to retrieve")).toBeDefined();
  expect(screen.queryByText(/keeps trying|appear here/)).toBeNull();
});

it("keeps the display controls of a deleted Resource and takes away its choices", () => {
  mount();
  event({
    ...ready,
    sources: [{ ...source, previous: true }],
    containers: [...ready.containers, { name: "sidecar", kind: "container" }],
  });
  line();
  act(() => latest().listener.end({ reason: "deleted" }));
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  for (const name of ["Timestamps", "Wrap", "Search"])
    expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("combobox", { name: "Container" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Previous run" }).hasAttribute("disabled")).toBe(true);
});

it("does not call a Pod gone because a status came before its containers were known", () => {
  mount({ target: { ...props.target, type: "deployments.apps" }, kind: "Deployment" });
  const other = { ...source, id: 1, pod: "web-b", podUid: "uid2" };
  event({ ...ready, sources: [source, other], pods: 2, followed: 2, loaded: 2 });
  line();
  // A resumed stream is ready after a second, with one Pod's manifest still on its way.
  event({ ...ready, sources: [source], pods: 2, followed: 2, loaded: 1 });
  event({ ...ready, sources: [source, other], pods: 2, followed: 2, loaded: 2 });
  expect(screen.getByRole("textbox").textContent).not.toMatch(/is gone|following Pod/);
  event({ ...ready, sources: [source], pods: 1, followed: 1, loaded: 1 });
  expect(screen.getByRole("textbox").textContent).toContain("··· Pod web-b is gone ···");
});

it("marks Pods that come and go in a stream narrowed to a container another Pod lacks", () => {
  mount({ target: { ...props.target, type: "deployments.apps" }, kind: "Deployment" });
  // Two Pods are followed and loaded, and only one has the chosen container.
  event({ ...ready, pods: 2, followed: 2, loaded: 2 });
  line();
  const next = { ...source, id: 1, pod: "web-c", podUid: "uid3" };
  event({ ...ready, sources: [next], pods: 2, followed: 2, loaded: 2 });
  const text = screen.getByRole("textbox").textContent;
  expect(text).toContain("··· following Pod web-c ···");
  expect(text).toContain("··· Pod web is gone ···");
});
it("applies live budgets to visible and hidden documents without restarting and unsubscribes disposed runs", () => {
  const view = mount();
  event();
  line("one");
  line("two");
  line("three");
  const first = opened[0]!;
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  act(() => useLogSettings.setState({ maxLines: 1 }));
  expect(screen.getByRole("textbox", { name: "Logs of Pod web", hidden: true }).textContent).toBe(
    "three",
  );
  expect(opened).toHaveLength(1);
  expect(first.close).not.toHaveBeenCalled();
  expect(first.pause).not.toHaveBeenCalled();
  line("four");
  expect(screen.getByRole("textbox", { name: "Logs of Pod web", hidden: true }).textContent).toBe(
    "four",
  );
  act(() => useLogSettings.setState({ maxLines: 100 }));
  expect(screen.getByRole("textbox", { name: "Logs of Pod web", hidden: true }).textContent).toBe(
    "four",
  );
  view.unmount();
  expect(first.close).toHaveBeenCalledOnce();
  act(() => useLogSettings.setState({ maxLines: 50000 }));
});
it("applies only confirmed Engine preferences to multiple documents, including a hidden one, after a failed save", async () => {
  const original = useLogSettings.getState();
  let value: unknown = { version: 1, logStreams: { maxLines: 3 } };
  let emit!: () => void;
  const client = {
    ...engine,
    getState: () => "open",
    onStateChange: () => () => {},
    subscribe: (_m: string, _p: unknown, listener: { data(value: unknown): void }) => {
      emit = () => listener.data({ key: "app/preferences", revision: "r", value });
      queueMicrotask(emit);
      return { close() {}, update() {} };
    },
    request: async () => {
      throw Object.assign(new Error("disk full"), { code: "internal" });
    },
  } as unknown as EngineClient;
  const contents = (visible: boolean) => (
    <EngineProvider client={client}>
      <PreferenceRuntime />
      <LogStreamView {...props} />
      <LogStreamView {...props} target={{ ...props.target, name: "other" }} visible={visible} />
    </EngineProvider>
  );
  const view = render(contents(true));
  const store = getPreferenceStore(client);
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(opened).toHaveLength(2);
    act(() => {
      for (const stream of opened) {
        void stream.listener.event(ready);
        void stream.listener.data(
          ["one", "two", "three"].map((text) => ({ source: 0, time: 0, text })),
        );
      }
    });
    view.rerender(contents(false));
    await act(async () => {
      store.change("maxLines", "1");
      await Promise.resolve();
    });
    for (const editor of screen.getAllByRole("textbox", { name: /Logs of Pod/, hidden: true }))
      expect(editor.textContent).toBe("onetwothree");
    act(() => {
      value = { version: 1, logStreams: { maxLines: 1 } };
      emit();
    });
    for (const editor of screen.getAllByRole("textbox", { name: /Logs of Pod/, hidden: true }))
      expect(editor.textContent).toBe("three");
    expect(opened).toHaveLength(2);
    for (const stream of opened) {
      expect(stream.pause).not.toHaveBeenCalled();
      expect(stream.close).not.toHaveBeenCalled();
    }
  } finally {
    view.unmount();
    store.dispose();
    useLogSettings.setState(original);
  }
});

it("dismisses only the loss notice, coalesces routine losses and announces a new settings loss, including while hidden", () => {
  useLogSettings.setState({ maxLines: 3 });
  const view = mount();
  event();
  for (const text of ["one", "two", "three", "four"]) line(text);
  const dismiss = screen.getByRole("button", { name: "Dismiss retention notice" });
  const announcement = screen
    .getAllByRole("status")
    .find((node) => node.textContent?.includes("retention limits"))!;
  expect(announcement.textContent).toContain("1 oldest retained lines");
  line("five");
  expect(announcement.textContent).toContain("1 oldest retained lines");
  expect(screen.getByText("2 oldest retained lines removed by retention limits.")).toBeDefined();
  dismiss.focus();
  fireEvent.click(dismiss);
  expect(document.activeElement).toBe(screen.getByRole("toolbar", { name: "Log Stream" }));
  expect(screen.queryByRole("button", { name: "Dismiss retention notice" })).toBeNull();
  expect(screen.getByRole("textbox").textContent).toBe("threefourfive");
  line("six");
  expect(screen.queryByText(/oldest retained lines/)).toBeNull();
  act(() => useLogSettings.setState({ maxLines: 4 }));
  act(() => useLogSettings.setState({ maxLines: 3, wrap: false }));
  expect(screen.queryByText(/oldest retained lines/)).toBeNull();
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  act(() => useLogSettings.setState({ maxLines: 1 }));
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  expect(screen.getAllByText("5 oldest retained lines removed by retention limits.")).toHaveLength(
    2,
  );
  expect(screen.getByRole("textbox").textContent).toBe("six");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss retention notice" }));
  act(() => useLogSettings.setState({ maxCharacters: 1 }));
  expect(screen.getByRole("button", { name: "Dismiss retention notice" })).toBeDefined();
  expect(screen.getByText("No retained lines fit")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss retention notice" }));
  expect(document.activeElement).toBe(screen.getByRole("toolbar", { name: "Log Stream" }));
  expect(screen.getByText("No retained lines fit")).toBeDefined();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(opened).toHaveLength(1);
  expect(latest().close).not.toHaveBeenCalled();
  expect(latest().pause).not.toHaveBeenCalled();
});

it("shows the first new loss after replay clears a dismissed document", () => {
  useLogSettings.setState({ maxLines: 1 });
  mount();
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const previousStatus = { ...ready, sources: [{ ...source, previous: true }] };
  event(previousStatus);
  line("old one");
  line("old two");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss retention notice" }));
  act(() => latest().listener.state?.("reconnecting"));
  event(previousStatus);
  line("replayed one");
  expect(screen.queryByRole("button", { name: "Dismiss retention notice" })).toBeNull();
  line("replayed two");
  expect(screen.getByRole("button", { name: "Dismiss retention notice" })).toBeDefined();
  expect(screen.getByRole("textbox").textContent).toBe("replayed two");
  expect(screen.getAllByText("1 oldest retained lines removed by retention limits.")).toHaveLength(
    2,
  );
  expect(opened).toHaveLength(2);
});

it("does not carry a dismissed loss into a replacement document", () => {
  useLogSettings.setState({ maxLines: 1 });
  const view = mount();
  event();
  line("one");
  line("two");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss retention notice" }));
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView
        {...props}
        target={{ ...props.target, type: "deployments.apps" }}
        kind="Deployment"
      />
    </EngineProvider>,
  );
  event();
  line("replacement one");
  line("replacement two");
  expect(screen.getByRole("button", { name: "Dismiss retention notice" })).toBeDefined();
  expect(screen.getByRole("textbox").textContent).toBe("replacement two");
});
