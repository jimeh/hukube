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
} from "@dnd-kit/dom";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortableOperation, useSortable } from "@dnd-kit/react/sortable";
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
import { useRef, useState, type RefObject } from "react";

import {
  columnSort,
  moveColumn,
  moveColumnTo,
  showColumn,
  type StoredColumnLayout,
} from "./column-layout.ts";
import type { ListColumn } from "./columns.ts";
import { ColumnMenuItems, type ColumnMenuProps } from "./column-menu.tsx";

const sensors = [
  PointerSensor.configure({
    activationConstraints: () => [new PointerActivationConstraints.Distance({ value: 5 })],
    preventActivation: (event) => event.pointerType === "touch",
  }),
];
const plugins = [
  AutoScroller.configure({ threshold: { x: 0.2, y: 0 } }),
  Cursor,
  Feedback.configure({ feedback: "clone", dropAnimation: null }),
  PreventSelection,
];

interface ColumnHeadersProps extends ColumnMenuProps {
  sort: Sort;
  onSort: (sort: Sort) => void;
}

/** Headers stay aligned with the cells until the column is dropped. */
export function ColumnHeaders({
  layout,
  sort,
  onSort,
  onEdit,
  scrollRef,
  allNamespaces,
  hasStored,
}: ColumnHeadersProps & { scrollRef: RefObject<HTMLDivElement | null> }) {
  const [marker, setMarker] = useState<{ id: string; edge: "left" | "right" }>();
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
      }}
      onDragStart={({ operation }) => {
        if (operation.source) setMarker({ id: String(operation.source.id), edge: "left" });
      }}
      onDragOver={({ operation }) => {
        if (!isSortableOperation(operation)) return setMarker(undefined);
        const { source, target } = operation;
        if (!source || !target) return setMarker(undefined);
        setMarker({
          id: String(target.id),
          edge: target.index > source.index ? "right" : "left",
        });
      }}
      onDragEnd={({ operation, canceled }) => {
        setMarker(undefined);
        if (canceled || !isSortableOperation(operation)) return;
        const { source, target } = operation;
        if (!source || !target) return;
        // Resolve the destination against the layout current at release.
        const position = layout.shown.findIndex((column) => column.id === target.id);
        const value = moveColumnTo(layout, String(source.id), position);
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
          onSort={onSort}
          onEdit={onEdit}
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
  onSort,
  onEdit,
  marker,
  allNamespaces,
  hasStored,
}: ColumnHeadersProps & {
  column: ListColumn;
  index: number;
  marker: "left" | "right" | undefined;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const { isDragging } = useSortable({
    element: ref,
    target: targetRef,
    id: column.id,
    index,
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
              className={cn(
                "flex h-full w-full min-w-0 items-center gap-1 text-left font-sans text-xs outline-none select-none hover:text-foreground focus-visible:text-foreground data-[dnd-placeholder]:opacity-40",
                column.numeric && "justify-end",
                isDragging &&
                  "rounded-md bg-background px-2 text-foreground shadow-md ring-1 ring-border",
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem onClick={() => onSort({ ...by, desc: false })}>
              Sort ascending
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onSort({ ...by, desc: true })}>
              Sort descending
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
