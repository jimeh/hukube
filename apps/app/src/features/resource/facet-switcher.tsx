import type { Facet } from "@hukube/k8s";
import { Button } from "@hukube/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@hukube/ui/components/dropdown-menu";
import { TabsList, TabsTrigger } from "@hukube/ui/components/tabs";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { FacetProps } from "./facet-props.ts";
import type { FacetEntry } from "./facets.ts";

/** Keeps every Facet reachable when its Pane is narrower than the tab list. */
export function FacetSwitcher({
  available,
  selected,
  visible,
  shared,
  onChoose,
  setControls,
  dirty = false,
}: {
  available: readonly FacetEntry[];
  selected: Facet;
  visible: boolean;
  shared: Omit<FacetProps, "showing" | "visible">;
  onChoose: (value: string) => void;
  dirty?: boolean;
  setControls: (element: HTMLDivElement | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [edges, setEdges] = useState({ start: false, end: false });
  const measureEdges = useCallback(() => {
    const container = scroller.current;
    if (!container) return;
    const start = container.scrollLeft > 0;
    const end = container.scrollLeft + container.clientWidth < container.scrollWidth - 1;
    setEdges((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    );
  }, []);
  const reveal = useCallback(() => {
    const container = scroller.current;
    const tab = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!container || !tab) return;
    const bounds = container.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    if (target.left < bounds.left) container.scrollLeft += target.left - bounds.left;
    else if (target.right > bounds.right) container.scrollLeft += target.right - bounds.right;
  }, []);
  useEffect(() => {
    const container = scroller.current;
    const tabs = list.current;
    if (!container || !tabs) return;
    const measure = () => {
      const button = more.current;
      const gap = button
        ? parseFloat(getComputedStyle(container.parentElement!).columnGap) || 0
        : 0;
      const availableWidth = container.clientWidth + (button ? button.offsetWidth + gap : 0);
      setOverflow(tabs.scrollWidth > availableWidth);
      reveal();
      measureEdges();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(tabs);
    measure();
    container.addEventListener("scroll", measureEdges);
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", measureEdges);
    };
  }, [reveal, measureEdges]);
  // A new array of the same Facets arrives with every live update, which must not undo a scroll.
  const facetIds = available.map((facet) => facet.id).join(" ");
  useLayoutEffect(() => {
    reveal();
    measureEdges();
    // The Facets, the selection, and the button change geometry. Scrolling must not reveal the tab.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [facetIds, selected, overflow, reveal, measureEdges]);
  return (
    <div className="@container/switcher flex h-8 shrink-0 items-center gap-2 border-b px-3">
      <div
        ref={scroller}
        style={{
          maskImage:
            edges.start || edges.end
              ? `linear-gradient(to right, ${edges.start ? "transparent, black 12px" : "black"}, ${edges.end ? "black calc(100% - 12px), transparent" : "black"})`
              : undefined,
        }}
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <TabsList ref={list} variant="line" aria-label="Facets" activateOnFocus>
          {available.map(({ id, label, Badge, accessibleName }) => (
            <TabsTrigger
              key={id}
              value={id}
              aria-label={accessibleName?.({
                ...shared,
                showing: selected === id,
                visible: visible && selected === id,
              })}
            >
              {label}
              {(id === "yaml" || id === "overview") && dirty && (
                <span className="size-1.5 rounded-full bg-foreground" aria-label="Unsaved edits" />
              )}
              {Badge && (
                <Badge {...shared} showing={selected === id} visible={visible && selected === id} />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {overflow && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
            ref={more}
            aria-label="More Facets"
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value={selected} onValueChange={onChoose}>
              {available.map(({ id, label, Badge, accessibleName }) => (
                <DropdownMenuRadioItem
                  key={id}
                  value={id}
                  aria-label={accessibleName?.({
                    ...shared,
                    showing: selected === id,
                    visible: visible && selected === id,
                  })}
                >
                  {label}
                  {(id === "yaml" || id === "overview") && dirty && (
                    <span
                      className="size-1.5 rounded-full bg-foreground"
                      aria-label="Unsaved edits"
                    />
                  )}
                  {Badge && (
                    <Badge
                      {...shared}
                      showing={selected === id}
                      visible={visible && selected === id}
                    />
                  )}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div ref={setControls} className="flex shrink-0 items-center" />
    </div>
  );
}
