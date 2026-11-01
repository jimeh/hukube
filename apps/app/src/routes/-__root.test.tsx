// @vitest-environment jsdom

import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useOpenClusters } from "@/features/clusters/open-clusters.ts";

const workspace = vi.hoisted(() => ({ mounts: 0, unmounts: 0, nextInstance: 0 }));

vi.mock("@hukube/engine-client/react", () => ({ useConnectionState: () => "open" }));
vi.mock("@/features/clusters/cluster-tabs.tsx", () => ({ ClusterTabs: () => null }));
vi.mock("@/features/connection/out-of-date-notice.tsx", () => ({
  OutOfDateNotice: () => null,
}));
vi.mock("@/features/edit/unsaved-guard.tsx", () => ({ UnsavedGuard: () => null }));
vi.mock("@/features/settings/preferences.ts", () => ({
  PreferencesController: () => <div data-testid="preference-controller" />,
}));
vi.mock("@/features/workspace/workspace.tsx", async () => {
  const { useEffect, useState } = await import("react");
  return {
    Workspace: ({ cluster, active }: { cluster: string; active: boolean }) => {
      const [instance] = useState(() => ++workspace.nextInstance);
      useEffect(() => {
        workspace.mounts++;
        return () => {
          workspace.unmounts++;
        };
      }, []);
      return (
        <div data-testid={`workspace-${cluster}`} data-active={String(active)}>
          instance {instance}
        </div>
      );
    },
  };
});

import { Route } from "./__root.tsx";

beforeEach(() => {
  workspace.mounts = 0;
  workspace.unmounts = 0;
  workspace.nextInstance = 0;
  useOpenClusters.setState({ ids: ["dev"] });
  window.scrollTo = () => {};
});

afterEach(() => cleanup());

it("keeps each Workspace and the preference controller mounted while Settings is active", async () => {
  const clusters = createRoute({
    getParentRoute: () => Route,
    path: "/",
    component: () => <div>Cluster picker</div>,
  });
  const cluster = createRoute({
    getParentRoute: () => Route,
    path: "/c/$cluster",
    component: () => null,
  });
  const settings = createRoute({
    getParentRoute: () => Route,
    path: "/settings",
    component: () => <div>Settings page</div>,
  });
  const router = createRouter({
    routeTree: Route.addChildren([clusters, cluster, settings]),
    history: createMemoryHistory({ initialEntries: ["/c/dev"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await act(async () => {});

  const original = screen.getByTestId("workspace-dev");
  expect(original.textContent).toBe("instance 1");
  expect(original.getAttribute("data-active")).toBe("true");
  expect(workspace.mounts).toBe(1);

  await act(async () => {
    await router.navigate({ to: "/settings", search: { category: "appearance" } });
  });
  expect(screen.getByText("Settings page")).toBeDefined();
  expect(screen.getByTestId("workspace-dev")).toBe(original);
  expect(original.getAttribute("data-active")).toBe("false");
  expect(original.parentElement?.hasAttribute("hidden")).toBe(true);
  expect(screen.getByTestId("preference-controller")).toBeDefined();
  expect(workspace.mounts).toBe(1);
  expect(workspace.unmounts).toBe(0);

  await act(async () => {
    await router.navigate({ to: "/c/$cluster", params: { cluster: "dev" } });
  });
  expect(screen.getByTestId("workspace-dev")).toBe(original);
  expect(original.getAttribute("data-active")).toBe("true");
  expect(workspace.mounts).toBe(1);
  expect(workspace.unmounts).toBe(0);
});
