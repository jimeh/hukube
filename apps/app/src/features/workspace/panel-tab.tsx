import { Button } from "@hukube/ui/components/button";
import { cn } from "@hukube/ui/lib/utils";
import { Cancel01Icon, ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useState } from "react";

import { guardPanel, useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { isRunning, useExecSessions } from "../exec/sessions.ts";

import { pinPanel } from "./dock.ts";

/**
 * A tab that shows Preview Tabs in italics. Double-clicking pins a preview;
 * middle-clicking closes the tab.
 */
export function PanelTab({ api, params }: IDockviewPanelHeaderProps<{ preview?: boolean }>) {
  const dirty = useUnsavedEdits((state) => state.entries.has(api.id));
  const exec = api.id.startsWith("exec:");
  const running = useExecSessions((state) =>
    isRunning(exec ? state.entries.get(api.id.slice(5)) : undefined),
  );
  const close = () => guardPanel(api.id, () => api.close());
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    const d = api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);

  return (
    <div
      className="flex h-full items-center gap-1 pr-1 pl-3"
      onDoubleClick={() => pinPanel(api, params)}
      onAuxClick={(e) => {
        if (e.button === 1) close();
      }}
    >
      {exec && (
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          className={cn("size-3.5 shrink-0", !running && "text-muted-foreground")}
        />
      )}
      <span
        className={cn(
          "max-w-56 truncate font-mono text-xs",
          params.preview && "italic",
          exec && !running && "text-muted-foreground",
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
