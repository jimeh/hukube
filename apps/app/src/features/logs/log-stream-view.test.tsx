// @vitest-environment jsdom
import type {
  EngineClient,
  LogStreamParams,
  LogStreamStatus,
  Setting,
  SettingPut,
  StreamListener,
  SubscriptionListener,
} from "@hukube/engine-client";
import { EngineRequestError } from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useImperativeHandle } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogDocument } from "./log-document.ts";
import type { LogEditorHandle } from "./log-editor.tsx";
import LogStreamView, { type LogStreamViewProps } from "./log-stream-view.tsx";
import { getPreferenceStore } from "../settings/preferences.ts";

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
let engine: EngineClient;
let preference: unknown;
let preferenceRevision: string;
let preferenceRevisionNumber: number;
let preferenceWatches: {
  closed: boolean;
  listener: {
    data(setting: Setting): void;
    error?(error: { code: string; message: string }): void;
  };
}[];
let preferencePuts: SettingPut[];
let failPreferencePut: EngineRequestError | undefined;

function publishPreference(value: unknown) {
  preference = value;
  preferenceRevision = `r${++preferenceRevisionNumber}`;
  const setting = { key: "app/preferences", value, revision: preferenceRevision };
  for (const watch of preferenceWatches) if (!watch.closed) watch.listener.data(setting);
}

function makeEngine(): EngineClient {
  return {
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
    subscribe: (_method: string, _params: unknown, listener: SubscriptionListener<Setting>) => {
      const watch = {
        closed: false,
        listener: listener as (typeof preferenceWatches)[number]["listener"],
      };
      preferenceWatches.push(watch);
      queueMicrotask(() => {
        if (!watch.closed)
          watch.listener.data({
            key: "app/preferences",
            value: preference,
            revision: preferenceRevision,
          });
      });
      return {
        update: () => {},
        close: () => {
          watch.closed = true;
        },
      };
    },
    request: async (_method: string, params: unknown) => {
      const put = params as SettingPut;
      preferencePuts.push(put);
      if (failPreferencePut) {
        const error = failPreferencePut;
        failPreferencePut = undefined;
        throw error;
      }
      if (put.ifRevision !== preferenceRevision)
        throw new EngineRequestError({ code: "conflict", message: "changed" });
      publishPreference(put.value);
      return undefined;
    },
    getState: () => "open",
    onStateChange: () => () => {},
    close: () => {},
  } as unknown as EngineClient;
}
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
const event = (status = ready) => act(() => latest().listener.event(status));
const line = (text = "hello") =>
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: new Date(2026, 9, 13, 1, 2, 3, 4).getTime(), text },
      ]),
  );
beforeEach(() => {
  opened = [];
  preference = { version: 1 };
  preferenceRevision = "r1";
  preferenceRevisionNumber = 1;
  preferenceWatches = [];
  preferencePuts = [];
  failPreferencePut = undefined;
  engine = makeEngine();
  vi.useFakeTimers();
  // The fixture's lines are from this day. A line from another day shows its date.
  vi.setSystemTime(new Date(2026, 9, 13, 12));
  search.mockClear();
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
  expect(opened).toHaveLength(1);
  await act(async () => {});
  expect(screen.getByText(/Saved$/)).toBeDefined();
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
  expect(screen.getByRole("button", { name: "Previous run" }).hasAttribute("disabled")).toBe(false);
  // The Engine sends a run's lines before it says it is ready.
  const restarted = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...restarted, ready: false });
  line("old");
  event(restarted);
  // Timestamps are still on from the toggle above.
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old");
  expect(screen.getByText("The previous run of constructor.")).toBeDefined();
  // A second socket sends the run again. Its already-delivered prefix is
  // ignored without clearing the retained document.
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...ready, ready: false, sources: [] });
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old");
  event({ ...restarted, ready: false });
  line("old");
  event(restarted);
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old");
  act(() => latest().listener.end({ reason: "complete" }));
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(opened).toHaveLength(3);
});

it("does not restore an evicted previous-run prefix after limits increase and the socket reconnects", async () => {
  mount();
  await act(async () => {});
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 3 } }));
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const previousReady = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
        { source: 0, time: 0, text: "three" },
      ]),
  );
  event(previousReady);

  act(() => publishPreference({ version: 1, logStreams: { maxLines: 1 } }));
  expect(screen.getByRole("textbox").textContent).toBe("three");
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 3 } }));
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
        { source: 0, time: 0, text: "three" },
      ]),
  );
  event(previousReady);

  expect(screen.getByRole("textbox").textContent).toBe("three");
});

it("keeps a partial previous-run replay and appends only the new tail from a full replay", () => {
  mount();
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const previousReady = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
      ]),
  );
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
        { source: 0, time: 0, text: "three" },
      ]),
  );
  event(previousReady);

  expect(screen.getByRole("textbox").textContent).toBe("onetwothree");
});

it("counts an initial previous-run gap in the prefix skipped by a full replay", () => {
  mount();
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const previousReady = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...previousReady, ready: false });
  line("one");
  act(() => latest().listener.gap({ bytes: 20, records: 2, sources: [{ id: 0, records: 2 }] }));
  line("four");
  event(previousReady);

  act(() => latest().listener.state?.("reconnecting"));
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
        { source: 0, time: 0, text: "three" },
        { source: 0, time: 0, text: "four" },
        { source: 0, time: 0, text: "five" },
      ]),
  );
  event(previousReady);

  expect(screen.getByRole("textbox").textContent).toBe(
    "one··· 2 lines dropped: they arrived faster than they could be shown ···fourfive",
  );
});

it("counts only the unseen part of a replay gap that spans the old prefix", () => {
  mount();
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const previousReady = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
      ]),
  );
  event(previousReady);

  act(() => latest().listener.state?.("reconnecting"));
  event({ ...previousReady, ready: false });
  line("one");
  act(() => latest().listener.gap({ bytes: 30, records: 3, sources: [{ id: 0, records: 3 }] }));
  event(previousReady);
  line("five");

  act(() => latest().listener.state?.("reconnecting"));
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
        { source: 0, time: 0, text: "three" },
        { source: 0, time: 0, text: "four" },
        { source: 0, time: 0, text: "five" },
      ]),
  );
  event(previousReady);

  expect(screen.getByRole("textbox").textContent).toBe(
    "onetwo··· 2 lines dropped: they arrived faster than they could be shown ···five",
  );
});

it("stages a ready replay until every previous source publishes an instance", () => {
  const other = {
    ...source,
    id: 1,
    pod: "web-b",
    podUid: "uid-b",
    container: "sidecar",
    instance: "",
    previous: true,
  };
  const first = { ...source, previous: true };
  mount();
  event({
    ...ready,
    sources: [first, other],
    containers: [...ready.containers, { name: "sidecar", kind: "container" }],
    pods: 2,
    followed: 2,
    loaded: 2,
  });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const unresolved = {
    ...ready,
    sources: [first, other],
    pods: 2,
    followed: 2,
    loaded: 2,
  };
  event(unresolved);
  let returned: void | Promise<void>;
  act(() => {
    returned = latest().listener.data([{ source: 0, time: 0, text: "first" }]);
  });
  expect(returned!).toBeUndefined();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(latest().close).not.toHaveBeenCalled();

  event({
    ...unresolved,
    sources: [first, { ...other, instance: "sidecar-run" }],
  });
  expect(screen.getByRole("textbox").textContent).toBe("constructor first");
});

it("classifies a previous-false source without an instance and ignores its later current instance", () => {
  const first = { ...source, previous: true };
  const noPrevious = {
    ...source,
    id: 1,
    pod: "web-b",
    podUid: "uid-b",
    container: "sidecar",
    instance: "",
    previous: false,
  };
  mount();
  event({ ...ready, sources: [first, noPrevious], pods: 2, followed: 2, loaded: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({
    ...ready,
    ready: false,
    sources: [first, noPrevious],
    pods: 2,
    followed: 2,
    loaded: 2,
  });
  line("old");
  event({ ...ready, sources: [first, noPrevious], pods: 2, followed: 2, loaded: 2 });
  expect(screen.getByRole("textbox").textContent).toContain("old");
  const openedBefore = opened.length;
  event({
    ...ready,
    sources: [first, { ...noPrevious, instance: "current-run" }],
    pods: 2,
    followed: 2,
    loaded: 2,
  });
  expect(opened).toHaveLength(openedBefore);
  expect(screen.getByRole("textbox").textContent).toContain("old");
});

it("waits for every per-source boundary when a two-source replay is reordered", () => {
  const first = { ...source, previous: true };
  const second = {
    ...source,
    id: 1,
    pod: "web-b",
    podUid: "uid-b",
    container: "sidecar",
    instance: "sidecar-run",
    previous: true,
  };
  const replayStatus = {
    ...ready,
    sources: [first, second],
    pods: 2,
    followed: 2,
    loaded: 2,
  };
  mount();
  event(replayStatus);
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...replayStatus, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "a1" },
        { source: 0, time: 0, text: "a2" },
        { source: 1, time: 0, text: "b1" },
      ]),
  );
  event(replayStatus);
  const baseline = screen.getByRole("textbox").textContent;

  act(() => latest().listener.state?.("reconnecting"));
  event(replayStatus);
  act(
    () =>
      void latest().listener.data([
        { source: 1, time: 0, text: "b1" },
        { source: 1, time: 0, text: "b2" },
        { source: 0, time: 0, text: "a1" },
      ]),
  );
  expect(screen.getByRole("textbox").textContent).toBe(baseline);
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "a2" },
        { source: 0, time: 0, text: "a3" },
      ]),
  );
  expect(screen.getByRole("textbox").textContent).toBe(`${baseline}sidecar b2constructor a3`);
});

it("keeps a coalesced multi-source gap hidden until every source boundary crosses", () => {
  const first = { ...source, previous: true };
  const second = {
    ...source,
    id: 1,
    pod: "web-b",
    podUid: "uid-b",
    container: "sidecar",
    instance: "sidecar-run",
    previous: true,
  };
  const replayStatus = {
    ...ready,
    sources: [first, second],
    pods: 2,
    followed: 2,
    loaded: 2,
  };
  mount();
  event(replayStatus);
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...replayStatus, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "a1" },
        { source: 0, time: 0, text: "a2" },
        { source: 1, time: 0, text: "b1" },
        { source: 1, time: 0, text: "b2" },
      ]),
  );
  event(replayStatus);
  const baseline = screen.getByRole("textbox").textContent;
  act(() => latest().listener.state?.("reconnecting"));
  event(replayStatus);
  act(() =>
    latest().listener.gap({
      bytes: 50,
      records: 4,
      sources: [
        { id: 0, records: 3 },
        { id: 1, records: 1 },
      ],
    }),
  );
  expect(screen.getByRole("textbox").textContent).toBe(baseline);
  act(() => void latest().listener.data([{ source: 1, time: 0, text: "b2" }]));
  expect(screen.getByRole("textbox").textContent).toBe(
    `${baseline}··· 1 lines dropped: they arrived faster than they could be shown ···`,
  );
});

it("commits a changed instance with its document and displayed source status", () => {
  const oldSource = { ...source, previous: true, error: "old error" };
  mount();
  event({ ...ready, sources: [oldSource] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...ready, ready: false, sources: [oldSource] });
  line("old");
  event({ ...ready, sources: [oldSource] });
  expect(screen.getByText(/could not be read: old error/)).toBeDefined();

  act(() => latest().listener.state?.("reconnecting"));
  const changed = {
    ...oldSource,
    container: "replacement",
    instance: "run-2",
    error: "new error",
  };
  event({
    ...ready,
    ready: false,
    sources: [changed],
    containers: [{ name: "replacement", kind: "container" }],
  });
  act(() => void latest().listener.data([{ source: 0, time: 0, text: "fresh" }]));
  expect(screen.getByRole("textbox").textContent).toContain("old");
  expect(screen.getByText(/could not be read: old error/)).toBeDefined();
  expect(screen.queryByText(/new error/)).toBeNull();
  event({
    ...ready,
    sources: [changed],
    containers: [{ name: "replacement", kind: "container" }],
  });
  expect(screen.getByRole("textbox").textContent).toBe("fresh");
  expect(screen.queryByText(/old error/)).toBeNull();
  expect(screen.getByText(/could not be read: new error/)).toBeDefined();
});

it("restarts without mixing when staging crossed an epoch absent from the definitive set", () => {
  const first = { ...source, previous: true };
  mount();
  event({ ...ready, sources: [first] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...ready, ready: false, sources: [first] });
  line("baseline");
  event({ ...ready, sources: [first] });
  const before = opened.length;

  act(() => latest().listener.state?.("reconnecting"));
  const stale = { ...first, instance: "stale-run" };
  event({ ...ready, ready: false, sources: [stale] });
  act(() => void latest().listener.data([{ source: 0, time: 0, text: "stale" }]));
  const replacement = {
    ...first,
    id: 1,
    podUid: "uid-b",
    pod: "web-b",
    instance: "fresh-run",
  };
  event({ ...ready, sources: [replacement] });
  expect(opened).toHaveLength(before + 1);
  expect(screen.queryByRole("textbox")).toBeNull();
  event({ ...ready, ready: false, sources: [replacement] });
  act(() => void latest().listener.data([{ source: 1, time: 0, text: "fresh" }]));
  event({ ...ready, sources: [replacement] });
  expect(screen.getByRole("textbox").textContent).toBe("fresh");
});

it("restarts before later-epoch data reaches a committed previous-run document", () => {
  const first = { ...source, previous: true };
  mount();
  event({ ...ready, sources: [first] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...ready, ready: false, sources: [first] });
  line("old");
  event({ ...ready, sources: [first] });
  const before = opened.length;

  event({ ...ready, sources: [{ ...first, instance: "run-2" }] });
  expect(opened).toHaveLength(before + 1);
  expect(screen.queryByRole("textbox")).toBeNull();
  event({ ...ready, ready: false, sources: [{ ...first, instance: "run-2" }] });
  line("new");
  event({ ...ready, sources: [{ ...first, instance: "run-2" }] });
  expect(screen.getByRole("textbox").textContent).toBe("new");
});

it("retains the complete baseline and status when a same-run replay ends one source short", () => {
  const first = { ...source, previous: true };
  const second = {
    ...source,
    id: 1,
    pod: "web-b",
    podUid: "uid-b",
    container: "sidecar",
    instance: "sidecar-run",
    previous: true,
    error: "baseline error",
  };
  const replayStatus = {
    ...ready,
    sources: [first, second],
    pods: 2,
    followed: 2,
    loaded: 2,
  };
  mount();
  event(replayStatus);
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...replayStatus, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "a" },
        { source: 1, time: 0, text: "b" },
      ]),
  );
  event(replayStatus);
  const baseline = screen.getByRole("textbox").textContent;
  expect(screen.getByText(/could not be read/)).toBeDefined();

  act(() => latest().listener.state?.("reconnecting"));
  event(replayStatus);
  act(() => void latest().listener.data([{ source: 0, time: 0, text: "a" }]));
  act(() => latest().listener.end({ reason: "complete" }));
  expect(screen.getByRole("textbox").textContent).toBe(baseline);
  expect(screen.getByText(/could not be read/)).toBeDefined();
  expect(screen.getByText(/ended before every retained source boundary/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});

it("discards hidden and lost candidates and applies retention changes to every staged document", async () => {
  preference = { version: 1, logStreams: { maxLines: 3 } };
  const stopPreferences = getPreferenceStore(engine).subscribe(() => {});
  await act(async () => {});
  const first = { ...source, previous: true };
  const second = {
    ...source,
    id: 1,
    pod: "web-b",
    podUid: "uid-b",
    container: "sidecar",
    instance: "sidecar-run",
    previous: true,
  };
  const replayStatus = {
    ...ready,
    sources: [first, second],
    pods: 2,
    followed: 2,
    loaded: 2,
  };
  const view = mount();
  event(replayStatus);
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...replayStatus, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "a1" },
        { source: 1, time: 0, text: "b1" },
        { source: 0, time: 0, text: "a2" },
      ]),
  );
  event(replayStatus);
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(latest().pause).toHaveBeenCalledOnce();
  act(() => latest().listener.state?.("paused"));
  expect(screen.getByRole("textbox").textContent).toContain("a1");
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  expect(latest().resume).toHaveBeenCalled();
  act(() => latest().listener.state?.("connecting"));
  event(replayStatus);
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "a1" },
        { source: 0, time: 0, text: "a2" },
        { source: 0, time: 0, text: "a3" },
      ]),
  );
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 1 } }));
  expect(screen.getByRole("textbox").textContent).toContain("a2");
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 3 } }));
  act(() => void latest().listener.data([{ source: 1, time: 0, text: "b1" }]));
  expect(screen.getByRole("textbox").textContent).toBe("constructor a3");

  act(() => latest().listener.state?.("reconnecting"));
  event({ ...replayStatus, ready: false });
  act(() => void latest().listener.data([{ source: 0, time: 0, text: "discarded" }]));
  act(() => latest().listener.state?.("reconnecting"));
  expect(screen.getByRole("textbox").textContent).toBe("constructor a3");
  view.unmount();
  expect(latest().close).toHaveBeenCalled();
  stopPreferences();
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

it("trims a hidden mounted document on confirmed budget updates without reopening its stream", async () => {
  preference = { version: 1, logStreams: { maxLines: 3 } };
  const stopPreferences = getPreferenceStore(engine).subscribe(() => {});
  await act(async () => {});
  const view = mount();
  event();
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "one" },
        { source: 0, time: 0, text: "two" },
        { source: 0, time: 0, text: "three" },
        { source: 0, time: 0, text: "four" },
      ]),
  );
  expect(screen.getByRole("textbox").textContent).toBe("twothreefour");
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 1 } }));
  expect(opened).toHaveLength(1);
  expect(latest().pause).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox").textContent).toBe("four");
  expect(
    screen.getByText(
      "Older log entries were discarded to stay within retention limits and cannot be restored.",
    ),
  ).toBeDefined();

  act(() => publishPreference({ version: 1, logStreams: { maxLines: 10 } }));
  expect(opened).toHaveLength(1);
  expect(screen.getByRole("textbox").textContent).toBe("four");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText(/Older retained log entries/)).toBeNull();
  stopPreferences();
});

it("keeps an unsaved toolbar choice visible and offers retry or the confirmed value", async () => {
  mount();
  event();
  failPreferencePut = new EngineRequestError({ code: "unavailable", message: "disk full" });
  fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("Not saved: disk full");
  expect(screen.getByRole("button", { name: "Wrap" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Use current value" }));
  expect(screen.getByRole("button", { name: "Wrap" }).getAttribute("aria-pressed")).toBe("true");
  expect(opened).toHaveLength(1);
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
