import { restoreWorkspaceFocus } from "./focus-return.ts";

/** Focus ownership for mounted Workspaces, released only when their IDs close. */
export function createWorkspaceFocusRegistry() {
  const workspaces = new Map<string, HTMLElement>();
  const lastFocused = new Map<string, HTMLElement>();

  return {
    workspace(id: string, element: HTMLElement | null) {
      if (element) workspaces.set(id, element);
      else workspaces.delete(id);
    },
    focused(id: string, element: HTMLElement) {
      lastFocused.set(id, element);
    },
    restore(id: string) {
      const workspace = workspaces.get(id);
      return workspace ? restoreWorkspaceFocus(workspace, lastFocused.get(id)) : undefined;
    },
    retain(ids: readonly string[]) {
      const retained = new Set(ids);
      for (const id of workspaces.keys()) if (!retained.has(id)) workspaces.delete(id);
      for (const id of lastFocused.keys()) if (!retained.has(id)) lastFocused.delete(id);
    },
    diagnostics(id: string) {
      return {
        workspaces: workspaces.size,
        focused: lastFocused.size,
        ownsWorkspace: workspaces.has(id),
        ownsFocus: lastFocused.has(id),
      };
    },
  };
}
