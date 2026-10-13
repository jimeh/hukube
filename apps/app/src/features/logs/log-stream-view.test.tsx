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
};
const mount = (override: Partial<LogStreamViewProps> = {}) =>
  render(
    <EngineProvider client={engine}>
      <LogStreamView {...props} {...override} />
    </EngineProvider>,
  );
const latest = () => opened.at(-1)!;
const event = (status = ready) => act(() => latest().listener.event(status));
const line = (text = "hello") =>
  act(() =>
    latest().listener.data([
      { source: 0, time: new Date(2026, 9, 13, 1, 2, 3, 4).getTime(), text },
    ]),
  );
beforeEach(() => {
  opened = [];
  vi.useFakeTimers();
  search.mockClear();
  useLogSettings.setState({ timestamps: false, wrap: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows loading, not found, no Pods, waiting, quiet, and no-source states with disabled loading controls", () => {
  mount({ uid: undefined, exists: undefined });
  expect(screen.getByLabelText("Loading Log Stream")).toBeDefined();
  expect(opened).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Timestamps" }).hasAttribute("disabled")).toBe(true);
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
  });
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  expect(
    screen.getByText("constructor is not running: CrashLoopBackOff. backing off"),
  ).toBeDefined();
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
  expect(screen.getByText("1 of 2 containers are not running.")).toBeDefined();
  expect(
    screen.getByText("Cannot read the logs of 2 containers. hukube keeps trying.").parentElement
      ?.title,
  ).toBe("first");
  act(() => latest().listener.state?.("reconnecting"));
  expect(screen.getByText("Connection to the Engine lost. Reconnecting…")).toBeDefined();
  expect(screen.getByRole("textbox").textContent).toBe("constructor hello");
  act(() => latest().listener.state?.("waiting"));
  expect(screen.getByText(/Waiting for a free Log Stream/)).toBeDefined();
  cleanup();
  mount();
  act(() => latest().listener.state?.("waiting"));
  expect(screen.getByText("Waiting for a free Log Stream")).toBeDefined();
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
  expect(screen.getByRole("combobox", { name: "Container" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("combobox").textContent).toContain("constructor");
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
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  expect(latest().params.previous).toBe(true);
  event();
  expect(screen.getByText("No previous run")).toBeDefined();
  expect(screen.getByRole("button", { name: "Previous run" }).hasAttribute("disabled")).toBe(false);
  event({ ...ready, sources: [{ ...source, previous: true }] });
  line("old");
  expect(screen.getByText("The previous run of constructor.")).toBeDefined();
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...ready, ready: false });
  expect(screen.getByRole("textbox").textContent).toContain("old");
  event();
  expect(screen.queryByRole("textbox")).toBeNull();
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
  event({ ...ready, sources: [source, other], pods: 2, followed: 2 });
  act(() =>
    latest().listener.data([
      { source: 1, time: 0, text: "next" },
      { source: 0, time: 0, text: "", gap: true },
      { source: 1, time: 0, text: "Error, exit code 1", exited: true },
    ]),
  );
  act(() => latest().listener.gap({ bytes: 1_000_000, records: 12340 }));
  event({ ...ready, sources: [other] });
  expect(screen.getByRole("textbox").textContent).toBe(
    "web hello··· following Pod web-b ···b next··· web: some lines may be missing ······ b exited: Error, exit code 1 ······ 12,340 lines dropped: they arrived faster than they could be shown ······ Pod web is gone ···",
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
  expect(screen.getByText("1 of 2 containers are not running.")).toBeDefined();
  event(withInit(0));
  expect(screen.queryByText(/not running/)).toBeNull();
});
