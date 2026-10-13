// Indented rows use treegrid semantics while keeping the Resource list's keyboard interaction.
/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events */

import type { Column, Related, RelatedRow } from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import { formatAge, type ResourceAddress } from "@hukube/k8s";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { cn } from "@hukube/ui/lib/utils";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { cellText, noValue } from "@/features/resource-list/columns.ts";
import { useWorkspace } from "@/features/workspace/workspace-context.tsx";
import { useNow } from "@/lib/use-now.ts";

import type { FacetProps } from "./facet-props.ts";
import { Notice } from "./notice.tsx";
import { rememberPointerOpened } from "./pointer-opened.ts";

function relatedCount(related: SubscriptionState<Related>): number {
  return related.error?.code === "forbidden" || !related.data?.found ? 0 : related.data.total;
}

/** Names the full count even when the badge's text is capped. */
export function relatedTabName({ related }: FacetProps): string {
  const count = relatedCount(related);
  return count ? `Related, ${count} ${count === 1 ? "Resource" : "Resources"}` : "Related";
}

/** Shows the number of related Resources, including a retained value. */
export function RelatedBadge({ related }: FacetProps) {
  const count = relatedCount(related);
  return count ? (
    <span className="text-muted-foreground" aria-hidden="true">
      {count > 999 ? "999+" : count}
    </span>
  ) : null;
}

function keyedRows(rows: RelatedRow[], section: string) {
  const ancestors: string[] = [];
  return rows.map((row) => {
    ancestors.length = row.depth;
    // A reference that did not resolve may have no type or Namespace, so the
    // kind, API version, and UID keep two references with one name apart.
    const identity = JSON.stringify([
      row.type ?? "",
      row.namespace ?? "",
      row.name ?? "",
      row.uid ?? "",
      row.kind,
      row.apiVersion ?? "",
    ]);
    const key = JSON.stringify([
      section,
      ...ancestors,
      identity,
      row.status === "more" ? "more" : "",
    ]);
    if (row.status !== "more") ancestors[row.depth] = identity;
    return { row, key };
  });
}

function secondLine(
  row: RelatedRow,
  namespace: string,
  columns: Column[] | undefined,
  now: number,
) {
  switch (row.status) {
    case "missing":
      return `Not found. No ${row.kind} with this name and UID exists.`;
    case "unserved":
      return `This Cluster does not serve ${row.apiVersion} ${row.kind}.`;
    case "forbidden":
      return `Your credentials cannot list ${row.type}.`;
    case "failed":
      return `The Cluster cannot list ${row.type}.`;
    case "syncing":
      return `Loading ${row.type}…`;
    default: {
      const parts: { text: string; label?: string; value?: string }[] = [];
      if (row.namespace && row.namespace !== namespace) parts.push({ text: row.namespace });
      if (row.createdAt) parts.push({ text: formatAge(new Date(row.createdAt), new Date(now)) });
      columns?.forEach((column, index) => {
        const value = cellText(row.cells?.[index]);
        if (value !== noValue && value !== "")
          parts.push({ text: `${column.name} ${value}`, label: column.name, value });
      });
      return parts;
    }
  }
}

// The Related Facet of the tab a row opens takes focus when it mounts, so the
// arrow keys keep working. The record expires, because a tab that was already
// open mounts nothing, and a later tab for the same Resource must not take focus.
let focusOpened: { address: ResourceAddress; at: number } | undefined;
const focusOpenedFor = 2000;
function focusWhenOpened(address: ResourceAddress) {
  focusOpened = { address, at: performance.now() };
}
/** Shows ownership paths and descendants, with live Table text and stable selection. */
export function RelatedFacet({ address, kind, manifest, related, panelId }: FacetProps) {
  const { cluster, types, status, openResource } = useWorkspace();
  const now = useNow();
  const grid = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const id = useId();
  useLayoutEffect(() => {
    const opened = focusOpened;
    if (
      opened &&
      performance.now() - opened.at < focusOpenedFor &&
      opened.address.cluster === address.cluster &&
      opened.address.type === address.type &&
      opened.address.namespace === address.namespace &&
      opened.address.name === address.name &&
      grid.current
    ) {
      focusOpened = undefined;
      grid.current.focus({ preventScroll: true });
    }
  }, [address.cluster, address.type, address.namespace, address.name]);
  const [selected, setSelected] = useState<string>();
  const { data, error } = related;
  const sections = (data?.sections ?? [])
    .filter((section) => section.relationship === "owns")
    .toSorted((a, b) => (a.direction === b.direction ? 0 : a.direction === "in" ? -1 : 1))
    .map((section) => ({ ...section, keyed: keyedRows(section.rows, section.direction) }));
  const openable = sections
    .flatMap((section) => section.keyed)
    .filter(({ row }) => row.status === "found");
  const openableIndex = new Map(openable.map(({ key }, index) => [key, index]));
  if (selected && !openableIndex.has(selected)) setSelected(undefined);
  const columns = new Map(data?.types.map((type) => [type.type, type.columns]));
  const forbidden = [...types.values()].filter((type) => type.state === "forbidden").length;
  const omittedText = `Resources of ${forbidden.toLocaleString("en-US")} ${forbidden === 1 ? "Resource Type" : "Resource Types"} your credentials cannot list are not shown.`;
  const warning =
    error?.message ??
    (status?.phase === "failed" ? status.message || "the Cluster cannot be reached" : undefined);
  const omitted = forbidden > 0 && <p className="px-3 py-2 text-muted-foreground">{omittedText}</p>;
  const open = (row: RelatedRow, preview: boolean) => {
    if (row.status !== "found" || !row.type || !row.name) return undefined;
    const opened = { type: row.type, namespace: row.namespace ?? "", name: row.name };
    // The destination is recorded before its Facet mounts.
    focusWhenOpened({ cluster, ...opened });
    openResource(opened, { preview, pane: panelId });
    return opened;
  };
  const select = (key: string) => {
    setSelected(key);
    const container = grid.current;
    const element = elements.current.get(key);
    if (!container || !element) return;
    const bounds = container.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    const heading = element
      .closest('[role="rowgroup"]')
      ?.querySelector('[role="columnheader"]')?.parentElement;
    const visibleTop = bounds.top + (heading?.getBoundingClientRect().height ?? 0);
    if (target.top < visibleTop) container.scrollTop += target.top - visibleTop;
    else if (target.bottom > bounds.bottom) container.scrollTop += target.bottom - bounds.bottom;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const index = openable.findIndex(({ key }) => key === selected);
    if (event.key === "ArrowDown" && index < openable.length - 1) select(openable[index + 1]!.key);
    else if (event.key === "ArrowUp" && index > 0) select(openable[index - 1]!.key);
    else if ((event.key === "Enter" || event.key === " ") && index >= 0)
      open(openable[index]!.row, event.key === " ");
    else return;
    event.preventDefault();
  };
  if (error?.code === "forbidden")
    return (
      <Notice
        title="Not permitted"
        description={`Your credentials cannot list ${address.type}, so hukube cannot tell what this ${kind} is related to.`}
      />
    );
  if (error && !data)
    return (
      <Notice
        title="Related Resources unavailable"
        description={`${error.message} hukube keeps trying.`}
      />
    );
  const loading = !data || (!data.found && !manifest.data?.deleted);
  const activeIndex = openable.findIndex(({ key }) => key === selected);
  return (
    <div className="relative h-full min-h-0">
      <div
        ref={grid}
        role="treegrid"
        aria-label="Related Resources"
        aria-busy={loading}
        aria-activedescendant={activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="peer h-full overflow-auto outline-none"
      >
        {warning !== undefined && (
          <p className="border-b px-3 py-2 text-destructive">
            Related Resources may be out of date: {warning}
          </p>
        )}
        {loading ? (
          <div>
            <div role="row" className="flex h-7 items-center border-b px-3">
              <div role="columnheader">
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
            {[0, 1, 2].map((index) => (
              <div key={index} role="row" aria-level={1} className="h-12 px-3 py-1.5">
                <div role="gridcell" className="flex flex-col gap-2">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-3 w-52" />
                </div>
              </div>
            ))}
          </div>
        ) : !data.found || sections.length === 0 ? (
          <div className="flex h-full flex-col">
            <div className="flex-1">
              <Notice
                title={data.found ? "No owners or owned Resources" : "Nothing related"}
                description={
                  !data.found
                    ? `This ${kind} does not exist right now. Related Resources appear here if it is created.`
                    : forbidden > 0
                      ? `No Resource that your credentials can list owns this ${kind} or is owned by it. ${omittedText}`
                      : `No Resource owns this ${kind}, and it owns none. Owners and owned Resources appear here as they change.`
                }
              />
            </div>
          </div>
        ) : (
          <>
            {sections.map((section) => (
              <div key={section.direction} role="rowgroup">
                <div
                  role="row"
                  className="sticky top-0 z-10 flex h-7 items-center gap-2 border-b bg-background px-3 text-xs text-muted-foreground"
                >
                  <div role="columnheader">{section.direction === "in" ? "Owned by" : "Owns"}</div>
                  {section.direction === "out" && (
                    <span>{section.total.toLocaleString("en-US")}</span>
                  )}
                </div>
                {section.keyed.map(({ row, key }, rowIndex) => {
                  const parts = secondLine(
                    row,
                    address.namespace,
                    columns.get(row.type ?? ""),
                    now,
                  );
                  const details =
                    typeof parts === "string" ? parts : parts.map((part) => part.text).join(" · ");
                  let older = false;
                  if (row.status === "more") {
                    for (let previous = rowIndex - 1; previous >= 0; previous--) {
                      const sibling = section.rows[previous]!;
                      if (sibling.depth < row.depth) break;
                      if (
                        sibling.depth === row.depth &&
                        sibling.status === "found" &&
                        sibling.type === row.type
                      ) {
                        older = true;
                        break;
                      }
                    }
                  }
                  const canOpen = row.status === "found";
                  const index = openableIndex.get(key);
                  return (
                    <div
                      key={key}
                      id={canOpen ? `${id}-${index}` : undefined}
                      ref={(element) => {
                        if (element) elements.current.set(key, element);
                        else elements.current.delete(key);
                      }}
                      role="row"
                      aria-label={
                        row.status === "more"
                          ? undefined
                          : `${row.status === "self" ? `This ${row.kind}` : row.kind} ${row.name} ${details}`
                      }
                      aria-level={row.depth + 1}
                      aria-selected={canOpen ? selected === key : undefined}
                      onClick={(event) => {
                        // The Resource tab handles the further clicks of a double-click.
                        if (!canOpen || event.detail > 1) return;
                        setSelected(key);
                        const opened = open(row, true);
                        if (opened) rememberPointerOpened({ cluster, ...opened });
                      }}
                      style={{ paddingLeft: 12 + Math.min(row.depth, 8) * 16 }}
                      className={cn(
                        "cursor-default pr-3",
                        row.status === "more"
                          ? "flex h-7 items-center text-muted-foreground"
                          : "h-12 py-1.5",
                        canOpen && "hover:bg-accent",
                        selected === key && "bg-cluster-subtle hover:bg-cluster-subtle",
                      )}
                    >
                      <div role="gridcell" className="min-w-0 w-full">
                        {row.status === "more" ? (
                          <span>
                            {(row.more ?? 0).toLocaleString("en-US")} {older && "older "}
                            {row.kind} {row.more === 1 ? "Resource is" : "Resources are"} not shown.
                          </span>
                        ) : (
                          <>
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 text-muted-foreground">
                                {row.status === "self" ? `This ${row.kind}` : row.kind}{" "}
                              </span>
                              <span
                                title={row.name}
                                className={cn(
                                  "min-w-0 truncate font-mono",
                                  row.status === "self" && "font-medium",
                                  !canOpen && row.status !== "self" && "text-muted-foreground",
                                )}
                              >
                                {row.name}
                              </span>
                            </div>
                            <div title={details} className="truncate text-muted-foreground">
                              {typeof parts === "string"
                                ? parts
                                : parts.map((part, partIndex) => (
                                    <span key={partIndex}>
                                      {partIndex > 0 && " · "}
                                      {part.value !== undefined ? (
                                        <>
                                          <span>{part.label}</span>{" "}
                                          <span className="text-foreground">{part.value}</span>
                                        </>
                                      ) : (
                                        part.text
                                      )}
                                    </span>
                                  ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                {section.direction === "in" && section.truncated && (
                  <p className="px-3 py-2 text-muted-foreground">Not every owner is shown.</p>
                )}
              </div>
            ))}
            {omitted}
          </>
        )}
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20 peer-focus-visible:outline-1 peer-focus-visible:-outline-offset-1 peer-focus-visible:outline-ring"
      />
    </div>
  );
}
