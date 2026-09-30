import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@hukube/ui/components/context-menu";
import { Button } from "@hukube/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { cn } from "@hukube/ui/lib/utils";
import { Add01Icon, Cancel01Icon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { DragEvent } from "react";

import { useHost } from "@/lib/host.tsx";
import { setTheme, useTheme } from "@/lib/theme.ts";

import { clusterScope } from "./cluster-color.ts";
import { useOpenClusters } from "./open-clusters.ts";

/** The window's top strip: one tab per open Cluster. */
export function ClusterTabs() {
  const ids = useOpenClusters((s) => s.ids);
  const active = useParams({ strict: false }).cluster;
  const close = useCloseCluster();
  const host = useHost();

  const moveToNewWindow = (id: string) => {
    host.openWindow(`/c/${encodeURIComponent(id)}`);
    close(id);
  };

  // Dropping a tab outside the window moves its Cluster to a new window.
  const onDragEnd = (id: string) => (e: DragEvent) => {
    const outside =
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight;
    if (outside && e.dataTransfer.dropEffect === "none") moveToNewWindow(id);
  };

  return (
    <nav aria-label="Clusters" className="flex h-9 shrink-0 items-stretch border-b bg-sidebar">
      <div className="flex min-w-0 items-stretch overflow-x-auto">
        {ids.map((id) => (
          <ContextMenu key={id}>
            <ContextMenuTrigger
              render={
                <div
                  {...clusterScope(id)}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", id)}
                  onDragEnd={onDragEnd(id)}
                  data-active={id === active}
                  className={cn(
                    "group/tab flex max-w-64 items-center gap-2 border-r pr-1 pl-3 text-muted-foreground",
                    "data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-[inset_0_2px_0_var(--cluster)]",
                  )}
                />
              }
            >
              <span className="size-2 shrink-0 rounded-full bg-cluster" aria-hidden />
              <Link
                to="/c/$cluster"
                params={{ cluster: id }}
                draggable={false}
                className="truncate font-mono text-xs outline-none focus-visible:underline"
              >
                {id}
              </Link>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Close ${id}`}
                className="opacity-0 group-hover/tab:opacity-100 group-data-[active=true]/tab:opacity-100 focus-visible:opacity-100"
                onClick={() => close(id)}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuGroup>
                <ContextMenuItem onClick={() => moveToNewWindow(id)}>
                  Move to new window
                </ContextMenuItem>
                <ContextMenuItem onClick={() => close(id)}>Close</ContextMenuItem>
              </ContextMenuGroup>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="m-1"
              nativeButton={false}
              render={<Link to="/" />}
              aria-label="Open a cluster"
            />
          }
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </TooltipTrigger>
        <TooltipContent>Open a cluster</TooltipContent>
      </Tooltip>
      <div className="ml-auto flex items-center pr-1">
        <ThemeToggle />
      </div>
    </nav>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Switch to ${next} mode`}
            onClick={() => setTheme(next)}
          />
        }
      >
        <HugeiconsIcon icon={theme === "dark" ? Sun03Icon : Moon02Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>Switch to {next} mode</TooltipContent>
    </Tooltip>
  );
}

/** Closes a Cluster tab, switching to a neighbour when it was active. */
function useCloseCluster() {
  const close = useOpenClusters((s) => s.close);
  const active = useParams({ strict: false }).cluster;
  const navigate = useNavigate();
  return (id: string) => {
    const next = close(id);
    if (id !== active) return;
    void (next
      ? navigate({ to: "/c/$cluster", params: { cluster: next } })
      : navigate({ to: "/" }));
  };
}
