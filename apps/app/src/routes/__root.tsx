import { useConnectionState } from "@hukube/engine-client/react";
import { Button } from "@hukube/ui/components/button";
import { createRootRoute, Outlet, useParams } from "@tanstack/react-router";

import { ClusterTabs } from "@/features/clusters/cluster-tabs.tsx";
import { useOpenClusters } from "@/features/clusters/open-clusters.ts";
import { useHost } from "@/lib/host.tsx";
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
      <OutdatedNotice />
      <ClusterTabs />
      <main className="min-h-0 flex-1">
        {ids.map((id) => (
          <div key={id} hidden={id !== active} className="h-full">
            <Workspace cluster={id} active={id === active} />
          </div>
        ))}
        <Outlet />
      </main>
    </div>
  );
}

function OutdatedNotice() {
  const connection = useConnectionState();
  const host = useHost();
  if (connection !== "outdated") return null;
  const web = host.kind === "web";
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-3 border-b border-border bg-warning/15 px-4 py-3 text-foreground"
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">
          {web ? "This page is out of date" : "This window is out of date"}
        </p>
        <p>
          {web
            ? "The Engine was updated after this page loaded, so live data has stopped. Reload to continue."
            : "It does not match the Engine it is connected to, so live data has stopped. Quit and reopen hukube to continue."}
          {import.meta.env.DEV && " In development, rebuild and restart the Engine if this stays."}
        </p>
      </div>
      {web && (
        <Button className="shrink-0" onClick={() => window.location.reload()}>
          Reload
        </Button>
      )}
    </div>
  );
}
