// Virtualized rows must be absolutely positioned, so the list uses divs with
// the ARIA grid pattern instead of a table; the grid handles the keyboard.
/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events */
import type { Column, Row, Sort } from "@hukube/engine-client";
import { useSubscription } from "@hukube/engine-client/react";
import { formatAge, type TypeKey } from "@hukube/k8s";
import { Button } from "@hukube/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hukube/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hukube/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@hukube/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@hukube/ui/components/select";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { cn } from "@hukube/ui/lib/utils";
import { Search01Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { useNamespaces } from "@/features/namespaces/use-namespaces.ts";
import { useWorkspace } from "@/features/workspace/workspace-context.tsx";
import { useNow } from "@/lib/use-now.ts";

import { ColumnHeaders } from "./column-header.tsx";
import { resolveColumnLayout, showColumn, shownSort } from "./column-layout.ts";
import {
  cellText,
  gridLayout,
  growWidths,
  noValue,
  type ColumnWidths,
  type ListColumn,
} from "./columns.ts";
import { listQuery, rowAt, windowFor } from "./query-window.ts";
import { useColumnLayout } from "./use-column-layout.ts";

const rowHeight = 26;
// The header scrolls sideways with the rows and stays at the top, so the rows
// start this far into the scrolling element. It matches the header's `h-7`.
const headerHeight = 28;
const allNamespaces = null;

interface ResourceListPanelProps {
  panelId: string;
  type: TypeKey;
  /** Called when the user works with the list, which pins its Preview Tab. */
  onInteract: () => void;
}

/** A live, virtualized list of every Resource of one type. */
export function ResourceListPanel({ panelId, type, onInteract }: ResourceListPanelProps) {
  const { cluster, types, openResource } = useWorkspace();
  const info = types.get(type);
  const [nameFilter, setNameFilter] = useState("");
  const [selectorFilter, setSelectorFilter] = useState("");
  const [namespace, setNamespace] = useState<string | null>(allNamespaces);
  const [sort, setSort] = useState<Sort>({ field: "name" });
  const [selected, setSelected] = useState<number>();
  const deferredName = useDeferredValue(nameFilter);
  const deferredSelector = useDeferredValue(selectorFilter);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const [total, setTotal] = useState(0);
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
  });
  const items = virtualizer.getVirtualItems();
  const window = windowFor(items[0]?.index ?? 0, items.at(-1)?.index ?? 0);

  const where = useMemo(
    () => listQuery(type, { namespace, name: deferredName, selector: deferredSelector }),
    [type, namespace, deferredName, deferredSelector],
  );
  const filtered = Boolean(namespace || deferredName.trim() || deferredSelector.trim());
  const { stored, put } = useColumnLayout(type);
  // Query data supplies the available cells; keep it while a derived sort changes.
  const [columnData, setColumnData] = useState<{ columns?: Column[]; rows: Row[] }>({ rows: [] });
  const resolved = useMemo(
    () =>
      resolveColumnLayout({
        type,
        namespaced: info?.namespaced ?? false,
        allNamespaces: namespace === allNamespaces,
        columns: columnData.columns,
        rows: columnData.rows,
        stored: stored ?? null,
      }),
    [type, info?.namespaced, namespace, columnData, stored],
  );
  const columns = stored === undefined ? [] : resolved.shown;
  const effectiveSort = shownSort(sort, columns);
  const { data, error } = useSubscription(
    "resources.query",
    info && info.state !== "forbidden"
      ? { cluster, where, sort: effectiveSort, columns: true, ...window }
      : undefined,
  );
  if (data && data.total !== total) setTotal(data.total);

  if (data && (data.columns !== columnData.columns || data.rows !== columnData.rows))
    setColumnData({ columns: data.columns, rows: data.rows });
  const [widths, setWidths] = useState<ColumnWidths>(() => new Map());
  const grown = growWidths(widths, columns, data?.rows ?? []);
  if (grown !== widths) setWidths(grown);
  const layout = gridLayout(columns, grown, resolved.spare);
  const gridColumns: CSSProperties = { gridTemplateColumns: layout.template };

  const open = (row: Row | undefined, preview: boolean) => {
    if (!row) return;
    onInteract();
    openResource(
      { type: row.type, namespace: row.namespace ?? "", name: row.name },
      { preview, beside: panelId },
    );
    // Previews keep focus in the list so arrow keys keep browsing.
    if (preview) requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));
  };
  const select = (index: number) => {
    setSelected(index);
    virtualizer.scrollToIndex(index);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const current = selected ?? -1;
    if (e.key === "ArrowDown" && current < total - 1) select(current + 1);
    else if (e.key === "ArrowUp" && current > 0) select(current - 1);
    else if (e.key === "Enter" && selected !== undefined) open(rowAt(data, selected), false);
    else if (e.key === " " && selected !== undefined) open(rowAt(data, selected), true);
    else return;
    e.preventDefault();
  };

  if (types.size > 0 && !info) {
    return (
      <Notice
        title="Resource type not served"
        description={`The cluster no longer serves ${type}.`}
      />
    );
  }
  if (info?.state === "forbidden") {
    return (
      <Notice
        title="Not permitted"
        description={`Your credentials cannot list ${type} in this cluster.`}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <h2 className="font-semibold">{info?.kind ?? type}</h2>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {data ? data.total : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" disabled={stored === undefined} />}
            >
              Columns
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-48">
              <DropdownMenuGroup>
                {resolved.available.map((column) => {
                  const shown = columns.some((c) => c.id === column.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={shown}
                      closeOnClick={false}
                      disabled={
                        (shown && columns.length === 1) ||
                        (column.source === "namespace" && namespace !== allNamespaces)
                      }
                      onCheckedChange={(checked) => {
                        onInteract();
                        const value = showColumn(resolved, column.id, checked);
                        if (value !== undefined) void put(value);
                      }}
                    >
                      {column.name}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={stored == null}
                onClick={() => {
                  onInteract();
                  void put(null);
                }}
              >
                Reset to default
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {info?.namespaced && (
            <NamespaceSelect cluster={cluster} value={namespace} onChange={setNamespace} />
          )}
          <InputGroup className="h-7 w-56">
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Filter by name"
              placeholder="Filter by name"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
            />
          </InputGroup>
          <InputGroup className="h-7 w-56">
            <InputGroupAddon>
              <HugeiconsIcon icon={Tag01Icon} strokeWidth={2} />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Filter by label selector"
              placeholder="Label selector"
              className="font-mono"
              value={selectorFilter}
              onChange={(e) => setSelectorFilter(e.target.value)}
            />
          </InputGroup>
        </div>
      </div>

      {error && <p className="px-3 py-2 text-destructive">{error.message}</p>}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-auto">
          {/* Column widths are in `ch`, so everything inside uses the cells' font. */}
          <div
            className="flex min-h-full min-w-full flex-col font-mono"
            style={{ minWidth: `max(100%, ${layout.minWidth})` }}
          >
            {/* The header keeps the rows' font, so that `ch` is as wide in both. */}
            <div
              role="row"
              className="sticky top-0 z-10 grid h-7 shrink-0 gap-x-3 border-b bg-background px-3 text-muted-foreground"
              style={gridColumns}
            >
              {stored !== undefined && (
                <ColumnHeaders
                  layout={resolved}
                  scrollRef={scrollRef}
                  sort={effectiveSort}
                  onSort={setSort}
                  onEdit={(value) => {
                    onInteract();
                    void put(value);
                  }}
                />
              )}
            </div>

            <div
              ref={gridRef}
              role="grid"
              aria-label={`${info?.kind ?? type} resources`}
              aria-rowcount={total}
              tabIndex={0}
              onKeyDown={onKeyDown}
              className="relative flex-1 outline-none"
              style={{ minHeight: virtualizer.getTotalSize() }}
            >
              {items.map((item) => (
                <ListRow
                  key={item.key}
                  row={stored === undefined ? undefined : rowAt(data, item.index)}
                  top={item.start - headerHeight}
                  gridColumns={gridColumns}
                  columns={columns}
                  selected={item.index === selected}
                  onClick={() => {
                    setSelected(item.index);
                    open(rowAt(data, item.index), true);
                  }}
                  onDoubleClick={() => open(rowAt(data, item.index), false)}
                />
              ))}
            </div>
          </div>
        </div>

        {data?.total === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-7 bottom-0 flex">
            <Notice
              title={filtered ? "No matches" : `No ${info?.kind ?? type} resources`}
              description={
                filtered
                  ? "Nothing matches the current filters."
                  : "The cluster has none right now. This list updates live."
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface ListRowProps {
  row: Row | undefined;
  top: number;
  gridColumns: CSSProperties;
  columns: ListColumn[];
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

function ListRow({
  row,
  top,
  gridColumns,
  columns,
  selected,
  onClick,
  onDoubleClick,
}: ListRowProps) {
  const now = useNow();
  return (
    <div
      role="row"
      aria-selected={selected}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ ...gridColumns, transform: `translateY(${top}px)`, height: rowHeight }}
      className={cn(
        "absolute inset-x-0 top-0 grid cursor-default items-center gap-x-3 px-3 hover:bg-accent",
        selected && "bg-cluster-subtle hover:bg-cluster-subtle",
      )}
    >
      {row ? (
        columns.map((column) => {
          if (column.source === "cell")
            return <ListCell key={column.id} column={column} cells={row.cells} />;
          return (
            <span
              key={column.id}
              role="gridcell"
              className={cn(
                "truncate font-mono",
                column.source !== "name" && "text-muted-foreground",
                column.source === "age" && "tabular-nums",
              )}
              title={column.source === "age" ? row.createdAt : undefined}
            >
              {column.source === "name"
                ? row.name
                : column.source === "namespace"
                  ? row.namespace
                  : formatAge(new Date(row.createdAt), new Date(now))}
            </span>
          );
        })
      ) : (
        <Skeleton className="h-3 w-48" />
      )}
    </div>
  );
}

/** One cell of a Row. A Row has no cells until the Engine has fetched them. */
function ListCell({ column, cells }: { column: ListColumn; cells: unknown[] | undefined }) {
  const text = cells && column.index !== undefined ? cellText(cells[column.index]) : "";
  return (
    <span
      role="gridcell"
      title={text}
      className={cn(
        "truncate",
        column.numeric && "text-right tabular-nums",
        text === noValue && "text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}

function NamespaceSelect({
  cluster,
  value,
  onChange,
}: {
  cluster: string;
  value: string | null;
  onChange: (ns: string | null) => void;
}) {
  const namespaces = useNamespaces(cluster);
  const items = [
    { label: "All namespaces", value: allNamespaces },
    ...(namespaces?.names ?? []).map((name) => ({ label: name, value: name })),
  ];
  return (
    <Select items={items} value={value} onValueChange={(v) => onChange(v)}>
      <SelectTrigger size="sm" className="w-48 font-mono" aria-label="Namespace">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value} className="font-mono">
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function Notice({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
