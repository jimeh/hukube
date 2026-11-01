import type { ClusterStatus } from "@hukube/engine-client";

export interface ClusterStatusPresentation {
  title: string;
  description: string;
  detail?: string;
  statusText: string;
}

function kubernetesDetail(status: ClusterStatus): string | undefined {
  const reason = status.error?.reason;
  const message = status.error?.message;
  if (message === "unknown") return reason;
  if (reason && message && reason !== message) return `${reason}: ${message}`;
  return reason ?? message;
}

/** Presentation for a Cluster that has not produced a usable Resource Type list. */
export function clusterStatusPresentation(
  status: ClusterStatus | undefined,
): ClusterStatusPresentation | undefined {
  if (!status || status.phase === "connecting")
    return {
      title: "Connecting to Cluster",
      description: "hukube is discovering the Resource Types this Cluster serves.",
      statusText: "Connecting to the Cluster",
    };
  if (status.phase === "ready") return undefined;

  if (status.error?.code === "forbidden") {
    const technical = kubernetesDetail(status);
    return {
      title: "Not permitted",
      description: "Your Kubernetes credentials cannot discover Resource Types for this Cluster.",
      ...(technical ? { detail: `Kubernetes reported ${technical}.` } : {}),
      statusText: `Not permitted to access the Cluster${technical ? `: ${technical}` : ""}`,
    };
  }

  const technical = status.message ?? status.error?.message;
  return {
    title: "Cluster unavailable",
    description:
      "hukube could not discover Resource Types because it could not reach this Cluster.",
    ...(technical ? { detail: `Technical detail: ${technical}` } : {}),
    statusText: `Cluster unavailable${technical ? `: ${technical}` : ""}`,
  };
}
