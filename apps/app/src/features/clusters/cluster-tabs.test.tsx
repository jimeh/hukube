// @vitest-environment jsdom

import type { Host } from "@hukube/host";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { HostProvider } from "@/lib/host.tsx";
import { validateSettingsSearch } from "@/routes/settings.tsx";

import { ClusterTabs } from "./cluster-tabs.tsx";
import { useOpenClusters } from "./open-clusters.ts";

const host: Host = {
  kind: "web",
  engine: () => Promise.resolve({ url: "http://localhost", token: "test" }),
  openWindow: vi.fn<(path: string) => void>(),
  openExternal: vi.fn<(url: string) => void>(),
  reportOpenWork: vi.fn<(work: { edits: number; sessions: number }) => void>(),
};

beforeEach(() => {
  window.scrollTo = () => {};
  sessionStorage.clear();
  useOpenClusters.setState({ ids: ["dev"] });
});
afterEach(() => cleanup());

async function mountTabs(initialEntry: string) {
  const root = createRootRoute({
    component: () => (
      <HostProvider host={host}>
        <ClusterTabs />
        <Outlet />
      </HostProvider>
    ),
  });
  const cluster = createRoute({
    getParentRoute: () => root,
    path: "/c/$cluster",
    component: () => null,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    validateSearch: validateSettingsSearch,
    component: () => null,
  });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, cluster, settings]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await act(async () => {});
  return router;
}

it("keeps the active Settings search and native link navigation semantics", async () => {
  const router = await mountTabs("/settings?category=logs&fromCluster=dev");
  const link = screen.getByRole("link", { name: "Settings" });
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(link.getAttribute("href")).toBe("/settings?category=logs&fromCluster=dev");
  const indexBefore = Reflect.get(router.history.location.state, "__TSR_index");

  const routerPrevented: boolean[] = [];
  const stopBrowserNavigation = (event: MouseEvent) => {
    routerPrevented.push(event.defaultPrevented);
    event.preventDefault();
  };
  link.addEventListener("click", stopBrowserNavigation);
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(link, { button: 1 });
  link.removeEventListener("click", stopBrowserNavigation);
  expect(routerPrevented).toEqual([false, false]);
  expect(router.state.location.search).toEqual({ category: "logs", fromCluster: "dev" });

  fireEvent.click(link, { detail: 0 });
  await act(async () => {});
  expect(router.state.location.search).toEqual({ category: "logs", fromCluster: "dev" });
  expect(Reflect.get(router.history.location.state, "__TSR_index")).toBe(indexBefore);
});

it("opens Settings from a Workspace on Appearance with its return Cluster", async () => {
  await mountTabs("/c/dev");
  const link = screen.getByRole("link", { name: "Settings" });
  expect(link.getAttribute("href")).toBe("/settings?category=appearance&fromCluster=dev");
  expect(link.hasAttribute("aria-current")).toBe(false);
});
