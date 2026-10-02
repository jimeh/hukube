# Plan: label Queries, quieter subscriptions, and Go to Resource

## Outcome

After this work:

- The Engine indexes every Resource's labels, and a Query can filter by a
  Kubernetes label selector such as `app=web,tier!=db`.
- A Query subscription recomputes only when a Resource Type it can match
  changes, and no subscription sends a value identical to the one it last
  sent.
- `Mod+K` in a Workspace opens a Go to Resource palette that finds Resource
  Types and Resources across every type the Cluster serves. It ranks names
  with fzf's fuzzy matcher and accepts type and Namespace prefixes such as
  `deploy/api` or `kube-system/po/core`.
- Resource lists accept a label selector next to the name filter.

This is the first step toward ADR-0003's promise that "search, sorting, and
Relationships work across every Resource Type". It does not build Relationships
or Apps.

## Current state

These observations come from the code at `1e1ab01`:

- `toMeta` in `engine/internal/cluster/cluster.go` keeps UID, namespace, name,
  creation time, and resourceVersion. It discards labels, although the
  metadata informer already receives them.
- `Expr` in `engine/internal/protocol/protocol.go` supports `and`, `or`, `not`,
  `in`, and `contains` over the fields `type`, `namespace`, and `name`.
- `index.Store` has one `notify.Signal` for all types. The `resources.query`
  topic in `engine/internal/server/topics.go` subscribes to it, so a
  ConfigMap list rescans, re-sorts, and resends its window whenever any
  Resource of any type changes, such as a Lease renewal.
- `runSubscription` in `engine/internal/server/session.go` sends every computed
  value. Nothing checks whether it equals the previous one. The 100 ms
  `minEmitInterval` bounds the rate but not the waste.
- The UI has no global keyboard shortcuts and no way to reach a Resource
  except through its type's list.

## Decisions

### Index labels, not ownerReferences or annotations

Add `Labels map[string]string` to `index.Meta`, copied from the informer's
object. Labels change the resourceVersion, so `Store.Diff` already produces a
Modified Change when they change.

Annotations are excluded because they can be large (for example
`kubectl.kubernetes.io/last-applied-configuration`) and nothing queries them.
OwnerReferences are excluded until Relationships need them. Adding them later
is a one-field change with the same plumbing.

Labels are stored as received, without interning. Phase 2 measures the memory
cost before deciding whether interning is worth its complexity (see Risks).

### Express label filters as a `selector` operator using kubectl syntax

Add `ExprOpSelector = "selector"`. It matches when the Resource's labels
satisfy the label selector in `Values[0]`, parsed with
`k8s.io/apimachinery/pkg/labels.Parse`. It composes with `and`, `or`, and
`not` like any other operator. `Compile` returns a `bad_request` error when
`Values` does not hold exactly one value, as it already does for `contains`,
or when the selector fails to parse. An empty selector matches everything,
following Kubernetes, but the UI omits the clause when its input is blank.

Why this approach:

- Users already know selector syntax from kubectl. Reusing the apimachinery
  parser gives exact Kubernetes semantics, including set-based forms such as
  `env in (a,b)` and `!key`, with no parser to maintain.
- A missing label behaves as it does in Kubernetes: `app!=web` and
  `app notin (web)` match Resources without an `app` label.

The rejected alternative is structured label operators: a `label` field with a
`key` and an `exists` operator, with selector syntax parsed in TypeScript. That
form would suit a future Saved Query editor better. It can be added beside
`selector` later, compiled to the same predicates, if that editor needs it.

### Add per-type change signals to the index

`Store.Changed` takes an optional list of types: `Changed(types ...TypeKey)`.
With no types, it fires on any change, as it does today. With types, it fires
only when `Apply` or `RemoveType` touches one of them.

The Store keeps a listener set per type alongside the existing global one. A
subscription creates one buffered channel and registers it in the set of every
type it names, under the Store's signal lock, and its stop function removes it
from all of them. `Apply` and `RemoveType` collect the touched types and send
to each listener once, without blocking, before they return. Delivery is
therefore synchronous, which the tests rely on. Listener sets for a type are
deleted when their last listener leaves, so types that come and go do not
accumulate.

`query.Compiled` exposes the types it scans. `scanTypes` also learns to take
the union of `or` branches when every branch is constrained, falling back to
nil (every type) when any branch is not. The `resources.query` and
`resources.find` topics subscribe to those types, and to the global signal
when the Query does not constrain the type. That choice lives in one small
helper, so the topics' wiring can be tested without a Cluster.

`forward` in `topics.go` takes `func() (<-chan struct{}, func())` values, which
a variadic method does not satisfy. Its callers wrap `Changed` in closures.

`cluster.types` keeps the global signal, because counts span every type. The
deduplication below stops it from resending an unchanged type list on every
Modified Change.

### Deduplicate subscription data in the session

`runSubscription` marshals each computed value to JSON once, compares the
bytes with the last value it sent, and skips the send when they are equal. The
`ServerMessage` then carries the pre-marshalled `json.RawMessage`, so the
write loop does not marshal it again.

The last-sent value resets in two cases:

- **The topic restarts with new params.** The first value after a restart is
  always sent, so the client always learns the result of an update.
- **The subscription reports an error.** The client keeps showing an error
  until data arrives, so data equal to the value from before the error must be
  sent again.

Comparing with the last value pushed to the outbox stays correct under the
outbox's latest-wins coalescing. The client always ends up with the last
pushed value, unless an error replaces it, and an error resets the comparison.

This relies on every topic computing values deterministically. Query results
sort with a full tiebreak, `Types()` sorts by key, and `encoding/json` sorts
map keys, so all current topics are deterministic. New topics must keep this
property.

### Find Resources with a dedicated `resources.find` topic

Ranking by match quality needs the search text, which a plain `Sort` cannot
express. So a new topic answers the palette:

```go
// MethodResourcesFind subscribes with FindParams to FindResult.
MethodResourcesFind Method = "resources.find"

type FindParams struct {
	Cluster string `json:"cluster"`
	Where   *Expr  `json:"where,omitempty"` // scope, such as a type prefix
	Text    string `json:"text"`
	Limit   int    `json:"limit"`           // capped at MaxFindLimit (200)
}

type FindResult struct {
	Text  string `json:"text"`          // echoed from FindParams
	Where *Expr  `json:"where,omitempty"` // echoed from FindParams
	Total int    `json:"total"`         // every match, not only the returned Rows
	Rows  []Row  `json:"rows"`
}
```

`useSubscription` keeps showing the previous data after an `update`, and
messages carry only the subscription ID. Without the echo, pressing `Enter`
right after typing could open a Resource from the previous text, or of another
type. The palette compares the echoed `Text` and `Where` with its current
params and treats a mismatched result as stale.

`Where` reuses `query.Compile`, so a scope prefix narrows the scan exactly as
it does for lists. The text is split on whitespace into words, and every word
must match the Resource's name, case-insensitively:

- A plain word matches fuzzily, as in fzf, using `FuzzyMatchV2` from
  `github.com/junegunn/fzf/src/algo`. Its scoring rewards matches at word
  boundaries (after `-`, `.`, `/`, and similar) and consecutive characters, and
  penalizes gaps, so `ngxprd` ranks `nginx-prod` well above an incidental
  match deep inside a generated name.
- A word that starts with `'` matches as an exact substring, which is fzf's
  syntax for the same thing. It is scored with fzf's `ExactMatchNaive`, so both
  kinds of word share one scale.

A Resource's score is the sum of its words' scores. Results order by score,
highest first, then by shorter name, then by name, namespace, and type. The
Engine keeps the top `Limit` results with a bounded heap instead of sorting
every match. Text that is empty, or holds only `'`, returns no rows, so the
palette never lists the whole Cluster.

fzf is an application, and `src/algo` is its internal matcher rather than a
library with a stable API. It takes fzf's `util.Chars` and `util.Slab` types
and needs `algo.Init` to select its scoring scheme. The Engine therefore:

- pins the fzf version in `go.mod`;
- wraps the package in one file in `engine/internal/query` that exposes
  `match(name string, word string) (score int, ok bool)`, so replacing fzf
  touches only that file;
- calls `algo.Init("default")` once, from that file; and
- gives each `resources.find` evaluation its own slab, because slabs are not
  safe for concurrent use and several subscriptions may run at once.

A subscription, not a request, fits the existing pattern: typing sends
`update` messages, the session already discards superseded params, and results
stay live while the palette is open.

"Find" is used instead of "search" because `CONTEXT.md` lists "search" as a
word to avoid for Query.

### Parse type and namespace prefixes in the UI

The palette parses its input in TypeScript as up to two scope segments, then
the name text, separated by `/`: `deploy/api`, `kube-system/core`, or
`kube-system/po/core`. The segments may appear in either order. Each scope
segment resolves, case-insensitively, as follows:

1. A Resource Type, when the segment matches a type's resource name, lowercase
   kind, short name, or full key (such as `deployments.apps`). The find is
   scoped with `{op: "in", field: "type", values: [...]}`.
2. Otherwise a Namespace, when it exactly matches an existing Namespace's
   name. The find is scoped with `{op: "in", field: "namespace", values:
[...]}`, which excludes cluster-scoped Resources.
3. Otherwise the palette shows "No resource type or namespace named
   `segment`" instead of searching names for the slash. When the palette
   does not know every Namespace, because the list was cut off at 1,000 or
   Namespaces cannot be listed, it reads the segment as a Namespace instead,
   and a wrong one finds nothing.

A segment that names both a type and a Namespace resolves as the type, matching
kubectl habits. The palette shows the resolved scope as chips above the
results, such as "Pod" and "kube-system", so the user can see how their input
was read. Two type segments, or two Namespace segments, are an error.

The UI already holds the type list from `cluster.types`, and the palette
subscribes to Namespace names while it is open. That subscription is the same
Query `NamespaceSelect` in the resource list uses, so both share one
`useNamespaces` hook. The Engine does not need to know about aliases.

### Palette behavior

The palette uses the shadcn `command` component (cmdk), with its built-in
filtering turned off because the Engine ranks Resources.

- It opens with `Mod+K` (Cmd on macOS, Ctrl elsewhere), handled by a
  capture-phase `keydown` listener on `window`. The listener calls both
  `preventDefault` and `stopPropagation`, so Monaco's `Ctrl+K` chord handling
  never sees the key.
- Only the active Workspace listens. Hidden Workspaces stay mounted (see
  `routes/__root.tsx`), so `Workspace` gets an `active` prop. The dialog
  renders in a portal outside the hidden Workspace's element, so the palette
  also closes and clears its text when its Workspace becomes inactive. Its
  subscription exists only while it is open.
- Stale results stay visible so typing does not flicker, but they render as
  disabled `cmdk` items. `cmdk` does not select disabled items, so `Enter` does
  nothing until fresh results arrive. The Engine sends the first value after an
  `update` immediately, so the delay is one compute and round trip. One pure
  function turns a result and the current params into palette items, marking
  stale ones disabled.
- It shows two groups. "Resource types" is filtered client-side from the type
  list, up to eight entries. "Resources" holds the Engine's ranked rows, up to
  50, with "N more" when `Total` exceeds them.
- `Enter` on a type opens its list. `Enter` on a Resource opens it as a pinned
  tab in the active Pane. Rows show kind, name, and namespace.
- The `resources.find` subscription exists only while the palette is open and
  the text, without its prefix, is not blank.

## Steps

The phases depend on each other in order. Phases 2 and 3 both change
`protocol.go`, so they must not run in parallel. The work ships as one PR.
Each phase is a series of small commits, one per numbered step or smaller,
and every commit passes `mise run check`.

### Phase 1: quieter subscriptions (no protocol change)

1. Add per-type signals to `index.Store` and `Changed(types ...TypeKey)`, and
   wrap the existing callers in closures for `forward`.
2. Expose the scanned types from `query.Compiled`, extend `scanTypes` to `or`,
   and subscribe `resources.query` through the signal-choosing helper.
3. Deduplicate and pre-marshal subscription data in `runSubscription`, with
   the two reset rules.

### Phase 2: labels and selector Queries

1. Add `Labels` to `index.Meta` and copy them in `toMeta`.
2. Add `ExprOpSelector` to the protocol, compile it in `query`, and run
   `mise run gen`.
3. Add an optional `selector` argument to `listQuery` in
   `apps/app/src/features/resource-list/query-window.ts`, and a "Label
   selector" input beside the name filter in `ResourceListPanel`. The "No
   matches" notice treats an active selector as a filter. An invalid selector
   shows the Engine's `bad_request` message in the panel's existing error
   line.
4. Measure the index's memory with and without labels (see Risks), and record
   the numbers in the PR description.

### Phase 3: Go to Resource

1. Add `FindParams`, `FindResult`, and `MethodResourcesFind` to the protocol,
   run `mise run gen`, and add the topic to `methods.ts` in the same change.
   `methods.ts` fails to compile while the generated `Method` union has a
   method its maps lack. Then implement ranking in `engine/internal/query`
   and the topic in `topics.go`.
2. Add the shadcn `command` and `dialog` components from `packages/ui` with
   `bunx --bun shadcn@latest add command dialog`.
3. Add `apps/app/src/features/go-to-resource/` with the prefix parser, the
   palette component, and the shortcut hook. Mount it in `Workspace` and pass
   `active` from the root layout.

## Testing strategy

Each test targets a specific failure mode:

| Risk                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A change to one type wakes subscribers of another, or a type's removal is missed    | `index` unit tests: subscribe to A, to B, and to A and C together; apply a change to A; then assert which channels fired. Delivery completes before `Apply` returns, so checking the channels afterwards needs no sleep. Also test `RemoveType`, a type first seen after subscribing, and that stopping a multi-type subscription removes it from every type.                                                                                                                                                                                   |
| A Query topic subscribes more broadly or narrowly than its Query                    | Unit tests for the signal-choosing helper: a single type, several types via `in`, an `or` of constrained branches, an `or` with an unconstrained branch (global), and no `where` (global). `scanTypes` table tests cover the same shapes.                                                                                                                                                                                                                                                                                                       |
| A duplicate value is sent, or a needed value is suppressed after an update or error | `server` unit test that drives `runSubscription` with a scripted topic. A blocked `compute` call marks the boundary where the previous emit finished. The test drains the outbox at each boundary, so latest-wins coalescing cannot hide a duplicate. The drained sequences are: A, A, B sends A then B; A, error, A sends all three; A, new params, A sends both. One sequence without draining (A, B, A) checks that a stalled client still receives A last.                                                                                  |
| Selector semantics differ from Kubernetes, or a bad selector is accepted            | `query` table tests for `=`, `!=`, `in`, `notin`, `key`, `!key`, missing labels, an empty selector, and combination with `and` and `not`. `TestCompileRejectsInvalidExpressions` gains an unparseable selector, a selector with no values, and one with two values.                                                                                                                                                                                                                                                                             |
| Labels are not indexed, or go stale when they change                                | Extend the envtest `TestIndexFollowsResourceChanges`: create a labelled ConfigMap, then relabel it and wait for the index to reflect the new labels.                                                                                                                                                                                                                                                                                                                                                                                            |
| Find ranks poorly, misses tokens, or ignores scope or limit                         | `query` table tests: a boundary match outranks a scattered one (`ngxprd` against `nginx-prod` and a generated name), `'` words match only exact substrings, every word must match, matching ignores case, tiebreaks, a heap that must replace a worse match with a better one, `Where` scoping, and `Total` with zero, negative, and oversized `Limit`. Empty, whitespace-only, and `'`-only text, and no matches, all encode `rows` as `[]`. These tests assert relative order, not fzf's exact scores, so an fzf upgrade does not break them. |
| Find is too slow to run on every keystroke                                          | `BenchmarkFind` over 200,000 synthetic Resources with realistic generated names, for a short and a long fuzzy word. The target is under 20 ms per run on a development machine; the PR records the measurement.                                                                                                                                                                                                                                                                                                                                 |
| Prefixes resolve wrongly                                                            | Vitest for the prefix parser: resource name, kind, short name, group-qualified key, a prefix shared by several types, a Namespace, a type and a Namespace in both orders, a segment naming both a type and a Namespace, two types, two Namespaces, an unknown segment with complete and incomplete Namespace lists, and no prefix.                                                                                                                                                                                                              |
| The palette acts on stale results                                                   | Vitest for the freshness check that compares a result's echoed `Text` and `Where` with the current params.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The palette does not work end to end                                                | One Playwright web test. It presses `Control+K`, types the test's Namespace, `/cm/`, and a fresh ConfigMap's name, presses `Enter`, and sees the ConfigMap's data in the YAML Facet. It then clicks into the editor, presses `Control+K` again, and asserts that the palette opens over Monaco. Typing `ConfigMap` and pressing `Enter` opens the type's list. This also covers the topic's wiring through the Engine.                                                                                                                          |

Some behavior is checked by hand on `mise run dev`, because automating it
would need new harness work for little extra confidence:

- The list's label selector: a valid selector, an invalid one showing the
  Engine's error, correcting it back to a valid one, clearing it, and
  relabelling a Resource with `kubectl` so it enters or leaves the list live.
- Two Clusters open in one window: `Mod+K` opens the palette only in the
  active Workspace, and switching Cluster tabs closes an open palette. The
  e2e environment has one Cluster, so automating this would need a second
  kubeconfig context.
- `Mod+K` in the desktop host.

## Risks

- **Index memory.** Labels may dominate index memory on large clusters.
  Measure the heap with `runtime.ReadMemStats` for 100,000 synthetic Pods
  carrying about six realistic labels each. If labels more than double the
  index's size, intern label keys and values with `unique.Make` as a follow-up.
  Interning whole label sets is not worth doing: `pod-template-hash` makes
  sets churn on every rollout.
- **Unscoped Queries still wake on every change.** A palette find without a
  type prefix subscribes to the global signal. It exists only while the
  palette is open, and deduplication suppresses unchanged results, so this is
  acceptable for now.
- **Dedup relies on deterministic computes.** A future topic that returns
  values in map iteration order would defeat deduplication silently, though it
  would not cause incorrect results. A comment on the `topic` type will state
  the requirement.
- **Shortcut conflicts.** In Firefox, `Ctrl+K` focuses the browser's search
  bar unless the page calls `preventDefault`. The capture-phase listener does,
  but only while the page has focus.
- **Topic wiring is verified by inspection.** Each topic passes the helper's
  choice straight to `forward`, and `runSubscription` already restarts a topic
  when its params change, which replaces its scope. Testing the wiring
  behaviorally would need a spy on internals, or timing that channel
  coalescing can defeat. The helper's tests cover the selection logic.
- **Find latency is unmeasured.** The 20 ms target comes from what feels
  instant while typing, not from a measurement. `FuzzyMatchV2` rejects names
  that cannot match with a quick scan before it scores, so most of the
  200,000 names should be cheap. If the benchmark misses the target, try
  `FuzzyMatchV1` (faster, with weaker ranking) before anything more complex.
- **fzf's matcher is not a stable API.** An fzf upgrade can change function
  signatures or scores. The wrapper confines signature changes to one file,
  and the tests assert ordering rather than exact scores. Dependabot or manual
  upgrades of fzf should run `mise run test:engine`.

## Non-goals

- Relationships, Apps, and indexing ownerReferences.
- Saved Queries, or a structured label editor.
- fzf's other extended-search syntax (`^prefix`, `suffix$`, `!negation`, and
  `|` alternation). Only `'` for exact words is supported for now.
- Labels as a list column.
- Patch-based query updates instead of whole-window values. ADR-0003 describes
  patches, but full windows with deduplication are enough at current sizes.

## Unresolved questions

None at the moment.
