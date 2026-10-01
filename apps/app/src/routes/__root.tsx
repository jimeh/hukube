import { createRootRoute, Outlet, useParams } from "@tanstack/react-router";

import { ClusterTabs } from "@/features/clusters/cluster-tabs.tsx";
import { useOpenClusters } from "@/features/clusters/open-clusters.ts";
import { Workspace } from "@/features/workspace/workspace.tsx";

export const Route = createRootRoute({ component: RootLayout });

/**
 * The window: Cluster tabs on top, and one Workspace per open Cluster. Hidden
 * Workspaces stay mounted so switching tabs keeps their state.
 */
function RootLayout() {
  const ids = useOpenClusters((s) => s.ids);
  const active = useParams({ strict: false }).cluster;
  return (
    <div className="flex h-full flex-col">
      <ClusterTabs />
      <main className="min-h-0 flex-1">
        {ids.map((id) => (
          <div key={id} hidden={id !== active} className="h-full">
            <Workspace cluster={id} />
          </div>
        ))}
        <Outlet />
      </main>
    </div>
  );
}
