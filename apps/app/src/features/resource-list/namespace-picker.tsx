import type { TypeState } from "@hukube/engine-client";
import { Button } from "@hukube/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxStatus,
  ComboboxTrigger,
  useComboboxFilteredItems,
} from "@hukube/ui/components/combobox";
import { InputGroupAddon } from "@hukube/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { cn } from "@hukube/ui/lib/utils";
import { Cancel01Icon, Layers01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { useNamespaces, type Namespaces } from "@/features/namespaces/use-namespaces.ts";
import { useWorkspace } from "@/features/workspace/workspace-context.tsx";

import {
  allNamespacesItem,
  missingNamespaces,
  namespaceLabel,
  nextSelection,
  pickerRows,
} from "./namespace-selection.ts";

const rowHeight = 28;
const count = new Intl.NumberFormat();

type Virtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;

interface NamespacePickerProps {
  /** The chosen Namespaces, sorted; empty for All namespaces. */
  value: readonly string[];
  onChange: (value: string[]) => void;
}

/**
 * The Namespace control of a Resource list: a filterable checklist of the
 * Cluster's Namespaces in a popup, and an × that returns to All namespaces.
 * The popup closes when its Workspace is hidden or the window is out of date,
 * because it renders outside the frozen content.
 */
export function NamespacePicker({ value, onChange }: NamespacePickerProps) {
  const { cluster, active, types } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The Namespaces chosen when the popup opened stay first while it is open.
  const [pinned, setPinned] = useState<readonly string[]>(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const virtualizerRef = useRef<Virtualizer | null>(null);

  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) setOpen(false);
  }
  const shown = open && active;

  const state = types.get("namespaces")?.state;
  const loaded = useNamespaces(cluster);
  const search = query.trim();
  // Whether to search comes from the unfiltered list, so it cannot flip as
  // search results arrive.
  const searching = shown && search !== "" && loaded !== undefined && !loaded.complete;
  const found = useNamespaces(cluster, searching, search);
  // Until the first search result arrives, the loaded names are narrowed instead.
  const names = (searching ? found : undefined) ?? loaded;
  const pending = searching && (!found || found.stale);

  const rows = useStableRows(
    useMemo(
      () =>
        pickerRows({ names: names?.names ?? [], pinned, chosen: value, filtering: query !== "" }),
      [names, pinned, value, query],
    ),
  );
  const missing = useMemo(
    () => missingNamespaces(value, loaded?.names, !!loaded?.complete && state === "ready"),
    [value, loaded, state],
  );
  const selected = useMemo(() => (value.length > 0 ? [...value] : [allNamespacesItem]), [value]);
  const label = namespaceLabel(value);

  return (
    <Combobox
      multiple
      virtualized
      autoHighlight
      items={rows}
      value={selected}
      onValueChange={(next) => {
        const selection = nextSelection(value, next);
        if (selection.join("\n") !== value.join("\n")) onChange(selection);
      }}
      inputValue={query}
      onInputValueChange={(next, details) => {
        // Keep the filter after a pick, selected, so several matches can be
        // checked and the next keystroke starts a new filter.
        if (details.isItemPress) {
          details.cancel();
          inputRef.current?.select();
          return;
        }
        setQuery(next);
      }}
      open={shown}
      onOpenChange={(next) => {
        if (next) {
          setPinned(value);
          setQuery("");
        }
        setOpen(next);
      }}
      onItemHighlighted={(item, { reason, index }) => {
        const virtualizer = virtualizerRef.current;
        if (item === undefined || !virtualizer) return;
        // The list scrolls a rendered row into view itself, but the first and
        // last rows may not be rendered when the highlight wraps around.
        const isStart = index === 0;
        const isEnd = index === virtualizer.options.count - 1;
        if (reason === "none" || (reason === "keyboard" && (isStart || isEnd))) {
          queueMicrotask(() =>
            virtualizer.scrollToIndex(index, { align: isEnd ? "start" : "end" }),
          );
        }
      }}
    >
      <div className="flex h-7 w-56 min-w-0">
        <ComboboxTrigger
          ref={triggerRef}
          aria-label="Namespace"
          className={cn(
            "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input bg-input/20 px-2 text-left text-xs/relaxed whitespace-nowrap transition-colors outline-none hover:bg-input/50 focus-visible:z-10 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 aria-expanded:bg-input/50 dark:bg-input/30 dark:hover:bg-input/60 dark:aria-expanded:bg-input/60 [&_svg]:shrink-0",
            value.length > 0 && "rounded-r-none border-r-0",
          )}
        >
          <HugeiconsIcon
            icon={Layers01Icon}
            strokeWidth={2}
            aria-hidden
            className="size-3.5 text-muted-foreground"
          />
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {label.name === undefined ? (
              <span className="truncate">{label.text}</span>
            ) : (
              <span translate="no" title={label.name} className="min-w-0 truncate font-mono">
                {label.name}
              </span>
            )}
            {label.more && (
              <>
                <span aria-hidden className="shrink-0 text-muted-foreground tabular-nums">
                  {label.more}
                </span>
                <span className="sr-only"> {label.moreText}</span>
              </>
            )}
          </span>
        </ComboboxTrigger>
        {value.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label="Show all namespaces"
                  className="h-7 w-7 rounded-l-none border-input border-l-0 bg-input/20 px-0 text-muted-foreground transition-colors hover:bg-input/50 hover:text-foreground focus-visible:z-10 dark:bg-input/30 dark:hover:bg-input/60"
                  onClick={() => {
                    onChange([]);
                    // The × unmounts itself, so focus would fall to the body.
                    triggerRef.current?.focus();
                  }}
                />
              }
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
            </TooltipTrigger>
            <TooltipContent>Show all namespaces</TooltipContent>
          </Tooltip>
        )}
      </div>
      <ComboboxContent
        aria-label="Namespaces"
        className="w-80 max-w-[min(28rem,var(--available-width))] min-w-(--anchor-width) motion-reduce:animate-none!"
      >
        <ComboboxInput
          ref={inputRef}
          showTrigger={false}
          aria-label="Filter namespaces"
          placeholder="Filter namespaces"
          autoComplete="off"
          spellCheck={false}
        >
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden />
          </InputGroupAddon>
        </ComboboxInput>
        <ComboboxStatus>{statusText(state, loaded, searching, found)}</ComboboxStatus>
        <ComboboxEmpty>{pending ? null : "No namespaces match."}</ComboboxEmpty>
        <ComboboxList aria-label="Namespaces" className="max-h-none overflow-visible p-0">
          <VirtualRows open={shown} missing={missing} virtualizerRef={virtualizerRef} />
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** The Status line: loading, errors, and Namespaces past the loaded ones. */
function statusText(
  state: TypeState | undefined,
  loaded: Namespaces | undefined,
  searching: boolean,
  found: Namespaces | undefined,
): string {
  if (state === "forbidden") return "Your credentials cannot list Namespaces.";
  if (state === "failed") return "Could not list Namespaces.";
  if (!loaded || state !== "ready") return "Loading namespaces…";
  if (loaded.complete) return "";
  if (!searching) {
    return `Showing ${count.format(loaded.names.length)} of ${count.format(loaded.total)} namespaces. Type to search the rest.`;
  }
  if (!found || found.stale) return "Searching…";
  if (!found.complete) {
    return `Showing ${count.format(found.names.length)} of ${count.format(found.total)} matches. Type more to narrow them down.`;
  }
  return "";
}

/**
 * Keeps the previous rows while they are unchanged, so a check that does not
 * change the rows does not hand Base UI a new list.
 */
function useStableRows(rows: string[]): string[] {
  const [stable, setStable] = useState(rows);
  const same = stable.length === rows.length && stable.every((row, i) => row === rows[i]);
  if (!same) setStable(rows);
  return same ? stable : rows;
}

/** The popup's rows, virtualized as in Base UI's virtualized Combobox example. */
function VirtualRows({
  open,
  missing,
  virtualizerRef,
}: {
  open: boolean;
  missing: ReadonlySet<string>;
  virtualizerRef: RefObject<Virtualizer | null>;
}) {
  const items = useComboboxFilteredItems<string>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    enabled: open,
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 20,
    paddingStart: 4,
    paddingEnd: 4,
    scrollPaddingStart: 4,
    scrollPaddingEnd: 4,
  });
  useImperativeHandle(virtualizerRef, () => virtualizer);
  const setScrollElement = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
      if (element) virtualizer.measure();
    },
    [virtualizer],
  );
  if (items.length === 0) return null;

  const totalSize = virtualizer.getTotalSize();
  return (
    <div
      role="presentation"
      ref={setScrollElement}
      // Chromium makes a scroller focusable, which would keep Tab inside the
      // popup; the rows are reached from the filter input instead.
      tabIndex={-1}
      className="h-[min(18rem,var(--total-size))] max-h-[calc(var(--available-height)-4.5rem)] overflow-y-auto overscroll-contain"
      style={{ "--total-size": `${totalSize}px` } as CSSProperties}
    >
      <div role="presentation" className="relative w-full" style={{ height: totalSize }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (item === undefined) return null;
          return (
            <ComboboxItem
              key={row.key}
              index={row.index}
              value={item}
              aria-setsize={items.length}
              aria-posinset={row.index + 1}
              className="absolute inset-x-1 top-0 w-auto pr-8"
              style={{ height: row.size, transform: `translateY(${row.start}px)` }}
            >
              {item === allNamespacesItem ? (
                <span className="truncate">All namespaces</span>
              ) : (
                <>
                  <span translate="no" title={item} className="min-w-0 flex-1 truncate font-mono">
                    {item}
                  </span>
                  {missing.has(item) && (
                    <span className="shrink-0 text-muted-foreground">Not found</span>
                  )}
                </>
              )}
            </ComboboxItem>
          );
        })}
      </div>
    </div>
  );
}
