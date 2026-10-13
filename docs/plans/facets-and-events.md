# Plan: Facets, starting with the Events Facet

Status: implemented, not merged yet. "What changed while building" lists where
the result differs from the text below.

ADR-0013 records how a Resource tab holds Facets, and ADR-0014 where a
Resource's Events come from and how they are selected.

## Outcome

After this work:

- A Resource tab has a Facet switcher under its header. It offers the Facets
  that apply to the Resource, which are YAML and Events. YAML is the default.
- The Facet is part of the tab's Resource URI, so a stored Workspace layout
  and a reload return to the same Facet.
- The Events Facet shows the Kubernetes Events about the Resource, live and
  newest first: when each was last seen, its type, reason, and message, how
  often it occurred, and what reported it. Ages are computed in the UI and
  keep ticking.
- The Events entry in the switcher shows how many of the Events are warnings,
  whichever Facet is open.
- A later Facet is its name in the Resource URI's list, one registry entry,
  and one component.

It does not add the other Facets, opening a Facet in its own tab, filtering
within the Events, links from an Event to a Resource, or anything that keeps
Events after the Cluster deletes them.

## Current state

These observations come from the code at `4321fde`:

- `ResourcePanel` in `apps/app/src/features/resource/resource-panel.tsx`
  subscribes to `resource.get` and shows the Manifest in Monaco. Its header
  holds the kind, name, Namespace, a `Deleted` badge, and the
  `Show managed fields` button.
- `Facet` in `packages/k8s/src/resource-uri.ts` is `"yaml"`. A URI may name a
  Facet after `#`, and a URI naming any other Facet does not parse.
- `openResource` in `workspace.tsx` opens a dockview panel whose ID is the
  Resource URI without a Facet, and whose params hold that URI.
- dockview fires `onDidLayoutChange` when a panel's params change
  (`onDidPanelParametersChange` in `dockview-core` 8.3.1), so
  `api.updateParameters` is enough for `persistLayout` to save a Facet.
- dockview keeps a hidden tab's component mounted, so a hidden Resource tab
  keeps its subscriptions.
- `Cluster.WatchObject` in `engine/internal/cluster/object.go` follows one
  Resource with a list and a watch, and waits for the Resource Type to be
  discovered. Type indexing in `cluster.go` uses a client-go `Reflector`.
- `toProtocolError` in `engine/internal/server/outbox.go` reports a refused
  request from the Cluster as `internal`.
- The design tokens already include `--warning` and `--success`.

## Evidence from research

### How `kubectl describe` selects Events

From `k8s.io/kubectl` v0.37.1, `pkg/describe/describe.go`:

- `searchEvents` (line 5408) lists core `v1` Events in the object's
  Namespace with a field selector on `involvedObject.name`,
  `involvedObject.namespace`, `involvedObject.kind`, and, when the object has
  one, `involvedObject.uid`. `GetFieldSelector` in client-go's
  `kubernetes/typed/core/v1/event_expansion.go` builds it.
- For a Node (line 3461) it searches twice, once with the Node's UID and once
  with the Node's name as the UID, with this comment: "there are two UIDs for
  host events: controller use node.uid, kubelet use node.name".
- For a cluster-scoped object the Namespace is empty, so it lists every
  Namespace with `involvedObject.namespace=`.

The API server supports those field selectors for core Events, and maps the
`regarding.*` selectors of `events.k8s.io` onto the same fields
(`pkg/apis/core/v1/conversion.go` line 267 and
`pkg/apis/events/v1/conversion.go` line 66 in Kubernetes v1.37.1).

Other tools: Lens filters all Events in memory by
`involvedObject.uid == object UID`, or the name for a Node
(`events/store.ts`). Headlamp uses a field selector on kind, name, and
Namespace, with no UID (`lib/k8s/event.ts`). `kubectl events --for` uses kind,
`apiVersion`, and name.

### What a real API server does

A throwaway test against envtest (Kubernetes 1.37) and real Events in the
k3d cluster (k3s 1.35.5) showed:

- **Cluster-scoped Resources.** The API server accepts an Event with an empty
  reference Namespace only in `default`, or in `default` or `kube-system`
  through `events.k8s.io` (`legacyValidateEvent` in
  `pkg/apis/core/validation/events.go`). Any other Namespace is rejected with
  "involvedObject.namespace: does not match event.namespace". A list of every
  Namespace with `involvedObject.namespace=` returns those Events and leaves
  out a namespaced Event whose reference has the same kind and name.
- **Recreated Resources.** A ConfigMap deleted and created again gets a new
  UID. A selector on kind, name, and Namespace returns the Events of both
  incarnations and those without a UID. Adding the UID returns only that
  incarnation and drops the ones without a UID.
- **UIDs that are not the Resource's.** The kubelet's reference to its Node
  has the Node's name as UID in Kubernetes 1.19 and 1.30 and no UID in 1.35
  and 1.37 (`nodeRef` in `pkg/kubelet/kubelet.go`). With an exact UID match,
  `kubectl describe node` therefore misses kubelet Events on a current
  Cluster. The hand-written Event in `e2e/fixtures/sample` has no UID either.
- **Two types, one Event.** An Event read through `events` and through
  `events.events.k8s.io` has the same UID. An Event written through
  `events.k8s.io` appears in the core type with `eventTime` and `series` set,
  `lastTimestamp` null, `count` 0, an empty `source`, and
  `reportingComponent` set.
- **A watch** with the selector delivers later Events and their deletion, and
  nothing about other Resources.
- **A user without permission** gets a `Forbidden` error from the list.

### Which timestamp is "last seen"

Real Events differ by writer:

| Writer                              | `lastTimestamp` | `eventTime` | `series`        | `count` |
| ----------------------------------- | --------------- | ----------- | --------------- | ------- |
| kubelet, controllers (old recorder) | set, updated    | null        | null            | 1, 2, … |
| scheduler (`events.k8s.io`)         | null            | set         | null            | null    |
| `events.k8s.io`, repeated           | null            | set         | count, observed | 0       |

The API documents `lastTimestamp` as "the time at which the most recent
occurrence of this event was recorded", `eventTime` as "time when this Event
was first observed", and `series.lastObservedTime` as "time of the last
occurrence observed". The API server's own printer (`printEvent` in
`pkg/printers/internalversion/printers.go`) and `kubectl events` (`eventTime`
in `pkg/cmd/events/events.go`) both prefer the series, then `lastTimestamp`,
then the first-seen time.

## Decisions

### Facets are a registry, and the tab shows one of them

See ADR-0013. In code:

- `packages/k8s/src/resource-uri.ts` lists the Facet names, `yaml` and
  `events`, and derives the `Facet` type and the parser's check from the list.
- `apps/app/src/features/resource/facets.ts` holds the registry, in the
  order `CONTEXT.md` lists Facets. An entry has an `id`, a `label`,
  `appliesTo(target)`, a `View` component, and an optional `Badge` component
  shown after the label in the switcher. `target` is the Resource's type key
  and, once the Cluster's types are known, its `ResourceType`.
- `facetsFor(target)` returns the entries that apply, and
  `resolveFacet(requested, target)` returns the requested Facet when it
  applies and `yaml` otherwise.
- YAML applies to every Resource. Events applies to every Resource except
  the two Event types, `events` and `events.events.k8s.io`: an Event about an
  Event does not occur in practice, and an always-empty Facet on every Event
  would mislead.
- The rules use the type key, so the switcher does not wait for the
  Cluster's types.

The panel owns what Facets share and passes it to each `View` and `Badge`:
the address, the kind, the Manifest state from `resource.get`, the Events
state from `resource.events`, whether the Facet is the one showing, and an
element in the switcher row to render its own controls into. A later Facet
that needs its own data subscribes inside its `View`.

### The Facet rules

1. A tab's Facet is `resolveFacet(the Facet in its URI, target)`.
2. Choosing a Facet calls `api.updateParameters` with the same params and the
   URI rewritten to name the Facet, including `#yaml`. Nothing else about the
   tab changes: not its ID, its title, or whether it is a Preview Tab.
3. A URI without a Facet shows the default and is not rewritten until the
   user chooses. A tab that takes its Facet from another tab (rule 5) names
   it from the start, so it keeps that Facet if the default changes.
4. A `View` mounts when its Facet is first shown and stays mounted, hidden,
   until the tab closes. Only the showing Facet renders controls into the
   switcher row.
5. A Resource tab that opens in a Pane whose active tab is a Resource tab
   takes that tab's Facet, through the same `resolveFacet`. It does not
   matter whether either tab is a Preview Tab, so a click, Enter, and the Go
   to Resource palette behave alike. An address that names a Facet keeps it.
   Opening a Resource that is already open focuses its tab and leaves its
   Facet alone.
6. The tab's ID stays the Resource URI without a Facet.

### Events come from a watch scoped to the Resource

See ADR-0014 for the choice and the selection rule. In code:

- A new topic, `resource.events`, takes `ResourceEventsParams` (Cluster, type,
  Namespace, name, an optional `uid`, and optional `otherUids`) and sends
  `ResourceEvents`:

  ```go
  type ResourceEvents struct {
      // Events holds the newest Events, newest first, at most 500.
      Events []ResourceEvent `json:"events"`
      // Total and Warnings count every Event about the Resource.
      Total    int `json:"total"`
      Warnings int `json:"warnings"`
  }

  type ResourceEvent struct {
      UID      string    `json:"uid"`
      Type     string    `json:"type"`
      Reason   string    `json:"reason"`
      Message  string    `json:"message"`
      Count    int       `json:"count"`
      LastSeen time.Time `json:"lastSeen" tstype:"string"`
      // Reporter is the component that reported the Event, such as
      // "kubelet", and ReporterInstance where it ran, such as a Node's name.
      Reporter         string `json:"reporter,omitempty"`
      ReporterInstance string `json:"reporterInstance,omitempty"`
  }
  ```

- `Cluster.WatchEvents` in a new `engine/internal/cluster/events.go` follows
  the shape of `WatchObject`: it waits for the Resource Type to be discovered,
  which gives the kind, the group, and whether the type is namespaced, then
  runs until its context ends.
- It uses a client-go `Reflector` over a typed core `v1` Events client with
  the field selector, as type indexing does. The Reflector already handles
  paging, resuming a watch, and an expired resourceVersion.
- The Engine runs the Reflector's list-and-watch in its own loop. An attempt
  returns an error only when a list, or the start of a watch, fails. The
  error is reported, the Events already held are kept, and the next attempt
  waits: from `Timing.ObjectRetry`, doubling up to `Timing.RetryMax`, as a
  Table watch does. The delay goes back to `Timing.ObjectRetry` once a watch
  has started, not once a list has completed: a credential that may list
  Events but not watch them would otherwise list every two seconds for as
  long as the tab is open. An expired resourceVersion is never reported.
- A watch that cannot start because the connection is refused also ends the
  attempt. The Reflector would retry it inside the attempt without
  returning, so an unreachable Cluster would leave the Facet with Events
  that no longer update and no error. A 429 is left to the Reflector, which
  backs off and resumes the watch without another list.
- A transport error is reported without its request URL, which holds the
  whole field selector.
- The value is rebuilt after every list and every watch event. An Event the
  Cluster deletes leaves it. Every attempt starts with a list, and a
  completed list sends the Events, which clears the error for the client.
- A watch asks the API server for a timeout of 30 to 60 minutes, not the
  Reflector's default of 5 to 10. Against envtest, a watch of Events that
  had delivered nothing could resume after 8 minutes but not after 10: the
  API server answered `410 Expired`, because etcd had compacted its
  resourceVersion and an uncached type sends no bookmarks to move it on. With
  the default timeout a quiet watch would therefore list its Namespace's
  Events again about every second resume.
- `toProtocolError` reports a `Forbidden` or `Unauthorized` answer from the
  Cluster as `forbidden`, for every topic.

The matching, conversion, and ordering are pure functions:

- **Match.** With `ref` the Event's reference and `target` the Resource:
  `sameIncarnation` is true when `target.UID` is empty, or `ref.UID` is
  empty, `target.UID`, one of `target.OtherUIDs`, or `target.Name`.
  `sameGroup` is true when `ref.UID` is not empty and is `target.UID` or one
  of `target.OtherUIDs`, or `ref.APIVersion` is empty, or its group is the
  type's group. An Event matches when both are true.
- **Last seen.** The first of these that is set: `series.lastObservedTime`,
  `lastTimestamp`, `eventTime`, `firstTimestamp`,
  `metadata.creationTimestamp`.
- **Count.** `series.count` when there is a series, else `count` when it is
  above 0, else 1.
- **Reporter.** `source.component`, else `reportingComponent`. The instance is
  `source.host`, else `reportingInstance`.
- **Order.** Newest last seen first, then by UID, so the same Events always
  encode to the same JSON. The cap of 500 applies after ordering. `Total` and
  `Warnings` count before the cap, and `Warnings` counts type `Warning`.

### The panel subscribes for the whole tab

`ResourcePanel` subscribes to `resource.events` while the tab is open and the
Events Facet applies, whichever Facet shows, so the switcher can show the
warning count. The rules for its params:

1. No subscription until `resource.get` has answered with a value or an
   error. The UID comes from that answer, and a first list without it could
   show another incarnation's Events for a moment.
2. `uid` is `metadata.uid` of the last Manifest the tab received, when it is a
   string. A deleted Resource keeps its last Manifest, so it keeps its UID. A
   Resource that was never found has none. `otherUids` holds the Manifest's
   `kubernetes.io/config.mirror` annotation when the Resource is a Pod that
   has one: the kubelet writes a static Pod's Events with that hash as the
   UID. On the test cluster, a static Pod's mirror Pod had UID `8a4b8257-…`
   and its `Pulled`, `Created`, and `Started` Events all referred to
   `5b0aeef7…`, the annotation's value.
3. When the Resource is created again, the UID changes and so do the params.
   Until the answer for the new params arrives, `useSubscription` reports the
   old value as `stale`; the Facet and the badge treat a stale value as
   loading.

## UI and UX

### The switcher

- **Where.** A second row in the Resource tab's header, under the row with
  the kind, name, Namespace, and `Deleted` badge. Tabs sit on the left. The
  showing Facet's own controls sit on the right of the same row, which is
  where `Show managed fields` moves, because it acts on the YAML Facet and not
  on the Resource.
- **Why a row of tabs under the title.** It is what the OpenShift console,
  Argo CD's resource panel, and Rancher do for the views of one Kubernetes
  object, and what a browser's network inspector does for one request. A
  second row costs 32 px and survives a narrow Pane and a long name, which a
  switcher squeezed beside the title would not.
- **Component.** shadcn's `tabs`, which wraps Base UI's Tabs, added with the
  shadcn CLI. It supplies the roles, the roving focus, and the arrow keys. No
  new dependency: `@base-ui/react` is already installed. Nothing is
  hand-rolled.
- **Always shown,** also when only YAML applies, so the row and the controls
  do not move between Resources.
- **Keyboard.** The tab list is one stop in the tab order, between the
  Workspace's tab strip and the Facet's controls. Left and Right move between
  Facets and show the one they land on, and Home and End go to the ends, as
  the ARIA tabs pattern recommends when a panel shows without delay. No key
  binding is added.
- **Pointer.** Click a tab. Tabs have hover, focus, and selected states from
  the component.
- **Label.** The tab list is labelled `Facets`.
- **Warning count.** The Events tab shows a warning icon and the number of
  Warning Events when there are any, and nothing otherwise. A count of Normal
  Events would be noise on a healthy Resource. Its accessible name reads
  `Events, 3 warnings`. The icon carries the warning color and the number
  uses the foreground color, because `--warning` on the light background does
  not reach 4.5:1 for small text.

### The Events Facet

- **Layout.** Each Event takes three lines. The first holds `Last seen`,
  `Type`, and `Reason`, in columns that line up across Events under a sticky
  header row in the list's style: the list headers' font, the same `px-3`
  and column gap, `h-7`, a bottom border, and muted text. The second line
  holds the message. The third, in muted text, says what reported the Event
  and how often it occurred: `From kubelet, node-1 · 241 times`. The second
  and third lines start under the Type column and run to the right edge. A
  hairline separates Events. The list is not virtualized: it holds at most
  500 Events, and wrapped messages give them different heights.
- **The message** wraps at word boundaries and keeps its own line breaks,
  with the white space around it trimmed, because it is the answer to "why",
  and a truncated answer is no answer.
- **Why lines and not columns.** A Resource usually opens in a Pane beside
  its list, which is about 520 px wide in a 1280 px window and 330 px wide in
  a 900 px one. A table with a Message column needs about 950 px. A first
  line that also held `Count` and `From` left Reason, which names the
  problem, a few characters at 330 px. The OpenShift console lays its Events
  out the same way: what happened, the message, then "Generated from" and how
  many times.
- **Narrow Panes.** Nothing scrolls sideways. Last seen and Type have fixed
  widths, so a first Warning does not move the columns, and Reason takes the
  rest of the line. Reason truncates, with the full text as a title, only
  when even that is too little, which starts below about 330 px. The third
  line wraps.
- **Count** is left out when the Event occurred once, as `kubectl describe`
  leaves it out. `2 times` and more are shown.
- **Semantics.** The grid carries the ARIA table roles. The message and the
  third line are one cell each, and their column headers, `Message` and
  `From and count`, are read only by assistive technology. A `<table>`
  cannot put cells on further lines and keep its semantics in every browser.
- **Last seen** is `formatAge` of the timestamp against `useNow`, as the
  list's Age column, with the timestamp as its title.
- **From** is the reporter, then `, ` and its instance when there is one, as
  `kubectl get events -o wide` prints it. An Event without a reporter has no
  `From` part.
- **Warning and Normal.** A Warning row has a warning icon and `Warning` in
  medium weight in its Type cell, and a faint warning tint behind the whole
  row. A Normal row's Type is muted. The difference does not rest on color
  alone. Any other type shows as text.
- **Rows are not interactive.** They have no hover highlight, which would
  suggest that a click does something, and their text can be selected and
  copied. The scrolling area is focusable so the keyboard can scroll it, and
  shows the focus ring inside its edge, where the Pane does not clip it.
- **More than 500.** A muted line under the rows says
  `Showing the newest 500 of 1,234 Events.`

Every text the Cluster supplies is rendered as text. An Event's type is
compared by value and never used as an object key. Rows are keyed by the
Event's UID, which is unique because one type is read.

### States of the Events Facet

| State                                 | What shows                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading: no value yet, or a stale one | The header row and three skeleton rows, marked busy. No badge. A stale value's Events are never shown, and an error that arrives meanwhile shows as it would without a value.                                                                                                               |
| Empty                                 | `No recent Events`. `A cluster keeps Events for a limited time, usually one hour, so a healthy <Kind> often has none. New Events appear here as they happen.`                                                                                                                               |
| Populated                             | The table. The badge counts warnings.                                                                                                                                                                                                                                                       |
| Not permitted (`forbidden`)           | `Not permitted`. Namespaced: `Your credentials cannot list and watch Events in the <namespace> Namespace.` Cluster-scoped: `Showing the Events of a cluster-scoped Resource such as this <Kind> needs permission to list and watch Events in every Namespace.` Replaces any rows. No badge. |
| Another error, no Events yet          | `Events unavailable`, the error's message, and `hukube keeps trying.`                                                                                                                                                                                                                       |
| Another error, with Events            | A line above the table in the destructive color, `Events may be out of date: <message>`. The rows and the badge stay.                                                                                                                                                                       |
| The Cluster is unreachable            | The status bar says so, as today. The watch fails, which is the row above. It clears when the watch recovers.                                                                                                                                                                               |
| The connection to the Engine is lost  | The status bar says so, as today. The rows stay and their ages keep ticking. The client subscribes again on reconnect.                                                                                                                                                                      |
| The Resource is deleted while open    | The header's `Deleted` badge, in every Facet. The Events stay live for the same incarnation, because the deletion's own Events are often the useful ones.                                                                                                                                   |
| The Resource was never found          | The header's `Not found` badge. Events about anything with that kind, name, and Namespace, or the empty state.                                                                                                                                                                              |
| The window is out of date             | Frozen by the root layout, as everything else.                                                                                                                                                                                                                                              |

The empty state uses the `Empty` component as other notices do. It names the
time limit so that it reads as the normal state of a healthy Resource, not as
a failure or as still loading.

### The YAML Facet

Unchanged in behavior. Its error line and its `Not found` notice move into the
Facet, because they are about the Manifest. `Show managed fields` moves to
the switcher row.

### Packages considered

- **Tabs:** shadcn `tabs` over Base UI, chosen. Already a dependency.
- **Events list:** shadcn `table` is a styling wrapper around `<table>`,
  which cannot lay an Event out on two lines. A CSS grid with the list's
  classes matches the application and needs no package.
  `@tanstack/react-table` and `@tanstack/react-virtual` solve sorting, column
  state, and virtualization, none of which this Facet has.

## Sample Resources

`e2e/fixtures/sample/resources.yaml` gains:

- A `worker` Deployment in `sample-shop` whose image is
  `registry.invalid/sample-shop/worker:1.4.2`. `.invalid` never resolves, so
  its Pod collects real `Failed` and `BackOff` Events without leaving the
  machine, and its Deployment and ReplicaSet collect Normal ones.
- A hand-written Event in `default` about the `sample-shop` Namespace, so a
  cluster-scoped Resource has one.

The existing hand-written Event about the `web` Deployment has no UID, so it
is the sample for that case.

## Phases

1. **Protocol and Engine.** The types, the topic, `WatchEvents`, the pure
   functions, the `forbidden` mapping, and their tests.
2. **Facets.** The URI's Facet list, the registry, the switcher, the YAML
   Facet moved into a `View`, and the Facet rules.
3. **Events Facet.** The table, its states, the badge, and the sample
   Resources.
4. **End to end,** then a check by hand of every state in both themes.

## Testing

| Risk                                                   | Evidence                                                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Resource's Events do not arrive or go stale          | envtest: an Event about a ConfigMap arrives; an update to its count and `lastTimestamp` arrives; deleting it removes it.                                                                                                               |
| Events about other Resources leak in                   | envtest: Events about another name, the same name in another Namespace, and the same name with another kind do not arrive.                                                                                                             |
| A recreated Resource shows its predecessor's Events    | envtest: with the new UID, the old incarnation's Event is left out and one without a UID stays; without a UID, both incarnations arrive.                                                                                               |
| A cluster-scoped Resource gets nothing                 | envtest: a Node's Events in `default` arrive whether the reference has the Node's UID, its name as UID, or none; a namespaced Event with the same kind and name does not.                                                              |
| An Event shows twice                                   | envtest: an Event written through `events.k8s.io` arrives once, with its series count and last observed time.                                                                                                                          |
| A user without permission sees an empty Facet          | envtest through the control socket: the topic answers `forbidden`, and sends Events after the permission is granted.                                                                                                                   |
| The wrong timestamp, count, or reporter                | Go table tests for each writer in the table above, and for each fallback.                                                                                                                                                              |
| The match rule is wrong                                | Go table test over UID, name-as-UID, empty UID, unknown target UID, and API group.                                                                                                                                                     |
| Order, cap, and counts                                 | Go test: 501 Events give 500 rows, a total of 501, warnings counted before the cap, ties ordered by UID.                                                                                                                               |
| A Facet shows for the wrong Resources                  | Vitest for `facetsFor` and `resolveFacet`: both Event types, another type, an unknown `ResourceType`, and a requested Facet that does not apply.                                                                                       |
| A URI's Facet does not survive                         | Vitest for the URI: `#events` round-trips, and an unknown Facet is still refused.                                                                                                                                                      |
| The subscription asks for the wrong incarnation        | Vitest for the params rule: nothing before the Manifest answers, the UID of the last Manifest, none when never found, kept after deletion.                                                                                             |
| A tab that opens over another Resource loses its Facet | Vitest for the rule that picks the new tab's URI, and for `openPanel` passing the Pane's active tab to it.                                                                                                                             |
| A state of the Events Facet shows the wrong thing      | Vitest with jsdom for each row of the states table that the Facet renders, the warning row's accessible text, the badge's name, the cap line, and an age that advances with the clock.                                                 |
| The feature does not work end to end                   | Playwright: open a ConfigMap, switch to Events, see the empty state, create a Warning Event with `kubectl`, see its row and the badge without a reload, reload once the layout is stored, and find the Events Facet showing the Event. |

Each new test is run once against a deliberately broken implementation, to
see it fail at its assertion.

The switcher and every state are also checked by hand on
`mise run dev:verify`, in both themes and at two widths, and then by an
independent experience review.

## Risks

- **Two watches for each open Resource tab.** Accepted for the warning count.
  ADR-0014 names the way out if it costs too much.
- **A hidden Monaco editor.** The YAML Facet stays mounted while hidden.
  Monaco lays out again when its container is shown; check by hand that it
  keeps its scroll position and does not flash.
- **Nested tab roles.** A Resource tab's panel now holds a tab list of its
  own, and a list tab can be titled `events`. End-to-end locators must be
  scoped to the Resource's panel.
- **Firefox and Safari.** CSS subgrid, sticky positioning, and `oklch`
  colors are supported by both. Nothing here is specific to Chromium.

## Non-goals

- The Related, Logs, Overview, Form, and History Facets.
- A Facet in its own tab or beside the current one.
- Filtering, searching, or sorting the Events.
- Links from an Event to a Resource, and an Event's sub-object.
- A warning count in Resource lists.
- Switching the Facet of a tab that is already open through a link.

## Unresolved questions

None.

## What changed while building

- **Registry entries can supply an accessible name.** The optional
  `accessibleName` callback keeps the switcher independent of Facet names and
  gives the Events tab the exact name `Events, 3 warnings`. Computing the name
  from the nested badge's text introduced a space before the comma in the
  browser. The badge itself is decorative to assistive technology.
- **The subscription params declare each address field explicitly.** Tygo
  generates an embedded Go struct as a nested TypeScript property, so
  `ResourceEventsParams` lists its fields to keep the intended flat wire
  contract.
- **Events take three lines.** The original table's Message column scrolled
  sideways in a Pane beside the Resource list. Putting the message on a second
  line fixed that, but keeping Count and From on the first left Reason only a
  few characters in a narrow Pane and truncated From beside unused space in a
  wide one. The first line now holds Last seen, Type, and Reason; the message
  and the reporter and count each use a further line under Type.
- **New Resource tabs inherit the active tab's Facet.** The plan first limited
  inheritance to a Preview Tab replacing another. Enter and opening after
  pinning therefore reset the Facet. Reading the destination Pane's active tab
  makes clicks, Enter, and the Go to Resource palette keep the shown Facet.
- **The Engine owns the Events retry loop.** The plan first relied on the
  Reflector's own retries. They logged refused lists at error level and the
  wrappers reported expired watches, so the Engine now calls list-and-watch
  itself with the Cluster's retry timing and Warn logging.
- **A refused watch ends the attempt.** Stopping the test cluster with a
  Resource's Events on screen showed the status bar's notice but no error in
  the Facet: the Reflector retries a refused connection inside its watch and
  never returns. The watch function now returns such an error in a form the
  Reflector does not retry.
- **Only a started watch resets the retry delay.** It first reset after a
  completed list, so credentials that could list Events but not watch them
  caused a list every two seconds. Watch-start failures now double the delay
  up to the Cluster's retry maximum.
- **Static Pods supply another UID.** The kubelet writes Events with the hash
  in the mirror Pod's `kubernetes.io/config.mirror` annotation. The client
  sends it in `OtherUIDs`, and the Engine treats it as another UID of the
  same incarnation for both incarnation and API group matching.
