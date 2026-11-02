import { useConnectionState } from "@hukube/engine-client/react";
import { cn } from "@hukube/ui/lib/utils";
import { createRootRoute, Outlet, useParams, useLocation } from "@tanstack/react-router";

import { UnsavedGuard } from "@/features/edit/unsaved-guard.tsx";

import { ClusterTabs } from "@/features/clusters/cluster-tabs.tsx";
import { useOpenClusters } from "@/features/clusters/open-clusters.ts";
import { OutOfDateNotice } from "@/features/connection/out-of-date-notice.tsx";
import { Workspace } from "@/features/workspace/workspace.tsx";

import { SettingsPage, rememberSettingsOrigin } from "@/features/settings/settings-page.tsx";
import { PreferenceRuntime } from "@/features/settings/preference-runtime.tsx";
import { useLayoutEffect, useRef, useState } from "react";

export const Route = createRootRoute({ component: RootLayout });

/**
 * The window: Cluster tabs on top, and one Workspace per open Cluster. Hidden
 * Workspaces stay mounted so switching tabs keeps their state.
 */
function RootLayout() {
  const location = useLocation();
  const settings = location.pathname.startsWith("/settings");
  const [visited, setVisited] = useState(settings);
  if (settings && !visited) setVisited(true);
  const previous = useRef(location.pathname);
  useLayoutEffect(() => {
    if (settings && !previous.current.startsWith("/settings"))
      rememberSettingsOrigin(
        previous.current,
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
      );
    previous.current = location.pathname;
  }, [settings, location.pathname]);
  const ids = useOpenClusters((s) => s.ids);
  const active = useParams({ strict: false }).cluster;
  const outdated = useConnectionState() === "outdated";
  return (
    <div className="flex h-full flex-col">
      <OutOfDateNotice />
      <PreferenceRuntime />
      <UnsavedGuard />
      {/* Freeze the content when out of date because the connection cannot recover. */}
      <div
        inert={outdated}
        className={cn("flex min-h-0 flex-1 flex-col", outdated && "opacity-60")}
      >
        <ClusterTabs />
        <main className="min-h-0 flex-1">
          {ids.map((id) => {
            const visible = !settings && id === active;
            return (
              <div key={id} hidden={!visible} className="h-full">
                <Workspace cluster={id} active={visible && !outdated} />
              </div>
            );
          })}
          {visited && <SettingsPage visible={settings} />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
