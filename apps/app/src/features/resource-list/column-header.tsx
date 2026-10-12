// Headers share the virtualized list's ARIA grid pattern.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import type { Sort } from "@hukube/engine-client";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@hukube/ui/components/context-menu";
import { cn } from "@hukube/ui/lib/utils";
import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  columnSort,
  moveColumn,
  moveColumnTo,
  showColumn,
  type ResolvedColumnLayout,
  type StoredColumnLayout,
} from "./column-layout.ts";
import type { ListColumn } from "./columns.ts";

/** A sortable header that can be dragged, with a menu to hide or move its column. */
export function ColumnHeader({
  column,
  layout,
  sort,
  onSort,
  onEdit,
}: {
  column: ListColumn;
  layout: ResolvedColumnLayout;
  sort: Sort;
  onSort: (sort: Sort) => void;
  onEdit: (layout: StoredColumnLayout) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const currentLayout = useRef(layout);
  useLayoutEffect(() => {
    currentLayout.current = layout;
  }, [layout]);
  const press = useRef<
    { pointer: number; x: number; y: number; dragging: boolean; position: number } | undefined
  >(undefined);
  const suppressClick = useRef(false);
  const stopListening = useRef<() => void>(undefined);
  useEffect(() => () => stopListening.current?.(), []);
  const [marker, setMarker] = useState<number>();
  const by = columnSort(column);
  const active = sort.field === by.field && sort.column === by.column;
  const index = layout.shown.findIndex((c) => c.id === column.id);
  const edit = (value: StoredColumnLayout | undefined) => {
    if (value !== undefined) onEdit(value);
  };
  const move = (direction: -1 | 1) => {
    edit(moveColumn(layout, column.id, direction));
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  };
  const cancel = () => {
    const current = press.current;
    press.current = undefined;
    stopListening.current?.();
    stopListening.current = undefined;
    if (current?.dragging) suppressClick.current = true;
    if (current && ref.current?.hasPointerCapture(current.pointer))
      ref.current.releasePointerCapture(current.pointer);
    setMarker(undefined);
  };
  const escape = (event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  const pointerMove = (event: globalThis.PointerEvent) => {
    const current = press.current;
    if (!current || current.pointer !== event.pointerId || !ref.current) return;
    if (event.buttons === 0) {
      cancel();
      return;
    }
    if (!current.dragging && Math.hypot(event.clientX - current.x, event.clientY - current.y) <= 5)
      return;
    if (!current.dragging) {
      current.dragging = true;
      ref.current.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const headers = Array.from(
      ref.current.parentElement!.querySelectorAll<HTMLButtonElement>("[data-column-id]"),
    );
    const others = headers.filter((header) => header.dataset.columnId !== column.id);
    const next = others.findIndex((header) => {
      const rect = header.getBoundingClientRect();
      return event.clientX < rect.left + rect.width / 2;
    });
    current.position = next === -1 ? others.length : next;
    const target = others[current.position];
    const edge = target
      ? target.getBoundingClientRect().left
      : others.at(-1)?.getBoundingClientRect().right;
    setMarker(
      (edge ?? ref.current.getBoundingClientRect().left) - ref.current.getBoundingClientRect().left,
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            ref={ref}
            type="button"
            role="columnheader"
            aria-label={column.name}
            data-column-id={column.id}
            aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
            onClick={(event) => {
              if (suppressClick.current) {
                suppressClick.current = false;
                // A drag release can click, but keyboard activation has no click count.
                if (event.detail > 0) return;
              }
              onSort({ ...by, desc: active ? !sort.desc : false });
            }}
            onPointerDown={(pressEvent) => {
              if (
                pressEvent.button !== 0 ||
                (pressEvent.pointerType !== "mouse" && pressEvent.pointerType !== "pen")
              )
                return;
              cancel();
              suppressClick.current = false;
              press.current = {
                pointer: pressEvent.pointerId,
                x: pressEvent.clientX,
                y: pressEvent.clientY,
                dragging: false,
                position: index,
              };
              // Listen outside the header until the threshold captures the pointer:
              // one fast move can already land over another header.
              const release = (event: globalThis.PointerEvent) => {
                const current = press.current;
                if (!current || current.pointer !== event.pointerId) return;
                if (current.dragging)
                  edit(moveColumnTo(currentLayout.current, column.id, current.position));
                cancel();
              };
              const pointerCancel = (event: globalThis.PointerEvent) => {
                if (press.current?.pointer === event.pointerId) cancel();
              };
              document.addEventListener("pointermove", pointerMove);
              document.addEventListener("pointerup", release);
              document.addEventListener("pointercancel", pointerCancel);
              document.addEventListener("keydown", escape);
              stopListening.current = () => {
                document.removeEventListener("pointermove", pointerMove);
                document.removeEventListener("pointerup", release);
                document.removeEventListener("pointercancel", pointerCancel);
                document.removeEventListener("keydown", escape);
              };
            }}
            onLostPointerCapture={cancel}
            className={cn(
              "relative flex h-full min-w-0 items-center gap-1 text-left font-sans text-xs outline-none select-none hover:text-foreground focus-visible:text-foreground",
              column.numeric && "justify-end",
            )}
          />
        }
      >
        <span className="truncate">{column.name}</span>
        {active && (
          <HugeiconsIcon
            icon={sort.desc ? ArrowDown01Icon : ArrowUp01Icon}
            strokeWidth={2}
            className="size-3"
          />
        )}
        {marker !== undefined && (
          <span
            aria-hidden
            data-column-drop-marker
            className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-primary"
            style={{ left: marker }}
          />
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem
            disabled={layout.shown.length === 1}
            onClick={() => edit(showColumn(layout, column.id, false))}
          >
            Hide
          </ContextMenuItem>
          <ContextMenuItem disabled={index === 0} onClick={() => move(-1)}>
            Move left
          </ContextMenuItem>
          <ContextMenuItem disabled={index === layout.shown.length - 1} onClick={() => move(1)}>
            Move right
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
