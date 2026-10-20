# Plan: status columns in Resource lists

Status: implemented, not merged yet. "What changed while building" lists where
the result differs from the text below.

## Outcome

After this work:

- A Resource list shows the columns `kubectl get` shows for its Resource Type,
  such as Ready, Status, and Restarts for Pods, between Name and Age. This
  holds for every type the Cluster serves, including a CRD's printer columns,
  with no per-type code.
- The cells update live while the list is open.
- A list can be sorted by any of these columns.
- The Engine fetches and watches a type's cells only while a list of that
  type is open, as ADR-0003 requires for anything beyond metadata.

It does not add filtering by cell values, a column chooser, or status colors.

## Current state

These observations come from the code at `85e6b31`:

- `index.Meta` holds UID, Namespace, name, creation time, resourceVersion, and
  labels. `protocol.Row` carries the first four, so a list can only show
  Name, Namespace, and Age.
- `Cluster.startType` in `engine/internal/cluster/cluster.go` runs one
  metadata reflector per type for the Cluster's lifetime. The only watch that
  starts and stops with a subscription is `WatchObject` in `object.go`, which
  follows a single Resource.
- `query.Run` builds a `Row` for every match, sorts them all, and then cuts
  the window. `Sort` supports `name`, `namespace`, and `age`.
- `runSubscription` stops a topic and starts it again whenever its params
  change, which happens each time a list scrolls to a new window.

## Evidence from a probe

A throwaway test ran against the envtest API server (Kubernetes 1.37,
client-go v0.37.1). It is not part of this change. It showed:

- A `rest.RESTClient` whose scheme holds the `meta.k8s.io/v1` types, sending
  `Accept: application/json;as=Table;v=v1;g=meta.k8s.io`, decodes both list
  responses and watch events into `metav1.Table`. This is how client-go's
  metadata client is built.
- Lists page with `limit` and `continue`. Every page carries the column
  definitions.
- In a watch, only the first event carries column definitions. Each event
  holds one row. A `DELETED` event holds the deleted Resource's row.
- Each row's `object` is a `PartialObjectMetadata`, including managedFields.
  With `includeObject=None` the row has no object, and so no Namespace or
  UID.
- Cells are typed JSON values. A CRD's `integer` and `boolean` columns arrive
  as `3` and `true`. Built-in types declare almost every column as `string`,
  including Restarts (`"0"`) and Ready (`"0/1"`), and use `"<none>"` for a
  missing value.
- Relative times are rendered by the API server. Age arrives as `"0s"`, and a
  CRD column of type `date` arrives as `"90m"`, not as a timestamp.
- The name column has the format `name`. For Events it has priority 1 and is
  not the first column.
- A column's declared type does not always match its cells. A ConfigMap's
  `Data` column is declared `string` and holds numbers. The envtest tests
  found this, not the probe.
- Columns with a priority above 0 are the ones `kubectl get -o wide` adds,
  such as IP and Node for Pods.

## Decisions

### Take columns from the API server's Table output

The Engine asks the API server for the Table form of a type instead of
computing columns itself. The API server already knows how to summarize every
built-in type, and CRD authors declare their columns in
`additionalPrinterColumns`. Reusing that gives every type useful columns that
match `kubectl get`.

The rejected alternative is watching full objects and computing columns in the
Engine. It would allow typed values and live relative times, but it means
porting and maintaining kubectl's printers for dozens of types and evaluating
JSONPath for CRDs.

This is an architectural choice with consequences for later features, so the
work records it as ADR-0010.

### Watch a type's Table only while a list needs it

A new `Cluster.Table(type)` returns a handle to the type's cells and a release
function. The first caller starts a Table watch for the type, and later
callers share it. The watch stops after the last release and a linger period,
30 seconds by default, set in `Timing` so tests can shorten it.

The linger exists because a list releases and reacquires on every scroll:
`runSubscription` stops the topic before it starts it with new params.
Without the linger each scroll would list the whole type again. It also
covers a Preview Tab that moves between lists.

The metadata reflector keeps running unchanged beside the Table watch. The
rejected alternative is replacing the reflector with the Table watch while a
list is open, because each row already carries metadata. That would save one
watch per open type, at the cost of switching a type's source of truth back
and forth while the index is in use.

The Table watch covers the whole type, across Namespaces, even when the list
filters by Namespace. One shared watch per type is simple, matches the
metadata reflector's scope, and needs no extra permission. A cluster-wide list
of a very large type is the cost (see Risks).

### Fetch Tables with a list and watch loop

`engine/internal/cluster/table.go` follows the shape of `watchObjectOnce`:
list, then watch from the list's resourceVersion, and start over after an
error or an expired resourceVersion, waiting `Timing.ObjectRetry` between
attempts. A `cache.Reflector` cannot be reused, because it expects a list with
an `items` field and a Table has rows.

- Lists are fetched in pages of 500, the page size kubectl uses.
- The first list fills the store page by page, so cells appear as pages
  arrive. A later list builds a new set and swaps it in, so Resources deleted
  while the watch was down disappear.
- The loop resolves the type's group and version on every attempt, as
  `WatchObject` does. Discovery stops a type's Table watch when it removes or
  restarts the type, and the loop restarts it if a list still holds it.
- A type whose Table the Cluster refuses to serve, for example an aggregated
  API that answers `406 Not Acceptable`, has no columns. Its list looks as it
  does today. The Engine logs the error and retries at the usual interval.

### Keep cells only, keyed like the index

For each row the Engine reads the Namespace and name from the row's metadata,
stores the cells under the same `namespace/name` key `index.Meta.Key()` uses,
and discards the rest. Requests use `includeObject=Metadata`, the default,
because rows are otherwise unidentifiable.

The Engine drops two columns when it stores a row, because the list already
shows live equivalents from the index:

- the column whose format is `name`; and
- a column named `Age`. A CRD could give that name to a column that reads
  another field. That column would be hidden, which is acceptable for now.

All other columns are stored and sent, including those with a priority above 0. The UI hides those, so a later column chooser needs no protocol change.

The index and the Table are fed by separate watches. A row can therefore
briefly have no cells, or the Table can hold cells for a Resource the index
no longer has. A Query's rows always come from the index, so the second case
is invisible and the first shows empty cells.

### Extend `resources.query` instead of adding a topic

```go
type QueryParams struct {
	// ...existing fields
	// Columns asks for the table columns of the one Resource Type the Query
	// selects. A Query that can match more than one type is a bad request.
	Columns bool `json:"columns,omitempty"`
}

type Column struct {
	Name string `json:"name"`
	// Type is the column's OpenAPI type: string, integer, number, boolean,
	// or date.
	Type     string `json:"type"`
	Priority int    `json:"priority"`
}

type QueryResult struct {
	// ...existing fields
	// Columns is absent until the type's Table has been fetched.
	Columns []Column `json:"columns,omitempty"`
}

type Row struct {
	// ...existing fields
	// Cells holds one value per QueryResult.Columns entry. It is absent when
	// the Engine has no cells for the Resource yet.
	Cells []any `json:"cells,omitempty" tstype:"unknown[]"`
}

type Sort struct {
	Field SortField `json:"field"` // gains SortFieldColumn = "column"
	// Column names the column to sort by when Field is "column".
	Column string `json:"column,omitempty"`
	Desc   bool   `json:"desc,omitempty"`
}
```

With `Columns` set, the topic acquires the type's Table and wakes on both the
index's changes for the type and the Table's own change signal. The existing
100 ms emit interval and deduplication bound the traffic.

The rejected alternative is a separate topic that returns cells for a list of
keys, joined in the UI. It keeps Queries unaware of cells, but sorting by a
column needs every match's cells next to the Query, which only the Engine
has. It would also take two subscriptions per list that must stay in step.

`query` stays independent of `cluster`. `Run` takes a small interface for
looking up columns and cells, and `Compiled.Types()` already tells the topic
whether the Query selects exactly one type.

### Sort by a column in the Engine

`Run` attaches cells after it cuts the window, so a list sorted by name reads
cells for at most one window of rows. Sorting by a column reads the cells of
every match.

The comparison depends on the column's type. `integer` and `number` compare
numerically and `boolean` compares false before true. Every other type
compares as text in natural order, where runs of digits compare as numbers,
so a Restarts cell of `"12 (3h ago)"` sorts after `"3"`. Rows without cells
sort last in both directions. Ties fall through to the existing name,
Namespace, and type order, which keeps results deterministic for
deduplication.

A `Sort.Column` the type does not have is not an error. Columns can change
while a list is open, for example when a CRD is updated, so the result falls
back to the tiebreak order.

### Show the columns in the list

`ResourceListPanel` sends `columns: true` and renders the returned columns
with priority 0 between Namespace and Age. Each header sorts like the
existing ones.

- Rows are absolutely positioned and each is its own grid, so column widths
  cannot come from content sizing. One pure function computes the grid
  template from the columns and the cells of the current window, clamped per
  column. Widths only grow while a list stays open, so scrolling does not make
  columns jump.
- The grid scrolls horizontally when the columns do not fit.
- `"<none>"` and missing cells render muted. Numbers align right.
- A list whose result has no columns renders exactly as today.

## Steps

The phases depend on each other in order. The work ships as one PR. Each
phase is a series of small commits, and every commit passes `mise run check`.

### Phase 1: Table watch in the Engine (no protocol change)

1. Add the Table REST client to `Cluster`, and the store that keeps columns
   and cells for one type with a change signal.
2. Add the list and watch loop, including paging, replacement on a later list,
   and the two dropped columns.
3. Add `Cluster.Table(type)` with sharing, release, and the linger, and stop
   or restart Table watches from discovery.

### Phase 2: protocol and Query

1. Add `Column`, `QueryParams.Columns`, `QueryResult.Columns`, `Row.Cells`,
   `Sort.Column`, and `SortFieldColumn` to the protocol, and run
   `mise run gen`.
2. Attach cells and sort by column in `query.Run`.
3. Acquire the Table in the `resources.query` topic and forward its signal.

### Phase 3: UI

1. Add the grid template function, cell rendering, and column headers to the
   resource list.
2. Add a `Size` printer column to the sample `Widget` CRD in
   `e2e/fixtures/sample/crds.yaml`, so `mise run dev:verify` shows a CRD's
   columns.
3. Check the Pod, Deployment, Event, and Widget lists in both themes, using
   `mise run dev:verify`.

### Phase 4: record the decision and the measurements

1. Add `docs/adr/0010-list-columns-from-table-output.md`.
2. Measure memory and first-list time (see Risks) and record the numbers in
   the PR description.
3. Mark this plan as shipped.

## Testing strategy

Each test targets a specific failure mode:

| Risk                                                                 | Evidence                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cells are missing, or go stale when a Resource changes or is deleted | envtest test in `cluster`: acquire the ConfigMap Table, create a ConfigMap, and wait for its `Data` cell; add a key and wait for the cell to change; delete it and wait for the row to go. It polls the store under a deadline, as the existing tests do. |
| A CRD's printer columns or typed cells are lost                      | envtest test: a CRD with `integer`, `boolean`, and priority 1 columns. Assert the column definitions and that the cells keep their JSON types.                                                                                                            |
| The dropped columns shift the remaining cells                        | Unit test for the function that turns a Table's definitions and rows into stored columns and cells, including Events, where the name column is not first, and a Table with no `Age` column.                                                               |
| Paging loses rows, or a later list keeps deleted ones                | Unit test of the loop against a fake Table client that serves two pages, then a watch that ends, then a list without one of the rows.                                                                                                                     |
| The watch outlives its lists, or restarts on every scroll            | Unit test with a fake client and a short linger: release then reacquire within the linger and assert one list call; release, wait for the fake's watch to be stopped, and assert a new acquire lists again.                                               |
| A column sort orders wrongly                                         | `query` table tests: an `integer` column, natural order for `"3"` and `"12 (3h ago)"`, rows without cells last in both directions, an unknown column, and ties falling through to name.                                                                   |
| Cells are attached to the wrong rows or outside the window           | `query` tests: two Namespaces holding the same name, and a window in the middle of the matches.                                                                                                                                                           |
| `columns` on a Query of several types is accepted                    | `server` test: a subscription with `columns` and a Query of two types returns `bad_request`.                                                                                                                                                              |
| The topic does not wake when only cells change                       | Extend the envtest `TestQuerySubscriptionFollowsTheCluster` in `server`: subscribe with `columns`, change a ConfigMap's data without touching its metadata, and wait for data with the new cell.                                                          |
| Column widths misalign or jump                                       | Vitest for the grid template function: clamping, growth only, and hidden priority 1 columns.                                                                                                                                                              |
| The feature does not work end to end                                 | One Playwright web test: open the ConfigMap list, see a `Data` header and a new ConfigMap's cell, add a key with `kubectl`, and see the cell change without a reload.                                                                                     |

The appearance of real lists is checked by hand on `mise run dev:verify`,
because layout quality is a judgment a test cannot make.

## Risks

- **Relative times go stale.** The API server renders cells such as an
  Event's Last Seen, a Pod's `3 (5m ago)` restarts, and a CRD's `date` columns
  when it sends the row. They stay as sent until the Resource next changes or
  the Table watch restarts. `kubectl get -w` behaves the same way. Dropping
  the `Age` column removes the most visible case. See Unresolved questions.
- **Memory while a list is open.** Cells for a large type may be sizeable.
  Measure the heap for 100,000 synthetic Pod rows. If it is a problem, intern
  cell strings with `unique.Make`, since values such as `Running` and `1/1`
  repeat heavily.
- **First list of a large type.** A cluster-wide Table list of tens of
  thousands of Pods takes the API server time to render and includes
  managedFields in each row. Cells appear page by page, so the list stays
  usable. Record the time against the largest cluster available. If it is too
  slow, scope the watch to the list's Namespace as a follow-up.
- **Two watches per open type.** The Table watch duplicates the metadata
  watch's traffic for that type while a list is open. This is accepted for the
  simpler design.
- **Width heuristics.** Fixed-width columns computed from one window may look
  wrong for types with long cells, such as an Event's Message. Phase 3 checks
  this by eye before the tests are written.

## Non-goals

- Filtering a Query by cell values, such as `status=Running`. The stored
  cells make it possible later.
- A column chooser, or showing priority 1 columns such as a Pod's Node.
- Coloring cells by health.
- Columns in the Go to Resource palette, or for Queries across several types.
- Remembering a list's sort or columns between sessions.

## What changed while building

- **Cells are ordered by what they hold, not by the column's type.** Declared
  types are unreliable (see the probe evidence), so numbers compare by value,
  `false` comes before `true`, and text compares in natural order whatever the
  column says. Text that reads as an age, such as `90s` or `2m30s`, compares
  by its length, so sorting Events by Last Seen works. Cells of different
  kinds are ordered by kind, which keeps the order consistent for any mix.
- **An ended watch resumes instead of listing again.** The API server ends
  every watch after a while. The loop continues from the resourceVersion of
  the last row it saw, and lists again only when that version has expired or
  the columns changed.
- **Failed lists back off.** The delay doubles from `Timing.ObjectRetry` up to
  `Timing.RetryMax`, so a type without a Table form costs one request a
  minute while its list is open, not one every two seconds.
- **The Table watch follows the type's indexing.** It waits while the type is
  not being indexed, for example while it is forbidden, and empties the Table
  meanwhile. It restarts when discovery restarts the type.
- **The name and Namespace columns have a least width**, 12rem and 8rem, so
  the list scrolls sideways instead of squeezing them to nothing. This also
  applies to a list without columns, which is the one visible difference
  from before for such a list.
- **`Column` went into the protocol first**, because the Table watch needs the
  type. Phase 1 therefore includes that part of phase 2.

## Measurements

Taken on an Apple silicon laptop with 100,000 synthetic Pod rows, each with
the seven columns the Engine keeps for a Pod:

- The cells use 33 MiB of heap, 344 bytes a row. That did not justify
  interning.
- Decoding and storing the 53 MiB of Table JSON takes 0.36 s. This leaves
  out the API server's time to render it and the network.
- One Query run takes 50 ms sorted by name, as before this work, and 89 ms
  sorted by a column.

The time for the first list of a large type against a real Cluster is not
measured. Only the k3d test cluster was available, with 5 Pods.

## Resolved questions

1. Rendered ages stay as the API server sent them, for CRD `date` columns
   too. Making them live remains possible for CRDs only.
2. Priority 1 columns, such as a Pod's Node and IP, are sent but hidden until
   a column chooser exists.
