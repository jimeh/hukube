import type {
  Access,
  Related,
  ResourceData,
  ResourceEvents,
  ResourceType,
} from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import type { ResourceAddress, TypeKey } from "@hukube/k8s";

/** The Resource Type used to decide which Facets apply. */
export interface FacetTarget {
  type: TypeKey;
  resourceType?: ResourceType;
  logs?: boolean;
}

/** Resource state and switcher controls shared by a Facet and its badge. */
export interface FacetProps {
  /** The Resource address, including the requested Facet. */
  address: ResourceAddress;
  /** The discovered kind, used in notices about the Resource. */
  kind: string;
  /** The live Manifest subscription state. */
  manifest: SubscriptionState<ResourceData>;
  /** The last Manifest received, retained after deletion. */
  lastObject?: Record<string, unknown>;
  /** The live Events subscription state for the same incarnation. */
  events: SubscriptionState<ResourceEvents>;
  /** The live Relationships, retained while only the request for cells changes. */
  related: SubscriptionState<Related>;
  /** The panel whose Pane related Resources open in. */
  panelId: string;
  /** Whether this Facet is selected in its Resource tab. */
  showing: boolean;
  /** Whether the Facet, its tab, and its Workspace are all showing. */
  visible: boolean;
  /** The switcher row element for the showing Facet's own controls. */
  controls: HTMLElement | null;
  editAccess?: Access;
  onEdit?: () => void;
}
