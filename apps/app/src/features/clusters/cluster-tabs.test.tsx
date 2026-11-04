// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createBrowserHost } from "@hukube/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { WorkspaceValue } from "../workspace/workspace-context.tsx";
import { HostProvider } from "@/lib/host.tsx";
import { commands, type Origin } from "../commands/runtime.ts";
import { compileKeymap, emptyDocument } from "../commands/keyboard.ts";
import { ClusterTabs } from "./cluster-tabs.tsx";

vi.mock("../settings/store.ts", () => ({
  usePreferences: () => ({
    store: {},
    snapshot: { loaded: true, fresh: true, drafts: {}, unconfirmed: [] },
  }),
}));
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(route = "/") {
  const settings = vi.fn<(section: string, origin: Origin) => void>();
  commands.configure({
    route,
    platform: "linux",
    host: "web",
    connection: "open",
    modalCount: 0,
    map: compileKeymap(emptyDocument, "linux"),
    preferencesReady: () => true,
    preference: () => {},
    settings,
  });
  const root = createRootRoute({
    component: () => (
      <HostProvider host={createBrowserHost()}>
        <ClusterTabs />
        <div data-command-panel="p">
          <input aria-label="Origin" />
        </div>
      </HostProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const workspace = createRoute({ getParentRoute: () => root, path: "/c/$cluster" });
  const appearance = createRoute({ getParentRoute: () => root, path: "/settings/$section" });
  const router = createRouter({
    routeTree: root.addChildren([index, workspace, appearance]),
    history: createMemoryHistory({ initialEntries: [route] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return { settings, router, link: screen.getByRole("link", { name: "Settings" }) };
}

it("keeps an href and returns the Settings link through the validated primary-pointer handoff", async () => {
  const { link, settings, router } = await setup();
  expect(link.getAttribute("href")).toBe("/settings/appearance");
  const origin = screen.getByRole("textbox", { name: "Origin" });
  origin.focus();
  fireEvent.pointerDown(link, { button: 0 });
  link.focus();
  fireEvent.click(link, { button: 0, detail: 1 });
  expect(settings).toHaveBeenCalledExactlyOnceWith(
    "appearance",
    expect.objectContaining({ element: link, route: "/" }),
  );
  expect(router.state.location.pathname).toBe("/");
});

it("preserves pre-pointer Workspace, panel, Pane, params and Resource identity when returning to the link", async () => {
  const { link, settings } = await setup("/c/c");
  const input = screen.getByRole("textbox", { name: "Origin" });
  const panel = { id: "p", group: {}, params: { uri: "original" } } as unknown as IDockviewPanel;
  const peer = { id: "peer", group: {}, params: {} } as unknown as IDockviewPanel;
  const api = { activePanel: panel, getPanel: (id: string) => (id === "p" ? panel : peer) };
  const unregisterWorkspace = commands.registerWorkspace("c", {
    token: {},
    value: { active: true, cluster: "c" } as WorkspaceValue,
    api: api as DockviewApi,
  });
  const unregisterSurface = commands.registerSurface({
    element: input,
    read: () => ({ kind: "resource", uid: "original-uid" }),
  });
  vi.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  try {
    input.focus();
    const captured = commands.capture();
    expect(captured.resourceUid).toBe("original-uid");
    fireEvent.pointerDown(link, { button: 0 });
    api.activePanel = peer;
    link.focus();
    fireEvent.click(link, { button: 0, detail: 1 });
    expect(settings).toHaveBeenCalledExactlyOnceWith("appearance", { ...captured, element: link });
    // Exercise the return owner's callback boundary with the element it receives.
    settings.mock.calls[0]![1].element?.focus();
    expect(document.activeElement).toBe(link);
  } finally {
    unregisterSurface();
    unregisterWorkspace();
  }
});

it("uses the link for a primary click without a preceding pointer event", async () => {
  const { link, settings } = await setup();
  screen.getByRole("textbox", { name: "Origin" }).focus();
  fireEvent.click(link, { button: 0, detail: 1 });
  expect(settings).toHaveBeenCalledExactlyOnceWith(
    "appearance",
    expect.objectContaining({ element: link }),
  );
});

it("refuses a pre-pointer origin whose route changed before activation", async () => {
  const { link, settings, router } = await setup();
  fireEvent.pointerDown(link, { button: 0 });
  await act(async () => {
    await router.navigate({ to: "/c/$cluster", params: { cluster: "c" } });
  });
  commands.configure({
    route: "/c/c",
    platform: "linux",
    host: "web",
    connection: "open",
    modalCount: 0,
    map: compileKeymap(emptyDocument, "linux"),
    preferencesReady: () => true,
    preference: () => {},
    settings,
  });
  fireEvent.click(link, { button: 0, detail: 1 });
  expect(settings).not.toHaveBeenCalled();
  expect(commands.getSnapshot().error).toContain("captured target changed");
});

it("captures the focused link for keyboard activation and revalidates before dispatch", async () => {
  const { link, settings } = await setup();
  const origin = screen.getByRole("textbox", { name: "Origin" });
  origin.focus();
  fireEvent.pointerDown(link);
  link.focus();
  fireEvent.click(link, { button: 0, detail: 0 });
  expect(settings).toHaveBeenCalledExactlyOnceWith(
    "appearance",
    expect.objectContaining({ element: link }),
  );
  settings.mockClear();
  commands.configure({
    route: "/",
    platform: "linux",
    host: "web",
    connection: "outdated",
    modalCount: 0,
    map: compileKeymap(emptyDocument, "linux"),
    preferencesReady: () => true,
    preference: () => {},
    settings,
  });
  fireEvent.click(link);
  expect(settings).not.toHaveBeenCalled();
});

it.each([
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
])("preserves native modified/middle activation without dispatching: %j", async (extra) => {
  const { link, settings, router } = await setup();
  // Observe the browser default at the window boundary, then suppress jsdom's
  // unimplemented new-tab navigation. React and the real router run first.
  let prevented: boolean | undefined;
  const observe = (event: MouseEvent) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("click", observe, { once: true });
  fireEvent.click(link, { button: 0, detail: 1, ...extra });
  expect(prevented).toBe(false);
  expect(settings).not.toHaveBeenCalled();
  expect(router.state.location.pathname).toBe("/");
});
