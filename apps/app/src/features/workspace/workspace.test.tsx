// @vitest-environment jsdom
import type { StreamListener, SubscriptionListener, Setting } from "@hukube/engine-client";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useEffectEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Workspace } from "./workspace.tsx";
import { detachClusterSessions, startSession, useExecSessions } from "../exec/sessions.ts";
import { fakeTerminal } from "../exec/test-terminal.ts";

const mocks = vi.hoisted(() => ({
  watch: undefined as SubscriptionListener<Setting> | undefined,
  added: new Set<(panel: { id: string; params: unknown }) => void>(),
  removed: new Set<(panel: { id: string }) => void>(),
  panels: [] as { id: string; params: unknown }[],
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
    return { close: () => {}, write: () => {}, resize: () => {} };
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
            const panel = { id: `exec:${id}`, params: params(id) };
            mocks.panels.push(panel);
            for (const fn of mocks.added) fn(panel);
          }
        },
        toJSON: () => ({}),
        clear: () => {},
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
  mocks.streams = [];
  mocks.terminals = [];
  mocks.added.clear();
  mocks.removed.clear();
  mocks.request.mockClear();
});

it("attaches every restored Tab including a hidden panel, without starting or attaching twice", async () => {
  // A newly opened Tab already has an entry before dockview adds it.
  await startSession(engine as never, "c", params("visible"), async () => fakeTerminal().terminal);
  render(<Workspace cluster="c" active />);
  act(() => mocks.watch!.data({ key: "workspace/c", value: { version: 1, dockview: {} } }));
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

it("ends a removed session Tab but detaches before dockview removes panels on Workspace unmount", async () => {
  const view = render(<Workspace cluster="c" active />);
  act(() => mocks.watch!.data({ key: "workspace/c", value: { version: 1, dockview: {} } }));
  await vi.waitFor(() => expect(mocks.streams).toHaveLength(2));
  act(() => {
    for (const fn of mocks.removed) fn({ id: "exec:visible" });
  });
  expect(mocks.request).toHaveBeenCalledWith("exec.end", { cluster: "c", session: "visible" });
  view.unmount();
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(useExecSessions.getState().entries.size).toBe(0);
});
