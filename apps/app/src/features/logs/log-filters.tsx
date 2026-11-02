import { Button } from "@hukube/ui/components/button";
import { Input } from "@hukube/ui/components/input";
import { Toggle } from "@hukube/ui/components/toggle";
import { useEffect, useRef, useState, type Ref } from "react";
import { emptyLogFilter, sameLogFilter, type LogFilter } from "./log-filter.ts";

/** Local to a mounted Resource Tab, above container/run replacement. */
export function useLogFilters() {
  const [draft, setDraft] = useState(emptyLogFilter);
  const [applied, setApplied] = useState(emptyLogFilter);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (sameLogFilter(draft, applied)) return;
    timer.current = setTimeout(() => setApplied(draft), 150);
    return () => clearTimeout(timer.current);
  }, [draft, applied]);
  return {
    draft,
    applied,
    expanded,
    setExpanded,
    pending: !sameLogFilter(draft, applied),
    change: (value: Partial<LogFilter>) => setDraft((current) => ({ ...current, ...value })),
    clear: () => {
      clearTimeout(timer.current);
      setDraft(emptyLogFilter);
      setApplied(emptyLogFilter);
    },
  };
}

export type LogFiltersState = ReturnType<typeof useLogFilters>;

export function LogFilters({
  filters,
  id,
  includeRef,
  clear,
}: {
  filters: LogFiltersState;
  id: string;
  includeRef: Ref<HTMLInputElement>;
  clear: () => void;
}) {
  return (
    <div id={id} hidden={!filters.expanded} className="border-t px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
          <label htmlFor={`${id}-include`}>Include text</label>
          <Input
            ref={includeRef}
            id={`${id}-include`}
            name="log-include"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={filters.draft.include}
            onChange={(event) => filters.change({ include: event.target.value })}
          />
        </div>
        <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
          <label htmlFor={`${id}-exclude`}>Exclude text</label>
          <Input
            id={`${id}-exclude`}
            name="log-exclude"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={filters.draft.exclude}
            onChange={(event) => filters.change({ exclude: event.target.value })}
          />
        </div>
        <Toggle
          pressed={filters.draft.matchCase}
          onPressedChange={(matchCase) => filters.change({ matchCase })}
        >
          Match case
        </Toggle>
        <Button variant="outline" onClick={clear}>
          Clear filters
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Filters inspect retained line text. Stream notices stay visible. Removed text is
        unavailable.
      </p>
    </div>
  );
}
