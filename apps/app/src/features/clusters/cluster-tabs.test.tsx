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

async function setup() {
  const settings = vi.fn<(section: string, origin: Origin) => void>();
  commands.configure({
    route: "/",
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
        <input aria-label="Origin" />
      </HostProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const appearance = createRoute({ getParentRoute: () => root, path: "/settings/$section" });
  const router = createRouter({
    routeTree: root.addChildren([index, appearance]),
    history: createMemoryHistory(),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return { settings, router, link: screen.getByRole("link", { name: "Settings" }) };
}

it("keeps an href and routes a primary click through the command with its pre-pointer focus origin", async () => {
  const { link, settings, router } = await setup();
  expect(link.getAttribute("href")).toBe("/settings/appearance");
  const origin = screen.getByRole("textbox", { name: "Origin" });
  origin.focus();
  fireEvent.pointerDown(link, { button: 0 });
  link.focus();
  fireEvent.click(link, { button: 0, detail: 1 });
  expect(settings).toHaveBeenCalledExactlyOnceWith(
    "appearance",
    expect.objectContaining({ element: origin, route: "/" }),
  );
  expect(router.state.location.pathname).toBe("/");
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
