import { createContext, use } from "react";

export type RequestSettingsFocusReturn = (cluster: string) => void;

export const SettingsFocusReturnContext = createContext<RequestSettingsFocusReturn | null>(null);

/** Requests focus restoration when Settings returns to its originating Workspace. */
export function useSettingsFocusReturn(): RequestSettingsFocusReturn | null {
  return use(SettingsFocusReturnContext);
}

function unavailable(element: HTMLElement, workspace: HTMLElement): boolean {
  if (!element.isConnected || !workspace.contains(element)) return true;
  if (element.matches(":disabled, [aria-disabled='true']")) return true;

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    )
      return true;
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return true;
    if (current === workspace) break;
  }

  return (
    typeof element.checkVisibility === "function" &&
    !element.checkVisibility({ checkVisibilityCSS: true })
  );
}

function focus(element: HTMLElement, workspace: HTMLElement): boolean {
  if (unavailable(element, workspace)) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function selectedResourceFacet(workspace: HTMLElement): HTMLElement | undefined {
  const selector = '[role="tablist"][aria-label="Facets"] [role="tab"][aria-selected="true"]';
  const selected = [
    ...workspace.querySelectorAll<HTMLElement>(
      `.dv-groupview.dv-active-group > .dv-content-container ${selector}`,
    ),
    ...workspace.querySelectorAll<HTMLElement>(selector),
  ];
  return selected.find(
    (element, index) => selected.indexOf(element) === index && !unavailable(element, workspace),
  );
}

/** Restores an exact mounted control, then the active Resource Facet, then the Workspace. */
export function restoreWorkspaceFocus(
  workspace: HTMLElement,
  previous: HTMLElement | undefined,
): HTMLElement {
  if (previous && focus(previous, workspace)) return previous;

  const selected = selectedResourceFacet(workspace);
  if (selected && focus(selected, workspace)) return selected;
  focus(workspace, workspace);
  return workspace;
}
