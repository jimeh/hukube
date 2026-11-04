// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";

const state = vi.hoisted(() => ({
  pathname: "/c/alpha",
  cluster: "alpha" as string | undefined,
  connection: "open",
  mounts: [] as string[],
  unmounts: [] as string[],
}));

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: unknown) => ({ options }),
  useLocation: () => ({ pathname: state.pathname }),
  useParams: () => ({ cluster: state.cluster }),
  Outlet: () => null,
}));
vi.mock("@hukube/engine-client/react", () => ({
  useConnectionState: () => state.connection,
}));
vi.mock("@/features/clusters/open-clusters.ts", () => ({
  useOpenClusters: () => ["alpha", "beta"],
}));
vi.mock("@/features/workspace/workspace.tsx", () => ({
  Workspace: ({ cluster, active }: { cluster: string; active: boolean }) => {
    useEffect(() => {
      state.mounts.push(cluster);
      return () => {
        state.unmounts.push(cluster);
      };
    }, [cluster]);
    return <section data-testid={cluster} data-active={active} />;
  },
}));
vi.mock("@/features/settings/settings-page.tsx", () => ({
  SettingsPage: ({ visible }: { visible: boolean }) => (
    <section aria-label="App Settings" hidden={!visible} />
  ),
  rememberSettingsOrigin: vi.fn<(pathname: string, origin?: HTMLElement) => void>(),
}));
vi.mock("@/features/settings/preference-runtime.tsx", () => ({ PreferenceRuntime: () => null }));
vi.mock("@/features/commands/command-runtime.tsx", () => ({ CommandRuntime: () => null }));
vi.mock("@/features/edit/unsaved-guard.tsx", () => ({ UnsavedGuard: () => null }));
vi.mock("@/features/clusters/cluster-tabs.tsx", () => ({ ClusterTabs: () => null }));
vi.mock("@/features/connection/out-of-date-notice.tsx", () => ({ OutOfDateNotice: () => null }));

import { Route } from "./__root.tsx";

const RootLayout = Route.options.component!;

afterEach(() => {
  cleanup();
  state.pathname = "/c/alpha";
  state.cluster = "alpha";
  state.connection = "open";
  state.mounts = [];
  state.unmounts = [];
});

function expectWorkspace(id: string, visible: boolean, active = visible) {
  const workspace = screen.getByTestId(id);
  expect(workspace.parentElement!.hidden).toBe(!visible);
  expect(workspace.getAttribute("data-active")).toBe(String(active));
  return workspace;
}

it("hides and deactivates mounted Workspaces when Settings pathname precedes Cluster params", () => {
  const view = render(<RootLayout />);
  const alpha = expectWorkspace("alpha", true);
  const beta = expectWorkspace("beta", false);

  state.pathname = "/settings/appearance";
  view.rerender(<RootLayout />);
  expect(screen.getByRole("region", { name: "App Settings" })).toBeTruthy();
  expectWorkspace("alpha", false);
  expectWorkspace("beta", false);

  state.cluster = undefined;
  view.rerender(<RootLayout />);
  expectWorkspace("alpha", false);

  state.pathname = "/c/alpha";
  state.cluster = "alpha";
  view.rerender(<RootLayout />);
  expectWorkspace("alpha", true);
  expectWorkspace("beta", false);
  expect(screen.getByTestId("alpha")).toBe(alpha);
  expect(screen.getByTestId("beta")).toBe(beta);
  expect(screen.queryByRole("region", { name: "App Settings" })).toBeNull();
  expect(state.mounts).toEqual(["alpha", "beta"]);
  expect(state.unmounts).toEqual([]);
});

it("switches mounted Workspaces and hides all of them without an active Cluster", () => {
  const view = render(<RootLayout />);
  const alpha = expectWorkspace("alpha", true);
  const beta = expectWorkspace("beta", false);

  state.pathname = "/c/beta";
  state.cluster = "beta";
  view.rerender(<RootLayout />);
  expectWorkspace("alpha", false);
  expectWorkspace("beta", true);

  state.pathname = "/";
  state.cluster = undefined;
  view.rerender(<RootLayout />);
  expectWorkspace("alpha", false);
  expectWorkspace("beta", false);
  expect(screen.getByTestId("alpha")).toBe(alpha);
  expect(screen.getByTestId("beta")).toBe(beta);
  expect(state.mounts).toEqual(["alpha", "beta"]);
  expect(state.unmounts).toEqual([]);
});

it("keeps the visible Workspace inactive while the Engine is outdated", () => {
  state.connection = "outdated";
  render(<RootLayout />);
  expectWorkspace("alpha", true, false);
  expectWorkspace("beta", false);
  expect(screen.getByTestId("alpha").closest("[inert]")).not.toBeNull();
});
