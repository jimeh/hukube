import type { Facet } from "@hukube/k8s";
import type { ComponentType } from "react";

import { EventsFacet, EventsBadge, eventsTabName } from "./events-facet.tsx";
import type { FacetProps, FacetTarget } from "./facet-props.ts";
import { YamlFacet } from "./yaml-facet.tsx";

interface FacetEntry {
  id: Facet;
  label: string;
  appliesTo: (target: FacetTarget) => boolean;
  View: ComponentType<FacetProps>;
  Badge?: ComponentType<FacetProps>;
  accessibleName?: (props: FacetProps) => string;
}

const facets: readonly FacetEntry[] = [
  { id: "yaml", label: "YAML", appliesTo: () => true, View: YamlFacet },
  {
    id: "events",
    label: "Events",
    appliesTo: ({ type }) => type !== "events" && type !== "events.events.k8s.io",
    View: EventsFacet,
    Badge: EventsBadge,
    accessibleName: eventsTabName,
  },
];

/** Returns the Facets that apply to the Resource, in switcher order. */
export function facetsFor(target: FacetTarget): readonly FacetEntry[] {
  return facets.filter((facet) => facet.appliesTo(target));
}

/** Resolves an applicable requested Facet, falling back to YAML. */
export function resolveFacet(requested: Facet | undefined, target: FacetTarget): Facet {
  return facetsFor(target).find((facet) => facet.id === requested)?.id ?? "yaml";
}
