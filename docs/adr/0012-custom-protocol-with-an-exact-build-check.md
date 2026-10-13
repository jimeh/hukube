# The protocol stays custom, and a UI only talks to an Engine of its own build

The UI-to-Engine protocol keeps its foundations: the WebSocket transport
(ADR-0004), JSON, its own envelope, and TypeScript types generated from Go
with tygo (ADR-0002). It is not moved onto Connect, gRPC-Web, JSON-RPC,
GraphQL, Server-Sent Events, WebTransport, or Protocol Buffers.

A UI and an Engine must be of the same build to talk. The Engine sends a
`hello` message holding a hash of the protocol first on every control socket.
A UI whose own hash differs, or that gets no `hello`, stops using the
connection, does not reconnect, and tells the user it is out of date. There
are no compatibility rules between versions.

The evidence is in `docs/research/engine-protocol-tooling.md`.

## Why the protocol stays custom

- **No standard option expresses the control socket's main primitive.** A
  subscription delivers the latest value, its params change in place, and
  the Engine coalesces and deduplicates what it sends. JSON-RPC, Connect,
  gRPC-Web, GraphQL subscriptions, and Server-Sent Events would each need
  that same pattern built on top.
- **The schema-first RPC options cannot carry an Exec Session in a browser.**
  Connect and gRPC-Web offer browsers server streaming only, which is the
  reason ADR-0004 rejected them. The Engine also serves cleartext HTTP/1.1,
  where a browser allows six connections per host, so one HTTP stream per
  subscription does not fit.
- **The weaknesses were local.** A method's types were stated by hand in
  three places, nothing detected a UI and an Engine of different builds, and
  a value did not say which params it answered. Each had a small fix that
  needed no new foundation.

## Why an exact match

An Engine does not serve a UI it did not ship with. The desktop Host packages
the Engine it starts, and the web Host's UI is served by the Engine. The two
can only differ when a browser tab stays open across an Engine upgrade, or
during development. With one release train there is nothing for
compatibility rules to protect, and an exact check needs none. VS Code's
remote server refuses a client of another commit for the same reason.

## What the hash covers

The hash is a SHA-256 over the Go tokens of the `engine/internal/protocol`
package, leaving out tests, generated files, and comments. A generator writes
it as a Go constant, and tygo copies that constant into the generated
TypeScript, so nobody has to remember to change a version.

The package is hashed because it is the definition: the envelope, every type,
enum value, and JSON tag, and every method with its params and result types.
Tokens are hashed instead of bytes so that rewording a comment does not make
a running Engine refuse its UI. A build identifier such as a commit was
rejected because two builds of one commit with uncommitted changes would
match, and every rebuild in development would mismatch without cause.

## Considered Options

- **Protocol Buffers with Buf as the schema, on the current transport.** One
  schema would generate both sides and `buf breaking` would detect
  incompatible changes. It pays when an Engine must serve UIs of other
  builds, which nothing planned requires. It would also turn Manifests,
  Table cells, and settings into opaque values and add a second toolchain.
- **Checking the build in the WebSocket handshake,** by putting the hash in
  the subprotocol. A browser tells a page nothing about why a handshake
  failed, so a refused build would look the same as an Engine that is not
  running, and the UI could not say what to do.
- **Negotiating a version, as the Docker Engine API does.** That is the cost
  of independent release trains, which hukube does not have.

## Consequences

- Each method is declared once in the protocol package with its types. The
  Engine's handlers are typed against the declarations, and the TypeScript
  method map is generated from them.
- A browser tab that outlives an Engine upgrade shows a notice and is fixed
  by reloading, which fetches the UI the new Engine serves. A desktop window
  in that state is fixed by restarting the app.
- In development, a running Engine refuses a UI built after a change to the
  protocol until the Engine is rebuilt. This is intended: the notice is the
  reminder.
- The check does not see a change in the Engine's behavior that leaves the
  package unchanged, such as a handler that answers the same params
  differently. A tab that stays open across such an upgrade keeps running.
- The hash does not cover types from other packages, so the protocol package
  imports only the standard library, and the generator enforces that.
- If an Engine must one day serve UIs of other builds, such as a shared or
  remote Engine, this decision is revisited. Protocol Buffers with Buf is
  the candidate, and the method registry already names what a schema would
  hold.
