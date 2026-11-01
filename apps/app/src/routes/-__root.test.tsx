// @vitest-environment jsdom

import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useOpenClusters } from "@/features/clusters/open-clusters.ts";
import { useSettingsFocusReturn } from "@/features/settings/focus-return.ts";

const workspace = vi.hoisted(() => ({ mounts: 0, unmounts: 0, nextInstance: 0 }));

vi.mock("@hukube/engine-client/react", () => ({ useConnectionState: () => "open" }));
vi.mock("@/features/clusters/cluster-tabs.tsx", () => ({
  ClusterTabs: () => {
    const active = useParams({ strict: false }).cluster;
    const navigate = useNavigate();
    return (
      <a
        href="/settings"
        aria-label="Settings"
        onClick={(event) => {
          event.preventDefault();
          void navigate({
            to: "/settings",
            search: { category: "appearance", ...(active ? { fromCluster: active } : {}) },
          });
        }}
      >
        Settings
      </a>
    );
  },
}));
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
          <span data-testid={`workspace-${cluster}-instance`}>instance {instance}</span>
          <button className="focus-visible:outline" type="button">
            {cluster} control
          </button>
          <div role="tablist" aria-label="Facets">
            <button className="focus-visible:outline" type="button" role="tab" aria-selected="true">
              Logs
            </button>
          </div>
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

function SettingsPage({ fromCluster }: { fromCluster: string }) {
  const ids = useOpenClusters((state) => state.ids);
  const navigate = useNavigate();
  const requestFocusReturn = useSettingsFocusReturn();
  const returnsToCluster = ids.includes(fromCluster);
  return (
    <a
      href={returnsToCluster ? `/c/${fromCluster}` : "/"}
      onClick={(event) => {
        event.preventDefault();
        if (returnsToCluster) {
          requestFocusReturn?.(fromCluster);
          void navigate({ to: "/c/$cluster", params: { cluster: fromCluster } });
        } else {
          void navigate({ to: "/" });
        }
      }}
    >
      {returnsToCluster ? `Back to ${fromCluster}` : "Back to clusters"}
    </a>
  );
}

async function mountRoot(ids: string[] = ["dev"], initialEntry = "/c/dev") {
  useOpenClusters.setState({ ids });
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
    component: () => <SettingsPage fromCluster="dev" />,
  });
  const router = createRouter({
    routeTree: Route.addChildren([clusters, cluster, settings]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await act(async () => {});
  return router;
}

async function openSettingsAndReturn(activationDetail: number) {
  const openSettings = screen.getByRole("link", { name: "Settings" });
  let reachedSettingsByKeyboard = false;
  if (activationDetail > 0) {
    fireEvent.pointerDown(openSettings);
  } else {
    const from = document.activeElement;
    const tabStops = [
      ...document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]"),
    ].filter((element) => element.tabIndex >= 0 && !element.matches(":disabled"));
    const previous =
      tabStops[(tabStops.indexOf(from as HTMLElement) - 1 + tabStops.length) % tabStops.length];
    fireEvent.keyDown(from ?? document.body, { key: "Tab", shiftKey: true });
    previous?.focus();
    fireEvent.keyUp(previous ?? document.body, { key: "Tab", shiftKey: true });
    reachedSettingsByKeyboard = document.activeElement === openSettings;
  }
  fireEvent.click(openSettings, { detail: activationDetail });
  const back = await screen.findByRole("link", { name: "Back to dev" });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
  back.focus();
  fireEvent.keyUp(back, { key: "Tab" });
  fireEvent.click(back, { detail: 0 });
  await act(async () => {});
  return reachedSettingsByKeyboard;
}

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
  expect(screen.getByTestId("workspace-dev-instance").textContent).toBe("instance 1");
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

it("restores the focused Workspace control after pointer-open and keyboard Back", async () => {
  await mountRoot();

  const original = screen.getByRole("button", { name: "dev control" });
  original.focus();
  expect(document.activeElement).toBe(original);

  await openSettingsAndReturn(1);

  expect(document.activeElement).toBe(original);
  expect(original.className).toContain("focus-visible:outline");
});

it("keeps the preceding Workspace control when Settings is reached and activated by keyboard", async () => {
  await mountRoot();
  const original = screen.getByRole("button", { name: "dev control" });
  original.focus();

  const reachedSettingsByKeyboard = await openSettingsAndReturn(0);

  expect(reachedSettingsByKeyboard).toBe(true);
  expect(document.activeElement).toBe(original);
  expect(original.className).toContain("focus-visible:outline");
});

it("uses the selected Logs Facet when the previous Workspace control becomes disabled", async () => {
  await mountRoot();
  const original = screen.getByRole("button", { name: "dev control" });
  original.focus();
  const openSettings = screen.getByRole("link", { name: "Settings" });
  fireEvent.click(openSettings);
  original.setAttribute("disabled", "");
  const back = await screen.findByRole("link", { name: "Back to dev" });
  back.focus();
  fireEvent.click(back, { detail: 0 });
  await act(async () => {});

  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Logs" }));
  expect(document.activeElement?.className).toContain("focus-visible:outline");
  expect(document.activeElement).not.toBe(original);
});

it("does not focus a stale Workspace when its originating Cluster closes in Settings", async () => {
  await mountRoot(["dev", "prod"]);
  const stale = screen.getByRole("button", { name: "dev control" });
  stale.focus();
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  await act(async () => useOpenClusters.setState({ ids: ["prod"] }));

  const back = await screen.findByRole("link", { name: "Back to clusters" });
  back.focus();
  fireEvent.click(back, { detail: 0 });
  await act(async () => {});

  expect(screen.getByText("Cluster picker")).toBeDefined();
  expect(document.activeElement).not.toBe(stale);
  expect(document.activeElement).not.toBe(
    screen.getByTestId("workspace-prod").querySelector('[role="tab"]'),
  );
});

it("does not steal focus during an ordinary Cluster switch", async () => {
  const router = await mountRoot(["dev", "prod"]);
  const settings = screen.getByRole("link", { name: "Settings" });
  settings.focus();

  await act(async () => {
    await router.navigate({ to: "/c/$cluster", params: { cluster: "prod" } });
  });

  expect(document.activeElement).toBe(settings);
  expect(screen.getByRole("region", { name: "prod Workspace" }).getAttribute("data-active")).toBe(
    "true",
  );
});
