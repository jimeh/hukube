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
  shared,
  onChoose,
  setControls,
}: {
  available: readonly FacetEntry[];
  selected: Facet;
  shared: Omit<FacetProps, "showing">;
  onChoose: (value: string) => void;
  setControls: (element: HTMLDivElement | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
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
      setOverflow(container.scrollWidth > container.clientWidth);
      reveal();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(tabs);
    measure();
    return () => observer.disconnect();
  }, [reveal]);
  useLayoutEffect(reveal);
  return (
    <div className="@container/switcher flex h-8 shrink-0 items-center gap-2 border-b px-3">
      <div
        ref={scroller}
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <TabsList ref={list} variant="line" aria-label="Facets" activateOnFocus>
          {available.map(({ id, label, Badge, accessibleName }) => (
            <TabsTrigger
              key={id}
              value={id}
              aria-label={accessibleName?.({ ...shared, showing: selected === id })}
            >
              {label}
              {Badge && <Badge {...shared} showing={selected === id} />}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {overflow && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
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
                  aria-label={accessibleName?.({ ...shared, showing: selected === id })}
                >
                  {label}
                  {Badge && <Badge {...shared} showing={selected === id} />}
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
