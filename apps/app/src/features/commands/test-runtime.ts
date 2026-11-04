import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { WorkspaceValue } from "../workspace/workspace-context.tsx";
import { commands } from "./runtime.ts";
import { compileKeymap, emptyDocument } from "./keyboard.ts";
/** Register the same owner boundary used by Workspace for component tests. */
export function commandTestWorkspace(
  api: object & { id: string },
  params: () => unknown,
  workspace?: WorkspaceValue,
) {
  const value = workspace ?? {
    cluster: "c",
    active: true,
    types: new Map(),
    openList: () => {},
    openResource: () => {},
    openExecSession: () => {},
  };
  const panel = {
    id: api.id,
    api,
    group: {},
    get params() {
      return params();
    },
  } as IDockviewPanel;
  const dock = {
    activePanel: panel,
    getPanel: (id: string) => (id === panel.id ? panel : undefined),
  } as DockviewApi;
  commands.configure({
    route: "/c/c",
    platform: "mac",
    host: "web",
    connection: "open",
    modalCount: 0,
    map: compileKeymap(emptyDocument, "mac"),
    preferencesReady: () => true,
    preference: () => {},
    settings: () => {},
  });
  return commands.registerWorkspace(value.cluster, { token: {}, api: dock, value });
}
