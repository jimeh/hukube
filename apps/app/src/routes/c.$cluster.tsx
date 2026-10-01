import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { useOpenClusters } from "@/features/clusters/open-clusters.ts";

export const Route = createFileRoute("/c/$cluster")({ component: ClusterRoute });

/**
 * Makes sure the Cluster in the URL has a tab, such as when a window is
 * opened directly on it. The root layout renders its Workspace.
 */
function ClusterRoute() {
  const { cluster } = Route.useParams();
  const open = useOpenClusters((s) => s.open);
  useEffect(() => open(cluster), [cluster, open]);
  return null;
}
