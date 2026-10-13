import { useConnectionState } from "@hukube/engine-client/react";
import { cn } from "@hukube/ui/lib/utils";
import { createRootRoute, Outlet, useParams } from "@tanstack/react-router";

import { UnsavedGuard } from "@/features/edit/unsaved-guard.tsx";

import { ClusterTabs } from "@/features/clusters/cluster-tabs.tsx";
import { useOpenClusters } from "@/features/clusters/open-clusters.ts";
import { OutOfDateNotice } from "@/features/connection/out-of-date-notice.tsx";
import { Workspace } from "@/features/workspace/workspace.tsx";

export const Route = createRootRoute({ component: RootLayout });

/**
 * The window: Cluster tabs on top, and one Workspace per open Cluster. Hidden
 * Workspaces stay mounted so switching tabs keeps their state.
 */
function RootLayout() {
  const ids = useOpenClusters((s) => s.ids);
  const active = useParams({ strict: false }).cluster;
  const outdated = useConnectionState() === "outdated";
  return (
    <div className="flex h-full flex-col">
      <OutOfDateNotice />
      <UnsavedGuard />
      {/* Freeze the content when out of date because the connection cannot recover. */}
      <div
        inert={outdated}
        className={cn("flex min-h-0 flex-1 flex-col", outdated && "opacity-60")}
      >
        <ClusterTabs />
        <main className="min-h-0 flex-1">
          {ids.map((id) => (
            <div key={id} hidden={id !== active} className="h-full">
              <Workspace cluster={id} active={id === active && !outdated} />
            </div>
          ))}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
