// @vitest-environment jsdom
import type { StreamListener, SubscriptionListener, Setting } from "@hukube/engine-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useEffectEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelTab } from "./panel-tab.tsx";
import { WorkspaceContext } from "./workspace-context.tsx";
import { useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { Workspace } from "./workspace.tsx";
import { detachClusterSessions, startSession, useExecSessions } from "../exec/sessions.ts";
import { readSessionTabs, rememberSessionTab } from "../exec/window-tabs.ts";
import { fakeTerminal } from "../exec/test-terminal.ts";

const mocks = vi.hoisted(() => ({
  addOptions: [] as {
    inactive: boolean;
    params: { preview: boolean };
    position: { referenceGroup: { id: string } };
  }[],
  broken: false,
  closes: [] as ReturnType<typeof vi.fn>[],
  watch: undefined as SubscriptionListener<Setting> | undefined,
  added: new Set<(panel: { id: string; params: unknown; api: { title: string } }) => void>(),
  removed: new Set<(panel: { id: string }) => void>(),
  panels: [] as { id: string; params: unknown; api: { title: string } }[],
  streams: [] as { params: Record<string, unknown>; listener: StreamListener<"pod.exec"> }[],
  request: vi.fn<(...args: unknown[]) => Promise<undefined>>(() => Promise.resolve(undefined)),
  terminals: [] as ReturnType<typeof fakeTerminal>[],
}));
const params = (sessionId: string) => ({
  sessionId,
  namespace: "ns",
  pod: "web",
  uid: "uid",
  container: "app",
});
const engine = {
  request: mocks.request,
  subscribe: (_method: string, _params: unknown, listener: SubscriptionListener<Setting>) => {
    mocks.watch = listener;
    return { close: () => {} };
  },
  openStream: (
    _method: string,
    streamParams: Record<string, unknown>,
    listener: StreamListener<"pod.exec">,
  ) => {
    mocks.streams.push({ params: streamParams, listener });
    const close = vi.fn<() => void>();
    mocks.closes.push(close);
    return { close, write: () => {}, resize: () => {} };
  },
  onStateChange: () => () => {},
  getState: () => "open",
};
vi.mock("@hukube/engine-client/react", () => ({
  useEngine: () => engine,
  useSubscription: () => ({ data: undefined }),
}));
vi.mock("@/lib/xterm.ts", () => ({
  createExecTerminal: () => {
    const fake = fakeTerminal();
    mocks.terminals.push(fake);
    return fake.terminal;
  },
}));
vi.mock("@/features/resource-list/resource-list-panel.tsx", () => ({
  ResourceListPanel: () => null,
}));
vi.mock("@/features/resource/resource-panel.tsx", () => ({ ResourcePanel: () => null }));
vi.mock("@/features/resource-types/type-sidebar.tsx", () => ({ TypeSidebar: () => null }));
vi.mock("@/features/go-to-resource/go-to-resource.tsx", () => ({ GoToResource: () => null }));
vi.mock("./status-bar.tsx", () => ({ StatusBar: () => null }));
vi.mock("dockview-react", () => ({
  DockviewReact: ({ onReady }: { onReady: (event: unknown) => void }) => {
    const ready = useEffectEvent(onReady);
    useEffect(() => {
      const register = <T,>(set: Set<T>, fn: T) => {
        set.add(fn);
        return { dispose: () => set.delete(fn) };
      };
      const api = {
        get panels() {
          return mocks.panels;
        },
        fromJSON: () => {
          for (const id of ["visible", "hidden"]) {
            const panel = { id: `exec:${id}`, params: params(id), api: { title: id } };
            mocks.panels.push(panel);
            for (const fn of mocks.added) fn(panel);
          }
          if (mocks.broken) throw new Error("invalid layout");
        },
        activeGroup: { id: "active-pane" },
        groups: [{ id: "first-pane" }],
        getPanel: (id: string) => mocks.panels.find((panel) => panel.id === id),
        addPanel: (options: (typeof mocks.addOptions)[number] & { id: string; title: string }) => {
          mocks.addOptions.push(options);
          const panel = { ...options, api: { title: options.title } };
          mocks.panels.push(panel);
          for (const fn of mocks.added) fn(panel);
        },
        toJSON: () => ({}),
        clear: () => {
          for (const panel of mocks.panels) for (const fn of mocks.removed) fn(panel);
          mocks.panels = [];
        },
        onDidAddPanel: (fn: typeof mocks.added extends Set<infer T> ? T : never) =>
          register(mocks.added, fn),
        onDidRemovePanel: (fn: typeof mocks.removed extends Set<infer T> ? T : never) =>
          register(mocks.removed, fn),
        onDidLayoutChange: () => ({ dispose: () => {} }),
        onDidActivePanelChange: () => ({ dispose: () => {} }),
      };
      ready({ api });
      return () => {
        for (const panel of mocks.panels) for (const fn of mocks.removed) fn(panel);
      };
    }, []);
    return null;
  },
}));
afterEach(() => {
  cleanup();
  detachClusterSessions("c");
  mocks.panels = [];
  mocks.broken = false;
  mocks.closes = [];
  useUnsavedEdits.getState().dismiss();
  mocks.addOptions = [];
  mocks.streams = [];
  mocks.terminals = [];
  mocks.added.clear();
  mocks.removed.clear();
  mocks.request.mockClear();
  sessionStorage.clear();
});

it("attaches every restored Tab including a hidden panel, without starting or attaching twice", async () => {
  // A newly opened Tab already has an entry before dockview adds it.
  await startSession(engine as never, "c", params("visible"), async () => fakeTerminal().terminal);
  render(<Workspace cluster="c" active />);
  act(() =>
    mocks.watch!.data({ revision: "", key: "workspace/c", value: { version: 1, dockview: {} } }),
  );
  await vi.waitFor(() => expect(mocks.streams).toHaveLength(2));
  expect(mocks.streams[0]!.params).toMatchObject({ session: "visible", start: true });
  expect(mocks.streams[1]!.params).toMatchObject({ session: "hidden" });
  expect(mocks.streams[1]!.params).not.toHaveProperty("start");
  mocks.streams[1]!.listener.end({
    reason: "error",
    error: { code: "not_found", reason: "SessionGone", message: "gone" },
  });
  await vi.waitFor(() =>
    expect(useExecSessions.getState().entries.get("hidden")?.state.phase).toBe("gone"),
  );
  expect(mocks.streams).toHaveLength(2);
});

it("detaches held sessions on a failed layout clear and keeps their window records", async () => {
  await startSession(engine as never, "c", params("visible"), async () => fakeTerminal().terminal);
  mocks.broken = true;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const view = render(<Workspace cluster="c" active />);
  act(() =>
    mocks.watch!.data({ revision: "", key: "workspace/c", value: { version: 1, dockview: {} } }),
  );
  expect(mocks.request).not.toHaveBeenCalledWith("exec.end", expect.anything());
  expect(readSessionTabs("c").map((tab) => tab.params.sessionId)).toEqual(["visible", "hidden"]);
  await vi.waitFor(() => expect(mocks.streams).toHaveLength(3));
  expect(mocks.closes[0]).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalledWith("exec.end", expect.anything());
  expect(readSessionTabs("c").map((tab) => tab.params.sessionId)).toEqual(["visible", "hidden"]);
  view.unmount();
  expect(mocks.request).not.toHaveBeenCalledWith("exec.end", expect.anything());
  warning.mockRestore();
});

it.each(["button", "middle click"])(
  "ends a held session once after its %s close is confirmed",
  async (action) => {
    await startSession(
      engine as never,
      "c",
      params("visible"),
      async () => fakeTerminal().terminal,
    );
    rememberSessionTab("c", { params: params("visible"), title: "visible" });
    const close = vi.fn<() => void>(() => {
      for (const fn of mocks.removed) fn({ id: "exec:visible" });
    });
    const api = {
      id: "exec:visible",
      title: "visible",
      close,
      onDidActiveChange: () => ({ dispose: () => {} }),
      onDidTitleChange: () => ({ dispose: () => {} }),
    } as unknown as Parameters<typeof PanelTab>[0]["api"];
    const props = { api, params: {} } as Parameters<typeof PanelTab>[0];
    const view = render(
      <WorkspaceContext value={{ cluster: "c" } as never}>
        <PanelTab {...props} />
      </WorkspaceContext>,
    );
    if (action === "button") fireEvent.click(screen.getByRole("button", { name: "Close visible" }));
    else
      fireEvent(
        view.container.firstElementChild!,
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    expect(mocks.request).not.toHaveBeenCalled();
    expect(readSessionTabs("c")).toHaveLength(1);
    act(() => useUnsavedEdits.getState().guard!.proceed());
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("exec.end", {
      cluster: "c",
      session: "visible",
    });
    expect(mocks.closes[0]).toHaveBeenCalledOnce();
    expect(readSessionTabs("c")).toEqual([]);
  },
);

it("recovers this window's missing session Tab after the shared layout restores, without start", async () => {
  rememberSessionTab("c", { params: params("local"), title: "My session" });
  const view = render(<Workspace cluster="c" active />);
  expect(mocks.panels).toHaveLength(0);
  act(() =>
    mocks.watch!.data({ revision: "", key: "workspace/c", value: { version: 1, dockview: {} } }),
  );
  await vi.waitFor(() => expect(mocks.streams).toHaveLength(3));
  expect(mocks.panels.find((panel) => panel.id === "exec:local")?.api.title).toBe("My session");
  expect(mocks.addOptions).toMatchObject([
    {
      inactive: true,
      params: { preview: false },
      position: { referenceGroup: { id: "active-pane" } },
    },
  ]);
  expect(mocks.streams.every((stream) => !("start" in stream.params))).toBe(true);
  act(() => {
    for (const fn of mocks.removed) fn({ id: "exec:local" });
  });
  expect(readSessionTabs("c").map((tab) => tab.params.sessionId)).toContain("local");
  view.unmount();
  expect(readSessionTabs("c").map((tab) => tab.params.sessionId)).toEqual([
    "visible",
    "hidden",
    "local",
  ]);
  mocks.panels = [];
  mocks.addOptions = [];
  mocks.streams = [];
  render(<Workspace cluster="c" active />);
  act(() =>
    mocks.watch!.data({ revision: "", key: "workspace/c", value: { version: 1, dockview: {} } }),
  );
  await vi.waitFor(() => expect(mocks.streams).toHaveLength(3));
  expect(mocks.panels.some((panel) => panel.id === "exec:local")).toBe(true);
});

it.each(["broken JSON", "null", "{}", '[null, {"title": "bad", "params": {"sessionId": "bad"}}]'])(
  "ignores malformed window-local storage: %s",
  async (stored) => {
    sessionStorage.setItem("hukube.exec.tabs/c", stored);
    expect(readSessionTabs("c")).toEqual([]);
    render(<Workspace cluster="c" active />);
    act(() =>
      mocks.watch!.data({ revision: "", key: "workspace/c", value: { version: 1, dockview: {} } }),
    );
    await vi.waitFor(() => expect(mocks.streams).toHaveLength(2));
    expect(mocks.panels).toHaveLength(2);
  },
);

it("normalizes untrusted params and keeps hostile names safe and Clusters separate", () => {
  const entry = {
    params: {
      ...params("constructor"),
      pod: "__proto__",
      container: "constructor",
      start: true,
      takeover: true,
      command: ["unsafe"],
      preview: true,
    },
    title: "Local",
  };
  sessionStorage.setItem("hukube.exec.tabs/c", JSON.stringify([entry, entry]));
  expect(readSessionTabs("c")).toEqual([
    {
      title: "Local",
      params: {
        ...params("constructor"),
        pod: "__proto__",
        container: "constructor",
        preview: false,
      },
    },
  ]);
  expect(readSessionTabs("other")).toEqual([]);
});
