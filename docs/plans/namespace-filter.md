# Plan: filter and choose several Namespaces in a Resource list

Status: implemented, not merged yet. Jim settled the open questions; see "Decisions
from Jim".

## Outcome

After this work:

- A Resource list of a namespaced type has a Namespace control in its toolbar,
  where the single-choice dropdown is today. Opening it shows a filter field
  and a checkable list of the Cluster's Namespaces. Typing narrows the list,
  and Enter or a click checks or unchecks a Namespace. The filter text stays
  after a pick, selected, so clicking several matches works and the next
  keystroke starts a new filter.
- The list shows the Resources of every checked Namespace at once, and updates
  as each Namespace is checked, without closing the popup.
- "All namespaces" is the empty selection. It is the first row of the popup
  and the default for every list. An × button on the control returns to it in
  one click. Nobody has to check every Namespace or uncheck every chosen one
  by hand.
- The control reads "All namespaces", the one chosen name, or the first name
  and a count, such as `shop +2`.
- The selection is saved with the list's Tab, so it survives a reload and a
  restart of the app.
- The Namespace column shows whenever the list can hold Resources from more
  than one Namespace, so it now also shows for two or more chosen Namespaces.
- A Cluster with more than 1,000 Namespaces says so in the popup, and typing
  searches all of them through the Engine.

The Engine and the protocol do not change.

## Constraints

- `AGENTS.md`, "Designing features": placement, keyboard and pointer paths, and
  every state are settled here; an established component is used rather than
  a hand-rolled one; no key binding is added without Jim's approval (none is
  proposed); the running app is reviewed in both themes and at two widths, and
  the `ux-review` skill runs before code review.
- Use `CONTEXT.md` terms: Namespace, Resource, Resource Type, Tab, Pane,
  Workspace, Preview Tab, Query, Engine, Cluster.
- `AGENTS.md`, "Query windows": a Namespace list holds at most `limit` rows,
  so code must check `total`. Today's dropdown ignores it.
- `AGENTS.md`, "End-to-end lists": tests share one Engine and one Workspace, so
  a test must not leave a list scoped for a later test to find.
- ADR-0009: Workspace layouts are read once on open and the last save wins.
  Tab params ride on that.
- Compatibility: a layout saved by an older build has no Namespace params and
  opens on All namespaces. An older build ignores the new param.
- Performance: one list subscription per list, as today. Namespace names stay
  one subscription of at most 1,000 rows per list, as today, plus a search
  subscription only while typing in a Cluster with more than 1,000.

## Current state

Observed at `c73a1a8`:

- `NamespaceSelect` in
  `apps/app/src/features/resource-list/resource-list-panel.tsx:388` is a Base
  UI `Select` (`packages/ui/src/components/select.tsx`) with "All namespaces"
  (`null`) and one item per name. It has no filter and holds one value in
  component state (`useState<string | null>`, line 70), so a reload, a closed
  Tab, or a replaced Preview Tab returns the list to All namespaces.
- It renders every name without virtualization and ignores
  `Namespaces.complete`, so names past the first 1,000 cannot be chosen and
  nothing says so.
- Its trigger is `size="sm"` (`h-6`, 24 px) beside two filter inputs that are
  `h-7` (28 px). The toolbar row (`flex items-center gap-2`, line 196) cannot
  wrap, so in a narrow Pane the controls overflow. That last point is inferred
  from the classes and must be confirmed in the running app.
- `useNamespaces` (`apps/app/src/features/namespaces/use-namespaces.ts`)
  subscribes to `resources.query` for `type in [namespaces]`, sorted by name,
  limit 1,000, and returns `names` and `complete`. Go to Resource
  (`go-to-resource.tsx:95`) also uses it, only while its palette is open, and
  treats a list that is incomplete or not `ready` as unknown.
- `listQuery` (`query-window.ts:34`) already builds
  `{op: "in", field: "namespace", values: [namespace]}`.
- The Engine compiles `in` to a set lookup (`engine/internal/query/query.go:86`)
  and scans every Resource of the type whatever the Namespace filter
  (`index.Store.Each`, `query.Run`). Change signals are per type
  (`queryChanges`, `server/topics.go:278`), and the Table watch covers the
  whole type across Namespaces (`docs/plans/list-columns.md`). A Query over
  several Namespaces therefore costs the same as one over a single Namespace.
  `query_test.go:84` already runs a multi-value Namespace `in`.
- `useSubscription` updates a live subscription in place when its params
  change (`packages/engine-client/src/react.tsx:88`), and the connection
  restores every subscription with its latest params after a reconnect
  (`connection.ts:66`).
- The Namespace column shows only when `namespace === null`
  (`column-layout.ts:152`), and the column menus disable its checkbox
  otherwise (`column-menu.tsx:57`). The flag is called `allNamespaces`.
- A list Tab's params are `{ type, preview? }` (`workspace/dock.ts:4`), and its
  panel ID is `list:<type key>`, one per type per Workspace.
  `api.updateParameters` merges into the panel's params and fires dockview's
  layout change (dockview-core 8.5.1, `main.esm.mjs` around line 18764), which
  `persistLayout` saves after 400 ms (`layout-persistence.ts`). Resource Tabs
  keep their Facet in params and Exec Session Tabs their command line
  (`exec-panel.tsx:312`), so Tab state in params is an established pattern.
- `pinPanel` (`dock.ts:86`) writes a full copy of the params it was given. A
  copy captured before a Namespace change would overwrite that change.
- Content turns `inert` when the window is out of date (`routes/__root.tsx:28`),
  but popups portal outside it. Go to Resource closes its palette when its
  Workspace is hidden or out of date for that reason.
- `clusters.list` sends each context's default Namespace
  (`protocol.Cluster.Namespace`), and the UI does not use it.
- `packages/ui` has no combobox. The shadcn registry's `combobox` for the
  `base-mira` style wraps Base UI `Combobox` and needs only `button` and
  `input-group`, which exist. Base UI 1.9 also ships Menu filtering, marked
  Preview.
- App copy is sentence case. Placeholders have no ellipsis ("Filter types");
  loading text has one ("Loading saved definitions…"). Empty filters say
  "No resource types match." No popup honors `prefers-reduced-motion`.

## Comparable tools

| Tool                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Source                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lens (Freelens fork)          | One selection per Cluster, shared by every list and saved in local storage, defaulting to `default`. A click selects only that Namespace and closes; holding Cmd (macOS) or Ctrl toggles and keeps the menu open. "All Namespaces" is the first option and means all, implicitly. Selected Namespaces sort first when the menu opens, frozen while it is open. The label reads "All namespaces", "Namespace: a", or "Namespaces: a, b". A layers icon marks each Namespace. | Checked in source: `freelensapp/freelens` `namespace-select-filter-model.tsx`, `namespace-select-filter.tsx`, `is-selection-modifier-key.injectable.ts`, `features/namespace-filtering/renderer/storage.injectable.ts`. |
| Headlamp                      | An MUI multiple Autocomplete with a checkbox per Namespace, kept open while picking (`disableCloseOnSelect`). An empty selection reads "All namespaces". The label joins names up to 12 characters, then "+N" with the rest in a tooltip. Picking clears the typed text. The selection is global (Redux) and mirrored in the URL's `namespace` parameter. When Namespaces cannot be listed it falls back to the kubeconfig default or configured "allowed namespaces".      | Checked in source: `kubernetes-sigs/headlamp` `frontend/src/components/common/NamespacesAutocomplete.tsx`.                                                                                                              |
| k9s                           | One active Namespace per context, or all, saved in its config, with favorites on number keys and 0 for all. No multiple selection.                                                                                                                                                                                                                                                                                                                                          | Memory.                                                                                                                                                                                                                 |
| GitHub (Primer SelectPanel)   | An anchored panel with a filter input and checkable rows, optional selected-first ordering, an optional "Select all", messages for empty, error, and loading. Anchored panels apply on close.                                                                                                                                                                                                                                                                               | Checked: primer.style SelectPanel docs.                                                                                                                                                                                 |
| Linear filters                | A filter chip opens a searchable checklist; the chip summarizes the values and its × removes the filter.                                                                                                                                                                                                                                                                                                                                                                    | Memory.                                                                                                                                                                                                                 |
| Grafana multi-value variables | "All" is a value of its own, distinct from checking every value; checking a value clears All.                                                                                                                                                                                                                                                                                                                                                                               | Memory.                                                                                                                                                                                                                 |

Every Kubernetes tool above scopes by Namespace from the list's own header,
and every one treats "all" as no filter rather than as every name. They split
on whether the selection is one per Cluster (Lens, Headlamp, k9s) or one per
view, and on whether a click replaces (Lens) or toggles (Headlamp, GitHub,
Linear, Grafana). Jim chose one selection per list Tab and toggling (see
"Decisions from Jim").

## Decisions

### "All namespaces" is no Namespace filter

The selection is a sorted list of names. Empty means All namespaces: the
Query has no Namespace clause, so it covers Namespaces created later and any
the UI has not loaded. Checking every listed name is a different, fixed set
that does not grow. The UI never turns one into the other, as Lens and Grafana
keep them apart. Because All namespaces is one action, there is no "Select
all" of names.

Clear, reset, and choose all are therefore one action, because a new list
starts on All namespaces. If a list instead opened on the context's
Namespace, reset would become a second, distinct action.

### The Engine and protocol do not change

`listQuery` takes `namespaces: string[]` and adds
`{op: "in", field: "namespace", values}` when it is not empty. The Engine
already evaluates it with a set lookup, at the cost of a single-Namespace
filter (see Current state). A thousand names add about 64 KB to a
subscription's params, far below `MaxClientMessageBytes` (8 MiB). No
`mise run gen`, no Engine restart notice.

The clause is added only when the list's type is namespaced, so params left on
a type whose CRD changed scope cannot empty a list with no control to undo it.

### The selection lives in the list Tab's params

Jim's decision. `ListPanelParams` gains
`namespaces?: string[]`, absent for All namespaces. The list derives its
selection from params on every render, so a restored layout, a reload, and an
Engine restart all show the saved selection. Restored params are untrusted:
`readNamespaces` keeps unique, non-empty strings, sorted.

A change writes one partial update,
`api.updateParameters({ namespaces: next.length ? next : undefined, preview: false })`.
Dockview merges it and deletes the key for `undefined`. One write avoids
`pinPanel` overwriting the change with a stale full copy. Changing the
Namespaces pins a Preview Tab, as opening a row and editing columns do,
because the selection is saved with the Tab and the next preview would
otherwise replace it.

Each list keeps its own selection, so two Panes can show different
Namespaces side by side. Opening another type starts on All namespaces, as it
does today.

### Base UI Combobox from the shadcn registry

Add `combobox` with the shadcn CLI from `packages/ui`
(`yes n | bunx --bun shadcn@latest add combobox`), which keeps the existing
`button` and `input-group`. Compose Base UI's "input inside popup" pattern
with `multiple`:

- Base UI documents Combobox as "a filterable Select" for lists large enough
  to filter, which is this control. The app already uses Base UI `Select` here.
- It has the parts this needs: `multiple`, an input inside the popup, `Status`
  and `Empty` live regions, `useFilter`, `useFilteredItems`, and external
  filtering. The × is a plain `Button`, not `Combobox.Clear`: the controlled
  value holds the "All namespaces" item while nothing is chosen (see below),
  so `Clear` would never hide.
- Its roles follow the APG combobox and listbox patterns: the trigger is a
  `combobox` with `aria-haspopup="dialog"`, the popup a `dialog`, the list a
  `listbox` with `aria-multiselectable` (checked in Base UI 1.9.0 source).
- Menu filtering in Base UI 1.9 is marked Preview and has action-menu
  semantics, not value selection. `cmdk` (`command.tsx`) has no multiple
  selection. Nothing is hand-rolled.

The popup's list is virtualized with `@tanstack/react-virtual`, which the
Resource list already uses, following Base UI's documented "Virtualized"
Combobox example: `virtualized` on the root, rows from `useFilteredItems`,
each `Combobox.Item` given its `index`, `aria-setsize` and `aria-posinset` on
rows, and the highlighted row scrolled into view from `onItemHighlighted`.
The guideline requires virtualizing lists over 50 items, and Base UI's docs
say memoization does not make opening fast once mount cost dominates. A
Cluster can hold up to the hook's 1,000 names, and measuring that would mean
creating 1,000 Namespaces on the shared test cluster.

### The popup's contents

Top to bottom:

1. A filter input: `aria-label="Filter namespaces"`, placeholder
   "Filter namespaces" (matching "Filter types"), `autoComplete="off"`,
   `spellCheck={false}`.
2. A `Combobox.Status` line, always mounted, polite. Its text depends on state
   (see States).
3. The listbox:
   - "All namespaces", checked when the selection is empty, shown only while
     the filter is empty. Hidden while filtering, it is not a match and would
     take the first-match highlight from the Namespace the user typed.
   - One row per Namespace: a check, the name in the mono font with
     `translate="no"`, truncated with its full text in `title`, and
     "Not found" in muted text for a chosen Namespace the Cluster no longer
     has.
   - Chosen Namespaces first, by name, then the rest by name. The order is
     taken when the popup opens and kept while it is open, so a row does not
     jump when it is checked (Lens does the same). No live change moves a
     row while it is open: Namespaces created since it opened follow the
     listed rows, and deleted ones stay until it closes (see "What changed
     while building").
4. `Combobox.Empty`: "No namespaces match.", except while the names load or
   cannot be listed, when no search ran.

"All namespaces" is an item whose value no Namespace name can take
(Namespace names are DNS-1123 labels). The controlled value holds it while the
selection is empty, so it reports `aria-selected` correctly. `nextSelection`
maps Base UI's new value back: checking the sentinel clears the selection,
pressing it while already on All changes nothing, and checking a name while on
All selects just that name.

Selections apply at once, not on close. The list behind the popup updates as
each Namespace is checked, the subscription changes in place, and the cost is
one Query recompute per click.

### More Namespaces than the UI loads

`useNamespaces` also returns `total`. When `total` exceeds the 1,000 loaded:

- The Status line reads "Showing 1,000 of 1,432 namespaces. Type to search the
  rest." Counts use `Intl.NumberFormat`.
- While the filter is not empty, a second subscription fetches up to 1,000
  Namespaces whose name contains the text
  (`and(type in [namespaces], name contains q)`), and the popup lists those.
  The decision to search comes from the unfiltered subscription, so it cannot
  flip back and forth as results arrive.
- The client-side filter still runs over whatever arrived, so a result for an
  older query is narrowed to the current text and Enter can only pick a name
  that matches it. While the result is stale, Status reads "Searching…".
- When the matches also exceed 1,000, Status reads "Showing 1,000 of 1,210
  matches. Type more to narrow them down.", echoing Go to Resource.

Chosen Namespaces outside the loaded set are still listed and still checked.

### A chosen Namespace that disappears

Names are never pruned from the selection automatically. A Namespace deleted
and recreated, such as by GitOps or a dev loop, keeps its place, and a
selection restored before the names load is not lost. Its Resources leave the
list as the Cluster deletes them. In the popup it stays checked and shows
"Not found", but only when the Namespace list is complete and the type is
`ready`. Otherwise the UI cannot know, and shows no mark. Unchecking it removes
it like any other.

### The Namespace column follows the number of Namespaces

Rename `allNamespaces` to `oneNamespace` (its inverse) in `column-layout.ts`,
`column-menu.tsx`, `column-header.tsx`, and their tests. The old name stops
being true once several Namespaces can be chosen. The column shows unless
exactly one Namespace is chosen, and the column menus disable its checkbox in
that case only. A list sorted by Namespace falls back to name while one
Namespace is chosen and returns when the column does, through the existing
`shownSort`.

### The toolbar wraps

The toolbar row and its filter group get `flex-wrap`, so in a narrow Pane the
three controls move under the heading instead of overflowing. The Namespace
control takes `w-56` and `h-7`, the size of the two filter inputs beside it,
so the row does not shift when the selection changes and the three controls
line up.

## Experience

### Placement

The control stays where the Namespace dropdown is: first of the list's filter
controls, left of "Filter by name". It filters the rows, so it belongs with
the filters, not on the column header (`AGENTS.md`). Lens and Headlamp put
their Namespace filter in the same place.

### The control

A bordered group, `w-56`, `h-7`:

- A trigger button with a leading layers icon (`Layers01Icon`, `aria-hidden`),
  matching the search and tag icons of the inputs beside it and Lens's layers
  icon for Namespaces; the label; and the chevron.
- An × button (`Cancel01Icon`) inside the group's right edge, shown only while
  Namespaces are chosen. Accessible name and tooltip: "Show all namespaces".
  At least 24 px wide and 28 px tall.

| Chosen | Label          | Accessible value  |
| ------ | -------------- | ----------------- |
| 0      | All namespaces | All namespaces    |
| 1      | `shop`         | shop              |
| 3      | `shop` +2      | shop and 2 more   |
| 40     | `alpha` +39    | alpha and 39 more |

The first name is the first chosen by name. It truncates (`min-w-0
truncate`); the count does not (`shrink-0 tabular-nums`). The visible "+2" is
`aria-hidden` and an `sr-only` "and 2 more" replaces it. The trigger's
accessible name is "Namespace", through `Combobox.Label` (visually hidden) or
`aria-label`, whichever Base UI associates with the trigger. The popup's
accessible name is "Namespaces". The full list of chosen names is in the
popup, first, and in a tooltip on the trigger (see "What changed while
building").

### Keyboard

No new key binding. Every key below belongs to the combobox and listbox
patterns Base UI implements; the implementer confirms each in the running app.

| Key                     | Where        | Result                                                                                            |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| Tab                     | Toolbar      | The trigger, then × when shown, then "Filter by name".                                            |
| Enter, Space, ArrowDown | Trigger      | Opens the popup and focuses the filter input.                                                     |
| Typing                  | Filter input | Narrows the rows. The first match is highlighted (`autoHighlight`).                               |
| ArrowDown, ArrowUp      | Filter input | Moves the highlight, wrapping from the last row to the first and back.                            |
| Enter                   | Filter input | Checks or unchecks the highlighted row, keeps the filter text selected, and keeps the popup open. |
| Escape                  | Popup        | Closes it and returns focus to the trigger.                                                       |
| Tab                     | Popup        | Closes it; focus moves on.                                                                        |
| Shift+Tab               | Popup        | Closes it and returns focus to the trigger, as Escape does.                                       |
| Enter, Space            | ×            | All namespaces; focus moves to the trigger.                                                       |

The common paths:

- One Namespace from All: open, type `sho`, Enter, Escape.
- Add a second: open, type `pay`, Enter, Escape.
- Back to All: × from the toolbar, or open, ArrowDown to "All namespaces",
  Enter.
- Switch from `shop` to `payments`: open (the highlight is on `shop`), Enter
  unchecks it, type `pay`, Enter. Jim chose toggling over Lens's one-step
  replace with a modifier.

After a pick, by Enter or by click, the filter text stays and is selected.
Base UI clears it by default when the input is inside the popup; cancel that
clear in `onInputValueChange` when `eventDetails.isItemPress` is set, as its
"Keeping the filter after selection" docs show, then select the input's text.
Typing a new name replaces the selected text, so one name after another works
as with clearing, and clicking or pressing Enter on several matches of one
filter, such as `prod`, also works. Clearing would reset the list under the
pointer after the first click. The text still resets when the popup closes.
Confirm in the running app that the selection survives Base UI's re-render;
if it cannot, keep the text without selecting it and record the deviation.
While text remains, the "All namespaces" row stays hidden; × and clearing the
text bring it back.

### Pointer

Click the trigger to open. Click a row to check or uncheck it; the popup
stays open and the filter stays. Click outside to close. Click × for All namespaces. Rows highlight
on hover.

### Assistive technology

- The trigger is a `combobox` named "Namespace", whose value is the label
  text, with `aria-expanded`.
- The filter input is a `combobox` named "Filter namespaces", pointing at the
  highlighted row with `aria-activedescendant`.
- Rows are `option`s with `aria-selected`; the listbox is
  `aria-multiselectable`. "Not found" is part of a row's text.
- `Combobox.Status` and `Combobox.Empty` announce politely, so loading, the
  incomplete-list note, searching, and no matches are spoken.
- Decorative icons are `aria-hidden`; Namespace names carry `translate="no"`.

### Focus

Opening focuses the filter input. Escape returns focus to the trigger. × unmounts
itself, so it moves focus to the trigger rather than to `body`. A click
outside leaves focus where the click put it. When the Workspace is hidden or
the window goes out of date, the popup is closed by force (controlled `open`,
closed when `useWorkspace().active` is false), as Go to Resource does, because
the popup is portaled outside the inert content.

### States

| State                                          | Popup                                                                                       | Trigger       | The rest of the list                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| Names loading                                  | Status "Loading namespaces…". All namespaces and the chosen rows, unmarked, are usable.     | From params   | Queries the selection at once; does not wait for names.         |
| Ready                                          | All rows                                                                                    | From params   | Unchanged                                                       |
| No match                                       | "No namespaces match."                                                                      | Unchanged     | Unchanged                                                       |
| Not permitted to list Namespaces (`forbidden`) | Status "Your credentials cannot list namespaces." All namespaces and chosen rows, unmarked. | Unchanged     | Unchanged; All namespaces still works.                          |
| Namespace listing failed (`failed`)            | Status "Could not list namespaces."                                                         | Unchanged     | Unchanged                                                       |
| More than 1,000                                | Status note; typing searches the Engine (see above)                                         | Unchanged     | Unchanged                                                       |
| Chosen Namespace deleted                       | Checked, "Not found" (complete list only)                                                   | Still counted | Its rows leave; the empty state says when no chosen one exists. |
| List type not permitted or not served          | No toolbar: the existing notices replace the list.                                          | Not shown     | Existing notice                                                 |
| Cluster unreachable                            | Last known names                                                                            | Unchanged     | Last known rows, as today                                       |
| Engine reconnecting                            | Last known names; checks still change params                                                | Unchanged     | The subscription resumes with the latest params on reconnect.   |
| Window out of date, or Workspace hidden        | Closed by force                                                                             | Inert         | Inert                                                           |

The list's empty state names the cause when only the Namespace selection
narrows it:

- One Namespace: "No ConfigMap resources in shop", then "This list updates
  live."
- Several: "No ConfigMap resources in 3 namespaces", then "This list updates
  live."
- With a name or label filter as well: the existing "No matches" and "Nothing
  matches the current filters."
- None of the chosen Namespaces exists, whatever the other filters: "shop not
  found" or "3 chosen namespaces not found" (see "What changed while
  building").

The × beside the control is the recovery, so the empty state stays
non-interactive.

### Widths, themes, and long names

- Narrow Pane (about 420 px): the controls wrap under the heading; the
  trigger keeps its width and its count; the popup is at least the trigger's
  width and at most `min(28rem, var(--available-width))`.
- Wide Pane (about 1,400 px): unchanged, right-aligned.
- Long names: a 63-character Namespace truncates in the trigger and in its
  row, keeps "+N" visible, and shows its full name in the row's `title` and
  the trigger's tooltip.
- Both themes: shadcn tokens only. Check the check mark, the highlighted row,
  "Not found", and the count against the popover background in light and
  dark.

## Web interface guidelines

Rules from `/tmp/nsms/wig-agents.md` and `/tmp/nsms/wig-command.md` that apply,
and what the implementer does for each:

- **Keyboard and focus (APG, visible rings, managed focus):** Base UI's
  combobox and listbox; the trigger and × keep the app's
  `focus-visible:ring-2 focus-visible:ring-ring/30` treatment; focus moves as
  Experience, "Focus" says.
- **Targets of at least 24 px:** the trigger is 28 px tall; × is at least
  24 × 28 px. Rows keep the registry's `min-h-7`.
- **Accessible names; icon-only buttons labelled; decorative icons hidden:**
  "Namespace", "Namespaces", "Filter namespaces", "Show all namespaces";
  `aria-hidden` on icons.
- **Polite live regions for async updates:** `Combobox.Status` and
  `Combobox.Empty`, mounted throughout.
- **Loading text ends with "…":** "Loading namespaces…", "Searching…".
- **Locale-aware numbers and tabular figures:** `Intl.NumberFormat` for every
  count; `tabular-nums` on "+N".
- **`translate="no"` on identifiers:** Namespace names in the trigger and rows.
- **Long content:** `min-w-0` and `truncate` on the name in the trigger and in
  rows; `shrink-0` on the count.
- **Empty and error states, no dead ends:** the States table; × always
  returns to All namespaces.
- **Reduced motion:** `motion-reduce:animate-none` on the popup. Other popups
  in the app lack this; that is a separate fix.
- **No `transition: all`:** keep the registry's `transition-colors`.
- **`overscroll-behavior: contain`:** the registry's list has it.
- **Inputs:** `autoComplete="off"`, `spellCheck={false}`, a controlled value
  with `onChange` (Base UI's).
- **Virtualize long lists:** the popup's list is virtualized (see "Base UI
  Combobox").
- **Not applied, by house convention:** Title Case (the app is sentence case:
  "All namespaces", "Customize columns"); ellipses in placeholders ("Filter
  types"); the URL reflecting filters (Tab state is restored from the
  Workspace layout, ADR-0009, not the URL).

## Approach and files

| File                                                                                                  | Change                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/components/combobox.tsx`                                                             | New, from the shadcn CLI.                                                                                            |
| `apps/app/src/features/namespaces/use-namespaces.ts`                                                  | Return `total`; take an optional search text, adding `name contains`. Go to Resource's call keeps working unchanged. |
| `apps/app/src/features/resource-list/namespace-selection.ts` and test                                 | Pure helpers: `readNamespaces`, `nextSelection`, the popup's row order and "Not found" marks, the trigger's label.   |
| `apps/app/src/features/resource-list/namespace-picker.tsx` and test                                   | The control: trigger, ×, popup, states, forced close.                                                                |
| `apps/app/src/features/resource-list/query-window.ts` and test                                        | `ListFilters.namespaces: string[]`.                                                                                  |
| `apps/app/src/features/resource-list/column-layout.ts`, `column-menu.tsx`, `column-header.tsx`, tests | `allNamespaces` becomes `oneNamespace`.                                                                              |
| `apps/app/src/features/resource-list/resource-list-panel.tsx`                                         | Selection from props; the picker; empty-state copy; toolbar wrap.                                                    |
| `apps/app/src/features/workspace/dock.ts`, `workspace.tsx`                                            | `ListPanelParams.namespaces`; the list component gets the selection and one partial update that pins.                |
| `e2e/tests/web.spec.ts`; `e2e/tests/exec.ts`                                                          | The new test; generalize `savedSessionLayout` to wait for a layout containing given text.                            |

The sample fixtures in `e2e/fixtures/sample` do not change. Running-app
checks that need long names or many Namespaces create temporary ones with a
unique prefix and delete them afterwards, because another session shares the
test cluster.

No Engine, protocol, ADR, or `CONTEXT.md` change.

## Steps

One PR, in commits that each pass `mise run check`.

1. Write the pure helpers and `listQuery` change test-first, and see the new
   tests fail at their assertions.
2. Rename `allNamespaces` to `oneNamespace` and show the column for several
   Namespaces.
3. Add the combobox with the shadcn CLI.
4. Extend `useNamespaces` and build the picker, with its component tests.
5. Wire the picker into the list and the Tab params; update the empty state
   and the toolbar.
6. Add the Playwright test.
7. Check the running app on `mise run dev:verify` (below), run the
   `ux-review` skill, fix and re-check, then code review.

## Testing strategy

| Risk                                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Query omits or mangles the selection                                   | Vitest for `listQuery`: none adds no clause; one; several, unsorted and repeated, become one sorted `in`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A malformed or old layout breaks the list                                  | Vitest for `readNamespaces`: missing, not an array, non-strings, empty strings, repeats.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| All namespaces and the names interact wrongly                              | Vitest for `nextSelection`: All to one name; a name to All; All pressed while All; adding and removing; the result sorted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rows jump, chosen names vanish, or "Not found" is wrong                    | Vitest for the row order: chosen first; order kept after a check while open; a new name while open; a chosen name absent from the names, marked only when the list is complete and `ready`, unmarked while loading, incomplete, or forbidden; All namespaces absent while filtering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The label misreads the selection                                           | Vitest for the label: 0, 1, 3, and 40, visible and accessible text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The Namespace column shows or hides wrongly                                | Existing `column-layout.test.ts` and `columns.test.ts` cases, renamed, plus one each for one and several Namespaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Status messages, the incomplete list, forced close, or × focus are wrong   | Vitest with jsdom and Testing Library for the picker, with a fake Engine client as `workspace.test.tsx` uses: loading, `forbidden`, `failed`, and incomplete Status text; the search subscription starts only when incomplete and filtering; the popup closes when the Workspace turns inactive; × moves focus to the trigger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| It does not work end to end, by keyboard and pointer, or is lost on reload | Playwright web test on the ServiceAccounts list, which no other test uses. Every Namespace gets a `default` ServiceAccount, so three fresh Namespaces need no fixtures. It opens the list as a Preview Tab, scopes locators to its tab panel, opens the control, types the first Namespace's name, presses Enter, types the second, presses Enter, presses Escape, and checks focus on the trigger, the label `<first> +1`, both Namespaces' rows, no third, and a Namespace column. It reopens, unchecks the first by clicking, and checks the label and that the column hid. It single-clicks the Secret type in the sidebar and finds the ServiceAccounts Tab still open, so the change pinned it. It waits for the layout to be saved, reloads, and finds the same selection and rows, which also catches `pinPanel` overwriting it. It ends by clicking "Show all namespaces", seeing all three, and checking focus on the trigger, which leaves the Tab on All for later tests. |
| The Engine evaluates several Namespaces wrongly                            | Existing `query_test.go:84` (multi-value Namespace `in`); the Playwright test through the Engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| It looks broken in a theme, a width, or with long names                    | Running app on `mise run dev:verify`: light and dark; a Pane of about 420 px and one of about 1,400 px; a temporary Namespace with a 63-character name in the trigger and a row; keyboard only; Playwright `ariaSnapshot()` of the trigger, popup, and listbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The virtualized popup loses the highlight or rows when scrolling           | Running app on `mise run dev:verify` with about 100 temporary Namespaces under a unique prefix, deleted afterwards: ArrowDown through the end of the list keeps the highlighted row in view, scrolling with the pointer shows every row, and filtering then clearing restores the full list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Not-permitted, Cluster-unreachable, and Engine-lost states mislead         | The `ux-review` skill's fault states, including an identity that can list a namespaced type but not Namespaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The Playwright test needs no fixed sleeps: it waits on rows, labels, and the
acknowledged `settings.put`. One targeted perturbation is enough for the
end-to-end path: make `listQuery` keep only the first Namespace and see the
test fail at the second Namespace's row, then restore it and rerun.

## Failure paths and risks

- **A stale params copy overwrites the selection.** One partial
  `updateParameters` that also pins; the reload step of the Playwright test
  covers it.
- **Selections restored before names load.** The selection comes from params,
  and nothing prunes it.
- **A deleted Namespace.** Kept and marked, never pruned (see Decisions).
- **More than 1,000 Namespaces.** Status note and Engine search; stale results
  are narrowed client-side, so Enter cannot pick a non-match.
- **Rapid checks.** Each changes the subscription in place; the list shows the
  previous rows until the next result, as with typing in the name filter. The
  layout save is debounced.
- **Engine reconnects.** Subscriptions resume with the latest params. A
  change made while the Engine is unreachable reaches params at once, but
  its layout save fails and is not retried until the next layout change. That
  is existing behavior for every layout change.
- **Two windows on one Cluster.** The last layout save wins (ADR-0009), as for
  every Tab.
- **The popup outlives its Workspace.** Closed by force when the Workspace is
  inactive or the window is out of date.
- **Open time on large Clusters.** The popup's list is virtualized.
- **Base UI behavior assumed from docs.** Keyboard details, the trigger's
  keys, and Tab closing the popup are from Base UI 1.9 docs and source, not
  yet observed. The Playwright test and the running-app check confirm them.
- **Lens users expect click-to-replace.** Jim chose toggling; the UX review
  checks that switching Namespaces still reads clearly.

## Non-goals

- A selection shared by every list of a Cluster (Jim chose one per list Tab).
- New lists inheriting a selection. It can follow later with an
  initial-params hook on `openList`.
- Saving the name and label filters in Tab params. They are typed and
  discarded often, and saving each keystroke into the layout needs its own
  debounce decision.
- Choosing a Namespace the Cluster does not let the user list. A user who can
  list a namespaced type cluster-wide but not Namespaces is rare, and the list
  still works on All namespaces.
- Scoping a list to a Namespace from Go to Resource.
- Engine-side Namespace scoping of watches or the Table watch.
- Bulk "select matching" while filtering.
- Starting a new list on the kubeconfig context's Namespace.
- Reduced-motion handling for the app's other popups.

## Decisions from Jim

Settled before implementation, each with the recommended option:

1. **Where the selection lives:** in each list Tab's params, saved with the
   Workspace layout, per list. Two Panes can differ, and opening another type
   starts on All namespaces. Not an Engine setting per Cluster, which Lens,
   Headlamp, and k9s use, and not component state.
2. **Click and Enter toggle** a Namespace and keep the popup open, as in
   GitHub, Linear, Headlamp, and Grafana. Not Lens's replace-on-click with a
   modifier to toggle, which would add a key binding.
3. **A new list starts on All namespaces**, not the kubeconfig context's
   Namespace, so clear, reset, and choose all stay one action.
4. **No bulk "Select N matching" action** in this feature. Because the filter
   text stays after a pick, checking several matches takes one click or Enter
   each.

## Open questions

None.

## What changed while building

- **The popup's width follows its longest name.** A fixed `w-80` cut long
  names short. The width is now the longest row in `ch` of the names' mono
  font, counting " Not found" on a missing one, plus 3rem for the row's
  padding and check mark, between the trigger's width (`--anchor-width`) and
  `min(28rem, var(--available-width))`. Nothing is measured in the DOM. The
  popup takes the mono font so that `ch` is the names' width, and its parts
  return to the app's font. A 63-character name needs about 31rem, so at the
  cap it still loses its last characters; its row's `title` has them.
- **The popup opens on the first chosen row.** Base UI takes the highlight on
  open from the rows it had while closed, and the rows put the chosen
  Namespaces first only as the popup opened. The highlight landed on the row
  that took the first chosen one's old place. While closed, the rows now
  follow the selection, so they are already in their open order, and Enter
  on open unchecks the first chosen Namespace.
- **A tooltip on the trigger names the chosen Namespaces.** "+N" hid every
  name after the first, and names with a common prefix truncated alike.
  Hovering or focusing the trigger lists up to ten, one per line in the mono
  font, then "and N more". It does not show while the popup is open, and it
  replaces the `title` on the trigger's name. In a narrow Pane it covers the
  filters, so it closes as soon as the pointer leaves the trigger and lets
  clicks through (`disableHoverablePopup`); the popup lists the same names.
  The focus that closing the popup returns to the trigger does not show it,
  and focus from another control does.
- **The empty state says when none of the chosen Namespaces exists.** "This
  list updates live." under a deleted Namespace had a user wait for
  Resources that could not appear. When the Namespace list is known, by the
  rule "Not found" uses, the list says "shop not found" or "3 chosen
  namespaces not found". It subscribes to the Namespaces for this only while
  it is empty and scoped.
- **An Engine restart keeps the popup open.** A restarted Engine lists no
  Resource Types until discovery completes, and the list hid its Namespace
  control while its type was unknown, which closed the popup and dropped
  focus to the page. The list now keeps the type's last known scope.
- **`combobox.tsx` adds `ComboboxStatus` and `useComboboxFilteredItems`,**
  which the registry's version lacks. `AGENTS.md` says to keep them.
- **The listbox is named "Namespaces"**, as the popup is.
- **The highlight wraps from the last row to the first,** and back, not
  through the filter input. Base UI does not loop through the input while
  `autoHighlight` is on.
- **Live changes do not move a row while the popup is open.** Base UI keeps
  the highlight by index, so a Namespace created above the highlighted row
  moved the highlight onto another Namespace, which Enter then checked, and
  an Engine restart emptied the rows for a moment and lost the highlight.
  While the popup is open, Namespaces created since it opened
  follow the rows it lists, sorted among those that arrive together, and
  deleted ones stay listed until it closes. The next open orders the rows as
  before. The Engine's search results, for a Cluster with more Namespaces
  than were loaded, follow the typed text instead. This also keeps the rows
  and the highlight while a restarted Engine lists the Namespaces again.
- **Leaving the popup closes it.** Base UI moved Shift+Tab focus from the
  filter to the ×, the control before the popup's place on the page, and left
  the popup open over the toolbar's filters, where Enter on the × cleared the
  selection behind it. Shift+Tab now returns focus to the trigger, as Escape
  does. Base UI also keeps the popup open when focus moves from it to the
  trigger or another control by script or assistive technology, so the picker
  closes the popup whenever focus leaves it. It leaves Tab to Base UI's focus
  guards, which close the popup and move focus on.
