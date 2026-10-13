// A grid keeps the message on a second line; ARIA preserves table semantics.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */

import type { ResourceEvent, ResourceEvents } from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import { formatAge } from "@hukube/k8s";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { cn } from "@hukube/ui/lib/utils";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useNow } from "@/lib/use-now.ts";

import type { FacetProps } from "./facet-props.ts";
import { Notice } from "./notice.tsx";

function warningCount(events: SubscriptionState<ResourceEvents>): number {
  return events.stale || events.error?.code === "forbidden" ? 0 : (events.data?.warnings ?? 0);
}

/** The Events tab names the number of Warning Events in its accessible label. */
export function eventsTabName({ events }: FacetProps): string {
  const count = warningCount(events);
  return count ? `Events, ${count} ${count === 1 ? "warning" : "warnings"}` : "Events";
}

/** Shows the warning count while the tab holds current, permitted Events. */
export function EventsBadge({ events }: FacetProps) {
  const count = warningCount(events);
  if (!count) return null;
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      <HugeiconsIcon icon={Alert02Icon} className="text-warning" aria-hidden="true" />
      <span className="text-foreground" aria-hidden="true">
        {count}
      </span>
    </span>
  );
}

const columns = ["Last seen", "Type", "Reason", "Count", "From"];

/** Shows live Events about the Resource, including loading and recovery states. */
export function EventsFacet({ address, kind, events }: FacetProps) {
  const { error } = events;
  const data = events.stale ? undefined : events.data;
  if (error?.code === "forbidden")
    return (
      <Notice
        title="Not permitted"
        description={
          address.namespace
            ? `Your credentials cannot list Events in the ${address.namespace} Namespace.`
            : `Your credentials cannot list Events across the cluster, which the Events of a cluster-scoped ${kind} need.`
        }
      />
    );
  if (error && !data?.events.length)
    return (
      <Notice title="Events unavailable" description={`${error.message} hukube keeps trying.`} />
    );
  if (!error && data?.total === 0)
    return (
      <Notice
        title="No recent Events"
        description={`A cluster keeps Events for a limited time, usually one hour, so a healthy ${kind} often has none. New Events appear here as they happen.`}
      />
    );
  const loading = !data;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!loading && error && (
        <p className="border-b px-3 py-2 text-destructive">
          Events may be out of date: {error.message}
        </p>
      )}
      <section
        className="min-h-0 flex-1 overflow-auto focus-visible:outline focus-visible:outline-ring"
        // The scrolling area must be reachable for keyboard scrolling.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label="Events"
        aria-busy={loading}
      >
        <div
          role="table"
          aria-label="Resource Events"
          className="grid grid-cols-[max-content_max-content_minmax(0,1fr)_max-content_minmax(0,min(28ch,30%))] gap-x-3 font-mono"
        >
          <div
            role="row"
            className="sticky top-0 z-10 col-span-full grid h-7 grid-cols-subgrid items-center border-b bg-background px-3 text-muted-foreground"
          >
            {columns.map((column) => (
              <div
                key={column}
                role="columnheader"
                className={cn("min-w-0 whitespace-nowrap", column === "Count" && "text-right")}
              >
                {column}
              </div>
            ))}
            <div role="columnheader" className="sr-only">
              Message
            </div>
          </div>
          {loading
            ? Array.from({ length: 3 }, (_, i) => (
                <div
                  key={i}
                  role="row"
                  className="col-span-full grid grid-cols-subgrid gap-y-1 border-b px-3 py-2"
                >
                  {columns.map((column) => (
                    <div key={column} role="cell" className="min-w-0">
                      <Skeleton className="h-3 w-full max-w-16" />
                    </div>
                  ))}
                  <div role="cell" className="col-[2/-1] min-w-0">
                    <Skeleton className="h-3 w-full max-w-80" />
                  </div>
                </div>
              ))
            : data.events.map((event) => <EventRow key={event.uid} event={event} />)}
        </div>
        {!loading && data.total > data.events.length && (
          <p className="px-3 py-2 text-muted-foreground">
            Showing the newest {data.events.length.toLocaleString("en-US")} of{" "}
            {data.total.toLocaleString("en-US")} Events.
          </p>
        )}
      </section>
    </div>
  );
}

function EventRow({ event }: { event: ResourceEvent }) {
  const now = useNow();
  const from = `${event.reporter ?? ""}${event.reporterInstance ? `, ${event.reporterInstance}` : ""}`;
  const warning = event.type === "Warning";
  return (
    <div
      role="row"
      className={cn(
        "col-span-full grid grid-cols-subgrid gap-y-1 border-b px-3 py-2",
        warning && "bg-warning/5",
      )}
    >
      <div role="cell" className="whitespace-nowrap tabular-nums" title={event.lastSeen}>
        {formatAge(new Date(event.lastSeen), new Date(now))}
      </div>
      <div
        role="cell"
        className={cn(
          "whitespace-nowrap",
          event.type === "Normal" && "text-muted-foreground",
          warning && "font-medium",
        )}
      >
        <span className="inline-flex items-center gap-1">
          {warning && (
            <HugeiconsIcon
              icon={Alert02Icon}
              className="size-3.5 text-warning"
              aria-hidden="true"
            />
          )}
          {event.type}
        </span>
      </div>
      <div role="cell" className="min-w-0 truncate" title={event.reason}>
        {event.reason}
      </div>
      <div role="cell" className="text-right whitespace-nowrap tabular-nums">
        {event.count}
      </div>
      <div role="cell" className="min-w-0 max-w-[28ch] truncate" title={from}>
        {from}
      </div>
      <div role="cell" className="col-[2/-1] min-w-0 wrap-break-word">
        {event.message}
      </div>
    </div>
  );
}
