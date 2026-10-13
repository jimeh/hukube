import { Button } from "@hukube/ui/components/button";
import {
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@hukube/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hukube/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { showColumn, type ResolvedColumnLayout, type StoredColumnLayout } from "./column-layout.ts";

export interface ColumnMenuProps {
  layout: ResolvedColumnLayout;
  allNamespaces: boolean;
  hasStored: boolean;
  onEdit: (layout: StoredColumnLayout | null) => void;
}

/** One checklist, rendered through either menu's primitives. */
export function ColumnMenuItems({
  layout,
  allNamespaces,
  hasStored,
  onEdit,
  context = false,
}: ColumnMenuProps & { context?: boolean }) {
  const Group = context ? ContextMenuGroup : DropdownMenuGroup;
  const CheckboxItem = context ? ContextMenuCheckboxItem : DropdownMenuCheckboxItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const shown = new Set(layout.shown.map((column) => column.id));
  return (
    <>
      <Group>
        {layout.available.map((column) => (
          <CheckboxItem
            key={column.id}
            checked={shown.has(column.id)}
            closeOnClick={false}
            disabled={
              (shown.has(column.id) && shown.size === 1) ||
              (column.source === "namespace" && !allNamespaces)
            }
            onCheckedChange={(checked) => {
              const value = showColumn(layout, column.id, checked);
              if (value !== undefined) onEdit(value);
            }}
          >
            {column.name}
          </CheckboxItem>
        ))}
      </Group>
      <Separator />
      <Group>
        <Item disabled={!hasStored} onClick={() => onEdit(null)}>
          Reset to default
        </Item>
      </Group>
    </>
  );
}

/** This cell sticks to the viewport edge, outside the sortable headers. */
export function CustomizeColumns({ loaded, ...menu }: ColumnMenuProps & { loaded: boolean }) {
  return (
    <div
      className="sticky right-0 z-10 -mr-3 flex items-center justify-center border-l bg-background"
      style={{ gridColumn: "-2 / -1" }}
    >
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" disabled={!loaded} />}
                aria-label="Customize columns"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>Customize columns</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-48">
          <ColumnMenuItems {...menu} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
