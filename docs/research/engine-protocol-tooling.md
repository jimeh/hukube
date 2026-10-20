# Research: is the UI-to-Engine protocol worth moving onto standard tooling?

Researched on 2026-10-13 against commit `f649e14`. Versions and browser support
are as of that date.

How to read this: a statement with a file path or a link next to it is an
observation. A sentence that starts with "I infer" is an inference.
Recommendations are in the summary and in
[Recommendation](#recommendation). Items I could not verify are listed in
[Appendix D](#appendix-d-what-i-could-not-verify).

## Summary

**Keep the WebSocket transport, the JSON encoding, the custom envelope, and
tygo. Harden them in five small steps, and design the stream socket before Log
Streams. Do not adopt Connect, gRPC-Web, JSON-RPC, GraphQL, SSE, or
WebTransport now.**

The facts that drive this:

1. **No standard option expresses what the control socket does.** A
   latest-value subscription whose params change in place, with coalescing and
   deduplication, is not a primitive in JSON-RPC, Connect, gRPC-Web, GraphQL
   subscriptions, or SSE. Each needs the same pattern built on top that
   `session.go` and `outbox.go` already implement in about 340 lines.
2. **The schema-first RPC options still cannot carry an Exec Session in a
   browser.** Connect's own documentation says browsers get "only server
   streaming"
   ([Connect for Web](https://connectrpc.com/docs/web/getting-started/)), and
   gRPC-Web says the same
   ([grpc-web README](https://github.com/grpc/grpc-web/blob/master/README.md)).
   The reason ADR-0004 gives for rejecting them still holds. On top of that,
   the Engine serves cleartext HTTP/1.1 on loopback, where a browser allows
   six connections per host, so one HTTP stream per subscription does not fit.
3. **The real weaknesses are small and local.** The method-to-types map is
   hand-written in three places, there is no check that a UI and an Engine
   speak the same protocol, errors carry no structure, and requests cannot be
   cancelled. Each has a fix of about a day or less that does not depend on
   any other decision.

The part of the protocol that needs real design is the one that does not exist
yet: the per-stream socket for Log Streams and Exec Sessions. That is where a
borrowed convention pays, and Kubernetes' own channel framing is the obvious
one to borrow.

The strongest case for a larger change is Protocol Buffers with Buf as the
schema source, keeping the current transport. It becomes worth its cost when
an Engine must serve UIs of other builds, which nothing on the agreed roadmap
requires.

## What we have

### Transport and authentication

- The Engine serves `GET /healthz`, `GET /ws`, and optionally the built UI
  (`engine/internal/server/server.go:67-76`). It is plain `net/http` without
  TLS, on a loopback listener
  (`engine/cmd/hukube-engine/main.go:129-143`, `154-168`).
- Every request must address a loopback name or an `--allow-host` name
  (`server.go:81-95`). The WebSocket upgrade checks the Origin, then a token
  carried as a `hukube.token.<token>` subprotocol, then the `hukube.v1`
  subprotocol (`server.go:97-144`, `protocol.go:14-17`).
- The desktop Host starts the Engine, reads its URL from a `ready` line on
  stdout, and gives the UI `{url, token}` over IPC
  (`apps/desktop/src/main.ts:88-111`, `189`). The web Host uses the page's own
  origin and a token from the URL fragment (`packages/host/src/index.ts:49-72`).
- The UI opens the socket in a Web Worker
  (`packages/engine-client/src/worker-client.ts:26-31`, `worker.ts:16-23`).

### Envelope and lifecycles

The client sends `{id, type, method?, params?}` with `type` one of `request`,
`subscribe`, `update`, or `unsubscribe`. The Engine sends
`{id, type, data?, error?}` with `type` one of `result`, `data`, or `error`
(`protocol.go:19-61`). All frames are JSON text.

- **Request:** the Engine looks the method up in `requests`, runs the handler
  in a goroutine under the session's context, and replies with `result` or
  `error` (`session.go:74-87`). The client rejects a request made while
  disconnected, and rejects every in-flight request when the socket drops
  (`connection.ts:76-90`, `191-198`).
- **Subscription:** `subscribe` starts a topic, which returns a `compute`
  function and calls `notify` when its value may have changed
  (`topics.go:19-31`). The session sends the newest value at most once per
  100 ms, skips a value whose JSON equals the last one sent, and keeps only
  the latest unsent value per subscription
  (`session.go:25`, `128-218`, `outbox.go:35-43`). `update` replaces the
  params and restarts the topic; a newer `update` replaces an unprocessed one
  (`session.go:105-114`, `186-198`). An error does not end a subscription
  (`session.go:153-156`).
- **Reconnect:** the client reconnects with backoff and sends `subscribe`
  again for every live subscription with its latest params
  (`connection.ts:141-163`).

### Typing, generation, and validation

- The Go types in `protocol.go` are the contract. tygo 0.2.21 turns them into
  `protocol.gen.ts` (`engine/tygo.yaml`, `mise.toml:9`, `40-43`), and
  `gen:check` fails the build when the file is stale (`mise.toml:236-251`).
- `methods.ts` maps each method name to its params and result types by hand
  (`packages/engine-client/src/methods.ts:18-31`).
- The Engine validates by decoding into the params struct
  (`topics.go:224-233`). The UI casts parsed JSON to the generated type
  (`connection.ts:151`).

### Adding a method today

1. Add the `Method` constant, a comment naming its types, and the params and
   result structs to `protocol.go`.
2. Run `mise run gen`.
3. Add a handler to `requests` or `topics` in `topics.go` that calls
   `decode[P]`.
4. Add the entry to `Requests` or `Topics` in `methods.ts` by hand.

Both plans followed these steps
(`docs/plans/labels-and-go-to-resource.md:292-296`,
`docs/plans/list-columns.md:247-253`).

### Weaknesses the code demonstrates

| #   | Weakness                                                                                                                                                                                                                                             | Evidence                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| W1  | The method-to-types map exists three times: a Go comment, the handler's `decode[P]` call and return value, and `methods.ts`. The compile-time check covers method names only, so a wrong type or a topic filed under `Requests` compiles.            | `protocol.go:84-101`, `topics.go:33-198`, `methods.ts:36-38`                                                             |
| W2  | Nothing checks that every `Method` constant has a handler. An unhandled method fails at run time as `bad_request`.                                                                                                                                   | `session.go:75-78`, `90-93`                                                                                              |
| W3  | There is no protocol version or handshake beyond the constant `hukube.v1`, which two protocol changes since its creation on 2026-10-01 left untouched. A browser tab that outlives an Engine upgrade reconnects and resubscribes with its old types. | `protocol.go:15`, `connection.ts:141-163`, `git log -- engine/internal/protocol/protocol.go`                             |
| W4  | Errors are one of four codes plus a message. `forbidden` is defined but never produced, and every Kubernetes API error reaches the UI as `internal`. There is no field for details such as a conflict or invalid fields.                             | `protocol.go:63-77`, `outbox.go:89-98`                                                                                   |
| W5  | A request cannot be cancelled and has no deadline. A request in flight when the socket drops is rejected with an unknown outcome.                                                                                                                    | `session.go:80-87`, `connection.ts:191-198`                                                                              |
| W6  | The Engine cannot end a subscription. There is no "done" message.                                                                                                                                                                                    | `protocol.go:46-53`                                                                                                      |
| W7  | `data` is latest-value only, frames are JSON text only, and the only socket route is `/ws`. The stream socket that ADR-0004 calls for does not exist.                                                                                                | `outbox.go:35-43`, `connection.ts:150`, `server.go:67-76`                                                                |
| W8  | A `data` message does not say which params it answers. Each updatable topic works around this by echoing params in its result.                                                                                                                       | `protocol.go:252-256`, `286-294`, `labels-and-go-to-resource.md:159-163`                                                 |
| W9  | Decoding is permissive at both ends. The Engine ignores unknown fields and unknown enum values, and the UI does not check anything. A malformed envelope closes the whole control socket.                                                            | `topics.go:224-233`, `engine/internal/query/query.go:295`, `connection.ts:151`, coder/websocket `wsjson/wsjson.go:37-41` |
| W10 | The Worker boundary is a second hand-written envelope that mirrors the wire one, with `as never` casts.                                                                                                                                              | `worker-protocol.ts:5-19`, `worker.ts:25`, `39`, `worker-client.ts:92`                                                   |
| W11 | A client message over 4 MiB closes the control socket. A large Manifest, or several in one request, can reach that.                                                                                                                                  | `session.go:18`, `45`, coder/websocket `read.go:527-528`                                                                 |
| W12 | ADR-0003 says subscribers get "a snapshot followed by patches". The code sends the full value every time. This is drift in the ADR's wording, not a bug.                                                                                             | `docs/adr/0003-engine-owns-cluster-state.md:4`, `session.go:165-174`                                                     |

W1 is a gap in a consequence ADR-0002 states: "TypeScript protocol types are
generated from Go definitions so the two sides cannot drift silently"
(`docs/adr/0002-go-engine-as-separate-process.md:19-20`).

## What the protocol must support next

| #   | Feature                         | What it asks of the protocol                                                               | Ready today?                |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| 1   | Column editor                   | Settings through `settings.put` and `settings.watch`. Stored values outlive builds.        | Yes                         |
| 2   | Facets, starting with Events    | More latest-value topics.                                                                  | Yes, with W1 and W8 growing |
| 3   | Relationships                   | More latest-value topics.                                                                  | Yes                         |
| 4   | Log Streams                     | Append-only, high-volume, possibly binary, own socket, bounded buffer, gap marker, an end. | No: W6, W7                  |
| 5   | Editing, applying, and deleting | Mutating requests, dry runs, conflicts, structured errors, cancellation.                   | No: W4, W5, W11             |
| 6   | Exec Sessions                   | Bidirectional binary stream with resize and an exit status.                                | No: W6, W7                  |

I confirmed the constraints in the brief:

- One UI runs in a browser and in Electron's renderer and connects from a Web
  Worker (`packages/host/src/index.ts:87-89`, `worker-client.ts:26-31`).
  Electron 44.5.0 embeds Chromium 152
  ([DEPS](https://github.com/electron/electron/blob/v44.5.0/DEPS)), and the UI
  build targets `chrome130` (`apps/app/vite.config.ts:30`).
- The Engine binds loopback, requires the token, and refuses other Host
  headers (`main.go:154-168`, `server.go:81-95`, `134-144`). Real
  authentication is deferred by ADR-0007.
- Subscriptions are latest-value, updatable in place, rate-bounded, and
  deduplicated (`session.go:128-218`).
- UI and Engine ship as one build in both Hosts: the desktop Host packages the
  Engine binary (`apps/desktop/src/main.ts:43-45`), and the web Host's UI is
  served by the Engine (`main.go:114-117`). Version skew therefore arises only
  from a stale tab, a stale development binary, or a future remote Engine.

## Options

Rows are options. Columns are the criteria from the brief. Versions and dates
are in [Appendix A](#appendix-a-versions-checked-on-2026-10-13), and the
reasoning behind each cell is in
[Appendix B](#appendix-b-notes-on-each-option).

| Option                                                 | Browser, Electron, Worker                                 | Latest-value subscription with param update | Log Stream and Exec Session                       | Backpressure and head-of-line blocking                            | Go and TypeScript implementations                           | Code generation and schema evolution                                  | Debugging and testing                                   | Adds to build and dependencies                      | Migration cost and what it replaces                                            |
| ------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Current design, hardened**                           | Yes                                                       | Native                                      | Needs the stream socket designed (both)           | Latest-wins outbox on control; separate sockets isolate streams   | coder/websocket 1.8.15, no TypeScript dependency            | tygo for types; method map by hand until generated; no evolution rule | JSON text frames; Go tests use a real socket            | Nothing                                             | About 4 days across five steps; replaces `methods.ts`                          |
| **JSON-RPC 2.0 on the same socket**                    | Yes                                                       | Pattern on top, same as today               | Out of scope of the spec                          | Same as today                                                     | sourcegraph/jsonrpc2 0.2.3, vscode-jsonrpc 9.0.3            | None in the spec; OpenRPC describes methods, not pushed data          | Same as today                                           | One library each side, or none                      | 2 to 3 days to rename the envelope; replaces nothing that hurts                |
| **Connect RPC as the transport**                       | Unary and server streaming only                           | Pattern on top; no in-place update          | Log Stream yes; Exec Session no                   | One HTTP/1.1 connection per stream, six per host without TLS      | connect-go 2.0.0 (six days old), connect-es 2.2.0           | Strong: `buf generate`, `buf breaking`                                | Good for unary; streams are opaque to cURL and DevTools | Buf CLI, two plugins, three runtime libraries       | 1 to 2 weeks; replaces the session, outbox, client, and types; WebSocket stays |
| **gRPC-Web**                                           | Unary and server streaming only                           | Pattern on top                              | Exec Session no                                   | As Connect                                                        | grpc-web 2.1.1; connect-go serves it                        | Protobuf                                                              | Base64 text or binary frames                            | As Connect, and a proxy unless served by connect-go | As Connect, with no advantage over it here                                     |
| **Protobuf and Buf as schema only, current transport** | Yes                                                       | Native, unchanged                           | Unchanged                                         | Unchanged                                                         | protobuf-go, protobuf-es 2.16.0                             | Strong, including the method map as service definitions               | ProtoJSON stays readable; binary does not               | Buf CLI, two plugins, two runtime libraries         | About a week now, more after each feature; replaces `protocol.go` and tygo     |
| **AsyncAPI, JSON Schema, TypeSpec, OpenAPI**           | Not applicable                                            | Describable, not generated                  | Describable                                       | Not applicable                                                    | No generator emits this envelope's Go handlers and client   | Model generation only; TypeSpec has no Go emitter                     | Adds documentation                                      | A Node toolchain and one or two generators          | Days, plus a second source of truth unless Go types are generated from it      |
| **GraphQL over `graphql-ws`**                          | Yes                                                       | Event streams with fixed variables          | Not suited to binary; Exec Session no             | Same single socket as today                                       | gqlgen 0.17.95, graphql-ws 6.3.0                            | Strong typing, own code generators                                    | Good tools, but a third language                        | Server framework, client library, code generator    | Weeks; replaces everything and fits worse                                      |
| **SSE with HTTP requests**                             | Yes                                                       | Pattern on top                              | One-way only; text only                           | Six connections per host on HTTP/1.1                              | Standard library both sides                                 | None                                                                  | Easy to read with cURL                                  | Nothing                                             | A week; replaces the socket with a weaker one                                  |
| **WebTransport**                                       | Chrome 97, Firefox 114, Safari 26.4; needs HTTP/3 and TLS | Pattern on top                              | Both, on independent streams                      | Best available: per-stream flow control, no cross-stream blocking | webtransport-go 0.13.0 (pre-1.0); nothing in Go's stdlib    | None                                                                  | Weak tooling; UDP                                       | quic-go, certificate handling                       | Weeks, plus a WebSocket fallback; revisits ADR-0004 and ADR-0007               |
| **CBOR, MessagePack, or Protobuf encoding**            | Yes                                                       | Unchanged                                   | Not needed: stream payloads are already raw bytes | Unchanged                                                         | fxamacker/cbor 2.9.6, cbor-x 1.6.6; Go MessagePack is stale | None                                                                  | Frames stop being readable                              | One library each side                               | Days; loses pass-through of the API server's JSON                              |

## What comparable tools do

Only the comparisons that teach something specific are here.

- **Kubernetes exec over WebSocket.** The API server and client-go multiplex an
  exec session on one WebSocket by making the first byte of each binary frame
  a channel number: 0 stdin, 1 stdout, 2 stderr, 3 error, 4 resize, 255 close.
  The subprotocol name carries the version (`v5.channel.k8s.io`)
  ([constants.go](https://github.com/kubernetes/apimachinery/blob/master/pkg/util/remotecommand/constants.go),
  [websocket.go](https://github.com/kubernetes/client-go/blob/master/tools/remotecommand/websocket.go)).
  The Engine already speaks this to the Cluster. **Lesson:** an Exec Session
  needs a channel byte and nothing more elaborate.
- **Headlamp** (Go backend, React UI, v0.45.0). It passes the Kubernetes
  channel subprotocols straight through to the browser for exec and attach
  ([pod.ts](https://github.com/kubernetes-sigs/headlamp/blob/main/frontend/src/lib/k8s/pod.ts)),
  and multiplexes watches on one WebSocket with a hand-written JSON envelope
  of `REQUEST`, `CLOSE`, and `COMPLETE` messages
  ([multiplexer.go](https://github.com/kubernetes-sigs/headlamp/blob/main/backend/cmd/multiplexer.go),
  [multiplexer.ts](https://github.com/kubernetes-sigs/headlamp/blob/main/frontend/src/lib/k8s/api/v2/multiplexer.ts)).
  **Lesson:** the closest comparable project also uses a custom envelope on a
  WebSocket, and its envelope has the "complete" message ours lacks (W6).
- **Docker Engine API.** Clients and daemons of different versions negotiate
  "the highest version of the API supported by both"
  ([Engine API](https://docs.docker.com/reference/api/engine/)). Attach and
  logs separate stdout from stderr with an 8-byte frame header holding the
  stream type and a length
  ([swagger.yaml](https://github.com/moby/moby/blob/master/api/swagger.yaml)).
  **Lesson:** negotiation is what independent release trains cost. hukube has
  one release train.
- **VS Code.** Its internal IPC has two primitives, `call` and `listen`, with
  numeric message types for promise, cancel, listen, and dispose
  ([ipc.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.ts)).
  That is our request and subscribe, plus a cancel. The remote server refuses
  a client built from another commit with "Client refused: version mismatch"
  ([remoteExtensionHostAgentServer.ts](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/remoteExtensionHostAgentServer.ts)).
  **Lesson:** when both ends ship together, an exact-build check is an
  accepted answer to version skew, and it needs no compatibility rules.
- **Language Server Protocol** (3.18 current). It uses JSON-RPC 2.0 and adds
  what JSON-RPC lacks: `$/cancelRequest`, `$/progress` with tokens for
  streamed partial results, and capabilities exchanged in `initialize` with no
  version handshake. Since 3.17 it publishes a machine-readable meta model
  from which clients generate types
  ([specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)).
  **Lesson:** JSON-RPC gives only the request and response envelope. LSP had to
  design cancellation, streaming, and negotiation itself.
- **Debug Adapter Protocol.** Its envelope is `seq` and `type`, with `type` one
  of `request`, `response`, or `event`. It does not use the JSON-RPC envelope. A JSON Schema
  file is the source of truth, and features are added behind capability flags
  ([overview](https://microsoft.github.io/debug-adapter-protocol/overview),
  [schema](https://github.com/microsoft/debug-adapter-protocol/blob/main/debugAdapterProtocol.json)).
  **Lesson:** a long-lived, widely implemented protocol can keep a custom
  envelope. What it cannot do without is one machine-readable source.
- **Chrome DevTools Protocol.** Definitions are generated daily from Chromium,
  and the published package includes a "simple name-to-type-interface"
  mapping from each command and event to its types
  ([README](https://github.com/ChromeDevTools/devtools-protocol/blob/master/README.md)).
  **Lesson:** that generated mapping is exactly what `methods.ts` should be.
- **Jupyter.** A kernel's control channel uses its own socket "to avoid
  queueing behind execution requests"
  ([messaging](https://jupyter-client.readthedocs.io/en/stable/messaging.html)).
  **Lesson:** it reached ADR-0004's conclusion about isolating traffic classes.
- **Tailscale LocalAPI.** Plain HTTP on the local machine, where the event bus
  is one long response of newline-delimited JSON
  ([localapi.go](https://github.com/tailscale/tailscale/blob/main/ipn/localapi/localapi.go)).
  **Lesson:** this works because its clients are not browsers, so the
  six-connection limit does not apply to them.

I left out the Kubernetes Dashboard, whose repository is archived, and Lens,
whose public repository has had no push since February 2025.

## Recommendation

### Tier 1: do now, whatever else is decided

Each step stands alone. None contradicts an ADR.

| Step                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                 | Fixes  | Land before                 | Touches                                                                                            | Rough size    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------- | -------------------------------------------------------------------------------------------------- | ------------- |
| **1a. Generate the method map from one Go registry**          | Declare each method once in Go with its types, for example `Topic[QueryParams, QueryResult]("resources.query")`. Register handlers as typed functions so the wrapper decodes params once. A small Go generator writes `methods.gen.ts`, and `gen` and `gen:check` cover it. A handler with the wrong types, or a method with no handler, then fails to compile or fails a test.              | W1, W2 | Feature 2                   | `protocol.go`, `topics.go`, `session.go`, a generator command, `mise.toml`, `methods.ts` (deleted) | 1 day         |
| **1b. Send a `hello` with a protocol hash**                   | The generator writes a hash of the protocol package into a Go constant and a TypeScript constant. The Engine sends a `hello` message holding the hash first on every socket. On a mismatch the UI stops retrying and says what to do: reload in the web Host, where the Engine serves the matching UI, or restart in the desktop Host. No one has to remember to bump a version.             | W3     | Feature 2; at latest 5      | `protocol.go`, `session.go`, `connection.ts`, `client.ts`, the generator, one UI state             | 0.5 to 1 day  |
| **1c. Echo a params revision**                                | `update` carries a client-chosen `rev`, and each `data` and `error` message carries the `rev` it answers. The UI can then discard stale values for any topic, and new topics stop echoing their params.                                                                                                                                                                                      | W8     | Feature 2                   | `protocol.go`, `session.go`, `connection.ts`, `react.tsx`, the palette                             | 0.5 day       |
| **1d. Validate stored settings in the UI**                    | Settings are the one payload that outlives a build. Give each stored value a version and parse it with a schema library at the point of use, starting with the column editor's settings. One small dependency such as valibot 1.5.0 or zod 4.6.7.                                                                                                                                            | W9     | With feature 1              | `apps/app` only                                                                                    | 0.5 day       |
| **1e. Structured errors, cancellation, and a "done" message** | Add an optional `details` to `ErrorDetail` and the codes mutations need (`conflict`, `invalid`, `cancelled`, `unavailable`). Map Kubernetes API errors to codes, starting with `forbidden`, and pass the API server's `Status` as details. Let `unsubscribe` cancel a request's context. Add a `done` server message type. Decide how a mutation with a lost connection reports its outcome. | W4-W6  | With feature 5; `done` by 4 | `protocol.go`, `outbox.go`, `session.go`, `connection.ts`, `client.ts`                             | 1 to 1.5 days |

Two cheaper notes:

- **Strict decoding in the Engine.** Go 1.27 ships `encoding/json/v2`, which
  can reject unknown members and writes a nil slice as `[]` by default
  ([Go 1.27 release notes](https://go.dev/doc/go1.27),
  [json/v2](https://pkg.go.dev/encoding/json/v2)). Using it for protocol
  encoding and decoding would turn a mistyped param into a `bad_request` and
  retire the nil-slice hazard in `AGENTS.md:52`. Its `omitempty` omits a
  field only when it encodes as an empty JSON value, so `bool` and `int`
  fields tagged `omitempty` need `omitzero`. Do this with step 1a, and check
  that tygo and the `json.RawMessage` fields behave the same first.
- **Amend ADR-0003's wording** to say subscribers get the latest value, or
  record that patches are deferred (W12).

### Tier 2: design the stream socket before Log Streams

This is the one place where the protocol must grow in kind, not in count. It is
new code, so there is no migration cost, and one design should serve features
4 and 6. I recommend writing it as a plan or ADR before feature 4, with these
choices as the starting point:

- **One route and one subprotocol** for both stream kinds, such as
  `/ws/stream` and `hukube.stream.v1`, with the checks `serveControl` already
  does. Keep the control socket as it is, per ADR-0004.
- **Text frames for control, binary frames for data.** The first frame is a
  JSON `open` message that names a method and params from the same registry
  as step 1a. Later text frames carry the gap marker, `done` with an exit
  status or error, and terminal resize. This needs no encoding library.
- **A one-byte channel prefix on binary frames**, numbered as Kubernetes
  numbers them, so stdin, stdout, and stderr map directly onto what client-go
  gives the Engine.
- **Flow control decided on evidence.** The standard browser `WebSocket` has
  no way to slow a sender. `WebSocketStream`, which adds backpressure, is in
  Chromium only and is not on a standards track
  ([browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/WebSocketStream.json)).
  I infer that a slow Worker may never cause the TCP backpressure the Engine's
  bounded buffer relies on, because the browser keeps reading and queues the
  messages. Measure this in the feature 4 spike. If it holds, add a
  client-sent acknowledgement of bytes consumed and bound the unacknowledged
  bytes in the Engine.
- **Keep the stream abstraction free of WebSocket details** in
  `engine-client`: ordered binary frames, control messages, and an end. That
  keeps a later move to WebTransport a transport swap.

Rough size: half a day for the design, with the implementation inside
feature 4. It touches `server.go`, a new stream session in the Engine, a new
stream class in `engine-client`, and `worker-protocol.ts`. Use transferable
`ArrayBuffer`s across the Worker boundary to avoid copying log chunks.

### Tier 3: what would justify a larger change

**The candidate is Protobuf with Buf as the schema source, on the current
WebSocket and envelope.** It is not Connect as a transport, for the reasons in
the summary.

It would give one schema that generates both sides, including service
definitions that replace the method map, and `buf breaking` to detect
incompatible changes against a Git branch
([Buf breaking](https://buf.build/docs/breaking/)). Those matter when an
Engine must serve UIs of other builds: a shared or remote Engine once ADR-0007
gets real authentication, or third-party clients.

The strongest argument against it today:

- UI and Engine ship as one build in both Hosts, so an exact-match check
  (step 1b) covers skew completely. Breaking-change detection has nothing to
  protect.
- The largest payloads are opaque to any schema: Manifests, Table cells, and
  settings (`protocol.go:271`, `307`, `319`). In Protobuf they become
  `google.protobuf.Struct`, `Value`, or bytes, and the Engine loses the
  ability to pass the API server's JSON through untouched
  (`ResourceData.Object` is a `json.RawMessage`).
- The Engine uses the protocol types internally, for example `query.Run`
  returns a `protocol.QueryResult` (`topics.go:95`). Generated message types
  would either spread through the Engine or need a mapping layer.
- ProtoJSON changes the wire shape: 64-bit integers become strings and fields
  holding default values are omitted
  ([ProtoJSON](https://protobuf.dev/programming-guides/json/)).
- It adds the Buf CLI and two plugins to a build that today needs one pinned
  Go tool.

If the trigger arrives, this migration is mechanical and step 1a makes it
easier, because the registry already names every method and its types. It
would revise the consequence in ADR-0002 that TypeScript types come from Go
definitions.

### What to leave alone

- **The WebSocket transport and one socket per stream (ADR-0004).** Its
  rejection of gRPC and Connect is still correct. Chromium allows 255
  WebSockets per host group
  ([client_socket_pool_manager.cc](https://github.com/chromium/chromium/blob/main/net/socket/client_socket_pool_manager.cc)),
  so a per-stream socket has room.
- **JSON on the control socket.** The Cluster sends JSON, the Engine forwards
  Manifests without re-encoding, deduplication compares JSON bytes, and frames
  stay readable. Stream payloads are raw bytes and need no encoding.
- **The envelope's shape.** Renaming it to JSON-RPC 2.0 buys a spec for the
  part that already works. The spec covers no streaming, subscriptions, or
  cancellation ([JSON-RPC 2.0](https://www.jsonrpc.org/specification)), so
  every extension would still be ours.
- **tygo.** It is one maintainer's tool with its last release in February
  2026, but it runs only at development time and its output is committed, so
  the worst case is replacing it. coder/guts 1.7.1 is the fallback, and the
  generator from step 1a could grow to cover types if needed.
- **WebTransport.** It became available in all major browsers in March 2026
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)), and
  it is the only option that removes head-of-line blocking without extra
  sockets. It needs HTTP/3 and a certificate on loopback, and Go's own HTTP/3
  is on hold. Revisit it if socket-per-stream becomes a measured limit.
- **Blanket runtime validation of wire messages.** With generated types and
  the check from step 1b, both ends are the same build. Validating every
  message at 10 Hz in the Worker would cost CPU to guard a case that step 1b
  already excludes.
- **The Worker envelope (W10).** It is small and typed at its public edge.
  Revisit it when the stream class adds messages to it.

## Open questions for Jim

1. Will an Engine ever serve a UI it did not ship with, such as a shared
   Engine for a team or a published client API? If yes within a year, weigh
   Tier 3 now. If no, step 1b is enough.
2. Is an exact protocol-hash match acceptable during development, where
   editing `protocol.go` makes a running Engine refuse the UI until it is
   rebuilt? I think that is the right signal, but it changes the
   `dev:engine` and `dev:ui` loop.
3. Should a Changeset apply be one request per Resource? That keeps each
   message under the 4 MiB limit (W11) and gives each Resource its own
   result, which matches "not atomic across Resources" in `CONTEXT.md`.
4. What should the UI show when a mutation's connection drops before the
   result arrives? Options are to make every mutation safe to repeat, or to
   let the client ask for the outcome by request ID after it reconnects.
5. Do Log Streams need to resume after a reconnect without a gap, or is
   restarting from a timestamp with a gap marker enough?
6. Is Firefox or Safari a supported browser for the web Host? The build
   targets `chrome130`. The answer changes how much weight WebTransport and
   `WebSocketStream` deserve later.

## Appendix A: versions checked on 2026-10-13

Release tags and dates come from each repository's latest GitHub release.
npm versions come from the npm registry.

| Project                                                                   | Latest version | Released   | Note                                                       |
| ------------------------------------------------------------------------- | -------------- | ---------- | ---------------------------------------------------------- |
| [coder/websocket](https://github.com/coder/websocket)                     | v1.8.15        | 2026-06-15 | In use                                                     |
| [gzuidhof/tygo](https://github.com/gzuidhof/tygo)                         | v0.2.21        | 2026-02-03 | In use; no commits since; 20 open issues and pull requests |
| [coder/guts](https://github.com/coder/guts)                               | v1.7.1         | 2026-06-03 | Go-to-TypeScript library used by Coder                     |
| [connectrpc/connect-go](https://github.com/connectrpc/connect-go)         | v2.0.0         | 2026-10-07 | New major API; v1.21.0 (2026-09-08) stays supported        |
| [connectrpc/connect-es](https://github.com/connectrpc/connect-es)         | v2.2.0         | 2026-09-07 |                                                            |
| [bufbuild/buf](https://github.com/bufbuild/buf)                           | v1.73.0        | 2026-09-11 |                                                            |
| [bufbuild/protobuf-es](https://github.com/bufbuild/protobuf-es)           | v2.16.0        | 2026-09-29 |                                                            |
| [grpc/grpc-web](https://github.com/grpc/grpc-web)                         | 2.1.1          | 2026-08-27 |                                                            |
| [sourcegraph/jsonrpc2](https://github.com/sourcegraph/jsonrpc2)           | v0.2.3         | 2026-09-10 | Has a WebSocket stream adapter; no batch support           |
| [golang.org/x/exp/jsonrpc2](https://pkg.go.dev/golang.org/x/exp/jsonrpc2) | untagged       | 2026-10-11 | "a minimal implementation"; experimental module            |
| [vscode-jsonrpc](https://www.npmjs.com/package/vscode-jsonrpc)            | 9.0.3          | 2026-09-25 |                                                            |
| [json-rpc-2.0](https://www.npmjs.com/package/json-rpc-2.0)                | 1.8.1          | 2026-09-20 |                                                            |
| [OpenRPC specification](https://github.com/open-rpc/spec)                 | 1.4.1          | 2026-02-25 |                                                            |
| [AsyncAPI specification](https://github.com/asyncapi/spec)                | 3.1.0          | 2026-01-31 |                                                            |
| [asyncapi/modelina](https://github.com/asyncapi/modelina)                 | 5.10.1         | 2025-10-19 | Generates data models                                      |
| [TypeSpec](https://github.com/microsoft/typespec)                         | 1.17.0         | 2026-10-08 | `@typespec/protobuf` is 0.87.0                             |
| [OpenAPI specification](https://github.com/OAI/OpenAPI-Specification)     | 3.2.1          | 2026-09-10 |                                                            |
| [enisdenjo/graphql-ws](https://github.com/enisdenjo/graphql-ws)           | v6.3.0         | 2026-09-24 |                                                            |
| [99designs/gqlgen](https://github.com/99designs/gqlgen)                   | v0.17.95       | 2026-09-01 |                                                            |
| [quic-go/webtransport-go](https://github.com/quic-go/webtransport-go)     | v0.13.0        | 2026-08-30 | Implements draft-16 of the protocol                        |
| [zod](https://github.com/colinhacks/zod)                                  | v4.6.7         | 2026-10-12 |                                                            |
| [valibot](https://github.com/fabian-hiller/valibot)                       | v1.5.0         | 2026-09-09 |                                                            |
| [ajv](https://github.com/ajv-validator/ajv)                               | v8.20.0        | 2026-04-24 |                                                            |
| [google/jsonschema-go](https://github.com/google/jsonschema-go)           | v0.4.3         | 2026-04-27 | Go types to JSON Schema                                    |
| [invopop/jsonschema](https://github.com/invopop/jsonschema)               | v0.14.0        | 2026-04-23 | Go types to JSON Schema                                    |
| [fxamacker/cbor](https://github.com/fxamacker/cbor)                       | v2.9.6         | 2026-10-06 | v2.9.1 is already an indirect dependency (`engine/go.mod`) |
| [cbor-x](https://www.npmjs.com/package/cbor-x)                            | 1.6.6          | 2026-08-25 |                                                            |
| [vmihailenco/msgpack](https://github.com/vmihailenco/msgpack)             | v5.4.1         | 2023-10-26 | No push since 2024-06                                      |
| [@msgpack/msgpack](https://github.com/msgpack/msgpack-javascript)         | v3.1.3         | 2025-12-26 |                                                            |
| [kubernetes-sigs/headlamp](https://github.com/kubernetes-sigs/headlamp)   | v0.45.0        | 2026-08-20 |                                                            |
| [kubernetes/dashboard](https://github.com/kubernetes/dashboard)           | 7.14.0         | 2025-10-30 | Repository archived                                        |

## Appendix B: notes on each option

### JSON-RPC 2.0 on the same socket

The specification defines a request (`jsonrpc`, `method`, `params`, `id`), a
response (`result` or `error`, `id`), a notification, and an error object with
`code`, `message`, and optional `data`. It defines no streaming,
subscriptions, cancellation, or transport
([JSON-RPC 2.0](https://www.jsonrpc.org/specification), last updated
2013-01-04).

Mapped onto hukube, `subscribe`, `update`, and `unsubscribe` become methods,
and `data` becomes a notification that carries a subscription ID. That is the
current envelope with different field names. I infer the libraries would
replace little: the latest-wins outbox must sit between the topic and the
socket, so the session logic stays ours. OpenRPC describes methods and their
results, and I found no place in it for server-pushed data.

What is worth taking from this family costs nothing: an error `data` field
(step 1e), a cancel message as in LSP, and a first-message handshake as in
LSP and MCP, where the client and server exchange versions and the client
"SHOULD disconnect" when they cannot agree
([MCP lifecycle](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/basic/lifecycle.mdx)).

### Connect RPC and gRPC-Web

- Connect's protocol supports every streaming type, but "Bidirectional
  streaming requires HTTP/2"
  ([protocol](https://connectrpc.com/docs/protocol)), and in browsers "you can
  use streaming from the browser, but only server streaming", because browser
  vendors have not agreed to support streaming request bodies
  ([Connect for Web](https://connectrpc.com/docs/web/getting-started/)).
- Chromium can stream a request body since version 105, but only as half
  duplex, "the response never becomes available until the request body has
  been fully sent", and "the fetch will be rejected if the connection is
  HTTP/1.x"
  ([Chrome: streaming requests](https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests)).
- gRPC-Web supports unary and server-streaming calls. "Client-side and
  Bi-directional streaming is not currently supported"
  ([README](https://github.com/grpc/grpc-web/blob/master/README.md)).
- The Engine serves cleartext HTTP/1.1, and "currently no browser supports
  HTTP/2 unencrypted" ([HTTP/2 FAQ](https://http2.github.io/faq/)). A browser
  holds at most six HTTP/1.1 connections per host
  ([MDN: EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)).
  I infer that each server-streaming call would hold one of those six, so a
  Workspace with a few Panes would exhaust them. Avoiding that means TLS on
  loopback, or one shared stream that multiplexes every subscription, which
  rebuilds the control socket on a transport that cannot send upstream.
- Param updates would need a second, unary call correlated with the stream, or
  cancelling and reopening the stream on every scroll.
- The desktop UI's origin is the `hukube://app` scheme and the Engine is
  `http://127.0.0.1:<port>` (`apps/desktop/src/main.ts:26`, `94`). I infer
  that Connect calls would be cross-origin requests that need CORS handling
  and a second way to carry the token.
- Connect's own advice on streaming is "Temper your enthusiasm": streams make
  "cURL and your browser's network inspector" useless
  ([streaming](https://connectrpc.com/docs/go/streaming/)).
- connect-go 2.0.0 was released on 2026-10-07 with a reshaped Go API. The wire
  protocol is unchanged
  ([release notes](https://github.com/connectrpc/connect-go/releases/tag/v2.0.0)).

Adopting Connect would contradict nothing in the ADRs for unary calls, but it
would leave the WebSocket in place for Exec Sessions, so the Engine would have
two transports.

### Describing the protocol: AsyncAPI, JSON Schema, TypeSpec, OpenAPI

- AsyncAPI 3.1 can describe channels, messages, a request and reply operation,
  and WebSocket bindings
  ([specification](https://github.com/asyncapi/spec/blob/v3.1.0/spec/asyncapi.md)).
  Its Modelina generator produces data models from AsyncAPI, JSON Schema, or
  OpenAPI input
  ([README](https://github.com/asyncapi/modelina/blob/master/README.md)). I
  found no generator that produces typed Go handlers and a TypeScript client
  for a custom envelope like ours.
- TypeSpec's repository has emitters for JSON Schema, OpenAPI 3, and Protobuf,
  client emitters for C#, Java, JavaScript, and Python, and server emitters
  for C# and JavaScript. It has none for Go
  ([packages](https://github.com/microsoft/typespec/tree/main/packages)). A
  TypeSpec source would need a chain through JSON Schema or Protobuf to reach
  Go.
- OpenAPI fits only the request and response part, which is two methods today.
  Moving requests to HTTP would create a second transport and a second
  authentication path.
- JSON Schema is useful as an output, not as a source. `google/jsonschema-go`
  or `invopop/jsonschema` can derive schemas from the Go types if a later
  need arises, such as validating fixtures or publishing the contract.

### GraphQL subscriptions and SSE

- In the `graphql-transport-ws` protocol, a `Subscribe` message carries fixed
  `variables`, and a second `Subscribe` with the same ID closes the socket
  with code 4409
  ([PROTOCOL.md](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md)).
  There is no message that changes a live subscription's variables. Updating
  a window would mean completing the subscription and starting another.
- `EventSource` is available in Workers but is limited to six connections per
  browser and host without HTTP/2
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)). It
  is one-way and text-only, so Exec Sessions would still need a WebSocket.

### WebTransport

- Browser support: Chrome 97, Firefox 114, Safari 26.4. MDN marks it "Baseline
  2026", newly available since March 2026, and available in Web Workers
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport),
  [browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/WebTransport.json)).
  The specification is a W3C Candidate Recommendation Snapshot dated
  2026-07-30 ([W3C](https://www.w3.org/TR/webtransport/)).
- It requires HTTPS. For a host without a publicly trusted certificate, the
  page passes `serverCertificateHashes`, and the certificate's validity
  period "MUST NOT exceed two weeks"
  ([MDN: constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport),
  [W3C](https://www.w3.org/TR/webtransport/)). The Engine would generate a
  certificate per launch and hand its hash to the UI beside the token.
- In Go the implementation is webtransport-go 0.13.0, which follows draft-16
  of the protocol and is pre-1.0
  ([README](https://github.com/quic-go/webtransport-go)). The proposal to add
  HTTP/3 to Go's `x/net` is open and labelled `Proposal-Hold`
  ([golang/go#70914](https://github.com/golang/go/issues/70914)), and the Go
  1.27 release notes do not mention HTTP/3.
- I infer that development through the Vite proxy and through a tailnet name
  (`apps/app/vite.config.ts:28`) would need an HTTP/3 path or a WebSocket
  fallback, so both transports would have to be maintained.

Adopting it would mean revisiting ADR-0004 (transport) and ADR-0007 (the
loopback token model gains TLS).

### Wire encodings

- Protobuf's binary form needs the schema work of Tier 3. CBOR and MessagePack
  keep the Go types but make frames unreadable in DevTools.
- The Engine's largest values are Manifests that arrive from the API server as
  JSON and are forwarded as `json.RawMessage` (`protocol.go:305-309`). I
  infer that a binary encoding would force a decode and re-encode of each, or
  an embedded JSON string, which removes most of the gain.
- Log and exec payloads are bytes already. Binary WebSocket frames carry them
  without any encoding library.

### Go-to-TypeScript generators and validators

- tygo and coder/guts both generate TypeScript types from Go types. Neither
  generates a method map, which is why step 1a needs a small generator of its
  own.
- Schema-first generation of both sides means Protobuf (Tier 3) or a chain
  from TypeSpec or JSON Schema. The chain has more moving parts than tygo and
  no better result for this codebase.
- zod and valibot validate at run time from schemas written in TypeScript.
  They fit step 1d, where the value's shape is owned by the UI. For wire
  types they would be a second definition of what tygo already generates.

## Appendix C: how each ADR bears on the options

| ADR                             | Constraint                                                 | Effect                                                                                        |
| ------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0002: Go Engine, own process    | Every UI is a client over one protocol; types come from Go | Tier 1 strengthens it. Tier 3 would change "generated from Go definitions".                   |
| 0003: Engine owns Cluster state | Subscriptions are scoped to what is on screen              | Rules out protocols that ship whole lists. Its "patches" wording differs from the code (W12). |
| 0004: WebSocket, own sockets    | Control socket plus one socket per stream; gap markers     | Tier 2 implements it. Connect, SSE, and WebTransport would each require revisiting it.        |
| 0007: web Host from day one     | Browser is a first-class Host; loopback and token for now  | Rules out anything Electron-only. TLS-requiring transports change the token model.            |
| 0009: Engine-owned persistence  | Settings live in the Engine and outlive UI builds          | Motivates step 1d.                                                                            |

## Appendix D: what I could not verify

- **Whether a slow Worker produces TCP backpressure on a WebSocket.** The
  flow-control recommendation in Tier 2 rests on an inference about browser
  buffering. It needs a measurement.
- **Whether DevTools shows frames of a WebSocket opened in a Worker** in the
  same way as a page's. I did not test it, so the "readable frames" benefit
  is confirmed only for the encoding, not for the tooling.
- **Chrome's Local Network Access rules for the desktop Host.** Chrome gates
  requests "from the public network to a local network or loopback
  destination" behind a permission from Chrome 142, and planned to extend
  this to WebSockets and WebTransport
  ([Chrome blog](https://developer.chrome.com/blog/local-network-access)).
  I could not determine how Chromium classifies a page on the `hukube://`
  scheme, or whether Electron applies the prompt. This affects the current
  design as much as any alternative.
- **`encoding/json/v2` with tygo and `json.RawMessage`.** I confirmed the v2
  defaults from its documentation, not by running it against this code.
- **The six-connection inference for Connect.** The limit is documented for
  SSE. I infer it applies to a `fetch` response stream on HTTP/1.1 because
  both hold a connection open, but I did not test Connect in a browser
  against a cleartext server.
- **Sizes.** Every estimate is my judgement from reading the code. None is
  measured.
- **No generator for this envelope from AsyncAPI.** I checked the
  specification and Modelina, not every community template.
- I did not run the Engine, the UI, or any test, as instructed.
