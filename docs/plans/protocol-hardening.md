# Plan: protocol hardening

Status: implemented, not merged yet. "What changed while building" lists where
the result differs from the text below.

The evidence for this work is `docs/research/engine-protocol-tooling.md`. The
decision to keep the protocol and to check for an exact build is recorded in
ADR-0012.

## Outcome

After this work:

- Each request method and subscription topic is declared once, in Go, with its
  params and result types. The Engine's handlers are registered against those
  declarations, and the TypeScript method map is generated from them.
- The Engine sends a `hello` message with a hash of the protocol first on
  every control socket. A UI whose own hash differs, or that gets no `hello`,
  stops using the connection, stops reconnecting, and shows a notice that it
  is out of date.
- Every `data` and `error` message of a subscription carries the revision of
  the params it answers. The client drops a value for params that a later
  `update` replaced, so no consumer compares echoed params by hand.
- ADR-0003 and ADR-0004 describe what the Engine sends: the latest value, not
  patches.

No feature changes. The only thing a user can see is the out-of-date notice.

## Current state

These observations come from the code at `05a1843`. Each confirms a weakness
the research lists.

- A method's types are stated three times: in a comment on its `Method`
  constant in `engine/internal/protocol/protocol.go`, in its handler's
  `decode[P]` call and return value in `engine/internal/server/topics.go`,
  and by hand in `packages/engine-client/src/methods.ts`. The only check is
  `_EveryMethodIsTyped`, which compares method names.
- `session.handle` looks a method up in the `requests` or `topics` map at run
  time. Nothing checks that every `Method` constant has a handler.
- The only version is the `hukube.v1` subprotocol constant. A client that
  reconnects to a newer Engine resubscribes with the types it was built with.
- `ClientMessage` and `ServerMessage` carry only the subscription ID.
  `FindResult` echoes `Text` and `Where`, and `resourceItems` in
  `apps/app/src/features/go-to-resource/palette-input.ts` compares them with
  the current params to disable rows from earlier input. No other consumer
  reads an echo. `QueryResult.Offset` is used as data by `rowAt`.
- `runSubscription` sends the whole value after each change. ADR-0003 says
  "a snapshot followed by patches", and ADR-0004 uses "patches" three times.
- The UI reaches the Engine through `WorkerEngineClient`. Its Worker holds
  the `EngineConnection`, so a value crosses two asynchronous hops: the
  socket, and the Worker boundary.

## Decisions

### One typed registry in the protocol package

A new file, `engine/internal/protocol/methods.go`, declares every method:

```go
var (
	RequestClustersList = DeclareRequest[None, []Cluster]("clusters.list")
	RequestSettingsPut  = DeclareRequest[Setting, None]("settings.put")

	TopicClusterStatus  = DeclareTopic[ClusterParams, ClusterStatus]("cluster.status")
	TopicClusterTypes   = DeclareTopic[ClusterParams, []ResourceType]("cluster.types")
	TopicResourcesQuery = DeclareTopic[QueryParams, QueryResult]("resources.query")
	TopicResourcesFind  = DeclareTopic[FindParams, FindResult]("resources.find")
	TopicResourceGet    = DeclareTopic[ResourceRef, ResourceData]("resource.get")
	TopicSettingsWatch  = DeclareTopic[SettingKey, Setting]("settings.watch")
)
```

- `Request[P, R]` and `Topic[P, D]` are small generic values that hold the
  method name. Declaring one records its name, kind, and the `reflect.Type`
  of its params and result in the package's list of methods. Declaring a name
  twice panics at start.
- `None` is an empty struct that stands for "no params" or "no result".
- `Methods()` returns the list in declaration order.
- The `Method` constants and their comments go away. `Method` stays as the
  type of the envelope's `method` field.
- `methods.go` is listed under `exclude_files` in `engine/tygo.yaml`, so tygo
  does not emit the generic types. `Method` therefore becomes `string` in
  `protocol.gen.ts`. The typed method names come from the generated map.

The Engine registers handlers against the declarations:

```go
handleRequest(protocol.RequestSettingsPut,
	func(ctx context.Context, srv *Server, p protocol.Setting) (protocol.None, error) { ... })

handleTopic(protocol.TopicClusterStatus,
	func(ctx context.Context, srv *Server, p protocol.ClusterParams, notify func()) (*live[protocol.ClusterStatus], error) { ... })
```

- The wrapper decodes the params once and passes a typed value. A handler
  whose types differ from its declaration does not compile.
- A method with `None` params accepts a message without params. Every other
  method still answers `bad_request` to missing or invalid params.
- A `None` result is sent as a message without `data`, as `settings.put`
  answers today.
- A topic's `compute` is typed by its data type and must still be able to say
  "nothing to send yet", which `resource.get` uses before its first Manifest
  arrives. The suggested shape is
  `compute func() (value D, ok bool, err error)`.
- A test in `server` walks `protocol.Methods()` and fails for a method without
  a handler of its kind, and for a handler without a declaration.

The rejected alternative keeps the `Method` constants and adds a declaration
beside each. It states each name twice and needs a second check that every
constant is declared.

### A small Go generator writes the method map and the hash

`engine/internal/protocol/gen` is a `main` package run with `go run`. It
writes two files:

- `packages/engine-client/src/methods.gen.ts` holds the `Requests` and
  `Topics` interfaces and the `RequestMethod` and `TopicMethod` types that
  `methods.ts` holds today. `methods.ts` is deleted.
- `engine/internal/protocol/hash.gen.go` holds `const Hash`. tygo copies the
  constant into `protocol.gen.ts`, as it already does for `Subprotocol`, so
  both sides get it from one generated value.

The generator names a type the way tygo does: a named type of the protocol
package by its name, a slice as `Name[]`, and `None` as `undefined`. It fails
on any other type, so a new shape is a decision and not an accident.

`mise run gen` runs the generator and then tygo, in that order, because tygo
reads `hash.gen.go`. `gen:check` and `gen:check:staged` compare all three
generated files, and the pre-commit `protocol` job also triggers on
`methods.gen.ts` and the generator's source.

### What the hash covers

The hash is the first 16 hexadecimal digits of a SHA-256 over the Go tokens
of every file in `engine/internal/protocol`, in file name order, leaving out
tests, generated files, and comments.

- **The source of the package, because it is the definition.** It holds the
  envelope, every type, every enum value, every JSON tag, and, with the
  registry, every method with its types. tygo's output and the method map are
  both derived from it.
- **Tokens, not bytes,** so a reworded comment or a reformatted file does not
  make a running Engine refuse its UI during development.
- **Not the generated TypeScript.** Hashing it would put the hash inside one
  of its own inputs, and would make the value depend on tygo's version.
- **Not a build identifier** such as a commit. Two builds of one commit with
  uncommitted changes would match, and every rebuild during development
  would mismatch without cause.

The check has two known limits, both accepted and recorded in ADR-0012:

- A change in how the Engine behaves that does not change the package, such
  as a handler that returns different rows for the same params, does not
  change the hash.
- The hash does not cover a type imported from another package. The generator
  fails if the protocol package imports anything outside the standard
  library.

### `hello` is the first message on every control socket

```go
const ServerTypeHello ServerType = "hello"

type ServerMessage struct {
	// ...existing fields
	Hello *Hello `json:"hello,omitempty"`
}

// Hello is the first message the Engine sends on a control socket.
type Hello struct {
	// Protocol is the Engine's protocol Hash.
	Protocol string `json:"protocol"`
}
```

`session.run` queues `hello` before it reads anything, with ID 0, which no
client uses.

A message is used and not the WebSocket handshake. A browser tells a page
nothing about why a handshake failed, so a refused subprotocol would look the
same as an Engine that is not running.

### How the client decides it is out of date

`ConnectionState` gains `outdated`. `EngineConnection` follows these rules:

1. When a socket opens, the client sends nothing and the state does not
   change. It waits for the first message, for at most 5 seconds
   (`helloTimeoutMs`, an option so tests can shorten it).
2. If the first message is a `hello` whose `protocol` equals the client's
   `Hash`, the client resets its backoff, enters `open`, and sends
   `subscribe` for every live subscription, as it does on open today.
3. If the first message is anything else, or a `hello` with another value, or
   the 5 seconds pass, the client is out of date. It closes the socket,
   cancels its timers, enters `outdated`, logs both hashes with
   `console.warn`, and never reconnects.
4. A socket that closes before its `hello` is an ordinary connection loss. The
   client reconnects with backoff, and the backoff does not reset.
5. In `outdated`, a request is rejected as it is when disconnected, and a
   subscription receives nothing. `close()` still moves to `closed`.

Because the client sends nothing before rule 2, an out-of-date UI never
sends a request or a subscription to an Engine of another build.

The 5 seconds exist for an Engine built before `hello` existed, which stays
silent. The Engine writes `hello` straight after the handshake, so a healthy
connection has it within milliseconds.

The Worker relays the state as it does the others.

### A revision ties a value to the params it answers

```go
type ClientMessage struct {
	// ...existing fields
	// Rev is the revision of a subscription's params, chosen by the client.
	Rev uint64 `json:"rev,omitempty"`
}

type ServerMessage struct {
	// ...existing fields
	// Rev is the revision of the params a data or error message answers.
	Rev uint64 `json:"rev,omitempty"`
}
```

The rules:

- **The client numbers a subscription's params.** A new subscription has
  revision 0. Each call of `update` adds 1, whether or not the socket is
  open. `subscribe` and `update` messages carry the current revision, so a
  subscription restored after a reconnect keeps its number.
- **The Engine echoes and never compares.** The latest `update` it received
  wins, as today. Each time the subscription starts its topic it remembers
  the revision that came with those params, and every `data` and `error`
  message it sends for the subscription carries the revision of the start it
  belongs to. An error from a start that failed carries that start's
  revision. An error the read loop sends for a `subscribe` it refuses carries
  that message's revision. A `result`, and the error of a request, carry
  none.
- **An update that overtakes an unprocessed one replaces it.** The
  subscription's goroutine then starts once, with the newer params and their
  revision, and sends nothing for the revision it skipped.
- **The first value after a start is always sent,** even when it equals the
  last one sent. This holds today and now matters more, because it is how the
  client learns that the new params have an answer.
- **The Engine does not withdraw a superseded value** that is already
  computed or waiting in the outbox. It goes out with its old revision and
  the client drops it. Withdrawing it would race with the first value for
  the new params.
- **The client drops a `data` or `error` message whose revision is not the
  subscription's current one.** `EngineConnection` does this where it
  receives a message.
- **The same rule applies at the Worker boundary,** the second hop a value
  can cross an update on. `WorkerEngineClient` counts its own `update` calls
  and sends the count with each `update` message. The Worker stamps each
  `data` and `error` it relays with the count of the last update it applied,
  and `WorkerEngineClient` drops a message whose count is not its own.
- **No consumer compares params.** `useSubscription` returns `stale`, which
  is true while the value it holds answers params other than the current
  ones. It records the params key in use when a value arrives, and compares
  that key with the current one while rendering. A value therefore turns
  stale in the same render that changes the params, and params that change
  and change back are not stale, which matches what the echo comparison did.

With that in place:

- `FindResult` loses `Text` and `Where`.
- `resourceItems` takes the hook's `stale` instead of the params, and
  `sameJson` is deleted with its tests.
- `QueryResult.Offset` stays, because the list uses it to place rows.
- `Setting.Key` stays, because `Setting` is also the params of
  `settings.put`.

### The out-of-date notice

This is the one thing a user sees, so its design is settled here.

**Where.** A bar across the full width of the window, above the Cluster tabs,
rendered by the root layout. It concerns the whole window and every Cluster
in it, so it does not belong in a Workspace's status bar, which is in one
Cluster's color and describes that Cluster. It pushes the content down
instead of covering it. Both Hosts use the native title bar, so nothing sits
above the tabs to collide with. A warning icon leads the bar.

**Which pattern.** A persistent bar at the top of the window with one action
is how web applications report that the page is older than its server, and
how VS Code reports that a restart is needed. A dialog was rejected: in the
desktop Host there is no action to offer, so a dialog would either trap the
user or be dismissed and leave no trace. A toast was rejected because it can
be missed and goes away.

**What it says.**

| Host    | Title                      | Text                                                                                                   | Action          |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------------------ | --------------- |
| Web     | This page is out of date   | The Engine was updated after this page loaded, so live data has stopped. Reload to continue.           | Reload (button) |
| Desktop | This window is out of date | hukube was updated while it was running, so live data has stopped. Quit and reopen hukube to continue. | none            |

In a development build (`import.meta.env.DEV`) both end with one more
sentence: "In development, rebuild and restart the Engine if this stays."

**How it differs from a connection problem.** A lost connection shows
"Reconnecting to the Engine" as text in the status bar and fixes itself. The
notice is a bar in the warning color at the other end of the window, with a
title, and stays. While it shows, the status bar's connection text reads "Out
of date" instead of a reconnecting message, and the Cluster picker does not
show its "Connecting to the Engine" spinner.

**Pointer and keyboard.** Reload is a standard `Button`. The bar has
`role="alert"`, so a screen reader announces it when it appears. When it
appears the bar itself takes focus, so one Tab reaches Reload. The bar is
focused and not the button, so a key pressed while typing cannot reload the
page. It adds no key binding. Reload calls `window.location.reload()`. The
Engine serves `index.html` with `no-cache` and without validators, so the
page always fetches the UI that matches it. The token survives in session
storage.

**States.** The notice is absent in every other connection state and has one
state of its own. It cannot be dismissed, because the window cannot recover
without the action. If a reload does not help, which happens only in
development, the notice appears again within milliseconds of the page
loading.

**The rest of the window.** Everything below the bar is frozen while it
shows: the root layout marks it `inert` and dims it, and the Go to Resource
palette, which renders outside it, does not open. The content stays readable
but cannot be clicked, focused, or selected. The connection is dead, so
anything a user opened would be empty or wrong, and each feature would
otherwise need an out-of-date state of its own.

**Width and themes.** At a narrow width the text wraps and the button stays
on the first line at the right. Colors come from the existing `warning`,
`foreground`, and `border` tokens and must hold their contrast in both
themes.

**Packages.** The bar is built from the existing `Button` and design tokens.
It is static content with one button, so there is no interaction to take from
a package. `Alert` from `packages/ui` was considered and is the wrong shape:
it is a rounded card for inline use, not a full-width bar. A toast library
such as Sonner was considered and rejected with the toast pattern.

The Host interface does not change. The notice reads `host.kind` to choose
its text.

## Steps

The phases depend on each other in order and ship as one pull request.

### Phase 1: registry and generator

1. Add `methods.go` with the declarations, `None`, and `Methods()`. Remove the
   `Method` constants. Exclude the file from tygo.
2. Replace the `requests` and `topics` maps with typed registration, and add
   the coverage test.
3. Add the generator, `methods.gen.ts`, and `hash.gen.go`. Point the client's
   imports at `methods.gen.ts` and delete `methods.ts`. Let the Worker
   protocol use `RequestMethod` and `TopicMethod` where it now casts `Method`.
4. Extend `gen`, `gen:check`, `gen:check:staged`, and the pre-commit job.

### Phase 2: `hello` and the out-of-date state

1. Add `Hello`, `ServerTypeHello`, and the `hello` field. Send it from
   `session.run`.
2. Implement the client rules, the `outdated` state, and the Worker relay.
3. Add the notice, the status bar text, and the Cluster picker change.

### Phase 3: revisions

1. Add `rev` to both envelopes, carry it through the subscription's params
   channel, and stamp `data` and `error` messages.
2. Drop superseded values in `EngineConnection` and at the Worker boundary.
3. Add `stale` to `useSubscription`, remove the echoes from `FindResult`, and
   simplify the palette.

### Phase 4: records

1. Update the "Protocol changes" hazard in `AGENTS.md`: methods are declared
   in `methods.go`, `mise run gen` writes three files, and an Engine built
   before a protocol change makes the UI show the notice until it is rebuilt.
2. Check the notice by hand (see below) and record how in the pull request.
3. Mark this plan as shipped.

ADR-0012 and the wording of ADR-0003 and ADR-0004 are written with this plan.

## Testing strategy

| Risk                                                                 | Evidence                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A declared method has no handler, or a handler has no declaration    | `server` test over `protocol.Methods()`.                                                                                                                                                                                                                                                                               |
| A handler's types differ from its declaration                        | The compiler. No test.                                                                                                                                                                                                                                                                                                 |
| The method map or the hash is stale                                  | `gen:check` in `mise run check` and in CI.                                                                                                                                                                                                                                                                             |
| The generator names a type wrongly, or the hash moves with a comment | Unit tests in the generator: a named type, a slice, and `None`; an unsupported type fails; a source with a changed comment and spacing hashes the same, and one with a changed field, enum value, or tag hashes differently.                                                                                           |
| A method with `None` params rejects a message without params         | The existing `clusters.list` use in `server` tests, plus a `bad_request` assertion for a topic without params.                                                                                                                                                                                                         |
| `hello` is not first, or holds the wrong value                       | `server` test: dial, and assert the first message is `hello` with `protocol.Hash`, before sending anything.                                                                                                                                                                                                            |
| A superseded value is delivered as current                           | `server` tests on the subscription harness: a value computed while an update waits goes out with the old revision and the next with the new one; two updates sent before the subscription reads either start the topic once, and no message carries the skipped revision; a failed start's error carries its revision. |
| The client uses an Engine of another build                           | Vitest on `EngineConnection`: a `hello` with another hash, a first message that is not `hello`, and no message within the timeout each end in `outdated`, send nothing, and open no further socket when timers advance.                                                                                                |
| A matching `hello` is mishandled                                     | Vitest: nothing is sent before `hello`; after it the state is `open` and subscriptions are restored; a socket that closes before `hello` reconnects with backoff.                                                                                                                                                      |
| The client delivers a value for replaced params                      | Vitest: after `update`, a `data` and an `error` with the old revision are dropped and one with the new revision is delivered; a subscription restored after a reconnect sends its current revision.                                                                                                                    |
| A value crosses an update at the Worker boundary                     | Vitest on `WorkerEngineClient` with a fake Worker: a `data` stamped with an earlier count is dropped after `update`.                                                                                                                                                                                                   |
| The palette opens a Resource from earlier input                      | Vitest for `resourceItems` with `stale`, and the existing Playwright palette test, which types at a human pace and presses Enter.                                                                                                                                                                                      |
| The change breaks a feature                                          | The existing unit, envtest, and end-to-end suites for both Hosts.                                                                                                                                                                                                                                                      |
| Reload fetches the old UI                                            | `server` test: a conditional request for `index.html`, at the root and at a client-side route, returns 200 with no validators.                                                                                                                                                                                         |
| The notice says the wrong thing for a Host, or does not take focus   | Render test of the notice for both Hosts, and of focus moving to it when the state becomes `outdated`.                                                                                                                                                                                                                 |
| The notice is missing, unclear, or does not clear                    | By hand, then by the experience review: open the web Host, replace its Engine with one built from a changed protocol definition on the same address, see the notice, reload, and see it gone. Both themes, 1280 px and a narrow width.                                                                                 |

The notice has no automated end-to-end test. Producing a mismatch needs a
second Engine build, and Playwright cannot rewrite a socket that a Worker
opens. The client tests cover the state, and the hand check covers the bar.

## Risks

- **A false "out of date".** The 5 second wait could expire on a healthy
  connection if the Engine's process is suspended between the handshake and
  its first write. The result is a notice that a reload clears. This is
  accepted over a second rule for retrying.
- **Revision counters at two hops.** The socket revision and the Worker count
  are separate numbers that follow the same rule. They are kept separate so
  `EngineConnection` stays correct when used without a Worker, as its tests
  do.
- **Development loop.** After a protocol change, a running Engine refuses the
  rebuilt UI until it is restarted. This is intended, and the notice says so
  in a development build.
- **A list that scrolls faster than the Engine answers.** A list replaces its
  window every 100 rows. Before, a value for the window just left was still
  shown, and it usually covered the visible rows. Now it is dropped, so while
  the window keeps changing faster than the Engine answers, no rows arrive
  until scrolling slows. This is an estimate, not a measurement: with the 50
  to 90 ms a Query took over 100,000 Pods in the list columns work, it needs
  more than about 1,100 rows a second, sustained. If it shows in use, a
  consumer could opt in to superseded values.
- **The notice needs the same address and token.** A tab meets a restarted
  Engine only when both are pinned, as ADR-0012 records. With the defaults it
  keeps reconnecting, which is what it did before this work.
- **`Method` is a plain string in the generated types.** The envelope loses a
  union type. The typed surface, `EngineClient`, keeps exact method names
  from the generated map.

## Non-goals

- Structured errors, error details, and new error codes.
- Cancelling a request, and a message with which the Engine ends a
  subscription.
- The separate socket for Log Streams and Exec Sessions.
- Validating every wire message at run time in the UI.
- Rejecting unknown fields, or moving the Engine to `encoding/json/v2`. The
  research suggests it but did not run it against this code. It is a possible
  follow-up once someone has checked tygo and the `json.RawMessage` fields
  under it.
- A restart button in the desktop Host. It needs a new IPC call and is not
  needed to tell the user what to do.

## What changed while building

- **The window freezes while it is out of date.** The plan left the content
  below the notice usable so a user could still copy from it. The experience
  review showed what that meant: a click replaced the list being read with an
  empty one, and opening a Cluster showed "No resource types match." The
  content is now inert and dimmed, and the notice takes focus when it
  appears, because inert content drops the focus it held.
- **`index.html` is served without validators.** The Engine sent
  `Last-Modified` and answered `304 Not Modified` when its file was not newer
  than the browser's copy, as after a rollback. Reload then loaded the old UI
  again. The Engine now ignores conditional requests for `index.html`.
- **The desktop text names no Engine.** A desktop user never starts or sees
  one, so the text says hukube was updated while it was running.
- **The notice has a warning icon,** because the bar's tint alone is quiet
  in the dark theme.
- **`stale` has a render test.** It needed a DOM, so `jsdom` and
  `@testing-library/react` joined the development dependencies. Both are the
  established packages for this, and the repository had no way to render a
  hook in a test.
- **A duplicate handler registration panics** at start instead of replacing
  the earlier handler.

## Follow-ups

- A restart button in the desktop Host's notice. It needs an IPC call from
  the UI to the main process.
- In the Go to Resource palette, Enter does nothing when pressed before the
  results for the current text arrive. This layer did not change that.
- A menu or tooltip that is open at the moment the window goes out of date
  renders outside the frozen content and stays usable until it closes. The
  palette closes itself, but that was not confirmed in a browser for the case
  where it is open at that moment.
- `build:engine` does not run `mise run gen`, so an Engine rebuilt after a
  protocol edit keeps the old hash until someone generates. `gen:check` and
  the pre-commit hook catch it before a commit.

## A possible addition: refusing a stale `settings.put`

Not part of this plan unless the coordinator confirms it.

Layer 1 found that `settings.put` cannot refuse a stale write, so the column
layout store writes one edit at a time and reopens its watch after each
write. Closing that needs a revision on the stored value:

- `Setting` gains a revision that the Engine assigns and stores, and
  `settings.put` gains the revision the write is based on and returns the
  stored `Setting`. The Engine refuses a write based on an older revision.
- It would be a fifth phase, after phase 3. The registry makes the changed
  result type a one-line edit to a declaration.
- It touches `engine/internal/settings` (the stored format and `Put`),
  `protocol.Setting` and the `settings.put` declaration and handler,
  `column-layout-store.ts` (which could then drop its one-at-a-time writes
  and its watch reopening), `layout-persistence.ts`, and their tests.
- A refused write needs an error the client can tell apart, such as a
  `conflict` code. New error codes are a non-goal of this layer, so adding
  this also means deciding that one code is in scope.

## Unresolved questions

None that block the work. The possible addition above waits for a decision.
