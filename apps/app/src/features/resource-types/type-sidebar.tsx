import type { ResourceType } from "@hukube/engine-client";
import { Button } from "@hukube/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@hukube/ui/components/input-group";
import { ScrollArea } from "@hukube/ui/components/scroll-area";
import { Spinner } from "@hukube/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import {
  Search01Icon,
  SquareLock02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDeferredValue, useMemo, useState } from "react";

import { useWorkspace } from "@/features/workspace/workspace-context.tsx";

import { groupTypes } from "./group-types.ts";

/** The Workspace sidebar listing every Resource Type the Cluster serves. */
export function TypeSidebar() {
  const { types, openList, activeListType } = useWorkspace();
  const [filter, setFilter] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const deferredFilter = useDeferredValue(filter);
  const groups = useMemo(
    () => groupTypes([...types.values()], { filter: deferredFilter, showEmpty }),
    [types, deferredFilter, showEmpty],
  );
  const syncing = [...types.values()].filter((t) => t.state === "syncing").length;

  return (
    <aside aria-label="Resource types" className="flex min-h-0 flex-col border-r bg-sidebar">
      <div className="flex items-center gap-1 p-2">
        <InputGroup className="h-7">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Filter resource types"
            placeholder="Filter types"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </InputGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-pressed={showEmpty}
                aria-label={showEmpty ? "Hide empty types" : "Show empty types"}
                onClick={() => setShowEmpty(!showEmpty)}
              />
            }
          >
            <HugeiconsIcon icon={showEmpty ? ViewIcon : ViewOffSlashIcon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>{showEmpty ? "Hide empty types" : "Show empty types"}</TooltipContent>
        </Tooltip>
      </div>
      {syncing > 0 && (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Indexing {syncing} {syncing === 1 ? "type" : "types"}
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-3 px-2 pb-3">
          {groups.map((g) => (
            <section key={g.group} aria-label={g.label} className="flex flex-col">
              <h2 className="truncate px-2 pb-0.5 text-xs text-muted-foreground" title={g.label}>
                {g.label}
              </h2>
              {g.types.map((t) => (
                <TypeItem
                  key={t.key}
                  type={t}
                  active={t.key === activeListType}
                  onOpen={(preview) => openList(t.key, { preview })}
                />
              ))}
            </section>
          ))}
          {groups.length === 0 && syncing === 0 && (
            <p className="px-2 text-muted-foreground">No resource types match.</p>
          )}
        </nav>
      </ScrollArea>
    </aside>
  );
}

function TypeItem({
  type,
  active,
  onOpen,
}: {
  type: ResourceType;
  active: boolean;
  onOpen: (preview: boolean) => void;
}) {
  const forbidden = type.state === "forbidden";
  return (
    <button
      type="button"
      data-active={active}
      title={`${type.key}${forbidden ? " (not permitted to list)" : ""}`}
      onClick={() => onOpen(true)}
      onDoubleClick={() => onOpen(false)}
      className="flex h-6 items-center gap-2 rounded-sm px-2 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring data-[active=true]:bg-cluster-subtle data-[active=true]:text-foreground"
    >
      <span className={forbidden ? "truncate text-muted-foreground" : "truncate"}>{type.kind}</span>
      <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
        {forbidden ? (
          <HugeiconsIcon
            icon={SquareLock02Icon}
            strokeWidth={2}
            className="size-3"
            aria-label="Not permitted"
          />
        ) : type.state === "syncing" ? (
          "…"
        ) : (
          type.count
        )}
      </span>
    </button>
  );
}
