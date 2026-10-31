import { Button } from "@hukube/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { ArrowExpand01Icon, ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { useCallback, useSyncExternalStore } from "react";

/** Native layout state is the authority, including exits caused by navigation. */
export function PaneHeaderActions({ api, containerApi }: IDockviewHeaderActionsProps) {
  const snapshot = useCallback(() => {
    if (api.location.type !== "grid") return "hidden";
    if (api.isMaximized()) return "restore";
    return containerApi.groups.filter((group) => group.api.location.type === "grid").length > 1
      ? "zoom"
      : "hidden";
  }, [api, containerApi]);
  const subscribe = useCallback(
    (changed: () => void) => {
      const subscriptions = [
        containerApi.onDidMaximizedGroupChange(changed),
        containerApi.onDidAddGroup(changed),
        containerApi.onDidRemoveGroup(changed),
        containerApi.onDidMovePanel(changed),
        containerApi.onDidLayoutFromJSON(changed),
        containerApi.onDidLayoutChange(changed),
        api.onDidLocationChange(changed),
      ];
      return () => subscriptions.forEach((subscription) => subscription.dispose());
    },
    [api, containerApi],
  );
  const state = useSyncExternalStore(subscribe, snapshot);

  if (state === "hidden") return null;
  const maximized = state === "restore";
  const label = maximized ? "Restore Panes" : "Zoom Pane";
  return (
    <div data-pane-header-actions className="flex h-full shrink-0 items-center px-1">
      <Tooltip>
        <TooltipTrigger
          delay={400}
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="touch-manipulation transition-none"
              aria-label={label}
              aria-pressed={maximized}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (snapshot() === "hidden") return;
                event.currentTarget.focus({ preventScroll: true });
                if (api.isMaximized()) api.exitMaximized();
                else {
                  // Activate before maximizing: Dockview otherwise reports a hidden
                  // peer's active Tab visible when this Pane was inactive.
                  api.setActive();
                  api.maximize();
                }
              }}
            />
          }
        >
          <HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
