# Plan: Event lists open newest first, with a live Last Seen

## Outcome

The Event list (`events` and `events.events.k8s.io`) opens sorted by Last
Seen with the newest Event at the top, as k9s shows them. Last Seen counts up
live, as Age does, so an Event that arrived twenty minutes ago reads `20m`,
not the `0s` the API server rendered when it sent the row. Events that arrive
while the list is open take their place at the top in the order they
happened.

Any list can return to its default sort from a column header's menu.

Age stays hidden by default, and the tuned Event columns stay as they are.

## Current state

- `defaultColumnLayout` in `apps/app/src/features/resource-list/column-layout.ts`
  hides Name and Age for Events and shows Last Seen, Type, Reason, Object, and
  Message. The panel starts every list at `{ field: "name" }`
  (`resource-list-panel.tsx`), so the Event list opens sorted by a hidden
  column. `shownSort` falls back to name when the requested column is not
  shown.
- There is no way back to a list's default sort except clicking the default
  column's header or reopening the list. The column menu's "Reset to default"
  resets only the layout.
- Cells come from the API server's Table output (ADR-0010). Event Tables
  declare Last Seen and First Seen as `type: string`, with cells such as
  `"28m"` (checked on the e2e k3d cluster).
- The Engine sorts a column by what its cells hold (`engine/internal/query/cells.go`).
  `"28m"` parses as an age, so the order is chronological, not textual.
- A row is rendered once, when it is listed or a watch event delivers it, and
  never again (ADR-0010). Every Event that arrives while the list is open
  therefore reads `0s` to `2s`. Those rows tie and fall back to name order, and
  the text stays `0s` as they age. Sorting the rendered cell is correct only
  at the moment the list opens.
- `resourceEvent` in `engine/internal/cluster/events.go` already works out an
  Event's last-seen time for the Events Facet: the series' last observed time,
  then `lastTimestamp`, `eventTime`, `firstTimestamp`, and the creation time.

## Decisions

### The Engine reads Event times from each Event

For the two Event types, the Engine asks the API server for Table rows with
the whole object (`includeObject=Object`) instead of metadata only, and
replaces the Last Seen and First Seen cells with the times they count from.
Other types keep `includeObject=Metadata`. `restTableClient.request` serves
both List and Watch, so one parameter covers both.

The Table already carries the object's metadata, which the Engine reads to
key rows, so the change is local to how one type's Table is requested and
how its rows are read. A separate watch of every Event would duplicate the
Table watch.

Times, per Event, in order of preference, matching `resourceEvent`:

- **Last Seen:** `series.lastObservedTime`, `lastTimestamp` (`deprecatedLastTimestamp`
  in `events.k8s.io/v1`), `eventTime`, `firstTimestamp`
  (`deprecatedFirstTimestamp`), creation time.
- **First Seen:** `firstTimestamp` (`deprecatedFirstTimestamp`), `eventTime`,
  creation time.

First Seen is hidden by default but goes stale the same way, and converting
it costs one more field, so it is converted too.

One decoding struct can read both API groups' field names. Share the
preference order with `resourceEvent` rather than repeating it. Store times
in UTC (`metav1.Time` decodes into Local), so they encode with a `Z` like
`createdAt`. The Event types are recognized by GVR (resource `events` in group
`""` or `events.k8s.io`) in one place in the `cluster` package. A Table
without a column of that name is left as it is.

The Event flag must reach `newTableLayout` itself, through the client or the
source, because both `listTable` and `watchTable` build a layout and the watch
compares it with `equal`. A watch-side layout without the rewrite would force
a relist on every watch.

### Time cells go on the wire as RFC 3339 strings, marked by Column type

A replaced column's `Column.Type` is `"timestamp"`, and its cells hold
RFC 3339 times. OpenAPI printer columns cannot declare that type, but an
aggregated API server could send anything, so the Engine rewrites a
server-declared `"timestamp"` to `"string"`, and the value always means the
Engine replaced the cells.

`Column.Type` stays a `string`. Add an untyped constant, as the `ExecReason*`
constants are (`protocol/streams.go`), not a named type: tygo would turn a
named type into a union and narrow `column.type`, breaking checks such as
`column.type === "integer"` in `columns.ts`. The constant also changes the
protocol hash, which ignores comments, so an out-of-date UI shows the
out-of-date notice instead of printing timestamps as text. Export it from
`packages/engine-client/src/index.ts` and run `mise run gen`.

The Engine stores the cell as a `time.Time`, which encodes as RFC 3339, and
`cellKey` orders `time.Time` values as a kind of their own. Ascending puts
the newest first, as ascending Age does (`comparator` in `query.go`), so a
Last Seen column sorted ascending reads `5s`, `2m`, `3h` down the list.
Rows without the cell still come last in both directions.

### The UI shows a timestamp cell as a live age

`columns.ts` gains one helper, for example `cellDisplay(column, value, now)`,
that formats a timestamp cell with `formatAge` and any other cell with
`cellText`; a value that is not a valid time falls back to `cellText`. Use it
in:

- `ListCell` in the Resource list, rendered against `useNow` like Age:
  monospace with `tabular-nums`, muted like Age, the exact time in `title`;
- `growWidths`, so widths fit the age, not the timestamp; and
- `secondLine` in the Related Facet, which shows an Event's own row and
  otherwise regresses to `Last Seen 2026-10-24T00:07:34Z`.

### Event lists open sorted by Last Seen

The type's default sort is `{ field: "column", column: "Last Seen" }`
ascending for the two Event types, and name ascending for every other type.
It applies unless the layout rules Last Seen out: the resolved layout hides
it, or the served Columns are known and lack it. While the stored layout is
loading or no Columns have arrived, the default still applies, because the
Engine orders by name until its Table has the column and then by the column.

The panel's sort state starts unset, meaning the default. A sort the user
chooses applies while its column is shown; otherwise the list falls back to
the default, then to name. So a user who hides Last Seen gets name order, as
today. The sort is still not remembered across reloads. Keep these rules in
`column-layout.ts`, replacing or extending `shownSort`.

A user whose stored layout hides Last Seen may see Last Seen order briefly on
open if the first result arrives before the stored layout. That costs one
extra query and is accepted.

### Any list can return to its default sort

The column header's context menu gains **Reset sort** after Sort ascending
and Sort descending. It clears the user's choice, so the list goes back to
its type's default. It is disabled while the effective sort already equals
the default. This follows MUI DataGrid's column-menu "Unsort", and keeps
header clicks as they are.

## Experience

- **Sort indicator:** the existing header shows the sort. On open, the Last
  Seen header has the ascending arrow and `aria-sort="ascending"`. Clicking it,
  or pressing Enter or Space on the focused header, toggles to oldest first.
- **Reset sort:** right-click any header. Keyboard users reach the header's
  context menu only where the browser fires `contextmenu` for Shift+F10 or the
  Menu key; nothing in the app handles those keys. That gap already applies
  to Sort ascending and Sort descending. `ux-review` checks it and reports
  it. A keyboard user can always restore the Event default by pressing Enter
  on Last Seen.
- **Live text:** Last Seen updates on the same clock as Age. Hovering a cell
  shows the exact time, as Age does.
- **Empty:** the existing copy, "The cluster has none right now. This list
  updates live." The header still shows the sort.
- **Loading:** skeleton rows as today. Until the Table arrives the list shows
  the fallback columns in name order with no sort arrow on any shown header,
  then switches to the tuned layout sorted by Last Seen, as it switches
  layouts today. A row without cells yet has an empty Last Seen and sorts
  last.
- **Not permitted:** the existing forbidden state; no query runs.
- **Cluster unreachable:** the Table keeps its cells, and the ages keep
  counting.
- **Engine lost:** the existing notice.
- **Sizes and themes:** both themes, a narrow (about 900 px) and a wide window.
  No new colors. The longest age, 6 characters, fits the Last Seen header.
- **Key bindings:** none.
- **Guidelines** (Vercel Web Interface Guidelines, fetched for this plan):
  `tabular-nums` for compared numbers, which the age cell keeps; native or
  ARIA semantics, which the existing `columnheader` and `aria-sort` provide;
  menu items whose labels name their action. Relative ages deliberately use
  kubectl's format, not `Intl`, as Age does.

## Failure paths and risks

- **Payload:** an Event Table row grows from metadata to the whole Event. On
  the e2e cluster, 8 Events grew from 14.9 KB to about 21.3 KB. Event Tables
  are fetched only while a list is open (ADR-0010). Accepted.
- **Clock skew:** ages count from the browser's clock, as Age does, and
  `formatAge` shows `0s` for a time in the future.
- **Missing column:** a Cluster whose Event Table has no Last Seen keeps its
  cells, and the list falls back to name order.
- **Ties:** Events in the same second fall back to identity order.
- **Relist loop:** covered by the layout decision and its test.
- **Protocol hash:** the Engine and UI must be rebuilt together after
  `mise run gen`.

## Non-goals

- Live ages for other rendered age columns, such as a CronJob's Last
  Schedule or a CRD's `date` columns.
- Remembering a list's sort.
- Changing the Events Facet or the tuned Event columns.
- Adding keyboard handling for context menus.

## Verification

| Concern                                                           | Evidence                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event rows get times from both API groups, with the fallbacks     | Go unit test of the row reader on core and `events.k8s.io` objects: series, last, event time only, first only, and creation only; times are UTC.                                                                                                                                                                 |
| Other types are untouched; a server-declared `timestamp` is reset | The same unit test with a non-Event row and a column declared `timestamp`, plus the existing Table tests.                                                                                                                                                                                                        |
| A watch does not force a relist for Event Tables                  | `fakeTables` unit test modelled on `TestTableFollowsListsAndWatches`: Event column definitions, a list, then a modified Event; the cell updates and the list count does not grow.                                                                                                                                |
| The API server returns objects and the Engine reads them          | envtest: create a core Event and an `events.k8s.io` Event, read Last Seen from the Table, then update `lastTimestamp` and wait for the new time.                                                                                                                                                                 |
| Time cells sort newest first, reverse, and keep absent rows last  | Go unit test in `query`.                                                                                                                                                                                                                                                                                         |
| The default sort, its fallbacks, and Reset sort                   | Vitest for the sort rules: Event default; user choice wins; Last Seen hidden by the stored layout, with and without Columns; Columns present before the stored layout; served Columns without Last Seen; other types; reset state.                                                                               |
| Timestamp cells display as ages everywhere                        | Vitest for `cellDisplay`: a timestamp formats with `formatAge`, an invalid value falls back to text.                                                                                                                                                                                                             |
| The whole path in the running app                                 | Playwright (web), scoped to the tab panel and the run's Namespace: two Events with `lastTimestamp` 3h and 1h ago; the 1h Event is first, its cell reads `1h` with the RFC 3339 time in `title`, Last Seen has `aria-sort="ascending"`; sort by another column, Reset sort, and the order and `aria-sort` return. |
| UI and UX                                                         | Running-app check by the implementer, then `ux-review`.                                                                                                                                                                                                                                                          |
| Repository gates                                                  | `mise run check`.                                                                                                                                                                                                                                                                                                |

Record the decision in a new ADR (0027): Event lists read times from each
Event, and the UI relies on the Engine's `timestamp` column type. It refines
two consequences of ADR-0010: that nothing in hukube relies on a cell's
meaning, and that rendered ages go stale. Point to it from both bullets.

## Open questions

None.

## What changed while building

A review of the running app found these problems.

- **Times keep the Engine's local zone.** The plan stored them in UTC to
  encode with a `Z` like `createdAt`, but `createdAt` and the Events Facet's
  times carry the Engine's local offset. A Last Seen title read
  `2026-10-24T01:27:43Z` while Age's read `2026-10-24T02:27:43+01:00`, so one
  instant looked an hour apart. The Engine now leaves the times as `metav1`
  decodes them, and tests compare instants rather than strings.
- **The Customize columns menu's "Reset to default" is "Reset columns".** It
  resets only the column layout, and now sits beside a sort reset.
- **Reset sort is also in the Customize columns menu,** above Reset columns.
  The menu's button is reached with Tab, while a header's context menu cannot
  be opened from a Mac keyboard. A header's menu keeps its own Reset sort
  among its sort items, so `ColumnMenuItems` shows the item only when given
  `onResetSort`.
- **Columns of times name their sort items by direction in time:** "Sort
  newest first" for ascending and "Sort oldest first" for descending, on Age
  and on `timestamp` cells. "Sort ascending" did not say whether the newest
  or the oldest came first. Other columns keep "Sort ascending" and "Sort
  descending", and `aria-sort` and the arrow are unchanged.
- **A list's selection stays on its Resource.** It was a row index, so an
  Event arriving at the top, a new sort, or Reset sort moved the highlight to
  another Resource while the open tab still showed the first, and the arrow
  keys continued from the wrong row. A selection is now the row's Resource URI
  and its last known index, and the list uses the URI's position while the
  query window holds it. This applies to every Resource list. Only the user's
  own moves scroll the list; keeping the view in place as rows arrive is left
  for later.
- **No row shows a selection whose Resource the window does not hold.** The
  last known index was a fallback for the highlight and the keys, so after a
  new sort, a filter, a Namespace change, a deletion, or a scroll away, the
  row now at that index showed as selected, and the arrow keys, Space, and
  Enter acted on it while the open tab showed the selected Resource. A list
  now shows or acts on a Resource as selected only if the user selected it.
  The selection also keeps its Resource's address: Enter and Space open the
  selected Resource from it when the window does not hold its row, and an
  arrow key selects the row next to the last index the Resource was seen at,
  clamped to the list, and scrolls to it. A row an arrow key selects before
  it has loaded shows at its index and takes its Resource once it loads.
- **Changing a filter clears the selection.** A filter or Namespace that hid
  the selection still let Enter open it, while the list showed only other
  rows. A change the user makes to the name filter, the label selector, or the
  Namespace now clears the selection, as MUI DataGrid drops filtered-out rows
  from its selection, so clearing the filter does not bring it back. A
  selection that a new sort, a deletion, or scrolling moves out of the window
  still opens with Enter.
- **The list shows keyboard focus.** The grid had no focus style, which went
  unnoticed while a focused list always had a highlighted row. Now that a
  list can hold focus with no row shown as selected, a ring like the column
  headers' marks the list while the grid has keyboard focus.
