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
- The header row is where columns are customized. A "Customize columns"
  button at its right end opens a checklist of the columns and "Reset to
  default". Dragging a header moves its column. A header's context menu
  sorts by the column, hides it, moves it left or right, and holds the same
  checklist.
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

While a list is writing it shows its own latest edit, and does not show what
its watch delivers. Such a value may be an echo of an earlier edit, another
client's value from before the write, or another client's value from after
it, and nothing in the value says which. When the writes have settled, the
list closes its watch and opens a new one. The Engine computes the first
value of a new watch after every write it has already answered, so that
value is what the Engine holds, and the list shows it and every value after
it. A late value from the watch it closed is dropped.

A failed write logs a warning, and the new watch then returns the list to
the stored layout. Two clients editing at once follow ADR-0009: the last
write wins, for the whole layout.

### Customize columns from the header row

Column actions sit on the header, where the columns are, as in Finder,
spreadsheets, and other data grids. The list's toolbar holds filters only.

- **A "Customize columns" button** at the right end of the header row opens
  the column checklist and "Reset to default". It is an icon button with a
  tooltip, pinned to the right edge when the list scrolls sideways, and it
  has a grid track of its own, so it never covers the last column.
- **A header's context menu** offers Sort ascending, Sort descending, Hide
  column, Move left, and Move right, and below a separator the same checklist
  and "Reset to default".

The button makes the feature findable, and the context menu is where users
of comparable tools look for it. Both render one checklist.

Showing a column scrolls the list sideways to bring it into view, because a
column that is hidden by default appears at the far end, which is off screen
in a list that fills its window. A header focused from the keyboard shows the
same focus ring as the app's other controls.

The first version put a "Columns" button in the toolbar, next to the
filters. It was moved in review (see "What changed while building").

### Drag headers with dnd-kit

Headers are dragged with dnd-kit: `@dnd-kit/react`, `@dnd-kit/dom`, and
`@dnd-kit/collision`, all 0.5.0. A press that moves more than 5 px starts a
drag, a copy of the header follows the pointer just below the header row, a
marker shows the edge where the column will land, releasing moves it, and
Escape cancels. A press that does not move still sorts. Dragging toward the
left or right edge scrolls the list sideways, so a column can be dropped on a
header that was off screen when the drag started.

The marker is the rule for where a column lands: it sits on the edge of the
nearest header that is nearer the pointer, and the drop puts the column
there. While the pointer is level with the header row, anywhere past the last
column means after it, including over the pinned button, and anywhere before
the first means before it. A release away from the header row moves nothing.

- **The newer dnd-kit API, not `@dnd-kit/core` and `@dnd-kit/sortable`.** The
  older packages last released in December 2024. `@dnd-kit/react` released
  0.5.0 in June 2026 and betas through September 2026. It is still before
  1.0, so the versions are pinned exactly.
- **No keyboard dragging.** dnd-kit's keyboard sensor and its announcements
  are off. Its pick-up key would collide with a header's sort action, and
  moving a column claims no key (see Keyboard).
- **The headers do not reorder while dragging.** The cells below stay where
  they are until the drop, so only the marker shows the destination.
- **Auto-scroll is sideways only.** The header sits at the top edge of the
  scrolling element, where a drag would otherwise scroll the list upwards.
- **The scrolling element is handed to dnd-kit directly.** dnd-kit stops
  looking for scrolling ancestors at a sticky element, and the header row is
  sticky. `Scroller.getScrollableElements` is a public property but not a
  documented option, so an upgrade of dnd-kit must recheck it. The Playwright
  test's edge-scrolling step fails if it stops working.
- **Touch does not start a drag**, so touch still scrolls the list.
- **Dockview is unaffected.** Dockview drags Tabs and Panes with HTML drag
  events, which dnd-kit's pointer sensor never starts.

The first version hand-rolled the drag with pointer events to avoid a
dependency. It could not scroll the list during a drag, which a library
provides. hukube uses an established, maintained package for a solved
interaction and hand-rolls only when nothing fits (`AGENTS.md`, "Designing
features").

### Keyboard

The "Customize columns" button is an ordinary button, so the keyboard shows
and hides columns and resets a list. Moving a column from the keyboard goes
through the header's context menu, where the browser has a key that opens
one. That path has not been tried on Windows or Linux.

Chromium on macOS has no such key, so there a column can only be moved with
the pointer. A header shortcut for moving was built to cover that and then
dropped (see "What changed while building").

## Steps

The work ships as one PR, in commits that each pass `mise run check`.

1. Add the layout model in `apps/app/src/features/resource-list/`: the stored
   shape and its reader, the defaults, resolving, and the edits. All of it is
   pure and unit tested.
2. Add the store that watches and writes a type's setting, and its hook.
3. Render the list from a resolved layout: the generalized header and cells,
   widths keyed by column, the spare-width column, and the derived sort.
4. Add the "Customize columns" button, the header context menu, and header
   dragging.
5. Add the Playwright test, check the Event and Pod lists by hand on
   `mise run dev:verify`, and mark this plan as shipped.

## Testing strategy

| Risk                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A layout resolves wrongly                                    | Vitest: the default alone; a stored layout; a served column the stored layout does not know, at the start, middle, and end; a stored column the Cluster does not serve, kept through an edit.                                                                                                                                                                                                                                                                                                                                                                          |
| A Cluster's column names break the list                      | Vitest: columns named `constructor`, `__proto__`, and `toString`; a served column named `Name`; two served columns with one name.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A stored value of the wrong shape breaks the list            | Vitest for the reader: `null`, another version, a non-array, entries of the wrong shape, and repeated entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The tuned defaults are wrong, or hide everything             | Vitest: the Pod and Event defaults against their real columns, both Event type keys, an Event list before its columns arrive, and a layout that shows nothing.                                                                                                                                                                                                                                                                                                                                                                                                         |
| A move lands in the wrong place                              | Vitest: moves across hidden and unserved entries, at both ends, and with the Namespace column not shown.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The sort outlives its column                                 | Vitest for the function that derives the sort from the shown columns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The spare width goes to the wrong column                     | Vitest for `gridLayout`: Message for Events, Name elsewhere, and the fallback when that column is hidden.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| An edit flickers back, or another window's edit is lost      | Vitest for the store against a fake client: an edit shows before its write resolves, an edit made during a write waits and the latest one replaces it, a value that arrives during a write is not shown whether it is the list's own or another client's, a late echo on a replaced watch is dropped, the first value of the new watch is shown, a value that arrives while idle is shown, and a failed write with and without an edit waiting. Playwright: a second page open on the same list follows an edit without a reload.                                      |
| A long type key cannot be stored                             | Go tests for the settings store: a 250-byte key survives reopening the store, two long keys with a shared prefix stay apart, and a short key keeps its file name.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Editing does not work end to end, or does not survive reload | Playwright, on the Service list: hide a column from the "Customize columns" menu, move one by dragging its header and one from its header's context menu, sort from the context menu, toggle a column from the context menu's checklist, reload, and find the layout kept. It also covers a drag cancelled with Escape, a press that only sorts, a drag that ends where it started, a drag to the edge that scrolls the list and drops on a column that was off screen, and the button staying clear of the last column. It resets the type's layout before and after. |

How the Event and Pod lists look at 1280 px is checked by hand on
`mise run dev:verify`, as is that dragging a header starts no dockview drag.

## Risks

- **dnd-kit is before 1.0.** `@dnd-kit/react` 0.5.0 can change its API in a
  minor release, and the scrolling workaround leans on a property that is
  not a documented option. Both packages are pinned exactly.
- **Firefox and Safari are untested.** The web Host should work in both.
  Nothing used is specific to Chromium, but dragging has only been run in
  Chromium.
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
- Dragging headers by touch.

## What changed while building

- **An experience review of the running app found four things, now fixed.**
  A drop at the right edge of a wide list failed while the pointer was over
  the pinned button. A column shown from the checklist could appear off
  screen. A header focused from the keyboard had no focus ring. The dragged
  copy of a header covered the marker and the labels beside it. The review
  also asked for the Event list to open sorted by Last Seen, which stays a
  non-goal here.
- **Dragging moved to dnd-kit.** The hand-rolled pointer-event drag was
  replaced on Jim's direction, because it avoided a dependency at the cost
  of the experience: a drag could not scroll the list. "Drag headers with
  dnd-kit" has the result and the reasons for the newer API.
- **Customization moved from the toolbar to the header row.** Jim found the
  "Columns" button next to the filters out of place. It became a button at
  the end of the header row, and the header's context menu gained the sort
  actions and the checklist.
- **No header shortcut for moving a column.** `Alt+ArrowLeft` and
  `Alt+ArrowRight` on a focused header were built, because Chromium on macOS
  cannot open a context menu from the keyboard. Jim dropped them in review:
  they are not a convention for moving columns, they only worked while a
  header had focus, and those keys are better kept for something else. Moving
  a column from the keyboard on macOS is an open gap.
- **The sync rule was replaced.** The plan first had a list tell its own
  echoes from another client's values by comparing them with what it had
  written. Every version of that rule had an order of messages that fooled
  it: another client's value that was never shown, an earlier edit that
  briefly replaced a later one, and a value from another client that matched
  an earlier edit. A value does not say when the Engine computed it, so the
  list no longer guesses. It ignores its watch while writing and asks again
  afterwards, as "Stay in sync" describes. The cost is one more subscription
  for each burst of edits.
- **Writes go one at a time.** Review found that the Engine can apply two
  writes in flight in either order, which could leave the older edit stored.
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
