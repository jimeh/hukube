import { Button } from "@hukube/ui/components/button";
import { cn } from "@hukube/ui/lib/utils";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useState } from "react";

import { pinPanel } from "./dock.ts";

/**
 * A tab that shows Preview Tabs in italics. Double-clicking pins a preview;
 * middle-clicking closes the tab.
 */
export function PanelTab({ api, params }: IDockviewPanelHeaderProps<{ preview?: boolean }>) {
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
        if (e.button === 1) api.close();
      }}
    >
      <span className={cn("max-w-56 truncate font-mono text-xs", params.preview && "italic")}>
        {title}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          api.close();
        }}
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </div>
  );
}
