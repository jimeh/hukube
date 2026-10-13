# Plan: ownership Relationships and the Related Facet

Status: implemented, not merged yet. "What changed while building" lists where
the result differs from the text below.

ADR-0015 records where ownership comes from and what identifies an owner and
an owned Resource.

## Outcome

After this work:

- The Engine indexes every Resource's owner references and answers, live and
  for any Resource, what owns it up to the top of the chain and what it owns
  all the way down.
- A Resource tab has a third Facet, Related. It shows the Resource's owners
  above it and what it owns below it, with each related Resource one click
  away and the status its Resource list shows.
- Another Engine package can ask for everything a Resource owns and be told
  when the answer may have changed. Log Streams will use this to follow a
  workload's Pods.
- The Facet switcher has a rule for a Pane too narrow to hold it.

It does not add other kinds of Relationship, Apps, a graph, a Query operator
for ownership, or links from Events.

## Current state

These observations come from the code at `952e219`:

- `toMeta` in `engine/internal/cluster/cluster.go` keeps UID, Namespace,
  name, creation time, resourceVersion, and labels. It discards
  `ownerReferences`, although the metadata reflector receives them.
- `index.Store` holds `map[TypeKey]map[string]Meta` and notifies per type.
  `Apply` sees the old and the new `Meta` of a changed Resource under one
  lock. Nothing else does.
- `Cluster.types` maps a type key to its discovered kind, group, scope, and
  indexing state. Nothing maps a kind back to a type.
- `checkTypeErr` marks a refused type `forbidden` or `failed` and stops its
  reflector, but leaves its Resources in the index until discovery next
  restarts the type.
- `Cluster.Table` (ADR-0010) shares one watched Table per Resource Type among
  callers and keeps it for 30 seconds after the last release.
- `ResourcePanel` renders the switcher from `facets.ts`. The tab list is
  `shrink-0` and the showing Facet's controls shrink and truncate, so in a
  330 px Pane `Show managed fields` already reads `Show man…`.
- `openPanel` in `dock.ts` opens a panel in the active Pane, or in a Pane
  beside the panel named by `beside`. A new Resource tab takes the Facet of
  the destination Pane's active Resource tab.

## Evidence from research

### How Kubernetes resolves an owner reference

From `pkg/controller/garbagecollector` in Kubernetes v1.37.1:

- The graph is keyed by UID (`uidToNode` in `graph_builder.go`). A dependent
  is attached to the node with its reference's UID, and the reference's
  kind, name, and Namespace are then checked against what was observed
  (`addDependentToOwners`, `ownerReferenceMatchesCoordinates`).
- `isDangling` in `garbagecollector.go` decides whether an owner exists. It
  maps the reference's API version and kind to a resource through the REST
  mapper (`apiResource` in `operations.go`), gets the Resource by name in the
  dependent's Namespace, or in none for a cluster-scoped type, and treats a
  missing Resource and one with another UID alike: "item's owner is not
  found, UID mismatch".
- A cluster-scoped dependent that names a namespaced owner is an error that
  "will not resolve on retry".
- A kind the REST mapper does not know is an error, and the garbage
  collector keeps retrying. It never deletes a dependent while one of its
  references cannot be resolved.
- `DefaultRESTMapper.RESTMappings` in apimachinery v0.37.1 does not fall back
  to another version when the one asked for is unknown.

The Kubernetes documentation (Owners and Dependents) states the Namespace
rule: "Cross-namespace owner references are disallowed by design. Namespaced
dependents can specify cluster-scoped or namespaced owners. A namespaced
owner must exist in the same namespace as the dependent."

`kubectl describe` prints `Controlled By: Kind/name` from the reference that
has `controller: true` (`printController` in `pkg/describe/describe.go`,
kubectl v0.37.1). It does not look the owner up and shows no other owner.

### How comparable tools show ownership

Read from source at pinned commits, not from running apps:

| Tool                 | Owners                                                            | Owned Resources                                                                                             | Status       | Many                                      |
| -------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| Freelens (Lens fork) | `Controlled By` link in the metadata block, never checked         | Flat tables per kind. ReplicaSets and their Pods by owner UID, a Deployment's Pods by its template's labels | Colored text | Pods table virtualizes above 20 rows      |
| Headlamp             | `Controlled by` link. An unknown kind shows as plain `Kind: name` | One flat Pods table by label selector. ReplicaSets by owner UID                                             | Colored chip | Pages of 15                               |
| Argo CD              | Parent nodes in a graph, matched by UID                           | Nested levels: Deployment, ReplicaSet, Pod                                                                  | Health icon  | Above 15 Pods they fold into their parent |
| k9s xray             | None. A separate jump-to-owner action resolves kind and name      | Indented tree by label selector. Skips the ReplicaSet                                                       | Name color   | Not found                                 |

What they share: owners are a link by kind and name, owned Resources carry a
name and a status, and a chain is either flattened into one table per kind
or nested. The tools that flatten can do so because they have code per kind.
The tools that nest (Argo CD, k9s, and the `kubectl tree` plugin) work for
any kind.

### What a tab bar does when it does not fit

- VS Code's Panel and Activity Bar drop the entries that do not fit, keep the
  active one, and add an `Additional Views` menu (`compositeBar.ts`). Chrome
  DevTools does the same with a `More tabs` menu (`TabbedPane.ts`).
- Carbon says tabs "should not wrap to multiple lines or stack on top of each
  other; instead, they should scroll horizontally". Material offers the same.
- The WAI-ARIA tabs pattern gives no guidance on overflow.

### Memory

A throwaway probe built 100,000 synthetic Pods with six labels and one owner
reference each, five Pods to a ReplicaSet, on an Apple silicon laptop:

| Index holds                            | Heap     | Per Pod    |
| -------------------------------------- | -------- | ---------- |
| Metadata and labels, as today          | 73.0 MiB | 765 bytes  |
| With owner references as decoded       | 90.5 MiB | 948 bytes  |
| With the API version and kind interned | 88.2 MiB | 924 bytes  |
| With a reverse index of slices         | 94.6 MiB | 991 bytes  |
| With a reverse index of sets           | 96.6 MiB | 1013 bytes |

Owner references and a reverse index of sets add 248 bytes a Pod, 32% on top
of the index today. The implementation is measured again (see Phases).

## Decisions

### Index owner references and a reverse index

`index.Meta` gains `Owners []OwnerRef`, nil for a Resource without owners:

```go
// OwnerRef is one of a Resource's owner references.
type OwnerRef struct {
    APIVersion string
    Kind       string
    Name       string
    UID        string
    Controller bool
}
```

`toMeta` copies them and interns `APIVersion` and `Kind` with
`unique.Make(s).Value()`, because a Cluster has few distinct values.

`index.Store` keeps `owned map[string]map[Ref]struct{}` from an owner's UID
to the Resources whose references name it, where `Ref` is a type key and an
index key. `Apply` updates it under the lock it already holds: it removes the
references of the `Meta` it replaces or deletes and adds those of the `Meta`
it stores. `RemoveType` removes the references of every Resource of the type.
An empty set is deleted. `Store.OwnedBy(uid)` returns the type and `Meta` of
each entry, copied under the read lock. A reference with an empty UID is not
indexed.

A set, not a slice, because a Job's thousands of Pods are deleted one at a
time and each removal from a slice scans it.

### One function resolves a reference

A new package, `engine/internal/relationship`, holds the graph. It reads the
`Store` and asks the Cluster two questions: the Resource Type for a type key,
and the Resource Type that serves a kind in an API group. `Cluster` keeps a
map from group and kind to type key for the second, rebuilt by `discover`.
When two types serve one kind in one group, the smaller type key wins.

`resolve(dependent, ref)` returns the owner a reference names and a status:

1. The group is the part of `ref.APIVersion` before `/`, or empty.
2. No type serves the kind in the group: `unserved`.
3. The type's state is `forbidden` or `failed`: that status, without reading
   the index, which may still hold what the type had before it was refused.
4. Read the index for the type, `ref.Name`, and the dependent's Namespace, or
   no Namespace when the type is cluster-scoped. A `Meta` whose UID is
   `ref.UID`: `found`.
5. Otherwise `syncing` when the type's state is `syncing`, else `missing`.

A cluster-scoped dependent that names a namespaced kind therefore reads a
namespaced type with no Namespace, finds nothing, and is `missing`.

The graph offers, for a `Node` (a type key and a `Meta`):

- `Owners(node)`: what each of its references resolves to, with the
  controller first, then by kind, name, and UID.
- `Owned(node)`: the Resources that `OwnedBy(node UID)` returns and that have
  a reference which `resolve` finds to be this node. Resources of a type in
  state `forbidden` or `failed` are left out. Of several Resources with one
  UID, which is one Resource served under several types, the one with the
  smallest type key is kept. Order: kind, type key, newest first, name,
  Namespace.
- `AllOwned(node)`: everything it owns directly or through what it owns,
  each Resource once, breadth first, never the node itself.
- `Node(type, namespace, name)` and `Changed()`, which signals after any
  change to the index, the set of types, or a type's state.

`AllOwned` and `Changed` are the one way another package gets what a
Resource owns. A Log Stream calls `AllOwned` for its workload, keeps the
Pods, and calls it again on each signal. It must listen to every change and
not only to Pods, because a new ReplicaSet and its first Pod arrive on two
watches in either order.

### Odd shapes

- **Several owners.** Every reference is an owner. The Resource appears
  under each of them.
- **An owner that is not a controller** is an owner like any other. The
  controller only sorts first. The Facet does not mark the difference in
  this layer.
- **A loop.** A walk never shows a Resource beneath itself: it stops at a
  Resource that is already on the path from the top. `AllOwned` visits each
  Resource once.
- **Nothing owns it and it owns nothing.** The answer has no sections. The
  Facet still applies (see UI and UX).
- **Deleted and created again.** The new Resource has a new UID. Resources
  that name the old UID are not owned by it, and their owner shows as
  `missing`.

### What the Facet's answer holds

`relationship.Related(node, limits)` builds two sections from the graph.
Section rows are in display order, and a row's `depth` says how far it is
indented. Within the answer, a row is owned by the nearest row above it with
a smaller depth.

**Owners.** Every path from the Resource up to an owner that has no owner,
does not resolve, or would repeat a Resource on the path. Each path is
reversed, so it starts at the top owner and ends at the direct owner, and the
Resource itself is appended with status `self`. Paths that start alike are
merged. A Pod's section is its Deployment at depth 0, its ReplicaSet at
depth 1, and the Pod at depth 2. At most 50 paths are followed. If there are
more, the section says it is truncated. The section is absent when the
Resource has no owner references.

**Owned.** The tree below the Resource, built level by level so that a
shallow level is complete before a deeper one starts:

1. Under one owner, at most 100 Resources of one Resource Type are shown,
   in `Owned` order.
2. The section shows at most 500 Resources. When the budget is spent, the
   rest are not shown.
3. Wherever Resources of a type under an owner are not shown, a row with
   status `more` follows that owner's shown Resources of the type and counts
   the ones left out. It does not count against the budget.
4. A Resource with two owners in the tree appears under both.

The section's `total` counts every Resource in `AllOwned`, shown or not. The
section is absent when the total is 0.

These rules mean the Facet never claims to hold everything: a group that is
cut says by how much, and the heading shows the full count.

### The `resource.related` topic

```go
// RelatedParams selects the Resources related to one Resource.
type RelatedParams struct {
    Cluster   string  `json:"cluster"`
    Type      TypeKey `json:"type"`
    Namespace string  `json:"namespace,omitempty"`
    Name      string  `json:"name"`
    // Cells asks for the list cells of each related Resource (ADR-0010).
    Cells bool `json:"cells,omitempty"`
}

// Related is what the Engine knows to be related to a Resource.
type Related struct {
    // Found reports whether the index holds the Resource.
    Found    bool             `json:"found"`
    Sections []RelatedSection `json:"sections"`
    // Types holds the Columns of the types whose rows carry cells.
    Types []RelatedType `json:"types"`
    // Total counts the related Resources of every section.
    Total int `json:"total"`
}

// RelatedSection holds the Resources at the other end of one kind of
// Relationship, in one direction.
type RelatedSection struct {
    Relationship RelationshipKind `json:"relationship"` // "owns"
    // Direction is "in" for the Resources the Relationship comes from, such
    // as owners, and "out" for those it points to.
    Direction RelatedDirection `json:"direction"`
    Rows      []RelatedRow     `json:"rows"`
    Total     int              `json:"total"`
    Truncated bool             `json:"truncated,omitempty"`
}

type RelatedRow struct {
    Depth  int           `json:"depth"`
    Status RelatedStatus `json:"status"`
    Kind   string        `json:"kind"`
    // APIVersion is set for a reference that did not resolve.
    APIVersion string     `json:"apiVersion,omitempty"`
    Type       TypeKey    `json:"type,omitempty"`
    Namespace  string     `json:"namespace,omitempty"`
    Name       string     `json:"name,omitempty"`
    UID        string     `json:"uid,omitempty"`
    CreatedAt  *time.Time `json:"createdAt,omitempty" tstype:"string"`
    // Cells holds one value per Column of the row's RelatedType.
    Cells []any `json:"cells,omitempty" tstype:"unknown[]"`
    // More counts the Resources a row with status "more" stands for.
    More int `json:"more,omitempty"`
}

type RelatedType struct {
    Type    TypeKey  `json:"type"`
    Columns []Column `json:"columns"`
}
```

`RelatedStatus` is `found`, `self`, `more`, `missing`, `unserved`,
`forbidden`, `syncing`, or `failed`. A `more` row carries the kind and type
it counts. A row that did not resolve carries the reference's kind, API
version, name, and UID, and the type when one serves the kind.

A later kind of Relationship adds a `RelationshipKind` and its sections.
`Types` is a list, not an object keyed by type, because a type key is a name
the Cluster supplies.

The topic computes its value from the graph and recomputes on
`Graph.Changed()` and on the Cluster's status:

| The Resource's type                                 | Answer                                 |
| --------------------------------------------------- | -------------------------------------- |
| Unknown, and the Cluster is not ready               | Nothing yet                            |
| Unknown, and the Cluster is ready                   | `not_found`, as `resource.get` answers |
| `forbidden`                                         | `forbidden`                            |
| `failed`                                            | `internal`, naming the type            |
| `syncing`, and the index does not hold the Resource | Nothing yet                            |
| `ready`, and the index does not hold the Resource   | `found: false` and no sections         |
| Otherwise                                           | `found: true` and the sections         |

The UID is not a param. Ownership is exact by UID, so the Engine answers for
the incarnation its index holds, which is the one the YAML Facet shows.

### Status comes from the Table cells, while the Facet shows

With `cells: true` the topic holds the Tables of the types among its `found`
and `self` rows, through `Cluster.Table`, and attaches each row's cells. It
holds at most 6 Tables, for the types with the most rows, then by type key.
It takes and releases Tables as the rows change, forwards each Table's
changes to the subscription, and releases them all when it stops. `Types`
lists the columns with priority 0, which are the ones `kubectl get` shows,
and a row's cells match them. Rows of other types have no cells.

The cap exists because a Table is a list and watch of a whole type across
the Cluster. A custom Resource that owns Resources of twenty types should
not start twenty of them.

The client asks for cells only while the Related Facet is the tab's showing
Facet, so the switcher's count costs no Table.

### The panel subscribes for the whole tab

`ResourcePanel` subscribes to `resource.related` while the tab is open, with
`cells` true while Related is the showing Facet. Within one tab only `cells`
changes, so a value `useSubscription` reports as `stale` still describes
this Resource. The Facet and the badge show a stale value as it is.

## UI and UX

### The Related Facet applies to every Resource

Related is always in the switcher, after Events. Most Resources own nothing
and have no owner, but an entry that came and went would move the switcher
between Resources and while a Resource changes. The entry's count says
whether there is anything behind it before a user opens it.

### The switcher's entry

- **Label.** `Related`, then the number of related Resources in muted text
  when it is above 0, and `999+` above 999. No icon: the Events entry's
  warning icon calls for attention, and a count of related Resources is only
  information.
- **Accessible name.** `Related, 12 Resources`, `Related, 1 Resource`, or
  `Related` without a count.
- **What it counts.** The answer's `total`: the owners the Resource's
  references name, resolved or not, and everything it owns.
- **No count** while there is no value, while `found` is false, and while
  the error is `forbidden`. Another error leaves the count of the value the
  tab still holds, as the States table says.

### A switcher that does not fit

Two rules, applied in this order as the row narrows:

1. **The showing Facet's controls give way first.** Below a row width of
   26rem a control shows as an icon button with its label as its accessible
   name and tooltip. `Show managed fields` becomes an eye icon. This uses a
   CSS container query on the switcher row. The controls no longer shrink
   and truncate.
2. **Then the tab list scrolls sideways,** with no visible scrollbar, and
   the showing Facet's tab is kept in view. While the list is wider than its
   space, a `More Facets` button sits after it, between the list and the
   controls. Its menu lists every Facet with its badge and marks the
   showing one. Choosing an entry shows that Facet. A hidden edge of the
   scrolling container fades over 12 px with a standard `mask-image` linear
   gradient. An edge with nothing hidden has no fade.

Why: tabs that scroll are what Carbon and Material prescribe, and a menu of
the entries is what VS Code and Chrome DevTools add. Dropping tabs that do
not fit, as those two do, needs each tab measured against the space, with
badges that change width live. A scrolling list leaves layout to the
browser, and the menu gives a pointer without sideways scrolling a way to
every Facet.

Built from native scrolling, shadcn's `dropdown-menu` with a radio group, and
a `ResizeObserver` that compares the list's `scrollWidth` with the width
available without the menu button. When the button is showing, its
`offsetWidth` and the row's gap are added back to the container's
`clientWidth`, so it appears and disappears at the same Pane width. The
same measurement and the container's `scroll` event track hidden edges:
`scrollLeft > 0` at the start, and
`scrollLeft + clientWidth < scrollWidth - 1` at the end. Keyboard: the tab
list stays one stop with the arrow keys, and
moving to a tab scrolls it into view. The menu button is the next stop.

Widths: at 330 px the row has 306 px. Three tabs with both badges need about
220 px and the icon control 36 px, so nothing scrolls. With Logs as a fourth
tab the list may scroll at 330 px, and fits at 520 px and 1040 px with the
control's label showing.

### Layout of the Facet

One scrolling area. Each section has a heading row in the style of the
Events header (`h-7`, `px-3`, bottom border, muted `text-xs`), then its rows.
The owners section comes first. Each heading stays at the top while its
section scrolls, with `sticky top-0`, an opaque `bg-background`, and `z-10`
above the Resource rows. Keyboard selection scrolls a row below its
heading so it is not covered.

- **Sections.** The Facet shows the sections whose Relationship is `owns`
  and skips any other, which a later layer adds.
- **Headings.** `Owned by` for the owners, and `Owns` with the section's
  total in muted text for the owned.
- **Indentation means "owns", everywhere.** A row is owned by the row it is
  indented under: 16 px a level, up to 8 levels. The owners section
  therefore reads from the top owner down to this Resource, like a path, and
  the owned section reads as a tree. This is how Argo CD, k9s, and
  `kubectl tree` show a chain, and it works for any kind.
- **A Resource row has two lines** and a fixed height. The first holds the
  kind in muted text and the name in the monospace font. The name takes the
  rest of the line and truncates with the full name as its title. The second
  line truncates on one line with its full plain text as its title. It holds
  the live age, then each cell that has a value as `Column value`, joined by
  `·`. The Namespace, age, separators, and column names are muted, while
  each cell value uses `text-foreground`. The row's accessible name keeps
  the same plain text:
  `3d · Ready 1/1 · Status Running · Restarts 0`. It starts with the
  Namespace when that differs from the Namespace of the tab's Resource.
- **Why the age is on the second line.** The index always knows the age, so
  the line exists before the cells arrive and no row changes height when
  they do.
- **This Resource** is the last row of each owner path, with status `self`:
  its name in medium weight and `This <Kind>` in place of the kind. It is
  not a link.
- **A reference that did not resolve** has the reference's kind and name in
  muted text and a fully muted reason on its second line (see States). It is
  not a link.
- **A `more` row** has one line of muted text, indented as the Resources it
  counts. If a `found` row of the same type and depth appears between it
  and the nearest preceding row of smaller depth, it says
  `30 older Pod Resources are not shown.` or
  `1 older Pod Resource is not shown.` The rows are newest first, so the
  omitted Resources are the oldest. Without such a shown sibling, it says
  `30 Pod Resources are not shown.` or `1 Pod Resource is not shown.`
- **Truncated owners.** A muted line under the owners section when it is
  `truncated`: `Not every owner is shown.` The owned section's `truncated`
  shows nothing more, because its `more` rows already say what is left out.
- **Types that cannot be listed.** When the Cluster has types in state
  `forbidden`, a muted line under the last section says
  `Resources of 12 Resource Types your credentials cannot list are not
shown.` The count comes from the Workspace's types. In the empty state,
  this qualification is part of the notice's description instead of a
  separate line.

At each width:

- **330 px.** A Pod at depth 2 has 242 px for its name, about 33 characters,
  and the second line truncates after `Status Running`.
- **520 px.** Names and second lines fit for the sample Resources.
- **1040 px.** The same rows with room to spare. Rows are not rearranged into
  columns: a table per kind would bring back per-kind layout and a
  breakpoint, and the Events Facet uses lines at every width for the same
  reason.

The rows are not virtualized. A section holds at most 500 Resources, as the
Events Facet holds at most 500 Events.

### Status

A related Resource shows what its Resource list shows: the cells of the
columns `kubectl get` prints, as text. They are not colored, because ADR-0010
rules out reading meaning from a cell. A Pod reads
`Ready 0/1 · Status ImagePullBackOff · Restarts 0`. A column layout a user
set for the type's list is not applied here. That is a follow-up.

### Opening a related Resource

Rows behave like the rows of a Resource list:

- **Pointer.** A click opens the Resource as a Preview Tab, and a
  double-click opens it as a regular tab. Rows have the list's hover and
  selected styles.
- **Keyboard.** The scrolling area is one stop in the tab order, with the
  ARIA `treegrid` role and `aria-level` on rows. Up and Down move the
  selection over the rows that can be opened, Enter opens the selected
  Resource as a regular tab, and Space opens it as a Preview Tab. These are
  the list's keys. No key binding is added.
- **Where it opens.** In the Pane of the tab it was opened from, not beside
  it. `OpenOptions` gains `pane`, the ID of a panel whose Pane the new tab
  opens in, and `openPanel` uses that panel's Pane instead of the active
  one. A Preview Tab replaces the Pane's Preview Tab, which is the tab the
  user is looking at when that tab is itself a preview. VS Code does the
  same when a link is followed from a preview editor.
- **Focus after opening.** When a pointer or keyboard action opens a
  Resource, its Related Facet takes focus on its `treegrid` when it mounts,
  using `focus({ preventScroll: true })`. A module-level record beside the
  double-click record holds the address just opened. Only a Facet with the
  same Cluster, type, Namespace, and name consumes it. It selects no row.
  A tab that was already open does not need to take focus.
- **Selection** is remembered by row, not by position, so it stays on the
  same Resource while rows arrive and leave. A selected row that leaves
  clears the selection.

### The new tab keeps the Related Facet

The rule from layer 3 stays: a new Resource tab takes the Facet of the
Pane's active Resource tab. A user who walks from a Deployment to one of its
Pods lands on the Pod's Related Facet, which shows the path back: the
Deployment, the ReplicaSet, and this Pod. That matters because a Preview Tab
replaced the Deployment's tab, and hukube has no navigation history yet.
Landing on YAML would save a click for a user who wanted the Manifest and
cost one, plus the way back, for a user who is walking the chain.

### States

In a row about a reference, `<Kind>`, `<apiVersion>`, and `<type>` are the
row's own. In a notice, `<Kind>` is the kind of the tab's Resource and
`<type>` its type key.

| State                                                                                                        | What shows                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading: no value and no error                                                                               | A heading skeleton and three two-line skeleton rows, marked busy. No count.                                                                                                                                                                                                                                                                                                                                                                   |
| `found` is false and the Manifest's answer is not `deleted`                                                  | The same skeleton, whether the Manifest has answered or not: the index has not caught up with the Manifest's watch. No count.                                                                                                                                                                                                                                                                                                                 |
| No owners or owned Resources                                                                                 | `No owners or owned Resources`. With no forbidden types: `No Resource owns this <Kind>, and it owns none. Owners and owned Resources appear here as they change.` With N forbidden types: `No Resource that your credentials can list owns this <Kind> or is owned by it. Resources of N Resource Types your credentials cannot list are not shown.` Use `1 Resource Type` for N of 1. No separate bottom line.                               |
| Populated                                                                                                    | The sections. The count shows.                                                                                                                                                                                                                                                                                                                                                                                                                |
| A large owner                                                                                                | 100 Resources of a type under one owner and a `more` row. The heading holds the full count.                                                                                                                                                                                                                                                                                                                                                   |
| A reference to a Resource that is gone (`missing`)                                                           | Second line: `Not found. No <Kind> with this name and UID exists.`                                                                                                                                                                                                                                                                                                                                                                            |
| A reference to a kind the Cluster does not serve (`unserved`)                                                | Second line: `This Cluster does not serve <apiVersion> <Kind>.`                                                                                                                                                                                                                                                                                                                                                                               |
| A reference to a type the user may not list (`forbidden`)                                                    | Second line: `Your credentials cannot list <type>.`                                                                                                                                                                                                                                                                                                                                                                                           |
| A reference to a type the Cluster refused (`failed`)                                                         | Second line: `The Cluster cannot list <type>.`                                                                                                                                                                                                                                                                                                                                                                                                |
| A reference to a type still loading (`syncing`)                                                              | Second line: `Loading <type>…`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Not permitted (`forbidden` error)                                                                            | `Not permitted`. `Your credentials cannot list <type>, so hukube cannot tell what this <Kind> is related to.` Replaces any rows. No count.                                                                                                                                                                                                                                                                                                    |
| Another error, no value yet                                                                                  | `Related Resources unavailable`, the error's message, and `hukube keeps trying.`                                                                                                                                                                                                                                                                                                                                                              |
| Another error, with a value                                                                                  | A line above the sections or empty state in the destructive color, `Related Resources may be out of date: <message>`. The rows and the count stay.                                                                                                                                                                                                                                                                                            |
| The Cluster is unreachable                                                                                   | The status bar says so, as today. A Workspace status with phase `failed` also shows `Related Resources may be out of date: <status.message>` above sections or the empty state, in the destructive color. Without a message, use `the Cluster cannot be reached`. A topic error takes precedence. Neither the `Not permitted` nor `Related Resources unavailable` notice gains this line. The index keeps what it last saw, so the rows stay. |
| The connection to the Engine is lost                                                                         | The status bar says so, as today. The rows stay and their ages keep ticking. The client subscribes again on reconnect.                                                                                                                                                                                                                                                                                                                        |
| `found` is false and the Manifest's answer is `deleted`: the Resource was deleted while open, or never found | The header's `Deleted` or `Not found` badge. `Nothing related`. `This <Kind> does not exist right now. Related Resources appear here if it is created.` No count.                                                                                                                                                                                                                                                                             |
| The Resource is created again                                                                                | The new incarnation's sections. What the old one owned is not owned by it.                                                                                                                                                                                                                                                                                                                                                                    |
| The window is out of date                                                                                    | Frozen by the root layout, as everything else.                                                                                                                                                                                                                                                                                                                                                                                                |

Every text the Cluster supplies is rendered as text. Kinds, type keys, and
column names are compared by value or held in a `Map`, never used as keys of
a plain object. Rows are keyed by their path of type, Namespace, and name
from the section's top, because a Resource can appear under two owners.

### Packages considered

- **Tree:** `@headless-tree/react` 1.7.0 (May 2026) and
  `react-aria-components` 1.22.1 give a tree its expand and collapse, its
  keyboard, and its roles. The Facet's rows do not expand or collapse in
  this layer: the limit of 100 a type keeps one large group from burying its
  neighbors. What is left is a list with indentation, which gets the
  Resource list's own keys. When rows need to collapse, adopt
  `@headless-tree/react` instead of growing this.
- **Overflowing tabs:** `rc-overflow` shows the first entries that fit and
  cannot keep the showing one. Primer's `UnderlineNav` would bring Primer's
  styling. Native scrolling and the existing `dropdown-menu` need neither.
- **Menu and tooltip:** shadcn's `dropdown-menu` and `tooltip`, already
  installed.

No package is added.

## Sample Resources

`e2e/fixtures/sample/resources.yaml` gains an `orphan-config` ConfigMap in
`sample-shop` with two owner references that cannot resolve: a Deployment
named `retired` with a made-up UID, and a `Gadget` of
`legacy.example.com/v1`, a kind the Cluster does not serve. The second keeps
the garbage collector from deleting the ConfigMap, because it never deletes
a dependent while a reference cannot be resolved.

The existing `web`, `api`, and `worker` Deployments supply ReplicaSets and
Pods, and `worker`'s Pod supplies an unhealthy status.

## Phases

1. **Index and graph.** `OwnerRef`, the reverse index, the kind lookup, the
   `relationship` package, and their tests. A benchmark that builds 100,000
   Pods through `Store.Apply` with and without owner references and reports
   bytes a Resource, and one that times `Related` for an owner of 10,000
   Pods. Record both under Measurements.
2. **Protocol and topic.** The types, `resource.related`, the Table holding,
   and their tests. `mise run gen`.
3. **Switcher.** `related` in the Resource URI's Facets, the registry entry,
   the two overflow rules, and the YAML control's compact form.
4. **Related Facet.** The sections, rows, states, badge, opening in the
   Pane, and the sample Resources.
5. **End to end,** then a check by hand of every state at 330, 520, and
   1040 px in both themes.

## Testing

| Risk                                                     | Evidence                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The reverse index drifts from the Resources              | Go test for `Store`: `OwnedBy` after an add, a change of owner, a delete, and `RemoveType`, and no empty set left behind.                                                                                                                                     |
| A reference resolves to the wrong Resource               | Go table test for `resolve` with a fake Cluster: each status, the version ignored, a namespaced owner in another Namespace, and a cluster-scoped dependent naming a namespaced kind.                                                                          |
| Two types with one UID collide                           | Go test: a Resource held under two types with one UID owns a child whose reference names one of them. The child's owner is that type's Resource, only that one owns it, and removing the other type changes nothing. A child held under two types shows once. |
| A recreated owner inherits its predecessor's Resources   | Go test and envtest: the owner is deleted and created again under the same name. It owns nothing, and the old child's owner is `missing`.                                                                                                                     |
| Odd shapes break a walk                                  | Go tests: two owners, a non-controller owner, a loop of two and of three, and a Resource with nothing related.                                                                                                                                                |
| The limits lie about what is left out                    | Go tests: 101 of a type under one owner give 100 rows and `more` 1. A wide second level under the budget of 500 keeps the first level whole and counts what it leaves out. `total` counts everything. More than 50 owner paths set `truncated`.               |
| The answer changes order between runs                    | Go test: the same graph built in two insertion orders encodes to the same JSON.                                                                                                                                                                               |
| Ownership does not follow the Cluster                    | envtest: a Deployment, its ReplicaSet, and its Pods, created with owner references because envtest runs no controllers, appear under it. A second ReplicaSet with a Pod appears, and the first leaves when deleted. A Pod's owners reach the Deployment.      |
| A reference that cannot resolve is hidden or wrong       | envtest: an owner that does not exist, a kind the Cluster does not serve, and a type the credentials cannot list each give their status.                                                                                                                      |
| A large owner floods the topic                           | envtest through the control socket: an owner of 101 ConfigMaps answers with 100 rows, a `more` row of 1, and a total of 101.                                                                                                                                  |
| Cells are missing, or Tables are held when not asked for | envtest through the control socket: with `cells` the rows of a type carry cells that match `types`. Without it the answer has no cells and no types. A Go test for the choice of 6 types.                                                                     |
| The topic answers wrongly for a type it cannot read      | envtest through the control socket: `forbidden` for a refused type, and `found: false` for a Resource that does not exist.                                                                                                                                    |
| Another package cannot follow what a Resource owns       | Go test: `AllOwned` returns each Pod under a Deployment once, and `Changed` signals when a Pod is added under a ReplicaSet that arrived after it.                                                                                                             |
| The Facet is missing or does not survive                 | Vitest: `#related` round-trips in a Resource URI, Related applies to every type, and a new tab takes it from the Pane's active tab.                                                                                                                           |
| A state of the Facet shows the wrong thing               | Vitest with jsdom for each row of the states table the Facet renders, the second line's text, the `more` row, the badge and its accessible name, and an age that advances with the clock.                                                                     |
| A row opens the wrong thing or in the wrong Pane         | Vitest: click, double-click, Enter, and Space call `openResource` with the row's address, the right `preview`, and the panel's ID as `pane`. Rows that are not Resources do nothing. `openPanel` opens in the named panel's Pane.                             |
| The selection jumps when rows change                     | Vitest: the selection stays on its Resource when a row is added above it and clears when its row leaves.                                                                                                                                                      |
| The switcher hides a Facet in a narrow Pane              | Vitest: the `More Facets` button shows only while the list overflows, its menu lists every Facet, and choosing one changes the tab's URI.                                                                                                                     |
| The feature does not work end to end                     | Playwright: create a Deployment, open it, switch to Related, see its ReplicaSet and Pod, open the Pod from it as a regular tab and see its owners, return, scale the Deployment up with `kubectl`, and see the second Pod without a reload.                   |

Each new test is run once against a deliberately broken implementation, to
see it fail at its assertion.

The Facet and the switcher are also checked by hand on `mise run dev:verify`
in every state, at 330, 520, and 1040 px and in both themes, and then by an
independent experience review.

## Risks

- **A Table for a few rows.** Showing three Pods' status starts a list and
  watch of every Pod in the Cluster, as opening the Pod list does. The rows
  show at once and the cells follow. In a very large Cluster the cells may
  take seconds. Scoping a Table to a Namespace is the way out, as the list
  columns plan already notes.
- **A hidden tab keeps its Tables.** `cells` follows the tab's showing
  Facet, not whether the tab is in front, so a tab left on Related in the
  background holds up to 6 Tables, as a hidden Resource list holds one. If
  that costs too much, stop asking for cells while the tab is hidden.
- **Every Change wakes every Related subscription.** The answer can depend
  on any type, so the topic listens to the whole index. The session sends
  nothing when the answer is unchanged. Phase 1 measures a recompute for a
  large owner.
- **Stale Resources of a refused type.** The index keeps a refused type's
  Resources until discovery restarts it. The graph ignores such types, so
  the Facet cannot show them.
- **`scrollIntoView` in the switcher** can scroll more than the tab list.
  The tab list's own `scrollLeft` is set instead.
- **Firefox and Safari.** Container queries, `scrollbar-width`, and
  `ResizeObserver` are supported by both. Nothing here is specific to
  Chromium.

## Non-goals

- Relationships other than ownership, Apps, and a graph or diagram.
- A Query operator for ownership. The Engine's own need is a lookup of one
  owner's Resources followed by `resolve`, not a predicate over a `Meta`, so
  it is not nearly free: it needs syntax in a list's filter and the palette,
  and a decision on direct or indirect ownership. It would let a `more` row
  open the full list.
- Expanding and collapsing rows, and a marker for a controller.
- Applying a type's column layout to the Facet's status line.
- Links from an Event to its Resource, Log Streams, and a Facet in its own
  tab.

## Unresolved questions

None.

## What changed while building

The Engine follows phases 1 and 2 without a design change. The existing tygo
generator emits the single-valued `RelationshipKind` as TypeScript `string`
plus `RelationshipKindOwns`, even with `enum_style: "union"`. The direction
and status enums generate unions. No generator workaround was added.

A double-click on a related Resource is handled as two clicks. The first
click opens a Preview Tab in the same Pane, or brings forward a tab that was
already open, which replaces the content under the pointer. The second click
therefore lands in whatever Facet that tab shows, and no `dblclick` reaches
the row. A click on a row records what it opened for five seconds, which
is longer than the slowest double-click an operating system allows. A second
click of the same burst (`detail` of 2) anywhere in a Resource tab opens the
recorded Resource as a regular tab. A click opens its Preview Tab at once,
with no delay to wait for a second.

Two code reviews found these, and they are fixed:

- **Row keys.** Two references that did not resolve and share a name, such
  as two kinds the Cluster does not serve, had one key in the Facet, so a row
  could stay after its reference left. A row's key now includes its UID,
  kind, and API version.
- **A double-click on a Resource whose tab was open on another Facet** did
  not make a regular tab of it, because only the Related Facet handled the
  second click. The Resource tab handles it now, and the record expires.
- **The switcher** brought the showing tab back into view on every live
  update, which undid a manual scroll. It now does so only when the Facets,
  the selection, or the layout change.
- **A Resource that names itself as its owner** got an owners section that
  held only itself, or a row for itself beside its other owners. A reference
  to itself now adds nothing.

An independent review of the running app found eight UI corrections:

1. The empty notice now says `No owners or owned Resources` and qualifies
   its description when Resource Types cannot be listed. The old copy
   claimed more than the Facet knew and separated the qualification from it.
2. A `more` row now says `older` only when the same owner has a shown
   Resource of that type. The old `more` copy did not say which were omitted.
3. Cell values now use the foreground color while their labels stay muted.
   The review found that status values were hard to read in the second line.
4. A newly opened Resource's Related Facet now takes focus without scrolling
   or selecting a row. Opening a Resource previously dropped keyboard focus.
5. A failed Cluster status now warns that Related Resources may be out of
   date, with topic errors taking precedence. Retained rows looked live
   while the Cluster was unreachable.
6. Section headings now stay at the top while their section scrolls. Long
   sections previously lost their heading as the user moved down the rows.
7. Hidden edges of the Facet switcher now fade over 12 px with `mask-image`.
   Clipped tabs previously ended at a hard edge.
8. The overflow measurement now adds the button's width and the row's gap
   back to available space. The button previously stayed after the tabs
   would have fit without it, so narrowing and widening had different thresholds.

## Measurements

Measured on 2026-10-13, macOS arm64, Apple M3 Max, Go 1.27.1, with:

```sh
mise run test:engine -- -run '^$' -bench 'Benchmark(StoreOwners|RelatedLargeOwner)$' -benchmem -benchtime=2s -race=false
```

The Store benchmark builds 100,000 synthetic Pods through `Store.Apply`,
with six labels each. In the ownership case, each Pod has one ReplicaSet
owner reference, five Pods per ReplicaSet, with API version and kind
interned. It measures retained heap after a GC while keeping the Store
alive, subtracts the heap before construction, and reports heap bytes per
Resource with `b.ReportMetric`. Both cases use the new `Meta` shape and
share the six literal label keys and values; this is not the same fixture
as the earlier throwaway probe.

| Index holds                             | Heap bytes per Resource | Time to build 100,000 Pods |
| --------------------------------------- | ----------------------- | -------------------------- |
| Metadata and labels, without owners     | 580.0                   | 51.52 ms                   |
| Owner references and reverse-index sets | 803.7                   | 78.46 ms                   |

Ownership adds 223.7 retained heap bytes per Resource in this fixture,
38.6% over the case without owners.

`BenchmarkRelatedLargeOwner` recomputes `Related` for an owner of 10,000
Pods using the default limits. It keeps the exact total of 10,000 and
returns 100 Resource rows and one `more` row of 9,900:

| Measurement | Time per recompute | Allocated bytes per recompute | Allocations per recompute |
| ----------- | ------------------ | ----------------------------- | ------------------------- |
| Before      | 32.19 ms           | 23,743,908                    | 30,811                    |
| After       | 12.98 ms           | 6,447,487                     | 10,619                    |

The four graph corrections reduce time by 2.48 times and allocated bytes by
3.68 times. The time target of three times was not reached; no further
restructuring was attempted. The after measurement runs the same benchmark
and flags, with `-bench 'BenchmarkRelatedLargeOwner$'` only.

The display limit bounds the answer's rows, but not the work of counting
all descendants. These are synthetic, local measurements without Table
fetches or control-socket JSON encoding, not a latency guarantee for a
Cluster. The race detector is disabled only for the benchmarks; the Engine
tests run with it enabled.
