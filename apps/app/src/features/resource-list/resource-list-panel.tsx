// Virtualized rows must be absolutely positioned, so the list uses divs with
// the ARIA grid pattern instead of a table; the grid handles the keyboard.
/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events */
import type { Column, Row, Sort } from "@hukube/engine-client";
import { useSubscription } from "@hukube/engine-client/react";
import { formatAge, type ResourceAddress, type TypeKey } from "@hukube/k8s";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hukube/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@hukube/ui/components/input-group";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { cn } from "@hukube/ui/lib/utils";
import { Search01Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useDeferredValue,
  useLayoutEffect,
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
import { columnRevealDelta } from "./column-reveal.ts";
import { CustomizeColumns, type ColumnMenuProps } from "./column-menu.tsx";
import { defaultSort, resolveColumnLayout, sameSort, shownSort } from "./column-layout.ts";
import {
  cellDisplay,
  cellText,
  cellTime,
  gridLayout,
  growWidths,
  noValue,
  type ColumnWidths,
  type ListColumn,
} from "./columns.ts";
import { NamespacePicker } from "./namespace-picker.tsx";
import { emptyListNotice, missingNamespaces, readNamespaces } from "./namespace-selection.ts";
import {
  listQuery,
  rowAt,
  selectedIndex,
  selectionAt,
  steppedIndex,
  windowFor,
  type ListSelection,
} from "./query-window.ts";
import { useColumnLayout } from "./use-column-layout.ts";

const rowHeight = 26;
// The header scrolls sideways with the rows and stays at the top, so the rows
// start this far into the scrolling element. It matches the header's `h-7`.
const headerHeight = 28;
const noNamespaces: string[] = [];

interface ResourceListPanelProps {
  panelId: string;
  type: TypeKey;
  /** The chosen Namespaces from the Tab's params, which a restored layout may hold in any shape. */
  namespaces: unknown;
  /** Saves a new Namespace selection in the Tab's params, pinning its Preview Tab. */
  onNamespacesChange: (namespaces: string[]) => void;
  /** Called when the user works with the list, which pins its Preview Tab. */
  onInteract: () => void;
}

/** A live, virtualized list of every Resource of one type. */
export function ResourceListPanel({
  panelId,
  type,
  namespaces: namespacesParam,
  onNamespacesChange,
  onInteract,
}: ResourceListPanelProps) {
  const { cluster, types, openResource } = useWorkspace();
  const info = types.get(type);
  // A restarted Engine lists no Resource Types until its discovery completes,
  // so the list keeps the type's last known scope, and with it the Namespace
  // control and its open popup, until the type is listed again.
  const [scope, setScope] = useState({ type, namespaced: info?.namespaced });
  if (info && (scope.type !== type || scope.namespaced !== info.namespaced))
    setScope({ type, namespaced: info.namespaced });
  const namespaced = info?.namespaced ?? (scope.type === type && !!scope.namespaced);
  const [nameFilter, setNameFilter] = useState("");
  const [selectorFilter, setSelectorFilter] = useState("");
  const chosen = useMemo(() => readNamespaces(namespacesParam), [namespacesParam]);
  // Namespaces narrow only a namespaced type, so params left on a type whose
  // CRD changed scope cannot empty its list.
  const namespaces = namespaced ? chosen : noNamespaces;
  // Unset until the user chooses a sort, which leaves the type's default.
  const [sort, setSort] = useState<Sort>();
  const [selection, setSelection] = useState<ListSelection>();
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
    () =>
      listQuery(type, {
        namespaced,
        namespaces,
        name: deferredName,
        selector: deferredSelector,
      }),
    [type, namespaced, namespaces, deferredName, deferredSelector],
  );
  const filtered = Boolean(deferredName.trim() || deferredSelector.trim());
  const oneNamespace = namespaces.length === 1;
  const { stored, put } = useColumnLayout(type);
  // Query data supplies the available cells; keep it while a derived sort changes.
  const [columnData, setColumnData] = useState<{ columns?: Column[]; rows: Row[] }>({ rows: [] });
  const resolved = useMemo(
    () =>
      resolveColumnLayout({
        type,
        namespaced,
        oneNamespace,
        columns: columnData.columns,
        rows: columnData.rows,
        stored: stored ?? null,
      }),
    [type, namespaced, oneNamespace, columnData, stored],
  );
  const columns = stored === undefined ? [] : resolved.shown;
  const initialSort = defaultSort(
    type,
    stored === undefined ? undefined : resolved,
    columnData.columns,
  );
  const effectiveSort = shownSort(sort, columns, initialSort);
  const sortIsDefault = sameSort(effectiveSort, initialSort);
  const { data, error } = useSubscription(
    "resources.query",
    info && info.state !== "forbidden"
      ? { cluster, where, sort: effectiveSort, columns: true, ...window }
      : undefined,
  );
  if (data && data.total !== total) setTotal(data.total);
  // Only an empty list of chosen Namespaces needs to know which ones exist.
  const known = useNamespaces(cluster, namespaces.length > 0 && data?.total === 0);
  const namespacesState = types.get("namespaces")?.state;
  const missing = useMemo(
    () =>
      missingNamespaces(namespaces, known?.names, !!known?.complete && namespacesState === "ready"),
    [namespaces, known, namespacesState],
  );
  // The selection stays on its Resource while rows arrive and the list
  // re-sorts, and no row shows it while the window does not hold it. Only the
  // user's own moves scroll to it.
  const selected = useMemo(
    () => selection && selectedIndex(data, cluster, selection),
    [data, cluster, selection],
  );
  // Remember where the Resource was, for when the window no longer holds it.
  if (selection && selected !== undefined && selected !== selection.index)
    setSelection({ ...selection, index: selected });
  // A row selected before it loaded becomes its Resource once it has.
  if (selection && selection.key === undefined && rowAt(data, selection.index))
    setSelection(selectionAt(data, cluster, selection.index));

  if (data && (data.columns !== columnData.columns || data.rows !== columnData.rows))
    setColumnData({ columns: data.columns, rows: data.rows });
  const [widths, setWidths] = useState<ColumnWidths>(() => new Map());
  const now = useNow();
  const grown = growWidths(widths, columns, data?.rows ?? [], now);
  if (grown !== widths) setWidths(grown);
  const layout = gridLayout(columns, grown, resolved.spare);
  const gridColumns: CSSProperties = { gridTemplateColumns: layout.template };
  const [reveal, setReveal] = useState<{ id: string; menu: Element | null }>();
  useLayoutEffect(() => {
    if (!reveal) return;
    const scroll = scrollRef.current;
    const header = Array.from(scroll?.querySelectorAll<HTMLElement>("[data-column-id]") ?? []).find(
      (element) => element.dataset.columnId === reveal.id,
    );
    if (scroll && header) {
      const bounds = scroll.getBoundingClientRect();
      const actions = scroll.querySelector("[data-column-actions]")?.getBoundingClientRect();
      const left = bounds.left + scroll.clientLeft;
      // The browser stops at the list's end, where the last column can still
      // sit under the open checklist until it closes.
      scroll.scrollLeft += columnRevealDelta(
        header.getBoundingClientRect(),
        { left, right: Math.min(left + scroll.clientWidth, actions?.left ?? Infinity) },
        reveal.menu?.getBoundingClientRect(),
      );
    }
    setReveal(undefined);
  }, [reveal, resolved.shown]);
  const columnMenu: ColumnMenuProps = {
    layout: resolved,
    oneNamespace,
    hasStored: stored != null,
    onEdit: (value) => {
      onInteract();
      void put(value);
    },
    onShow: (id, menu) => setReveal({ id, menu }),
  };

  const open = (address: Omit<ResourceAddress, "cluster"> | undefined, preview: boolean) => {
    if (!address) return;
    onInteract();
    openResource(address, { preview, beside: panelId });
    // Previews keep focus in the list so arrow keys keep browsing.
    if (preview) requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));
  };
  const select = (index: number) => {
    setSelection(selectionAt(data, cluster, index));
    virtualizer.scrollToIndex(index);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    const next = step ? steppedIndex(selection, selected, step, total) : undefined;
    if (next !== undefined) select(next);
    // The selected Resource opens even when the window does not hold its row.
    else if (e.key === "Enter" && selection) open(selection.address, false);
    else if (e.key === " " && selection) open(selection.address, true);
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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <h2 className="font-semibold">{info?.kind ?? type}</h2>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {data ? data.total : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {namespaced && <NamespacePicker value={chosen} onChange={onNamespacesChange} />}
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
                  {...columnMenu}
                  scrollRef={scrollRef}
                  sort={effectiveSort}
                  sortIsDefault={sortIsDefault}
                  onSort={setSort}
                />
              )}
              <CustomizeColumns
                {...columnMenu}
                loaded={stored !== undefined}
                sortIsDefault={sortIsDefault}
                onResetSort={() => setSort(undefined)}
              />
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
                    const clicked = selectionAt(data, cluster, item.index);
                    setSelection(clicked);
                    open(clicked.address, true);
                  }}
                  onDoubleClick={() => open(selectionAt(data, cluster, item.index).address, false)}
                />
              ))}
            </div>
          </div>
        </div>

        {data?.total === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-7 bottom-0 flex">
            <Notice
              {...emptyListNotice({
                kind: info?.kind ?? type,
                chosen: namespaces,
                missing,
                filtered,
              })}
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
            return <ListCell key={column.id} column={column} cells={row.cells} now={now} />;
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

/**
 * One cell of a Row. A Row has no cells until the Engine has fetched them. A
 * timestamp cell shows a live age, as Age does, with its time in the title.
 */
function ListCell({
  column,
  cells,
  now,
}: {
  column: ListColumn;
  cells: unknown[] | undefined;
  now: number;
}) {
  const value = cells && column.index !== undefined ? cells[column.index] : undefined;
  const text = cells && column.index !== undefined ? cellDisplay(column, value, now) : "";
  const age = cellTime(column, value) !== undefined;
  return (
    <span
      role="gridcell"
      title={age ? cellText(value) : text}
      className={cn(
        "truncate",
        column.numeric && "text-right tabular-nums",
        age && "text-muted-foreground tabular-nums",
        text === noValue && "text-muted-foreground",
      )}
    >
      {text}
    </span>
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
