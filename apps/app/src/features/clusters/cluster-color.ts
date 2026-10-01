import type { CSSProperties } from "react";

// Hues that read clearly in light and dark mode. Red is left out so it can
// later mark Clusters the user flags as production.
const hues = [255, 200, 295, 330, 175, 85, 130, 225];

/** A stable hue for a Cluster, so it keeps its color across sessions. */
export function clusterHue(clusterId: string): number {
  // FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < clusterId.length; i++) {
    hash ^= clusterId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hues[(hash >>> 0) % hues.length]!;
}

/** Props that tint an element and its descendants with a Cluster's color. */
export function clusterScope(clusterId: string): { "data-cluster": string; style: CSSProperties } {
  return {
    "data-cluster": clusterId,
    style: { "--cluster-hue": clusterHue(clusterId), "--cluster-chroma": 0.14 } as CSSProperties,
  };
}
