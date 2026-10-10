// Virtualized rows must be absolutely positioned, so the list uses divs with
// the ARIA grid pattern instead of a table; the grid handles the keyboard.
/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events */
import type { Row, Sort } from "@hukube/engine-client";
import { useSubscription } from "@hukube/engine-client/react";
import { formatAge, type TypeKey } from "@hukube/k8s";
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
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Search01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
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

import {
  cellText,
  gridLayout,
  growWidths,
  listColumns,
  noValue,
  type ColumnWidths,
  type ListColumn,
} from "./columns.ts";
import { listQuery, rowAt, windowFor } from "./query-window.ts";

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
  const { data, error } = useSubscription(
    "resources.query",
    info && info.state !== "forbidden"
      ? { cluster, where, sort, columns: true, ...window }
      : undefined,
  );
  if (data && data.total !== total) setTotal(data.total);

  const showNamespace = (info?.namespaced ?? false) && namespace === allNamespaces;
  const columns = useMemo(() => listColumns(data?.columns, data?.rows ?? []), [data]);
  const [widths, setWidths] = useState<ColumnWidths>({});
  const grown = growWidths(widths, columns, data?.rows ?? []);
  if (grown !== widths) setWidths(grown);
  const layout = gridLayout(showNamespace, columns, grown);
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
              <SortHeader by={{ field: "name" }} label="Name" sort={sort} onSort={setSort} />
              {showNamespace && (
                <SortHeader
                  by={{ field: "namespace" }}
                  label="Namespace"
                  sort={sort}
                  onSort={setSort}
                />
              )}
              {columns.map((column) => (
                <SortHeader
                  key={column.index}
                  by={{ field: "column", column: column.name }}
                  label={column.name}
                  alignRight={column.numeric}
                  sort={sort}
                  onSort={setSort}
                />
              ))}
              <SortHeader by={{ field: "age" }} label="Age" sort={sort} onSort={setSort} />
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
                  row={rowAt(data, item.index)}
                  top={item.start - headerHeight}
                  gridColumns={gridColumns}
                  columns={columns}
                  showNamespace={showNamespace}
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
  showNamespace: boolean;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

function ListRow({
  row,
  top,
  gridColumns,
  columns,
  showNamespace,
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
        <>
          <span role="gridcell" className="truncate font-mono">
            {row.name}
          </span>
          {showNamespace && (
            <span role="gridcell" className="truncate font-mono text-muted-foreground">
              {row.namespace}
            </span>
          )}
          {columns.map((column) => (
            <ListCell key={column.index} column={column} cells={row.cells} />
          ))}
          <span
            role="gridcell"
            className="font-mono text-muted-foreground tabular-nums"
            title={row.createdAt}
          >
            {formatAge(new Date(row.createdAt), new Date(now))}
          </span>
        </>
      ) : (
        <Skeleton className="h-3 w-48" />
      )}
    </div>
  );
}

/** One cell of a Row. A Row has no cells until the Engine has fetched them. */
function ListCell({ column, cells }: { column: ListColumn; cells: unknown[] | undefined }) {
  const text = cells ? cellText(cells[column.index]) : "";
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

function SortHeader({
  by,
  label,
  alignRight = false,
  sort,
  onSort,
}: {
  /** The order this header sorts by, ascending. */
  by: Sort;
  label: string;
  alignRight?: boolean;
  sort: Sort;
  onSort: (s: Sort) => void;
}) {
  const active = sort.field === by.field && sort.column === by.column;
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
      onClick={() => onSort({ ...by, desc: active ? !sort.desc : false })}
      className={cn(
        "flex h-full min-w-0 items-center gap-1 text-left font-sans text-xs outline-none hover:text-foreground focus-visible:text-foreground",
        alignRight && "justify-end",
      )}
    >
      <span className="truncate">{label}</span>
      {active && (
        <HugeiconsIcon
          icon={sort.desc ? ArrowDown01Icon : ArrowUp01Icon}
          strokeWidth={2}
          className="size-3"
        />
      )}
    </button>
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
