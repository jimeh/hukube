import type { ResourceData, ResourceEventsParams } from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import { formatResourceUri, parseResourceUri, type ResourceAddress } from "@hukube/k8s";

import type { FacetTarget } from "./facet-props.ts";
import { resolveFacet } from "./facets.ts";

/** Wait for the Manifest's first answer and keep the last incarnation after deletion. */
export function resourceEventsParams(
  address: ResourceAddress,
  manifest: SubscriptionState<ResourceData>,
  lastObject: Record<string, unknown> | undefined,
): ResourceEventsParams | undefined {
  if (!manifest.data && !manifest.error) return undefined;
  const { cluster, type, namespace, name } = address;
  const metadata = lastObject?.["metadata"];
  const uid =
    metadata && typeof metadata === "object" && "uid" in metadata ? metadata.uid : undefined;
  const annotations =
    metadata && typeof metadata === "object" && "annotations" in metadata
      ? metadata.annotations
      : undefined;
  const mirror =
    annotations && typeof annotations === "object" && "kubernetes.io/config.mirror" in annotations
      ? annotations["kubernetes.io/config.mirror"]
      : undefined;
  return {
    cluster,
    type,
    namespace,
    name,
    ...(typeof uid === "string" ? { uid } : {}),
    ...(type === "pods" && typeof mirror === "string" && mirror ? { otherUids: [mirror] } : {}),
  };
}

/** A new Resource tab inherits the Pane's active tab's Facet unless its address names one. */
export function newResourceUri(
  uri: string,
  activeUri: string | undefined,
  target?: FacetTarget,
  source?: FacetTarget,
): string {
  const address = parseResourceUri(uri);
  const active = activeUri ? parseResourceUri(activeUri) : undefined;
  if (!address || address.facet || !active?.facet) return uri;
  if (resolveFacet(active.facet, source ?? { type: active.type }) !== active.facet) return uri;
  const destination = target ?? { type: address.type };
  if (resolveFacet(active.facet, destination) !== active.facet) return uri;
  return formatResourceUri({ ...address, facet: active.facet });
}
