# Event lists read times from each Event

An Event list is read by when each Event happened, so it opens sorted by Last
Seen with the newest Event first, as k9s shows it. The API server renders
Last Seen and First Seen as ages such as `"28m"` when it sends a row
(ADR-0010), and does not send the row again as time passes. Every Event that
arrives while a list is open reads `0s` and keeps reading it, so the column
can neither be sorted nor read once the list has been open for a while.

For the two Event types, `events` and `events.events.k8s.io`, the Engine
therefore asks for Table rows with the whole Event (`includeObject=Object`)
instead of its metadata, and replaces the Last Seen and First Seen cells with
the times they count from:

- **Last Seen:** the series' last observed time, then the last time
  (`lastTimestamp`, or `deprecatedLastTimestamp` in `events.k8s.io`), the
  event time, the first time, and the creation time.
- **First Seen:** the first time (`firstTimestamp`, or
  `deprecatedFirstTimestamp`), then the event time and the creation time.

This is the order the Events Facet uses for an Event's last time, and both
read it from one place. The times keep the Engine's local zone, as a Row's
`createdAt` and the Events Facet's times do, so one instant reads the same in
every title. Every other type is still listed with metadata only.

## The `timestamp` column type

A replaced column's `Column.Type` is `"timestamp"`, and its cells hold RFC
3339 times. The UI shows such a cell as a live age, as it shows Age, with the
exact time in its title, and the Engine sorts the cells as times, the newest
first in ascending order, as ascending Age does. OpenAPI printer columns
cannot declare `timestamp`, but an aggregated API server could send any type,
so the Engine reads a declared `"timestamp"` as `"string"`. The type then
always means that the Engine replaced the cells.

`Column.Type` stays a string, and `ColumnTypeTimestamp` is a constant rather
than a member of a union type, so the UI's checks for the OpenAPI types keep
working. The constant is part of the protocol hash (ADR-0012), so a UI built
before it shows the out-of-date notice instead of printing times as text.

## Considered Options

- **Keep the rendered ages and sort them.** `"28m"` parses as a duration, so
  the order is right when the list opens. Every Event that arrives afterwards
  reads `0s` to `2s`, ties with the others, and keeps that text as it ages.
- **Watch every Event beside the Table.** It would give the Engine the times
  without changing how the Table is fetched, but it duplicates the Table's
  own list and watch of the same Events.
- **Recompute the column in the UI.** The UI has only the rendered text and
  each Row's creation time, which is not when a repeated Event last happened.

## Consequences

- An Event's row carries the whole Event instead of its metadata. On the e2e
  Cluster, a Table of 8 Events grew from 14.9 KB to about 21.3 KB. Event
  Tables are fetched only while a list of them is open (ADR-0010).
- The UI now relies on what some cells mean, but only on cells the Engine
  marks as `timestamp`. It still knows Event columns by name only to lay them
  out (ADR-0011) and to sort by Last Seen.
- Only the two Event columns get live ages. Other rendered ages, such as a
  CronJob's Last Schedule or a CRD's `date` columns, still go stale until
  their Resource changes. The same mechanism can serve them, one type at a
  time, where the Engine knows which field a column counts from.
- An Event list sorts by Last Seen unless its layout hides the column or the
  Cluster serves none, and then by name. The sort is not remembered, and any
  list returns to its type's default from a column header's Reset sort.
- Ages count from the browser's clock, as Age does, so a skewed clock shifts
  them, and a time in the future reads `0s`.
