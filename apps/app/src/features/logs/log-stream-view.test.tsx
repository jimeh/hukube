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
import { EngineConnection, EngineRequestError, type SocketLike } from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { frame as wireFrame } from "../../../../../packages/engine-client/src/log-test-fixtures.ts";
import {
  Hash,
  LogRecordFlagGap,
  type StreamClientMessage,
} from "../../../../../packages/engine-client/src/protocol.gen.ts";
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

class StreamSocket implements SocketLike {
  sent: StreamClientMessage[] = [];
  binaryType = "";
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onmessage: SocketLike["onmessage"] = null;

  send(value: string | Uint8Array<ArrayBuffer>) {
    if (typeof value === "string") this.sent.push(JSON.parse(value) as StreamClientMessage);
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
  hello() {
    this.onopen?.(new Event("open"));
    this.receive({ type: "hello", hello: { protocol: Hash } });
  }
}

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

function makeWireEngine() {
  const sockets: StreamSocket[] = [];
  const connection = new EngineConnection({
    url: "http://localhost",
    token: "test",
    retryDelaysMs: [1],
    createSocket: () => {
      const socket = new StreamSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const client: EngineClient = {
    ...makeEngine(),
    openStream: connection.openStream.bind(connection),
  };
  return { client, connection, sockets };
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
  // A second socket resumes after the committed cursor without clearing the
  // retained document.
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...ready, ready: false, sources: [] });
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old");
  event({ ...restarted, ready: false });
  line("new");
  event(restarted);
  expect(screen.getByRole("textbox").textContent).toBe("01:02:03.004 old01:02:03.004 new");
  act(() => latest().listener.end({ reason: "complete" }));
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(opened).toHaveLength(3);
});

it("rejects toolbar display changes when the stored Log Streams section is non-object", async () => {
  preference = { version: 1, logStreams: "broken" };
  mount();
  await act(async () => {});
  event();
  const wrap = screen.getByRole("button", { name: "Wrap" });
  const timestamps = screen.getByRole("button", { name: "Timestamps" });
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  expect(timestamps.getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(wrap);
  fireEvent.click(timestamps);
  await act(async () => {});
  expect(preferencePuts).toHaveLength(0);
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  expect(timestamps.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText(/Repair Log Streams section first/)).toBeDefined();
  expect(screen.queryByText(/Saved/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {});
  expect(preferencePuts).toHaveLength(0);
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
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
        { source: 0, time: 1, text: "one" },
        { source: 0, time: 2, text: "two" },
        { source: 0, time: 3, text: "three" },
      ]),
  );
  event(previousReady);

  act(() => publishPreference({ version: 1, logStreams: { maxLines: 1 } }));
  expect(screen.getByRole("textbox").textContent).toBe("three");
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 3 } }));
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...previousReady, ready: false });
  act(() => void latest().listener.data([{ source: 0, time: 4, text: "four" }]));
  event(previousReady);

  expect(screen.getByRole("textbox").textContent).toBe("threefour");
});

it("keeps a partial previous-run handle and appends its resumed suffix", () => {
  mount();
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const previousReady = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 1, text: "one" },
        { source: 0, time: 2, text: "two" },
      ]),
  );
  act(() => latest().listener.state?.("reconnecting"));
  event({ ...previousReady, ready: false });
  act(() => void latest().listener.data([{ source: 0, time: 3, text: "three" }]));
  event(previousReady);

  expect(screen.getByRole("textbox").textContent).toBe("onetwothree");
});

it.each([
  ["initial", "without an instance"],
  ["initial", "as provisional no-previous"],
  ["changed", "without an instance"],
  ["changed", "as provisional no-previous"],
] as const)(
  "preserves %s staged previous rows when a replacement socket first describes the source %s",
  (stage, provisional) => {
    const first = { ...source, instance: "run-1", previous: true };
    mount();
    event({ ...ready, sources: [first] });
    fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
    event({ ...ready, ready: false, sources: [first] });

    if (stage === "changed") {
      line("committed");
      event({ ...ready, sources: [first] });
      act(() => latest().listener.state?.("reconnecting"));
    }

    const staged = {
      ...first,
      instance: stage === "changed" ? "run-2" : first.instance,
    };
    event({ ...ready, ready: false, sources: [staged] });
    line("prefix");
    act(() => latest().listener.state?.("reconnecting"));
    event({
      ...ready,
      ready: false,
      sources: [
        provisional === "without an instance"
          ? { ...staged, instance: undefined }
          : { ...staged, previous: false, instance: undefined },
      ],
    });
    event({ ...ready, ready: false, sources: [staged] });
    line("suffix");
    event({ ...ready, sources: [staged] });

    expect(screen.getByRole("textbox").textContent).toBe("prefixsuffix");
  },
);

it("keeps a resolved previous-run gap and appends the resumed suffix", () => {
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
  line("five");
  event(previousReady);

  expect(screen.getByRole("textbox").textContent).toBe(
    "one··· 2 lines dropped: they arrived faster than they could be shown ···fourfive",
  );
});

it("closes an unresolved previous-run gap at reconnect and ignores later messages", () => {
  mount();
  event({ ...ready, sources: [{ ...source, previous: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  const previousReady = { ...ready, sources: [{ ...source, previous: true }] };
  event({ ...previousReady, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 1, text: "one" },
        { source: 0, time: 2, text: "two" },
      ]),
  );
  event(previousReady);

  act(() => latest().listener.gap({ bytes: 30, records: 3, sources: [{ id: 0, records: 3 }] }));
  act(() => latest().listener.state?.("reconnecting"));
  const abandoned = latest();
  expect(abandoned.close).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox").textContent).toContain("onetwo");
  expect(screen.getByRole("textbox").textContent).toContain("3 lines dropped");
  expect(screen.getByText(/ReplayIncomplete: .*could not resume safely/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();

  event({ ...previousReady, ready: false });
  act(() => void abandoned.listener.data([{ source: 0, time: 5, text: "late" }]));
  event(previousReady);
  expect(screen.getByRole("textbox").textContent).not.toContain("late");
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

it("appends reordered per-source suffixes directly for unchanged epochs", () => {
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
        { source: 0, time: 1, text: "a1" },
        { source: 0, time: 2, text: "a2" },
        { source: 1, time: 3, text: "b1" },
      ]),
  );
  event(replayStatus);
  const baseline = screen.getByRole("textbox").textContent;

  act(() => latest().listener.state?.("reconnecting"));
  event(replayStatus);
  act(
    () =>
      void latest().listener.data([
        { source: 1, time: 4, text: "b2" },
        { source: 0, time: 5, text: "a3" },
      ]),
  );
  expect(screen.getByRole("textbox").textContent).toBe(`${baseline}sidecar b2constructor a3`);
});

it("reconciles only changed epochs and preserves the unchanged source's loss", () => {
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
        { source: 0, time: 1, text: "a1" },
        { source: 0, time: 2, text: "a2" },
        { source: 1, time: 3, text: "b1" },
        { source: 1, time: 4, text: "b2" },
      ]),
  );
  event(replayStatus);
  act(() => latest().listener.state?.("reconnecting"));
  const changedSecond = { ...second, instance: "sidecar-run-2" };
  event({ ...replayStatus, ready: false, sources: [first, changedSecond] });
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
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 5, text: "a3" },
        { source: 1, time: 6, text: "b-new" },
      ]),
  );
  event({ ...replayStatus, sources: [first, changedSecond] });
  expect(screen.getByRole("textbox").textContent).toBe(
    "constructor a1constructor a2··· 3 lines dropped: they arrived faster than they could be shown ···constructor a3··· 1 lines dropped: they arrived faster than they could be shown ···sidecar b-new",
  );
  expect(screen.getByRole("textbox").textContent).not.toContain("b1");
  expect(screen.getByRole("textbox").textContent).not.toContain("b2");
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

it("removes a superseded staged epoch before a third epoch becomes definitive", () => {
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
  act(() => void latest().listener.data([{ source: 0, time: 2, text: "stale" }]));
  const replacement = {
    ...first,
    instance: "fresh-run",
  };
  event({ ...ready, ready: false, sources: [replacement] });
  act(() => void latest().listener.data([{ source: 0, time: 3, text: "fresh" }]));
  event({ ...ready, sources: [replacement] });
  expect(opened).toHaveLength(before);
  expect(screen.getByRole("textbox").textContent).toBe("fresh");
  expect(screen.getByRole("textbox").textContent).not.toContain("stale");
});

it("keeps a changed epoch staged until its definitive source set arrives", () => {
  const first = { ...source, previous: true };
  mount();
  event({ ...ready, sources: [first] });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...ready, ready: false, sources: [first] });
  line("old");
  event({ ...ready, sources: [first] });
  const before = opened.length;

  event({ ...ready, ready: false, sources: [{ ...first, instance: "run-2" }] });
  line("new");
  expect(screen.getByRole("textbox").textContent).toBe("old");
  event({ ...ready, sources: [{ ...first, instance: "run-2" }] });
  expect(opened).toHaveLength(before);
  expect(screen.getByRole("textbox").textContent).toBe("new");
});

it("completes an exit-only epoch and ignores every later record for it", () => {
  const previousSource = { ...source, previous: true };
  const replayStatus = { ...ready, sources: [previousSource] };
  mount();
  event(replayStatus);
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...replayStatus, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "Completed, exit code 0", exited: true },
      ]),
  );
  event(replayStatus);
  const baseline = screen.getByRole("textbox").textContent;

  act(() => latest().listener.state?.("reconnecting"));
  event({ ...replayStatus, ready: false });
  act(
    () =>
      void latest().listener.data([
        { source: 0, time: 0, text: "duplicate", exited: true },
        { source: 0, time: 2, text: "late" },
      ]),
  );
  event(replayStatus);
  expect(screen.getByRole("textbox").textContent).toBe(baseline);
  expect(baseline).toContain("exited: Completed, exit code 0");
});

it("retains the complete baseline and status when a changed replay ends before definitive status", () => {
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
        { source: 0, time: 1, text: "a" },
        { source: 1, time: 2, text: "b" },
      ]),
  );
  event(replayStatus);
  const baseline = screen.getByRole("textbox").textContent;
  expect(screen.getByText(/could not be read/)).toBeDefined();

  act(() => latest().listener.state?.("reconnecting"));
  const changedSecond = { ...second, instance: "sidecar-run-2", error: "new error" };
  event({ ...replayStatus, ready: false, sources: [first, changedSecond] });
  act(() => latest().listener.end({ reason: "complete" }));
  expect(screen.getByRole("textbox").textContent).toBe(baseline);
  expect(screen.getByText(/previous runs of 1 containers could not be read/)).toBeDefined();
  expect(screen.getByTitle("baseline error")).toBeDefined();
  expect(screen.getByText(/ended before its changed source set was definitive/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});

it("retains a safe hidden previous handle and applies retention to its resumed suffix", async () => {
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
        { source: 0, time: 1, text: "a1" },
        { source: 1, time: 2, text: "b1" },
        { source: 0, time: 3, text: "a2" },
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
  act(() => void latest().listener.data([{ source: 0, time: 4, text: "a3" }]));
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 1 } }));
  expect(screen.getByRole("textbox").textContent).toContain("a3");
  act(() => publishPreference({ version: 1, logStreams: { maxLines: 3 } }));
  expect(screen.getByRole("textbox").textContent).toBe("constructor a3");
  view.unmount();
  expect(latest().close).toHaveBeenCalled();
  stopPreferences();
});

it("abandons a hidden previous handle when an in-flight gap reaches the paused boundary", async () => {
  const previousSource = { ...source, previous: true };
  const replayStatus = { ...ready, sources: [previousSource] };
  const view = mount();
  event(replayStatus);
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  event({ ...replayStatus, ready: false });
  act(() => void latest().listener.data([{ source: 0, time: 1, text: "kept" }]));
  event(replayStatus);

  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  const abandoned = latest();
  expect(abandoned.pause).toHaveBeenCalledOnce();
  act(() => abandoned.listener.gap({ bytes: 20, records: 2, sources: [{ id: 0, records: 2 }] }));
  act(() => abandoned.listener.state?.("paused"));
  expect(abandoned.close).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox").textContent).toContain("kept");
  expect(screen.getByRole("textbox").textContent).toContain("2 lines dropped");
  expect(screen.getByText(/ReplayIncomplete: .*could not resume safely/)).toBeDefined();

  abandoned.resume.mockClear();
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  expect(abandoned.resume).not.toHaveBeenCalled();
  act(() => void abandoned.listener.data([{ source: 0, time: 2, text: "late" }]));
  expect(screen.getByRole("textbox").textContent).not.toContain("late");
});

it("resumes a previous LogRun through SocketStream and LogCodec from the committed cursor", async () => {
  const wire = makeWireEngine();
  engine = wire.client;
  const wireSource = { ...source, id: 7, instance: "run-1", previous: true };
  const wireStatus = { ...ready, sources: [wireSource] };
  const serve = (
    socket: StreamSocket,
    id: number,
    history: readonly { time: bigint; text: string }[],
  ) => {
    const cursor = BigInt(
      ((socket.sent[0]?.params as LogStreamParams | undefined)?.resume?.[0]?.time as string) ?? "0",
    );
    socket.receive({
      type: "event",
      event: { ...wireStatus, ready: false, sources: [{ ...wireSource, id }] },
    });
    for (const record of history)
      if (record.time > cursor) socket.receive(wireFrame(id, 0, record.time, record.text));
    socket.receive({
      type: "event",
      event: { ...wireStatus, sources: [{ ...wireSource, id }] },
    });
  };
  const view = mount();
  await act(async () => {});
  const current = wire.sockets[1]!;
  act(() => {
    current.hello();
    current.receive({ type: "event", event: wireStatus });
  });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  await act(async () => {});

  const first = wire.sockets.at(-1)!;
  act(() => {
    first.hello();
    serve(first, 7, [
      { time: 1_000_000_000n, text: "one" },
      { time: 2_000_000_000n, text: "two" },
    ]);
  });
  expect(screen.getByRole("textbox").textContent).toBe("onetwo");

  act(() => first.close());
  await act(async () => vi.advanceTimersByTimeAsync(1));
  const resumed = wire.sockets[3]!;
  act(() => resumed.hello());
  expect(resumed.sent[0]?.params).toMatchObject({
    previous: true,
    resume: [
      {
        podUid: "uid",
        container: "constructor",
        instance: "run-1",
        time: "2000000000",
      },
    ],
  });
  // The available tail grew backwards, but the fake Engine honors the cursor
  // and sends only the suffix.
  act(() =>
    serve(resumed, 9, [
      { time: 500_000_000n, text: "zero" },
      { time: 1_000_000_000n, text: "one" },
      { time: 2_000_000_000n, text: "two" },
      { time: 3_000_000_000n, text: "three" },
    ]),
  );
  expect(screen.getByRole("textbox").textContent).toBe("onetwothree");

  act(() => resumed.close());
  await act(async () => vi.advanceTimersByTimeAsync(1));
  const resumedAgain = wire.sockets.at(-1)!;
  act(() => resumedAgain.hello());
  expect(resumedAgain.sent[0]?.params).toMatchObject({
    resume: [{ instance: "run-1", time: "3000000000" }],
  });
  // The available tail also moves forwards without changing what this handle
  // already owns.
  act(() =>
    serve(resumedAgain, 11, [
      { time: 2_000_000_000n, text: "two" },
      { time: 3_000_000_000n, text: "three" },
      { time: 4_000_000_000n, text: "four" },
    ]),
  );
  expect(screen.getByRole("textbox").textContent).toBe("onetwothreefour");

  view.unmount();
  wire.connection.close();
});

it("preserves staged rows through an early no-instance SocketStream and LogCodec status", async () => {
  const wire = makeWireEngine();
  engine = wire.client;
  const wireSource = { ...source, id: 7, instance: "run-1", previous: true };
  const wireStatus = { ...ready, sources: [wireSource] };
  const view = mount();
  await act(async () => {});
  act(() => {
    wire.sockets[1]!.hello();
    wire.sockets[1]!.receive({ type: "event", event: wireStatus });
  });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  await act(async () => {});

  const first = wire.sockets.at(-1)!;
  act(() => {
    first.hello();
    first.receive({ type: "event", event: { ...wireStatus, ready: false } });
    first.receive(wireFrame(7, 0, 1_000_000_000n, "prefix"));
    first.close();
  });
  await act(async () => vi.advanceTimersByTimeAsync(1));

  const resumed = wire.sockets.at(-1)!;
  act(() => resumed.hello());
  expect(resumed.sent[0]?.params).toMatchObject({
    previous: true,
    resume: [
      {
        podUid: "uid",
        container: "constructor",
        instance: "run-1",
        time: "1000000000",
      },
    ],
  });
  act(() => {
    resumed.receive({
      type: "event",
      event: {
        ...wireStatus,
        ready: false,
        sources: [{ ...wireSource, id: 9, instance: undefined }],
      },
    });
    resumed.receive({
      type: "event",
      event: { ...wireStatus, ready: false, sources: [{ ...wireSource, id: 9 }] },
    });
    resumed.receive(wireFrame(9, 0, 2_000_000_000n, "suffix"));
    resumed.receive({
      type: "event",
      event: { ...wireStatus, sources: [{ ...wireSource, id: 9 }] },
    });
  });
  expect(screen.getByRole("textbox").textContent).toBe("prefixsuffix");

  view.unmount();
  wire.connection.close();
});

it("ends a real previous LogRun with an untimed tail when its hidden socket pauses", async () => {
  const wire = makeWireEngine();
  engine = wire.client;
  const wireSource = { ...source, id: 7, instance: "run-1", previous: true };
  const wireStatus = { ...ready, sources: [wireSource] };
  const view = mount();
  await act(async () => {});
  act(() => {
    wire.sockets[1]!.hello();
    wire.sockets[1]!.receive({ type: "event", event: wireStatus });
  });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  await act(async () => {});
  const previous = wire.sockets.at(-1)!;
  act(() => {
    previous.hello();
    previous.receive({ type: "event", event: { ...wireStatus, ready: false } });
    previous.receive(wireFrame(7, 0, 1_000_000_000n, "timed"));
    previous.receive(wireFrame(7, 0, 0n, "untimed"));
    previous.receive({ type: "event", event: wireStatus });
  });
  expect(screen.getByRole("textbox").textContent).toBe("timeduntimed");

  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByText(/ReplayIncomplete: .*could not resume safely/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  expect(screen.getByRole("textbox").textContent).toBe("timeduntimed");
  const count = wire.sockets.length;
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(wire.sockets).toHaveLength(count);

  view.unmount();
  wire.connection.close();
});

it("ends a real previous LogRun when a source gap reaches its hidden paused boundary", async () => {
  const wire = makeWireEngine();
  engine = wire.client;
  const wireSource = { ...source, id: 7, instance: "run-1", previous: true };
  const wireStatus = { ...ready, sources: [wireSource] };
  const view = mount();
  await act(async () => {});
  act(() => {
    wire.sockets[1]!.hello();
    wire.sockets[1]!.receive({ type: "event", event: wireStatus });
  });
  fireEvent.click(screen.getByRole("button", { name: "Previous run" }));
  await act(async () => {});
  const previous = wire.sockets.at(-1)!;
  act(() => {
    previous.hello();
    previous.receive({ type: "event", event: { ...wireStatus, ready: false } });
    previous.receive(wireFrame(7, 0, 1_000_000_000n, "timed"));
    previous.receive(wireFrame(7, LogRecordFlagGap, 0n, ""));
    previous.receive({ type: "event", event: wireStatus });
  });
  const baseline = screen.getByRole("textbox").textContent;
  expect(baseline).toContain("timed");
  expect(baseline.match(/some lines may be missing/g)).toHaveLength(1);

  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} visible={false} />
    </EngineProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByText(/ReplayIncomplete: .*could not resume safely/)).toBeDefined();
  expect(screen.getByRole("textbox").textContent).toBe(baseline);
  const count = wire.sockets.length;
  view.rerender(
    <EngineProvider client={engine}>
      <LogStreamView {...props} />
    </EngineProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(wire.sockets).toHaveLength(count);

  view.unmount();
  wire.connection.close();
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
