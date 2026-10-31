import type { DockviewApi } from "dockview-react";

type Group = DockviewApi["groups"][number];

/** Keep native-hidden Panes mounted, but exclude their entire header and content from interaction. */
export function bindPaneInteractivity(api: DockviewApi): () => void {
  const groups = new Map<Group, () => void>();
  // Visibility fires before maximize, and inert can blur the hidden descendant.
  // Retain only that displaced focus until reveal, removal, or the synchronous handoff.
  let displaced: { group: Group; element: Element } | undefined;
  const add = (group: Group) => {
    if (groups.has(group)) return;
    let ownsInert = false;
    const sync = () => {
      if (!group.api.isVisible) {
        const focused = group.element.ownerDocument.activeElement;
        if (focused && group.element.contains(focused)) displaced = { group, element: focused };
        if (!group.element.hasAttribute("inert")) {
          group.element.setAttribute("inert", "");
          ownsInert = true;
        }
      } else {
        if (displaced?.group === group) displaced = undefined;
        if (ownsInert) group.element.removeAttribute("inert");
        ownsInert = false;
      }
    };
    const visibility = group.api.onDidVisibilityChange(sync);
    groups.set(group, () => {
      visibility.dispose();
      if (ownsInert) group.element.removeAttribute("inert");
      if (displaced?.group === group) displaced = undefined;
    });
    sync();
  };
  for (const group of api.groups) add(group);
  const subscriptions = [
    api.onDidAddGroup(add),
    api.onDidRemoveGroup((group) => {
      groups.get(group)?.();
      groups.delete(group);
    }),
    api.onDidMaximizedGroupChange(({ group, isMaximized }) => {
      const previous = displaced;
      displaced = undefined;
      if (!isMaximized || !previous || previous.group.api.isVisible) return;
      const document = group.element.ownerDocument;
      // A different control may have deliberately taken focus during the native events.
      if (document.activeElement !== document.body && document.activeElement !== previous.element)
        return;
      const control = group.element.querySelector<HTMLButtonElement>(
        "[data-pane-header-actions] button",
      );
      if (group.api.isVisible && control?.isConnected && !control.closest("[hidden], [inert]"))
        control.focus({ preventScroll: true });
    }),
  ];
  return () => {
    subscriptions.forEach((subscription) => subscription.dispose());
    groups.forEach((dispose) => dispose());
    groups.clear();
  };
}
