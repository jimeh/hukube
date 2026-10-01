import type { TypeKey } from "@hukube/k8s";
import type { AddPanelPositionOptions, DockviewApi } from "dockview-react";

export interface ListPanelParams {
  type: TypeKey;
  preview?: boolean;
}

export interface ResourcePanelParams {
  uri: string;
  preview?: boolean;
}

export type PanelComponent = "list" | "resource";

interface OpenPanelOptions<P> {
  id: string;
  component: PanelComponent;
  title: string;
  params: P;
  preview: boolean;
  /** The panel this one was opened from; the new panel opens in a Pane beside it. */
  beside?: string;
}

/**
 * Opens a panel, or focuses it if it is already open. A preview panel
 * replaces the current Preview Tab of its Pane, so browsing does not pile up
 * tabs; opening an existing preview without preview pins it. Panels opened
 * from another panel go into a different Pane, splitting one off to the right
 * if needed, so a list and the Resource picked from it show side by side.
 */
export function openPanel<P extends { preview?: boolean }>(
  api: DockviewApi,
  { id, component, title, params, preview, beside }: OpenPanelOptions<P>,
): void {
  const existing = api.getPanel(id);
  if (existing) {
    if (!preview) pinPanel(existing.api, existing.params);
    existing.api.setActive();
    return;
  }

  const source = beside ? api.getPanel(beside) : undefined;
  const group = source ? api.groups.find((g) => g !== source.group) : api.activeGroup;
  const previous = preview
    ? group?.panels.find((p) => (p.params as { preview?: boolean } | undefined)?.preview)
    : undefined;
  const index = previous && group ? group.panels.indexOf(previous) : undefined;

  let position: AddPanelPositionOptions | undefined;
  if (group) position = { referenceGroup: group, ...(index === undefined ? {} : { index }) };
  else if (source) position = { referencePanel: source, direction: "right" };

  api.addPanel({
    id,
    component,
    title,
    tabComponent: "tab",
    params: { ...params, preview },
    ...(position ? { position } : {}),
  });
  previous?.api.close();
}

/** Turns a Preview Tab into a regular tab. */
export function pinPanel(
  panelApi: { updateParameters: (params: object) => void },
  params: { preview?: boolean } | undefined,
): void {
  if (params?.preview) {
    panelApi.updateParameters({ ...params, preview: false });
  }
}
