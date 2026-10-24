// Headers share the virtualized list's ARIA grid pattern.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import {
  AutoScroller,
  Cursor,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
  PreventSelection,
  Scroller,
  type DragMoveEvent,
} from "@dnd-kit/dom";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import type { Sort } from "@hukube/engine-client";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@hukube/ui/components/context-menu";
import { cn } from "@hukube/ui/lib/utils";
import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import {
  columnSort,
  moveColumn,
  moveColumnTo,
  showColumn,
  type StoredColumnLayout,
} from "./column-layout.ts";
import type { ListColumn } from "./columns.ts";
import { dropEdge, dropPosition, headerCollision, type DropEdge } from "./column-drag.ts";
import { ColumnMenuItems, type ColumnMenuProps } from "./column-menu.tsx";

const sensors = [
  PointerSensor.configure({
    activationConstraints: () => [new PointerActivationConstraints.Distance({ value: 5 })],
    // Touch scrolls the list, and Control-click opens the context menu on macOS.
    preventActivation: (event) => event.pointerType === "touch" || event.ctrlKey,
  }),
];
const plugins = [
  AutoScroller.configure({ threshold: { x: 0.2, y: 0 } }),
  Cursor,
  Feedback.configure({ feedback: "clone", dropAnimation: null }),
  PreventSelection,
];

/** A drag in progress: the header a drop would go to, and the pointer. */
type DropOperation = Pick<DragMoveEvent["operation"], "target" | "position">;

/**
 * The header edge a drop would land on, while the pointer is level with the
 * row. It reads the header's place on screen, which auto-scroll changes
 * under a pointer that is not moving.
 */
function dropAt({ target, position }: DropOperation, pointer = position.current) {
  const bounds = target?.element?.getBoundingClientRect();
  if (!target || !bounds || pointer.y < bounds.top || pointer.y > bounds.bottom) return undefined;
  return { id: String(target.id), edge: dropEdge(pointer.x, bounds) };
}

interface ColumnHeadersProps extends ColumnMenuProps {
  sort: Sort;
  /** Whether sort is the one the list uses until the user chooses another. */
  sortIsDefault: boolean;
  /** Sorts the list; undefined returns it to its default sort. */
  onSort: (sort: Sort | undefined) => void;
}

/** Headers stay aligned with the cells until the column is dropped. */
export function ColumnHeaders({
  layout,
  sort,
  sortIsDefault,
  onSort,
  onEdit,
  onShow,
  scrollRef,
  allNamespaces,
  hasStored,
}: ColumnHeadersProps & { scrollRef: RefObject<HTMLDivElement | null> }) {
  const [marker, setMarker] = useState<{ id: string; edge: DropEdge }>();
  // A drop goes where the marker last showed, so the two cannot disagree.
  const shown = useRef(marker);
  const show = (next: typeof marker) => {
    shown.current = next;
    setMarker(next);
  };
  const stopFollowing = useRef<() => void>(undefined);
  useEffect(() => () => stopFollowing.current?.(), []);
  return (
    <DragDropProvider
      sensors={sensors}
      plugins={plugins}
      onBeforeDragStart={(_, manager) => {
        // dnd-kit stops ancestor discovery at the sticky header.
        const scroller = manager.registry.plugins.get(Scroller);
        if (scroller)
          scroller.getScrollableElements = () =>
            scrollRef.current ? new Set([scrollRef.current]) : null;
        // Auto-scroll moves the headers under a pointer that sends no events.
        const list = scrollRef.current;
        const follow = () => show(dropAt(manager.dragOperation));
        list?.addEventListener("scroll", follow, { passive: true });
        stopFollowing.current = () => list?.removeEventListener("scroll", follow);
      }}
      onDragStart={({ operation }) => {
        if (operation.source) show({ id: String(operation.source.id), edge: "left" });
      }}
      onDragOver={({ operation }) => show(dropAt(operation))}
      // dnd-kit sends a move before it applies it; `to` is where the pointer is.
      onDragMove={({ operation, to }) => show(dropAt(operation, to ?? undefined))}
      onDragEnd={({ operation, canceled }) => {
        stopFollowing.current?.();
        stopFollowing.current = undefined;
        const at = shown.current;
        show(undefined);
        if (canceled || !operation.source || !at) return;
        // Resolve the destination against the layout current at release.
        const source = String(operation.source.id);
        const position = dropPosition(
          layout.shown.map((column) => column.id),
          source,
          at.id,
          at.edge,
        );
        if (position === undefined) return;
        const value = moveColumnTo(layout, source, position);
        if (value !== undefined) onEdit(value);
      }}
    >
      {layout.shown.map((column, index) => (
        <ColumnHeader
          key={column.id}
          column={column}
          index={index}
          layout={layout}
          sort={sort}
          sortIsDefault={sortIsDefault}
          onSort={onSort}
          onEdit={onEdit}
          onShow={onShow}
          allNamespaces={allNamespaces}
          hasStored={hasStored}
          marker={marker?.id === column.id ? marker.edge : undefined}
        />
      ))}
    </DragDropProvider>
  );
}

/** A sortable header with sorting and column customization in its menu. */
function ColumnHeader({
  column,
  index,
  layout,
  sort,
  sortIsDefault,
  onSort,
  onEdit,
  onShow,
  marker,
  allNamespaces,
  hasStored,
}: ColumnHeadersProps & {
  column: ListColumn;
  index: number;
  marker: DropEdge | undefined;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const { isDragging } = useSortable({
    element: ref,
    target: targetRef,
    id: column.id,
    index,
    collisionDetector: headerCollision,
    plugins: [],
    transition: null,
  });
  const by = columnSort(column);
  const active = sort.field === by.field && sort.column === by.column;
  const edit = (value: StoredColumnLayout | undefined) => {
    if (value !== undefined) onEdit(value);
  };
  const move = (direction: -1 | 1) => {
    edit(moveColumn(layout, column.id, direction));
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  };
  return (
    <div ref={targetRef} className="relative h-full min-w-0">
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
                if (event.defaultPrevented) return;
                onSort({ ...by, desc: active ? !sort.desc : false });
              }}
              className="group/header h-full w-full min-w-0 rounded-sm text-left font-sans text-xs outline-none select-none hover:text-foreground focus-visible:text-foreground focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset data-[dnd-dragging]:outline-none data-[dnd-dragging]:ring-0"
            />
          }
        >
          <span
            className={cn(
              "flex h-full min-w-0 items-center gap-1 group-data-[dnd-dragging]/header:w-fit",
              column.numeric && "justify-end",
              isDragging &&
                "group-data-[dnd-dragging]/header:translate-y-8 group-data-[dnd-dragging]/header:rounded-md group-data-[dnd-dragging]/header:bg-background group-data-[dnd-dragging]/header:px-2 group-data-[dnd-dragging]/header:text-foreground group-data-[dnd-dragging]/header:shadow-md group-data-[dnd-dragging]/header:ring-1 group-data-[dnd-dragging]/header:ring-border",
            )}
          >
            <span className="truncate">{column.name}</span>
            {active && (
              <HugeiconsIcon
                icon={sort.desc ? ArrowDown01Icon : ArrowUp01Icon}
                strokeWidth={2}
                className="size-3"
              />
            )}
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem onClick={() => onSort({ ...by, desc: false })}>
              Sort ascending
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onSort({ ...by, desc: true })}>
              Sort descending
            </ContextMenuItem>
            <ContextMenuItem disabled={sortIsDefault} onClick={() => onSort(undefined)}>
              Reset sort
            </ContextMenuItem>
            <ContextMenuItem
              disabled={layout.shown.length === 1}
              onClick={() => edit(showColumn(layout, column.id, false))}
            >
              Hide column
            </ContextMenuItem>
            <ContextMenuItem disabled={index === 0} onClick={() => move(-1)}>
              Move left
            </ContextMenuItem>
            <ContextMenuItem disabled={index === layout.shown.length - 1} onClick={() => move(1)}>
              Move right
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ColumnMenuItems
            context
            layout={layout}
            allNamespaces={allNamespaces}
            hasStored={hasStored}
            onEdit={onEdit}
            onShow={onShow}
          />
        </ContextMenuContent>
      </ContextMenu>
      {marker !== undefined && (
        <span
          aria-hidden
          data-column-drop-marker
          className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-primary"
          style={{ [marker]: 0 }}
        />
      )}
    </div>
  );
}
