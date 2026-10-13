# A stream has its own socket, an end, and flow control by acknowledgement

ADR-0004 gives each high-volume stream its own WebSocket and a bounded buffer
in the Engine that drops data and sends a gap marker. This records how that
socket works. Log Streams use it now, and it is shaped so that an Exec Session
fits later without rework.

A stream socket is `GET /ws/stream` with the subprotocol `hukube.stream.v1`.
It passes the same Host, Origin, and token checks as the control socket, and
the Engine sends the same `hello` with the protocol hash first (ADR-0012). The
client then sends one `open` message naming a stream method and its params.
Stream methods are declared in the registry beside requests and topics, so
their params and event types are generated like the others. A stream's params
never change: a different selection is a new stream.

Text frames carry JSON control messages and are never dropped. Binary frames
carry data. Their first byte is a channel, numbered as Kubernetes numbers its
exec channels (0 stdin, 1 stdout, 2 stderr), and the rest is defined by the
method.

## Flow control

The client acknowledges what it has consumed, and the Engine sends data only
while less than 1 MiB is unacknowledged. Data that waits beyond that sits in
the Engine's queue for the stream, which holds at most 4 MiB. When the queue
is full the oldest frames are dropped and replaced by one `gap` message, in
their place in the order, that counts the bytes and records dropped. The
producer of a stream never waits.

"Consumed" means the main thread's listener has returned, not that the Worker
received the frame. The Worker relays each acknowledgement to the socket.

This was measured, not assumed (`docs/plans/log-streams.md`, Flow control).
TCP backpressure cannot be the mechanism:

- In Chromium a slow handler holds the sender back only when it runs on the
  thread that owns the socket. hukube's sockets live in a Worker that relays
  to the main thread (ADR-0004), and in that arrangement the sender wrote
  3.1 GiB in 9 seconds while the consumer took 32 MiB.
- In WebKit a slow handler never held the sender back, on either thread.
- With a 1 MiB acknowledged window, both browsers held at most 1.0 MiB in
  transit and the sender dropped the rest.

## A stream ends, a subscription does not

The Engine's last message on a stream is `end`, with a reason: `complete`,
`deleted`, or `error` with an error detail. It then closes the socket. A
socket that closes without `end` was lost, and the client opens the stream
again. An `end` is final, and the client does not reconnect.

The control protocol gets no such message. A subscription is a view of
current state: it answers again whenever the state changes, a Resource that
is deleted is a value, and an error is a value that a later one replaces.
Nothing a topic serves has a last element. Anything that does is a stream.

## The UI caps concurrent stream sockets

A window runs at most 8 stream sockets. A stream opened beyond that waits,
first come first served, and its state says so. Chromium allows 255
WebSockets per host (`docs/research/engine-protocol-tooling.md`), so the cap
is well inside the browser's. It bounds what one window can ask of the Engine
and the Cluster, because one Log Stream can hold dozens of requests to the
API server. A Log Stream closes its socket while
its Facet is hidden, so in practice the cap counts what is on screen.

## How an Exec Session fits

Nothing below is built. It is here to show the socket does not need to change.

- **Input** is binary frames from the client on channel 0. Output is channels
  1 and 2, as the Engine receives them from the Cluster.
- **Resize** is a client text message. An **exit status** is a field of `end`
  with the reason `complete`. Closing stdin is a client text message.
- **Flow control toward the client** uses the same acknowledgements. A
  terminal cannot lose bytes in the middle of an escape sequence, so an Exec
  Session will stop reading the container's output while the window is
  closed, which is what a slow terminal does to a process. That holds back
  one process, not the Engine. The queue offers dropping, which Log Streams
  use, and the gap marker stays available.
- **Flow control toward the Engine** is TCP's: the Engine is the reader, and
  a browser exposes `bufferedAmount` to a client that sends too fast.
- **Data reaches the main thread** as transferred buffers, which a terminal
  emulator takes as they are. A Log Stream's frames are parsed in the Worker
  instead, as ADR-0004 requires, and reach the main thread as lines.

## Considered Options

- **Rely on TCP backpressure,** as the research proposed to test. The
  measurements above rule it out.
- **`WebSocketStream`,** which has backpressure built in. It is in Chromium
  only and on no standards track.
- **Pause and resume messages from the client** instead of a byte window. The
  Engine would keep sending between the moment the client falls behind and
  the moment its message arrives, so memory in the browser has no bound.
- **Keep a stream alive in the Engine across a lost socket** and replay from
  a sequence number. An Engine restart loses that state anyway, so the client
  must be able to resume from what it holds. One mechanism covers both.
- **An `end` or `done` on the control protocol too.** See above: nothing
  there ends.

## Consequences

- A slow UI costs the Engine at most the queue, and the browser at most the
  window, per stream. What the user loses is shown as a gap.
- The stream abstraction in `packages/engine-client` exposes states, events,
  data, gaps, and an end. It exposes nothing of WebSockets, so another
  transport could replace them.
- Each stream method has a codec in the Worker that turns frames into what
  the main thread receives and holds what is needed to resume.
- A stream socket is one more route for anything that proxies the Engine. The
  development server's `/ws` proxy rule already covers `/ws/stream`.
