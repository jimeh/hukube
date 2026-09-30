import type { ClusterStatus, ResourceType } from "@hukube/engine-client";
import type { ResourceAddress, TypeKey } from "@hukube/k8s";
import { createContext, use } from "react";

export interface OpenOptions {
  /** Open as a Preview Tab, replaced by the next preview in the same Pane. */
  preview?: boolean;
  /** The ID of the panel this is opened from, to open beside it. */
  beside?: string;
}

export interface WorkspaceValue {
  cluster: string;
  status?: ClusterStatus;
  types: ReadonlyMap<TypeKey, ResourceType>;
  /** The Resource Type of the active list tab, if the active tab is a list. */
  activeListType?: TypeKey;
  openList: (type: TypeKey, options?: OpenOptions) => void;
  openResource: (address: Omit<ResourceAddress, "cluster">, options?: OpenOptions) => void;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/** The Workspace of the Cluster the calling component belongs to. */
export function useWorkspace(): WorkspaceValue {
  const value = use(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside a Workspace");
  return value;
}
