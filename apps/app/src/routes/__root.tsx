import { useConnectionState } from "@hukube/engine-client/react";
import { cn } from "@hukube/ui/lib/utils";
import { createRootRoute, Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { UnsavedGuard } from "@/features/edit/unsaved-guard.tsx";

import { ClusterTabs } from "@/features/clusters/cluster-tabs.tsx";
import { useOpenClusters } from "@/features/clusters/open-clusters.ts";
import { OutOfDateNotice } from "@/features/connection/out-of-date-notice.tsx";
import { SettingsFocusReturnContext } from "@/features/settings/focus-return.ts";
import { createWorkspaceFocusRegistry } from "@/features/settings/workspace-focus-registry.ts";
import { Workspace } from "@/features/workspace/workspace.tsx";
import { PreferencesController } from "@/features/settings/preferences.ts";

export const Route = createRootRoute({ component: RootLayout });

/**
 * The window: Cluster tabs on top, and one Workspace per open Cluster. Hidden
 * Workspaces stay mounted so switching tabs keeps their state.
 */
export function RootLayout() {
  const ids = useOpenClusters((s) => s.ids);
  const active = useParams({ strict: false }).cluster;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const outdated = useConnectionState() === "outdated";
  const [focusRegistry] = useState(createWorkspaceFocusRegistry);
  const pendingReturn = useRef<string | undefined>(undefined);
  const requestFocusReturn = useCallback((cluster: string) => {
    pendingReturn.current = cluster;
  }, []);

  useLayoutEffect(() => focusRegistry.retain(ids), [focusRegistry, ids]);

  useLayoutEffect(() => {
    if (pathname === "/settings" || !pendingReturn.current) return;
    // TanStack Router publishes the destination path before its params. Keep the
    // one-shot request until the destination Cluster is available.
    if (pathname.startsWith("/c/") && !active) return;
    const cluster = pendingReturn.current;
    pendingReturn.current = undefined;
    if (active !== cluster || !ids.includes(cluster)) return;
    focusRegistry.restore(cluster);
  }, [active, focusRegistry, ids, pathname]);

  return (
    <SettingsFocusReturnContext value={requestFocusReturn}>
      <div className="flex h-full flex-col">
        <OutOfDateNotice />
        <UnsavedGuard />
        <PreferencesController />
        {/* Freeze the content when out of date because the connection cannot recover. */}
        <div
          inert={outdated}
          className={cn("flex min-h-0 flex-1 flex-col", outdated && "opacity-60")}
        >
          <ClusterTabs />
          <main className="min-h-0 flex-1">
            {ids.map((id) => (
              <section
                key={id}
                ref={(element) => focusRegistry.workspace(id, element)}
                aria-label={`${id} Workspace`}
                tabIndex={-1}
                hidden={id !== active}
                data-active={id === active}
                className="h-full outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset"
                onFocusCapture={(event) => {
                  if (event.target instanceof HTMLElement) focusRegistry.focused(id, event.target);
                }}
              >
                <Workspace cluster={id} active={id === active && !outdated} />
              </section>
            ))}
            <Outlet />
          </main>
        </div>
      </div>
    </SettingsFocusReturnContext>
  );
}
