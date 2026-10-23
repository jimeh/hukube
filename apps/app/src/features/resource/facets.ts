import type { Facet } from "@hukube/k8s";
import type { ComponentType } from "react";

import { EventsFacet, EventsBadge, eventsTabName } from "./events-facet.tsx";
import type { FacetProps, FacetTarget } from "./facet-props.ts";
import { RelatedFacet, RelatedBadge, relatedTabName } from "./related-facet.tsx";
import { LogsFacet } from "./logs-facet.tsx";
import { typeHasLogs } from "./logs-rule.ts";
import { OverviewFacet } from "../overview/overview-facet.tsx";
import { YamlFacet } from "./yaml-facet.tsx";

export interface FacetEntry {
  id: Facet;
  label: string;
  appliesTo: (target: FacetTarget) => boolean;
  View: ComponentType<FacetProps>;
  Badge?: ComponentType<FacetProps>;
  accessibleName?: (props: FacetProps) => string;
}

const facets: readonly FacetEntry[] = [
  {
    id: "overview",
    label: "Overview",
    appliesTo: ({ overview }) => !!overview,
    View: OverviewFacet,
  },
  { id: "yaml", label: "YAML", appliesTo: () => true, View: YamlFacet },
  {
    id: "logs",
    label: "Logs",
    appliesTo: ({ type, logs }) => typeHasLogs(type) || !!logs,
    View: LogsFacet,
  },
  {
    id: "events",
    label: "Events",
    appliesTo: ({ type }) => type !== "events" && type !== "events.events.k8s.io",
    View: EventsFacet,
    Badge: EventsBadge,
    accessibleName: eventsTabName,
  },
  {
    id: "related",
    label: "Related",
    appliesTo: () => true,
    View: RelatedFacet,
    Badge: RelatedBadge,
    accessibleName: relatedTabName,
  },
];

/** Returns the Facets that apply to the Resource, in switcher order. */
export function facetsFor(target: FacetTarget): readonly FacetEntry[] {
  return facets.filter((facet) => facet.appliesTo(target));
}

/** Resolves an applicable requested Facet, falling back to YAML. */
export function resolveFacet(requested: Facet | undefined, target: FacetTarget): Facet {
  return (
    facetsFor(target).find((facet) => facet.id === requested)?.id ??
    (requested ? "yaml" : target.overview ? "overview" : "yaml")
  );
}
