import { useConnectionState } from "@hukube/engine-client/react";

import { useWorkspace } from "./workspace-context.tsx";

const connectionLabels = {
  connecting: "Connecting to the Engine",
  reconnecting: "Reconnecting to the Engine",
  closed: "Disconnected from the Engine",
} as const;

/** A bar in the Cluster's color, so it is always clear which Cluster a window acts on. */
export function StatusBar() {
  const { cluster, status } = useWorkspace();
  const connection = useConnectionState();

  const clusterText =
    status?.phase === "ready"
      ? `Kubernetes ${status.serverVersion ?? ""}`.trim()
      : status?.phase === "failed"
        ? `Cannot reach the cluster: ${status.message ?? "unknown error"}`
        : "Connecting to the cluster";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 bg-cluster px-3 text-xs text-cluster-foreground">
      <span className="font-mono font-semibold">{cluster}</span>
      <span className="truncate" aria-live="polite">
        {clusterText}
      </span>
      {connection !== "open" && <span className="ml-auto">{connectionLabels[connection]}</span>}
    </footer>
  );
}
