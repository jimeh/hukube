import type { ResourceData, ResourceEventsParams } from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import { formatResourceUri, parseResourceUri, type ResourceAddress } from "@hukube/k8s";

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
  return { cluster, type, namespace, name, ...(typeof uid === "string" ? { uid } : {}) };
}

/** A replacing Preview Tab inherits the shown Facet unless its address names one. */
export function previewResourceUri(uri: string, previousUri: string | undefined): string {
  const address = parseResourceUri(uri);
  const previous = previousUri ? parseResourceUri(previousUri) : undefined;
  if (!address || address.facet || !previous) return uri;
  return formatResourceUri({
    ...address,
    facet: resolveFacet(resolveFacet(previous.facet, { type: previous.type }), {
      type: address.type,
    }),
  });
}
