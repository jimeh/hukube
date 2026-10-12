# Plan: column editor and per-type column defaults

Status: implemented, not merged yet.

## Outcome

After this work:

- Every column of a Resource list can be shown, hidden, and moved. Name,
  Namespace, and Age are entries in one ordered list next to the columns the
  Cluster serves, including the priority 1 ("wide") ones such as a Pod's Node.
- A list's columns are a built-in default for its Resource Type plus the
  user's stored layout. The stored layout is saved per Resource Type in the
  Engine's settings store, shared across Clusters, and open lists of the type
  follow it live.
- A Columns menu in the list toolbar has a checkbox for each column and
  "Reset to default". Dragging a header moves its column. A header's context
  menu offers Hide, Move left, and Move right.
- Events show Namespace, Last Seen, Type, Reason, Object, and Message, and
  Message takes the spare width. Pods also show Node. Every other type looks
  as it did.

The protocol does not change. The Engine changes in one place: its settings
store can now hold a key too long to be a file name (see "What changed while
building").

## Current state

These observations come from the code at `f649e14`:

- `resources.query` already returns every column of a type's Table except the
  name column and `Age`, which the Engine drops, and it sorts by any of them.
  `listColumns` in `apps/app/src/features/resource-list/columns.ts` hides the
  ones with a priority above 0.
- `ResourceListPanel` renders Name, Namespace, the columns, and Age in a fixed
  order. `gridLayout` gives Name the spare width (`minmax(12rem, 2fr)`).
- A Workspace has at most one list per type, because a list's panel ID is
  `list:<type key>`. Lists of one type are open together only across
  Workspaces, windows, and Hosts.
- `settings.put` stores any JSON value under a key and `settings.watch`
  sends the value again after each put. A missing setting has a `null` value.
  Only Workspace layouts use the store today, and they read it once.
- `packages/ui` already has the dropdown and context menu components.

## Decisions

### One ordered list of columns

A layout is an ordered list of columns, each shown or hidden. A column is
identified by where its value comes from and, for a column the Cluster
serves, by its name:

```ts
interface StoredColumn {
  /** "cell" is a column the Cluster serves; the others are the list's own. */
  source: "name" | "namespace" | "age" | "cell";
  /** The Cluster's name for a "cell" column. */
  name?: string;
  hidden?: boolean;
}
```

The source keeps a CRD's printer column called `Name` or `Namespace` apart
from the list's own. Column names are untrusted, so every lookup by name uses
a `Map` or `Set`.

Two served columns with the same name share one entry, and the list shows the
first. The Engine already sorts by the first column of a name, and the API
server's built-in types have no such columns.

### The stored layout is the whole list

The setting `columns/<type key>` holds `{ version: 1, columns: StoredColumn[] }`:
every column the user's layout knows, in order. The first edit writes the
resolved layout, and "Reset to default" writes `null`.

The rejected alternative is storing only differences from the default, such
as lists of hidden and moved columns. It would let a later change to a
built-in default reach users who have edited the type, but an order has no
natural difference form, and resolving one against a default that changed is
harder to predict than a list that stays as the user left it.

A stored value is read defensively: anything that is not version 1, and any
entry of the wrong shape or repeating an earlier one, is ignored.

### Resolving a layout

A list resolves its layout from three inputs: the type's default, the stored
layout, and the columns available here. Available means Name, Age, Namespace
for a namespaced type, and the columns the Cluster serves.

1. Start from the stored layout's entries, in order, or from the default when
   nothing is stored.
2. Add each available column the stored layout does not know, with the
   default's visibility. It goes after the nearest column before it in the
   default that the layout already holds, or first when there is none. A new
   CRD printer column therefore appears where the default puts it.
3. Show the entries that are available and not hidden. Stored entries the
   Cluster does not serve are skipped but stay in the layout, so an edit made
   against one Cluster keeps what another Cluster's columns were given.
4. Namespace keeps its rule: it shows only while the list covers every
   Namespace.
5. A list that would show nothing shows Name.

Hide and the checkboxes flip an entry's flag. A move puts a column before or
after the nearest shown column, skipping hidden and unserved entries. The
last shown column cannot be hidden.

### Built-in defaults

The default for a type is Name, Namespace, the priority 0 columns in the
Cluster's order, and Age, followed by the wide columns, hidden. Two types
differ:

- **Pod** also shows Node, between the priority 0 columns and Age.
- **Event**, under both `events` and `events.events.k8s.io`, shows Namespace,
  Last Seen, Type, Reason, Object, and Message. Name sits first and Age after
  Message, both hidden, and the remaining columns follow, hidden.

A tuned default applies only while the Cluster serves every column it shows.
Until an Event list's columns arrive, and for a Cluster that cannot serve the
Table at all, the general default applies, so the list never shrinks to a
Namespace column alone.

### One column takes the spare width

A type's default names the column that takes the spare width: Message for
Events and Name for every other type. That column's track is
`minmax(12rem, 2fr)`. When it is hidden or not served, Name takes its place if
Name is shown. A Name column that does not take the spare width is sized by
its content like a served column.

### A list sorts by a column only while it shows it

When the column a list is sorted by stops being shown, the list falls back to
its default order, by name. This is derived from the sort and the shown
columns, not stored, so it also covers a column hidden from another window,
and the sort returns if the column does. A sort that the header cannot show
or undo would be worse.

A list sorts by name by default even when Name is hidden, as an Event list
is. A default sort per type is a non-goal.

### Stay in sync through `settings.watch`

A list subscribes to its type's setting for as long as it is open and shows
whatever arrives, so an edit in one window reaches the others. It does not
render columns before the first value arrives, so a stored layout never
flashes the default.

An edit shows at once and is then written. A list writes one edit at a time,
because the Engine may apply two writes that are in flight in either order.
An edit made during a write waits for it, and only the latest waiting edit is
sent.

The list keeps showing its latest edit while it is writing. A value that
arrives meanwhile is kept, and is one of two things:

- A value this list wrote since it was last idle is an echo of its own
  earlier edit, and changes nothing.
- Any other value is another client's. When the list's writes have all
  settled, it shows the latest value it received in place of its own edit.

When the list is not writing, an arriving value always wins. A failed write
logs a warning and returns the list to the stored layout. Two clients editing
at once follow ADR-0009: the last write wins, for the whole layout.

### Drag headers with pointer events

Dragging a header is hand-rolled with pointer events. The interaction is one
row on one axis: a press that moves more than a few pixels starts a drag, a
marker shows where the column will land, releasing moves it, and Escape
cancels. A press that does not move still sorts. Dockview drags Tabs and
Panes with HTML drag events, which a pointer drag never starts.

The rejected alternative is a drag-and-drop library. It would bring keyboard
dragging and edge scrolling, at the cost of a dependency for one interaction.
A drag does not scroll the list sideways, so a column moves past the visible
edge with Move left and Move right.

### Keyboard

Chromium on macOS has no key that opens a context menu, so the context menu
alone is not a keyboard path there. The Columns menu, which is an ordinary
menu button, shows and hides columns from the keyboard. A focused header
moves with `Alt+ArrowLeft` and `Alt+ArrowRight`, keeps focus afterwards, and
the context menu shows the two shortcuts beside Move left and Move right.

## Steps

The work ships as one PR, in commits that each pass `mise run check`.

1. Add the layout model in `apps/app/src/features/resource-list/`: the stored
   shape and its reader, the defaults, resolving, and the edits. All of it is
   pure and unit tested.
2. Add the store that watches and writes a type's setting, and its hook.
3. Render the list from a resolved layout: the generalized header and cells,
   widths keyed by column, the spare-width column, and the derived sort.
4. Add the Columns menu, the header context menu, the keyboard moves, and
   header dragging.
5. Add the Playwright test, check the Event and Pod lists by hand on
   `mise run dev:verify`, and mark this plan as shipped.

## Testing strategy

| Risk                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A layout resolves wrongly                                    | Vitest: the default alone; a stored layout; a served column the stored layout does not know, at the start, middle, and end; a stored column the Cluster does not serve, kept through an edit.                                                                                                                                                                                                                                                                                       |
| A Cluster's column names break the list                      | Vitest: columns named `constructor`, `__proto__`, and `toString`; a served column named `Name`; two served columns with one name.                                                                                                                                                                                                                                                                                                                                                   |
| A stored value of the wrong shape breaks the list            | Vitest for the reader: `null`, another version, a non-array, entries of the wrong shape, and repeated entries.                                                                                                                                                                                                                                                                                                                                                                      |
| The tuned defaults are wrong, or hide everything             | Vitest: the Pod and Event defaults against their real columns, both Event type keys, an Event list before its columns arrive, and a layout that shows nothing.                                                                                                                                                                                                                                                                                                                      |
| A move lands in the wrong place                              | Vitest: moves across hidden and unserved entries, at both ends, and with the Namespace column not shown.                                                                                                                                                                                                                                                                                                                                                                            |
| The sort outlives its column                                 | Vitest for the function that derives the sort from the shown columns.                                                                                                                                                                                                                                                                                                                                                                                                               |
| The spare width goes to the wrong column                     | Vitest for `gridLayout`: Message for Events, Name elsewhere, and the fallback when that column is hidden.                                                                                                                                                                                                                                                                                                                                                                           |
| An edit flickers back, or another window's edit is lost      | Vitest for the store against a fake client: an edit shows before its write resolves, an edit made during a write waits and the latest one replaces it, an echo of an earlier edit during a later write does not show, another client's value that arrives during a write shows once the write settles, a value that arrives while idle wins, and a failed write with and without an edit waiting. Playwright: a second page open on the same list follows an edit without a reload. |
| A long type key cannot be stored                             | Go tests for the settings store: a 250-byte key survives reopening the store, two long keys with a shared prefix stay apart, and a short key keeps its file name.                                                                                                                                                                                                                                                                                                                   |
| Editing does not work end to end, or does not survive reload | Playwright: hide a column from the Columns menu, move one by dragging its header and one from the keyboard, reload, and find the layout kept. It also covers a drag cancelled with Escape, a press that only sorts, and a move that changes nothing. It resets the type's layout before and after.                                                                                                                                                                                  |

How the Event and Pod lists look at 1280 px is checked by hand on
`mise run dev:verify`, as is that dragging a header starts no dockview drag.

## Risks

- **Thin drag coverage.** Pointer capture, the click that follows a drag, and
  Escape are covered only by the one Playwright drag and the check by hand.
- **Wide Event cells.** Object can grow to 48 characters, which with a long
  Reason leaves Message its least width or forces sideways scrolling in a
  narrow Pane. Resizing columns is a non-goal here.
- **Stored columns accumulate.** A layout keeps every column name it has seen
  across Clusters until it is reset. The count is bounded by the columns that
  versions of one type declare.

## Non-goals

- Resizing columns by dragging.
- A default sort per Resource Type, or remembering a list's sort.
- Filtering by cell values, and status colors.
- Layouts per Cluster.
- Dragging headers by touch, and scrolling the list sideways during a drag.

## What changed while building

- **The sync rule changed twice.** The plan first had a list ignore values
  that arrived during a write. A value another client wrote just after this
  list's own would then never show, because the Engine sends nothing further.
  Review then found that edits written at the same time could be applied out
  of order, and that an echo of an earlier edit could be taken for another
  client's value and briefly replace a later edit. The rule under "Stay in
  sync" is the result.
- **One Engine change: long setting keys.** The settings store names a file
  after the key, and a type key can be up to 253 bytes, so the file name of
  `columns/<type key>` could pass the 255-byte limit and that type's layout
  would fail to save. A Workspace key built from a long kubeconfig context
  name had the same problem. The store now names such a file after a SHA-256
  of the key. Shorter keys keep their file names, so stored settings stay
  readable. The fix is in the store, not in the list, because the limit is
  the store's and applies to every key.
- **`mise run e2e` starts from an empty Engine data directory**, as CI does.
  The new Playwright test first passed locally and failed in CI, because a
  Workspace layout kept from earlier runs hid a second open list.
- **An edit that changes nothing stores nothing.** A move past either end, a
  drag dropped where it started, and hiding the last shown column leave the
  setting alone, so they do not turn a default into a stored layout.
- **The fallback to Name is kept by the next edit.** When a list shows Name
  only because nothing else would show, the next edit stores Name as shown.
  Otherwise showing a second column would hide Name again.
- **A sample Event.** `e2e/fixtures/sample/resources.yaml` gained one Event,
  so `mise run dev:verify` has an Event list to look at. The API server
  removes Events after an hour, and each `dev:verify` applies it again.
