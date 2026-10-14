import { Button } from "@hukube/ui/components/button";
import { cn } from "@hukube/ui/lib/utils";
import { Cancel01Icon, ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";

import { guardPanel, useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { useExecSessions } from "../exec/sessions.ts";

import { closeSessionTab } from "../exec/window-tabs.ts";
import { useWorkspace } from "./workspace-context.tsx";

import { pinPanel } from "./dock.ts";

/**
 * A tab that shows Preview Tabs in italics. Double-clicking pins a preview;
 * middle-clicking closes the tab.
 */
export function PanelTab({ api, params }: IDockviewPanelHeaderProps<{ preview?: boolean }>) {
  const { cluster } = useWorkspace();
  const dirty = useUnsavedEdits((state) => state.entries.has(api.id));
  const exec = api.id.startsWith("exec:");
  const phase = useExecSessions((state) =>
    exec ? state.entries.get(api.id.slice(5))?.state.phase : undefined,
  );
  const running = phase === "live" || phase === "starting";
  const over = phase === "ended" || phase === "failed" || phase === "gone";
  const status = phase === "elsewhere" ? "open in another window" : (phase ?? "attaching");
  const tab = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A Tab opened or chosen beyond the strip's edge would otherwise stay out of sight.
    const reveal = () => tab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (api.isActive) reveal();
    const d = api.onDidActiveChange((event) => {
      if (event.isActive) reveal();
    });
    return () => d.dispose();
  }, [api]);
  const close = () =>
    guardPanel(api.id, () => {
      if (exec) closeSessionTab(cluster, api.id.slice(5));
      api.close();
    });
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    const d = api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);

  return (
    <div
      ref={tab}
      className="flex h-full items-center gap-1 pr-1 pl-3"
      title={exec ? `Exec Session, ${status}: ${title}` : undefined}
      onDoubleClick={() => pinPanel(api, params)}
      onAuxClick={(e) => {
        if (e.button === 1) close();
      }}
    >
      {exec && (
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          // A live session's icon is in the Cluster's color, so it reads as live
          // in a Tab that is not the active one too.
          className={cn("size-3.5 shrink-0", running ? "text-cluster" : "opacity-40")}
        />
      )}
      <span
        className={cn(
          "max-w-56 truncate font-mono text-xs",
          params.preview && "italic",
          exec && over && "text-muted-foreground line-through decoration-1",
        )}
      >
        {title}
      </span>
      <Button
        className="group/close"
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
      >
        {dirty ? (
          <span
            className="size-1.5 rounded-full bg-foreground group-hover/close:hidden"
            aria-label="Unsaved edits"
          />
        ) : null}
        <HugeiconsIcon
          icon={Cancel01Icon}
          strokeWidth={2}
          className={dirty ? "hidden group-hover/close:block" : ""}
        />
      </Button>
    </div>
  );
}
