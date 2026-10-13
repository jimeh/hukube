# Plan: Log Streams, the stream socket, and the Logs Facet

Status: implemented, not merged yet. "What changed while building" lists where
the result differs from the text below.

## Outcome

After this work:

- A Pod's tab has a Logs Facet that tails its containers live. The user picks
  a container or reads them all, and can show the previous run of a container
  that restarted.
- A workload's Logs Facet shows the lines of the Pods it owns in one view,
  each marked with its Pod, and follows the workload as Pods are replaced.
  This holds for any Resource that owns Pods, including custom workload
  types.
- The view stays at the newest line while the user is at the bottom, stops
  when they scroll up or select text, and offers a way back. Timestamps and
  line wrapping can be turned on and off. The loaded lines can be searched,
  selected, and copied.
- Each Log Stream has its own socket (ADR-0004), with a bounded buffer in the
  Engine, a gap marker when lines are dropped, and an end with a reason. The
  socket is designed so that an Exec Session fits.

It does not build Exec Sessions, a dock for logs, downloading, filtering by
level, or selecting a Log Stream with a Query.

Three decisions are recorded as ADRs: the stream socket (ADR-0016), how a Log
Stream reads the Cluster (ADR-0017), and the viewer (ADR-0018).

## Current state

From the code at `0942a73`:

- The Engine serves `GET /healthz`, `GET /ws`, and the UI
  (`engine/internal/server/server.go`). `/ws` is the control socket. Every
  frame on it is JSON text. A subscription keeps only its latest unsent
  value (`outbox.go`), and the Engine has no message that ends one.
- Methods are declared once in `engine/internal/protocol/methods.go` as a
  `Request` or a `Topic`, and `mise run gen` writes the TypeScript method
  map and the protocol hash from them.
- The index holds metadata only. `Cluster.WatchObject` follows the full
  manifest of one Resource. `Cluster.Graph` answers what a Resource owns
  (`AllOwned`) and signals when that may have changed (`Changed`).
- The client runs one `EngineConnection` in a Web Worker
  (`packages/engine-client/src/worker.ts`). `WorkerEngineClient` relays
  requests and subscriptions across the Worker boundary. Nothing handles
  binary frames.
- A Resource tab shows one Facet from the registry in
  `apps/app/src/features/resource/facets.ts`. A Facet may place controls in
  the switcher row, and gets `showing`, which is true while it is the
  selected Facet. Nothing tells a Facet whether its tab is in front.
- `yaml-editor.tsx` loads Monaco on demand from `monaco-editor/editor/editor.api`,
  which has no find, clipboard, or icon-font feature.
- The sample workloads run a pause image and print nothing.

## Evidence from research

### Flow control

The research proposed relying on TCP backpressure and inferred that a browser
may never produce it. Measured on 2026-10-13 with a Go source (coder/websocket
v1.8.15) writing 16 KiB binary frames as fast as the socket accepts on
loopback, and a consumer that busy-waits 5 ms a frame, so it can take about
3.3 MiB a second. Browsers are Playwright 1.63.0 builds on macOS 27.0.1,
Apple silicon. "In transit" is what the source wrote minus what the
consumer's handler finished with.

Without acknowledgements:

| Browser      | Where the slow handler runs                           | Source ran | Sent     | Consumed | In transit at the end | Browser memory                                          |
| ------------ | ----------------------------------------------------- | ---------- | -------- | -------- | --------------------- | ------------------------------------------------------- |
| Chromium 153 | no delay, baseline                                    | 5 s        | 1873 MiB | 1873 MiB | 0.1 MiB               | not meaningful                                          |
| Chromium 153 | the main thread, which owns the socket                | 10 s       | 33 MiB   | 33 MiB   | 2.1 MiB at most       | +59 MiB                                                 |
| Chromium 153 | a Worker, which owns the socket                       | 10 s       | 33 MiB   | 33 MiB   | 2.1 MiB at most       | +61 MiB                                                 |
| Chromium 153 | the main thread, fed by a Worker that owns the socket | 9 s        | 3123 MiB | 32 MiB   | 3091 MiB              | +4185 MiB at its peak                                   |
| WebKit 26.6  | the main thread, which owns the socket                | 5 s        | 2893 MiB | 13 MiB   | 2880 MiB              | not captured                                            |
| WebKit 26.6  | a Worker, which owns the socket                       | 5 s        | 3027 MiB | 16 MiB   | 3011 MiB              | +1370 MiB after 1338 MiB, then the page stopped reading |
| WebKit 26.6  | the main thread, fed by a Worker                      | 5 s        | 2953 MiB | 14 MiB   | 2939 MiB              | not captured                                            |

With the source sending only while less than 1 MiB is unacknowledged, and
dropping the rest:

| Browser      | Where the slow handler runs      | Source ran | Sent     | Consumed | In transit, most | Browser memory | Dropped at the source |
| ------------ | -------------------------------- | ---------- | -------- | -------- | ---------------- | -------------- | --------------------- |
| Chromium 153 | the main thread, fed by a Worker | 10 s       | 32.1 MiB | 32.1 MiB | 1.0 MiB          | +66 MiB        | 1402 MiB              |
| WebKit 26.6  | a Worker, which owns the socket  | 5 s        | 16.5 MiB | 16.5 MiB | 1.0 MiB          | +20 MiB        | 724 MiB               |
| WebKit 26.6  | the main thread, fed by a Worker | 5 s        | 16.5 MiB | 16.5 MiB | 1.0 MiB          | +28 MiB        | 742 MiB               |

What this shows:

- Chromium holds a sender back only when the slow code runs on the thread
  that owns the socket. The Worker that ADR-0004 requires relays to the main
  thread, where rendering is the slow part, so the Engine would never see
  it.
- WebKit never holds a sender back.
- An acknowledged window bounds the data in transit in both.

Firefox was not measured. Playwright's Firefox build 1543 does not start on
macOS 27.0.1 ("Could not find profile folder"), and no Firefox is installed
on the machine. The design does not depend on its answer.

### What the Pod log API does

Observed on the k3d test cluster (k3s v1.35.5, containerd 2.2.3) with kubectl
1.37.1 and client-go v0.37.1, and read from Kubernetes v1.37.1 source. The
log reader is unchanged between the two versions.

- **A request names one container** and passes through the API server to the
  node's kubelet, which reads the container's log file. An error before the
  kubelet starts writing is an API `Status`. An error after that is plain
  text inside a `200` response.
- **`timestamps`** prefixes each line with an RFC 3339 timestamp with nine
  fractional digits, in whatever zone the runtime wrote, and one space.
- **`sinceTime` is inclusive and has whole-second precision.** client-go
  sends whole seconds and the API server truncates again. Resuming from the
  second of the last line gave 7 repeated lines and no loss. Rounding up
  lost 3 lines.
- **Timestamps were unique and increasing** over 1,204 lines of one stream.
  They are not guaranteed to be: standard output and standard error are
  stamped by separate goroutines.
- **`tailLines` and reads without `follow` see the current log file only.**
  After a rotation, a Pod with 1.2 million lines on disk returned an empty
  `200`.
- **A clean end of a follow is ambiguous.** A container exit, a Pod deletion
  (2 to 7 seconds after the delete), and an unscheduled Pod (`204`, empty)
  all end the same way. From source, so do a kubelet restart and the
  kubelet's four-hour write limit.
- **A follow never continues into a restarted container.** While a container
  waits in `CrashLoopBackOff`, a follow returns its whole last log and ends
  at once.
- **A reader that falls behind a rotation loses lines and then hangs.** A Pod
  wrote 4 million lines in 10 seconds and 40 more later. Two followers that
  started at the first line received exactly the first rotated file, then
  nothing, with no error, until the Pod was deleted. A follower that kept up
  crossed 6 rotations with no loss. One follow carries about 100,000 lines a
  second (10 MiB) here.
- **A long line arrives whole.** A 1 MiB line is 64 entries in the log file
  and one line with one timestamp in the response.
- **Bytes pass through unchanged,** except that `\r\n` becomes `\n`: ANSI
  escapes, a lone `\r`, NUL, and invalid UTF-8 arrive as written. A final
  line with no newline arrives without one.
- **Waiting states are all `400 BadRequest`** and differ only in message
  text: `is waiting to start: ContainerCreating`, `PodInitializing`,
  `image can't be pulled`, `trying and failing to pull image`,
  `is not available`. `previous` with no earlier run is also a `400`.
- **Missing permission is `403 Forbidden`,** even for a Pod that does not
  exist.
- **Errors inside a `200`** are one line with no timestamp and no newline,
  such as `unable to retrieve container logs for containerd://...` and
  `failed to try resolving symlinks in path ...`.
- **Standard output and standard error cannot be separated.** The `stream`
  option is behind `PodLogsQuerySplitStreams`, alpha and off in 1.35 and
  1.37.
- **`rest.Config.Timeout` ends a follow** at that duration. The client's
  rate limit applies once per request, when it opens.
- **kubectl** fixes its Pods at startup, reads one Pod for `deployment/x`,
  tails 10 lines with a selector, and refuses more than 5 follows. **stern**
  watches Pods, starts a tail for each new container ID, allows 50, and
  resumes with `sinceTime` and a count of lines to skip.

### Viewer

Three approaches were built in a harness and measured in headless Chromium
153 on an M3 Max, with lines of about 154 characters, 10% of them colored.
WebKit 26.6 ran the same pages.

|                                                       | Virtual list and `anser` | xterm.js 6.0.0 | Monaco 0.57.0                     |
| ----------------------------------------------------- | ------------------------ | -------------- | --------------------------------- |
| Memory at 50,000 lines                                | 12 MB                    | 183 to 313 MB  | 29 to 43 MB                       |
| Memory at 100,000 lines                               | 23 MB                    | 364 to 626 MB  | 56 to 84 MB                       |
| Append 100,000 lines in batches of 500                | 222 ms                   | 853 ms         | 706 to 805 ms                     |
| Longest task at 5,000 lines a second, 50,000-line cap | 3.6 to 4.7 ms            | 1.6 to 2.3 ms  | 4.4 to 11 ms                      |
| The same with the CPU slowed 4 times                  | 15 ms                    | 4 to 12 ms     | 16 to 20 ms, half the main thread |
| Turn timestamps on, 50,000 lines                      | 2 ms                     | 447 ms         | 228 ms as text                    |
| Turn wrapping on, 50,000 lines                        | 2 to 70 ms               | not possible   | 94 to 152 ms                      |
| Select all and copy, 100,000 lines                    | 54 rows, no newlines     | all, 0.8 s     | all, 0.4 s                        |
| A 1 MiB line                                          | 54 ms                    | 23 ms          | 12 to 18 ms                       |

Other findings the design uses:

- No ANSI parser tested (`anser`, `ansi_up`, `fancy-ansi`,
  `ansi-sequence-parser`) removes every sequence that is not a color.
- Monaco: `model.applyEdits` works on a read-only editor and
  `editor.executeEdits` does not. The view moves when lines above it are
  deleted, and subtracting the removed height, measured with
  `getTopForLineNumber`, holds it. A decoration costs about 320 bytes. A
  lone `\r` or `\r\n` in inserted text starts a new model line. The find
  widget needs `monaco-editor/features/find/register` and
  `features/codicon/register`, shows `1 of 2500`, hides the count below
  about 380 px, and stops counting at 19,999.
- Comparable tools: Freelens uses a virtual list with `ansi_up`, Headlamp
  uses xterm.js, k9s a text view, and VS Code's Output panel a read-only
  Monaco editor with a scroll lock. Their toolbars share an order: the
  container first, then toggles for previous, timestamps, and wrap, then
  search. Following that stopped shows as a control that changed state or as
  a floating button over the log. Merged lines begin with a colored Pod
  name, as in stern. They tail 100 to 1,000 lines by default.

## Decisions

### The stream socket

ADR-0016 has the reasoning. The contract:

- **Route.** `GET /ws/stream`, subprotocol `hukube.stream.v1` with the token
  subprotocol, and the checks `serveControl` does: Host, Origin, token.
- **Opening.** The Engine sends `hello` first. The client checks the hash and
  sends `open` with a stream method and params. The Engine waits 10 seconds
  for it. An unknown method or params that do not decode end the stream with
  `error` and code `bad_request`.
- **Client messages** (text): `open`, and `ack` with `bytes`, the total
  length of the binary frames consumed so far.
- **Engine messages** (text): `hello`, `event` with a value typed by the
  method, `gap` with `bytes` and `records`, and `end` with a `reason`
  (`complete`, `deleted`, `error`) and an `error` detail for the last.
- **Data** (binary): a channel byte, then a payload the method defines. A
  Log Stream uses channel 1.
- **Queue.** One ordered queue per stream. Text messages are never dropped.
  Data frames in the queue hold at most 4 MiB. Adding a frame that does not
  fit drops the oldest data frames until it does and puts one `gap` where
  the first of them was, or adds to a `gap` already at the front. Adding
  never waits.
- **Window.** The writer sends the queue in order. It sends a data frame
  only while sent minus acknowledged bytes is under 1 MiB. Text behind a
  waiting data frame waits too, so order holds.
- **Ending.** When the method's handler returns, the Engine sends what is
  queued under the same window rule, then `end`, then closes. If nothing is
  acknowledged for 10 seconds, the data left becomes a `gap` and `end`
  follows it. A handler's context ends when the socket closes.
- **Limits.** A write that takes over 10 seconds, or more than 1,024 text
  messages waiting, closes the socket without `end`, and the client opens
  the stream again.
- **Registry.** `protocol.DeclareStream[P, E]` beside `DeclareRequest` and
  `DeclareTopic`, a `handleStream` in the server typed against it, and a
  `Streams` interface in `methods.gen.ts`. The test that every declared
  method has a handler covers streams.

The measured window of 1 MiB allows far more than one follow can carry, so
it never limits a client that keeps up.

### The `resource.logs` stream

```go
// LogStreamParams opens a Log Stream on a Pod, or on the Pods a Resource owns.
type LogStreamParams struct {
	Cluster   string  `json:"cluster"`
	Type      TypeKey `json:"type"`
	Namespace string  `json:"namespace,omitempty"`
	Name      string  `json:"name"`
	// UID is the incarnation to read. The stream ends when it is gone.
	UID string `json:"uid"`
	// Container names the container to read in every Pod. Empty reads all.
	Container string `json:"container,omitempty"`
	// Previous reads the previous run of each container and then ends.
	Previous bool `json:"previous,omitempty"`
	// Resume holds what the client already has, when it opens a stream again.
	Resume []LogCursor `json:"resume,omitempty"`
}

// LogCursor is the newest line a client holds from one container.
type LogCursor struct {
	PodUID    string `json:"podUid"`
	Container string `json:"container"`
	// Instance is the container ID the line came from.
	Instance string `json:"instance"`
	// Time is the line's timestamp in Unix nanoseconds, in decimal.
	Time string `json:"time"`
}

// LogStreamStatus is what a Log Stream reads right now.
type LogStreamStatus struct {
	// Ready reports that the stream has found its Resource and knows the
	// containers of the Pods it reads.
	Ready bool `json:"ready"`
	Sources    []LogSource    `json:"sources"`
	Containers []LogContainer `json:"containers"`
	// Pods counts the Pods the Resource owns, and Followed those being read.
	Pods     int `json:"pods"`
	Followed int `json:"followed"`
}

type LogContainer struct {
	Name string           `json:"name"`
	Kind LogContainerKind `json:"kind"` // container, init, ephemeral
}

type LogSource struct {
	// ID is what a record's source field refers to.
	ID        int    `json:"id"`
	Pod       string `json:"pod"`
	PodUID    string `json:"podUid"`
	Container string `json:"container"`
	// Instance is the container ID being read, empty before the first run.
	Instance string         `json:"instance,omitempty"`
	State    LogSourceState `json:"state"` // waiting, running, terminated
	// Reason and Message come from the container's status.
	Reason   string `json:"reason,omitempty"`
	Message  string `json:"message,omitempty"`
	ExitCode *int32 `json:"exitCode,omitempty"`
	// Previous reports that an earlier run exists.
	Previous bool `json:"previous,omitempty"`
	// Error is set while the container's logs cannot be read.
	Error string `json:"error,omitempty"`
}
```

A data frame is the channel byte and then records, each:

| Field   | Size           | Meaning                                                    |
| ------- | -------------- | ---------------------------------------------------------- |
| source  | 2 bytes        | A `LogSource.ID`                                           |
| flags   | 1 byte         | 1 cut, 2 gap, 4 exited                                     |
| time    | 8 bytes        | Unix nanoseconds, signed, 0 when the line has no timestamp |
| length  | 4 bytes        | Length of the content                                      |
| content | `length` bytes | The line, as the container wrote it                        |

Integers are big-endian. The sizes and flag values are constants in the
protocol package, so the hash covers them. A golden frame in
`engine/internal/protocol/testdata` is written by a Go test and decoded by a
TypeScript test.

- **cut:** the line was longer than 64 KiB and the content is its first
  64 KiB.
- **gap:** no content. Lines from this container may be missing here.
- **exited:** the run that the lines above belong to is over. The content
  is the reason and exit code as text, such as `Error, exit code 1`.

`Sources` lists every container being read. IDs are never reused within one
socket. `Containers` is the union of the container names of the followed
Pods, in the order regular, init, ephemeral, then by name. A status is sent
before the first frame that uses a new ID, and whenever it changes, at most
once every 100 ms. The first status is sent at once, with `ready` false and
nothing else. `ready` turns true when the target has been found and the
manifest of every followed Pod has arrived, or a second has passed. A
status that is ready and has no Pods means the Resource owns none.

### Which Pods

The Pods come from the index and the graph, for every target:

- **A Pod** is its own Pod set.
- **Anything else:** `Graph.AllOwned` of the target, keeping the Pods.
- **The target** is looked up with `Graph.Node`. While its type or the Pod
  type is syncing, or the Cluster is not ready, the stream waits and sends a
  status with no sources. A type in state `forbidden` ends the stream with
  `error` and code `forbidden`. A type in state `failed` ends it with
  `error` and code `internal`.
- **A target that is gone.** The UI learns of a Resource from its own watch
  of the manifest, which can be ahead of the index. Until the index has
  shown the target with `params.UID` once, a missing target or another UID
  means "not yet", and the stream waits up to 10 seconds for it. After that,
  or once it has been seen, a missing target or another UID ends the stream
  with `deleted`.
- **The limit is 20 Pods.** The first set is the 20 newest by creation time,
  then name. A followed Pod stays while it is still owned. A free place goes
  to the newest Pod that is not followed. `Pods` and `Followed` carry the
  counts.
- **Changes.** The set is computed again when `Graph.Changed` signals, at
  most once every 250 ms. A Pod that left is closed, and one that joined is
  opened.

With `Previous`, the set is computed once, when the target is first found.

### Reading a Pod

For each followed Pod the Engine calls `Cluster.WatchObject` and decodes each
manifest as a `corev1.Pod`. A manifest with another UID, or `Deleted`, closes
the Pod's readers. The Pod's containers are every entry of `spec.containers`,
`spec.initContainers`, and `spec.ephemeralContainers`. `params.Container`
keeps the one with that name, and a Pod without it contributes nothing.

Each container has one reader. From its entry `s` in the Pod's status:

- **current(s)** is the instance a log request reads: `s.containerID` when
  `s.state` is running or terminated, otherwise
  `s.lastState.terminated.containerID`, otherwise none.
- **previous(s)** is `s.lastState.terminated.containerID`, or none.

The reader keeps a cursor (an instance and a timestamp, from `Resume` or from
what it has sent) and `finished`, the instance it has read to its end. It
loops:

1. **Wait** while the Pod has no `spec.nodeName`, or current(s) is none, or
   current(s) is `finished`. The source's state, reason, and message come
   from `s`. Wake on a Pod change.
2. **Open** a request for current(s), by this table. Every request sets the
   container, `timestamps`, and `follow`.

   | The cursor              | Before following                                                                                                       | The follow request               | Its first timed line                                       |
   | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- |
   | none                    | nothing                                                                                                                | `tailLines`                      | anything                                                   |
   | is for this instance    | nothing                                                                                                                | `sinceTime`, the cursor's second | at or before the cursor, otherwise send a gap record first |
   | is for previous(s)      | read `previous` with `sinceTime` to its end, without `follow`, by the row above. Send a gap record if that read fails. | from the start                   | anything                                                   |
   | is for another instance | send a gap record                                                                                                      | from the start                   | anything                                                   |

   In a request with `sinceTime`, lines at or before the cursor are skipped
   until the first line after it. Later lines are all sent.

3. **Read** lines until the response ends. Each timed line moves the cursor
   to the larger of its timestamp and the cursor's.
4. **When the response ends:** if the Pod's status says this instance is not
   running, send an `exited` record and set `finished`. Otherwise the status
   may be out of date or the request was cut, so wait the retry delay, or
   for a Pod change that changes current(s) or its state, and loop.
5. **When a request fails:** `403` ends the whole stream with `error` and
   code `forbidden`. A `400` and a `404` are not errors: the Pod's status
   already says why, so wait as in step 4. Anything else sets the source's
   `Error` to the message and waits as in step 4. `Error` clears when a
   request opens.

Details the loop depends on:

- **Retry delay.** 1 second, doubling to 30. It resets when a line is sent
  and when current(s) changes.
- **`tailLines`** is 2,000 divided by the number of containers the stream
  starts with, at least 50 and at most 1,000. Containers that join later
  use the same number.
- **Lines** are read with a `bufio.Reader`, never a `Scanner`. Content past
  64 KiB is read and discarded, and the record is flagged `cut`.
- **A line whose prefix is not a timestamp** is sent with time 0 and does
  not move the cursor.
- **The last bytes of a response, when they have no newline:** with a
  timestamp they are a line. Without one they are the kubelet's error text,
  which becomes the source's `Error` and is not sent as a line.
- **A follow that may be stuck.** A reader that received more than 2 MiB
  within one second is marked fast. A fast reader whose container is
  running and whose request has been silent for 15 seconds cancels the
  request and loops. The table then shows a gap if lines were lost.
- **The client.** Log requests use their own `CoreV1` client, built from the
  Cluster's config with `Timeout` set to 0, so they have their own rate
  limiter.

With `Previous`, each reader makes one request with `previous` and
`tailLines`, without `follow`. A `400` means there is no previous run. The
stream ends with `complete` when every reader is done.

All durations live in a timing value that tests shorten, as `cluster.Timing`
does.

### Merging and order

Readers add records to one batch. The batch is sent when it is 100 ms old or
holds 256 KiB. Sending merges the containers' records by timestamp, keeps
each container's own order, puts a line without a timestamp after the line
before it, and writes frames of at most 64 KiB, or one record if it is
larger.

The first batch waits until every reader of the first Pod set has settled or
1 second has passed. A reader has settled when it is waiting (steps 1, 4,
and 5), is done with a previous run, or its request has delivered data and
then nothing for 100 ms.

ADR-0017 states what the order guarantees.

### Bounds

| What                                     | Bound                                                    | What the user sees past it                |
| ---------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| A line                                   | 64 KiB                                                   | The line ends with a mark that it was cut |
| Lines waiting in the Engine for a client | 4 MiB a stream                                           | `n lines dropped` in their place          |
| Data in transit to a client              | 1 MiB a stream                                           | nothing                                   |
| Pods in a stream                         | 20                                                       | `Showing the 20 newest of n Pods`         |
| Lines the UI keeps                       | 50,000 lines, 32 million characters, 200,000 decorations | The oldest lines leave                    |
| Stream sockets in a window               | 8                                                        | A notice that the stream is waiting       |

The Engine holds, per stream, the queue, one batch, and a 64 KiB read buffer
and one line per container.

### The client

**The stream abstraction** in `packages/engine-client`:

```ts
type StreamState = "waiting" | "connecting" | "open" | "reconnecting" | "paused" | "ended";

interface StreamListener<M extends StreamMethod> {
  state?(state: StreamState): void;
  event(event: Streams[M]["event"]): void;
  data(data: StreamData[M]): void;
  gap(gap: StreamGap): void;
  end(end: StreamEnd): void;
}

interface EngineStream {
  /** Closes the socket and keeps what is needed to resume. */
  pause(): void;
  resume(): void;
  close(): void;
}

// On EngineClient:
openStream<M extends StreamMethod>(
  method: M,
  params: Streams[M]["params"],
  listener: StreamListener<M>,
): EngineStream;
```

- **In the Worker,** one object per stream owns a socket. It checks `hello`,
  sends `open`, and passes text messages on. A hash that does not match ends
  the stream with `error` and no retry. A socket that closes without `end`
  moves the stream to `reconnecting` and opens it again after the delays the
  control connection uses.
- **A codec per method** in the Worker turns a binary frame into what the
  main thread receives, may rewrite events, and supplies the params for
  opening again. `StreamData` maps each method to what its codec produces.
- **Acknowledgements.** A data message to the main thread carries its frame's
  length. `WorkerEngineClient` calls the listener's `data`, and when it
  returns posts the total to the Worker, which sends `ack`.
- **The cap.** The Worker runs at most 8 sockets. A stream beyond that is
  `waiting` and starts when one ends, closes, or pauses, first come first
  served.
- **`EngineConnection`** used directly, without a Worker, implements the same
  `openStream`, so tests and any future non-Worker client share it.

**The log codec:**

- Decodes records with a `DataView` and decodes content as UTF-8, where an
  invalid byte becomes U+FFFD.
- Keeps a cursor per Pod UID and container from the lines it decodes and the
  `instance` in the status, and returns them as `resume`.
- Gives each Pod UID and container a number that stays the same across
  sockets, and rewrites `LogSource.ID` and each line's source to it. The
  main thread never sees the Engine's IDs.
- Filters and parses each line (next section), and posts a batch:

```ts
interface LogLine {
  source: number;
  /** Milliseconds since the epoch, or 0. */
  time: number;
  text: string;
  /** [start, end, foreground, background, flags]; -1 means the default color. */
  spans?: [number, number, number, number, number][];
  cut?: true;
  gap?: true;
  exited?: true;
}
```

### Log content

Lines are untrusted. In the Worker, in this order:

1. **Carriage returns.** The line is split at `\r` and its last part that is
   not empty is kept, which is what a terminal shows after a progress line
   rewrites itself.
2. **Escape sequences.** Color and style sequences (`CSI ... m`) are kept
   for step 4. Every other sequence is removed whole: other CSI sequences,
   OSC, DCS, APC, PM, and SOS strings whether or not they are terminated,
   and two-byte escapes.
3. **Control characters.** Each remaining C0 control except tab becomes its
   symbol from the Unicode Control Pictures block (U+2400 and up), DEL
   becomes U+2421, and each C1 control becomes U+FFFD. A stray ESC is one of
   these.
4. **Colors.** `anser` parses what is left into text and spans. The 16
   standard colors, bold, dim, italic, and underline are kept. A 256-color
   or true-color sequence maps to the nearest of the 16. At most 32 spans a
   line are kept.

The main thread gets text and numbers. It sets them as editor text and
decorations with class names from a fixed list, so nothing in a line is
markup. Pod and container names are text from the Cluster too, and follow
the same rule: text in the editor, compared by value, held in a `Map`.

## UI and UX

### Which Resources have a Logs Facet

- **Always:** Pods, and the built-in workload types: `deployments.apps`,
  `replicasets.apps`, `statefulsets.apps`, `daemonsets.apps`, `jobs.batch`,
  `cronjobs.batch`, and `replicationcontrollers`.
- **Any other Resource that owns a Pod.** The panel already holds the
  Resource's Relationships. The Facet applies when the owned section has a
  Pod, or was cut short, so that a custom workload (an Argo Rollout, a
  CloudNativePG Cluster, a Tekton TaskRun) gets its Pods' logs with no code
  for its kind.
- **It never goes away while the tab is open.** Once a tab has offered Logs
  it keeps offering it, so a CronJob between runs and a custom Resource
  whose Pods are gone keep the entry and show the "no Pods" state. Layer 4
  found that an entry which comes and goes is disorienting. A custom
  Resource gains the entry once, a moment after its tab opens.

The switcher order follows `CONTEXT.md`: YAML, Logs, Events, Related. The
entry has no badge. `logs` joins the Resource URI's Facets.

A new tab takes the Pane's active Facet when it applies to the new tab's
type (ADR-0013). That rule sees only the type, so moving through a list of
Pods keeps Logs, and a custom Resource opens on YAML.

### Where the code lives

- **`apps/app/src/features/logs/`** holds the Log Stream view: one component
  that takes a target (Cluster, type, Namespace, name), the Resource's
  current UID and whether it exists, its kind for texts, and whether it is
  visible. It owns the toolbar, the notices, the editor, and the stream. It
  knows nothing of Resource tabs or Facets, so a dock can show it later. It
  is loaded on demand with the editor, and the stream opens when it mounts.
- **`apps/app/src/features/resource/logs-facet.tsx`** is the Facet. It maps
  the Facet's props to the view's.
- **`FacetProps` gains `visible`:** Logs is not the only Facet that will
  want to stop work while its tab is behind another. The panel reads it
  from dockview's `isVisible` and `onDidVisibilityChange`, and the
  Workspace context gains whether the Workspace is the active one.
- **Monaco's setup moves to one module** that both editors import: the
  worker, the editor API, and the find, clipboard, and icon-font features.

### Controls sit in a toolbar inside the Facet

The Log Stream has its own toolbar, directly above the lines, not in the
switcher row.

- Every comparable log viewer puts its controls on the log: Freelens,
  Headlamp, Argo CD, Rancher, and VS Code's Output panel.
- Five controls do not fit beside four Facet tabs in a 330 px Pane.
- A Log Stream must be showable outside a Resource tab later. The toolbar
  belongs to the view, so the view is one component with no ties to the
  switcher.

The toolbar is one row, `h-8`, `px-3`, with a bottom border, `role="toolbar"`
and the label `Log Stream`. From the start of the row:

| Control      | Component       | Label, and what it does                                                                                                                                                                                                                          |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Container    | shadcn `select` | Shows the selection. Options: `All containers`, then the names under the group labels `Containers`, `Init containers`, and `Ephemeral containers`. With one container in total it shows that name and is disabled. Choosing starts a new stream. |
| Previous run | shadcn `toggle` | `Previous run`. Pressed, the view shows the previous run of each selected container and stops. Disabled, with the tooltip `No container has restarted`, while no source has `previous`. It stays enabled while pressed.                          |
| (space)      |                 |                                                                                                                                                                                                                                                  |
| Timestamps   | `toggle`        | `Timestamps`. Shows each line's time.                                                                                                                                                                                                            |
| Wrap         | `toggle`        | `Wrap`. On by default. Off scrolls sideways.                                                                                                                                                                                                     |
| Search       | `button`        | `Search`. Opens the editor's find widget.                                                                                                                                                                                                        |

- **Compact form.** The toolbar is a CSS container. At 34rem and wider each
  control shows an icon and its label. Narrower, the four after the
  container show icons only, with the label as tooltip and accessible name,
  as the YAML Facet's control does. The container select keeps its text and
  truncates, with a least width of 6rem.
- **Order.** The container and the previous run choose what is read, so they
  come first, as in Freelens, Headlamp, and Argo CD. The other three change
  how it is shown and sit at the end, with search last, where VS Code and
  browsers put it.
- **Keyboard.** Each control is a tab stop, in row order, before the editor.
  Toggles answer Space and Enter. Ctrl or Cmd+F opens search while the
  viewer has focus, which is the editor's own binding ("Resolved questions"
  has its conditions). hukube adds no other key binding.
- **Timestamps and wrap are shared.** One in-memory setting for the window,
  so a choice holds for the next Logs Facet opened, including each Pod of a
  list moved through with a Preview Tab. It is not stored across reloads.
- **Defaults.** All containers, the current run, timestamps off, wrap on.
  Wrap is on because a 330 px Pane shows about 40 characters of an unwrapped
  line.

### The lines

A read-only Monaco editor (ADR-0018) in the app's theme, with the monospace
font and size of the YAML Facet, no line numbers, no minimap, no folding, no
link detection, and `ariaLabel` `Logs of <Kind> <name>`.

Each line of the editor is one line of the stream:

```
[time ][origin ]text
```

- **Time,** when timestamps are on: `HH:mm:ss.SSS` in the user's time zone,
  with `MM-DD ` before it for a line that is not from today. Muted.
- **Origin,** when the stream reads more than one container. The Pod's name
  without the target's name and a hyphen at its start, when it has them, so
  a Pod of Deployment `web` shows as `7d9f8c6b5-x2k4q` and a Pod of
  StatefulSet `db` as `0`. Then `/` and the container's name when the Pods
  have more than one container among them. On a Pod's own tab the origin is
  the container's name alone. Each Pod has a color, in the order Pods first
  appear, from six of the theme's ANSI colors: cyan, green, magenta, blue,
  yellow, and bright cyan. The color helps the eye. The name is what
  identifies.
- **Text** with its colors. A cut line ends with ` … cut at 64 KiB`, muted.

Marker lines are lines of the editor too, muted and starting with `···`, so
they stay in place, wrap, and are copied with the lines around them:

| When                                                   | Text                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A `gap` message                                        | `··· 12,340 lines dropped: they arrived faster than they could be shown ···`                                |
| A gap record                                           | `··· <origin>: some lines may be missing ···`, without the origin and colon when there is one container     |
| An exited record                                       | `··· <origin> exited: Error, exit code 1 ···`, or `··· the container exited: …` when there is one container |
| A Pod joins a workload's stream after its first status | `··· following Pod <name> ···`                                                                              |
| A Pod leaves it                                        | `··· Pod <name> is gone ···`                                                                                |

Opening a stream again after a lost connection adds no marker. Resuming is
silent unless a gap record says lines may be missing.

The ANSI palette is 16 CSS variables in `packages/ui/src/styles/globals.css`
for each theme, based on VS Code's terminal defaults and adjusted so that
every color but black and white has a contrast of at least 4.5 to 1 with the
theme's background. ANSI black in the dark theme and white in the light
theme use the muted foreground, so no text is invisible. Exec Sessions will
use the same variables.

### Following

The rule, in full:

- A view starts following.
- While following, every change of the content's height, which is an
  append, a wrap toggle, or a Pane resize, scrolls to the bottom.
- Following stops when a scroll that the view did not make leaves the
  bottom, or when the selection becomes non-empty. A click that selects
  nothing does not stop it.
- Following starts again when the view is scrolled to the bottom by any
  means, or the user presses the Newest button.
- While not following, the first visible line stays where it is. When old
  lines leave the top, the view scrolls back by their height. When the line
  the user is reading leaves, the view shows the oldest line kept.
- Scrolls the view makes itself, to follow or to hold still, never change
  whether it follows.

While not following, a button floats over the bottom of the lines, centered,
with a down arrow and `Newest`, and the number of lines that arrived since
following stopped, as `Newest · 1,204 new`. Pressing it scrolls to the
bottom and follows. It is the next tab stop after the editor. Inside the
editor, Ctrl+End, or Cmd+Down on macOS, moves to the end, which is the bottom, so the
keyboard has a second way that is the editor's own.

This is Freelens's "To bottom" button and VS Code's smart scroll together: a
floating button is the most visible way back, and stopping on a selection
keeps text still while the user copies it.

### Search

The Search button runs the editor's `actions.find`. Monaco's find widget
opens at the top right of the lines with the query, case, whole word, and
regular expression toggles, the count, previous and next, and close. Enter
and Shift+Enter move between matches and Escape closes it, as in VS Code.
The count follows new lines. Moving to a match scrolls, which stops
following by the rule above.

The widget takes its colors from the app's tokens through the editor theme
(`editorWidget`, `input`, `inputOption`, and `editor.findMatch` colors), so
it matches both themes. Below about 380 px it hides the count and keeps the
rest.

### States

The area under the toolbar shows, from the top: notice lines, then either
the editor or a centered notice. A centered notice shows only while the
editor has no lines. Notice lines use the style of the other Facets'
warnings: `border-b px-3 py-2`, destructive for a failure and muted for
information, each `role="status"`.

`<Kind>` and `<name>` are the tab's Resource. `<container>` is a container
name. "One container" means the stream reads exactly one.

| State                                                                                                 | What shows                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The manifest has not answered, or the viewer's code is loading, or the stream's status is not `ready` | Three skeleton lines, marked busy. The toolbar shows with its controls disabled.                                                                                                                                                                          |
| The Resource does not exist and no stream ran                                                         | Centered: `Not found`. `No <Kind> named <name> exists right now. Its logs appear here if it is created.`                                                                                                                                                  |
| No Pods (a workload)                                                                                  | Centered: `No Pods`. `This <Kind> owns no Pods right now. Lines appear here when it does.`                                                                                                                                                                |
| Every container is waiting and nothing was printed                                                    | Centered: `Waiting for the container to start`, or `Waiting for containers to start`. Below it, per waiting container up to three, `<container>: <reason>` and the status message, then `and n more`.                                                     |
| Running, nothing printed                                                                              | Centered: `No log lines yet`. `<container> has not printed anything. Lines appear here as it does.` With several containers: `These containers have not printed anything. …`                                                                              |
| Lines                                                                                                 | The editor.                                                                                                                                                                                                                                               |
| Some containers are not running, with lines showing                                                   | A muted notice line. One container: `<container> is not running: CrashLoopBackOff.` and the status message. Several: `2 of 6 containers are not running.`                                                                                                 |
| A container's logs cannot be read                                                                     | A destructive notice line. One container: `Cannot read the logs of <container>: <error>. hukube keeps trying.` Several: `Cannot read the logs of 2 containers. hukube keeps trying.` with the first error as its title.                                   |
| More Pods than the limit                                                                              | A muted notice line: `Showing the 20 newest of 134 Pods. Open a Pod to see its own logs.`                                                                                                                                                                 |
| A fast container, lines dropped                                                                       | The `lines dropped` marker in the lines. Nothing else.                                                                                                                                                                                                    |
| A long line                                                                                           | Wrapped in full with wrap on. With wrap off it extends sideways. Cut at 64 KiB with the mark.                                                                                                                                                             |
| Colored output                                                                                        | Colors from the theme's palette. Other escape sequences are gone.                                                                                                                                                                                         |
| Previous run, pressed                                                                                 | The previous run's lines, not following new ones. A muted notice line: `The previous run of <container>.` or `The previous runs of n containers.` When no selected container has one, centered: `No previous run`. `No selected container has restarted.` |
| The connection to the Engine is lost                                                                  | The lines stay. A destructive notice line: `Connection to the Engine lost. Reconnecting…` The status bar says so too, as today. On return the stream resumes where it was.                                                                                |
| The Cluster cannot be reached                                                                         | The lines stay. Containers show as unreadable, as above, with the Cluster's error. The status bar says so, as today.                                                                                                                                      |
| Not permitted                                                                                         | The stream ended with `forbidden`. With no lines, centered: `Not permitted`, the error's message, and a `Try again` button. With lines, a destructive notice line with the same message and button.                                                       |
| The Pod or workload was deleted while open                                                            | The lines stay, and the header shows `Deleted` as today. A muted notice line: `This <Kind> was deleted. These are the last lines it printed.`                                                                                                             |
| A Resource with the same name exists again                                                            | The notice line becomes `This <Kind> was deleted and created again.` with a `Show its logs` button, which clears the lines and opens a stream on the new one. Nothing restarts by itself.                                                                 |
| The stream ended with another error                                                                   | A destructive notice line: `The Log Stream stopped: <message>.` with `Try again`.                                                                                                                                                                         |
| More than 8 Log Streams                                                                               | Centered, or a muted notice line when lines show: `Waiting for a free Log Stream`. `hukube runs 8 at a time. This one starts when another Logs Facet is closed or hidden.`                                                                                |
| The Facet is hidden                                                                                   | The stream pauses 10 seconds after the Facet stops being visible and resumes when it shows again. Visible means: Logs is the tab's Facet, the tab is the one showing in its Pane, and its Workspace is the active one. Lines stay while it is paused.     |
| The window is out of date                                                                             | Frozen by the root layout, as everything else.                                                                                                                                                                                                            |

The stream that a view runs is chosen by the Resource's UID when the stream
starts, the container, and the previous run toggle. Changing the container
or the toggle clears the lines and starts a new stream. A stream that ended
is only started again by the user.

### At each width

- **330 px.** The toolbar has 306 px: the container select takes what the
  four icon buttons (28 px each) leave, about 170 px. With wrap on, a line
  holds about 42 characters, 29 after a timestamp. The find widget shows
  without its count. The Newest button is centered.
- **520 px.** Icons still, a wider select, about 68 characters a line.
- **1040 px.** Labels show on every control. About 140 characters a line.

Dragging a Pane's edge re-wraps every line Monaco holds, about 80 ms for
50,000, so the editor's layout follows the Pane at most once per animation
frame.

### Packages considered

- **Viewer:** Monaco, xterm.js, a virtual list, `@melloware/react-logviewer`,
  and `@patternfly/react-log-viewer`. ADR-0018 has the comparison. Monaco
  0.57.0 is already installed.
- **ANSI:** `anser` 2.3.5 (December 2025, MIT, 16 million downloads a week)
  is added to `packages/engine-client` for parsing colors. `ansi_up` and
  `fancy-ansi` return HTML, and `ansi-sequence-parser` leaks every sequence
  that is not a color. The filter in front is hukube's own, because none of
  the four removes every other sequence.
- **Search:** Monaco's find widget, not a search bar of hukube's own.
- **Controls:** shadcn `select`, `toggle`, `button`, and `tooltip`, all
  installed.
- **State:** `zustand`, already a dependency, for the shared timestamps and
  wrap setting.

`anser` is the one package added.

## Sample workloads

`e2e/fixtures/sample/resources.yaml` gains three Deployments in
`sample-shop`, on `busybox:1.36`:

- **`clock`**, 2 replicas. An init container `setup` prints three lines. The
  container `clock` prints a line a second with a level colored by ANSI
  sequences, and every 30 seconds a 3 KB line, a progress line that rewrites
  itself with carriage returns, and a line with invalid UTF-8 and control
  bytes. A second container `ticker` prints a line every 5 seconds.
- **`firehose`**, 1 replica. Every 30 seconds it prints 300,000 numbered
  lines as fast as it can, about 30 MB, then sleeps. That is more than a
  stream's queue holds, without keeping a core busy.
- **`crasher`**, 1 replica. It prints a few lines and an error with a stack
  trace, then exits 1 after 20 seconds, so it restarts and always has a
  previous run.

`web` and `api` stay quiet containers, and `worker` stays one that cannot
start.

## Phases

1. **Protocol and stream socket.** The stream wire types and registry, the
   generator's `Streams` map, `/ws/stream`, the queue, the window, and
   ending, with their tests against a stream method that exists only in
   tests.
2. **Log Stream in the Engine.** `engine/internal/logstream`, the Cluster's
   log client, `resource.logs`, and their tests. The sample workloads.
3. **Client.** `openStream` in `EngineConnection` and across the Worker, the
   cap, pause and resume, the log codec, the content filter, and their
   tests.
4. **Logs Facet.** The Facet rule and registry entry, panel visibility, the
   view with its toolbar, states, and markers, the editor with following,
   trimming, and search, and the palette.
5. **End to end,** then a check by hand of every state at 330, 520, and
   1040 px in both themes, and the flow-control measurement repeated against
   the built app.

The Engine half (phases 1 and 2) is inspected before the UI is built on it.

## Testing

| Risk                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stream socket accepts a client the control socket would refuse | Go test through a real socket: a wrong Host, Origin, token, or subprotocol is refused as on `/ws`, and `hello` is the first message.                                                                                                                                                                                                                        |
| A bad `open` is not answered                                     | Go test: an unknown method, bad params, and a first message that is not `open` each end with `error` and `bad_request`. No `open` within the timeout closes the socket.                                                                                                                                                                                     |
| A slow client blocks the Engine or grows its memory              | Go test with a test stream method and a client that never acknowledges: the producer adds 64 MiB without waiting, the queue never holds more than 4 MiB, and at most the window is sent. The client then acknowledges and receives one `gap` with the dropped bytes and records, then the newest frames in order.                                           |
| The window is not respected, or order is lost                    | Go test: unacknowledged bytes never exceed the window by more than one frame, and events, gaps, and frames arrive in the order they were added.                                                                                                                                                                                                             |
| A stream does not end, or ends without its data                  | Go test: a handler that returns sends what is queued, then `end` with its reason, then closes. With a client that stops acknowledging, `end` follows a `gap` after the timeout. Closing the socket ends the handler's context.                                                                                                                              |
| A declared stream has no handler, or the map is stale            | The registry test covers streams, and `gen:check` covers `Streams`.                                                                                                                                                                                                                                                                                         |
| The record layout drifts between Go and TypeScript               | A Go test writes a golden frame with every flag and compares it. A TypeScript test decodes the same file.                                                                                                                                                                                                                                                   |
| A Pod's lines arrive out of order or twice                       | Go test in `logstream` with a scripted log API and Pod status: the lines of one container arrive once, in order, with their timestamps.                                                                                                                                                                                                                     |
| The wrong container is read                                      | Go test: `Container` reads only that container in each Pod, a Pod without it contributes nothing, and all containers are read without it, including init and ephemeral ones. `Containers` lists the names by kind.                                                                                                                                          |
| The previous run is wrong                                        | Go test: `Previous` reads each container's previous run, reports none for a `400`, and ends with `complete`.                                                                                                                                                                                                                                                |
| A restart replays or loses lines                                 | Go test: a container that exits and restarts gives its last lines, an `exited` record, and the new run from its start. While its status still says running after the response ends, the reader waits and does not replay. During `CrashLoopBackOff` it opens no request.                                                                                    |
| Resuming duplicates or silently loses lines                      | Go table test over the four rows of the reader's table: the same instance with and without the cursor's line still present, the previous instance, an older instance, and a failed previous read. Lines at the cursor are skipped once and a gap record appears exactly where the table says.                                                               |
| A long line exhausts memory                                      | Go test: a 4 MiB line arrives as one cut record of 64 KiB, the next line is intact, and the reader never holds more than its buffer.                                                                                                                                                                                                                        |
| An error in a `200` is shown as a line                           | Go test: a response whose last bytes have no timestamp and no newline sets the source's `Error` and sends no record.                                                                                                                                                                                                                                        |
| A stuck follow stays stuck                                       | Go test with shortened timing: a fast reader that goes silent is opened again and sends a gap record when the new response does not begin at the cursor.                                                                                                                                                                                                    |
| A workload's Pods are not merged, or a rollout is not followed   | Go test in `logstream`, and an envtest test through the socket with the log API replaced: two Pods' lines arrive in one stream, sorted by timestamp within a batch. A Pod under a new ReplicaSet joins, and a deleted Pod leaves, with the status following.                                                                                                |
| The Pod limit is wrong                                           | Go test: 23 Pods give 20 sources, the newest, with `pods` 23. Deleting a followed Pod brings in the newest one not followed. A newer Pod does not displace a followed one.                                                                                                                                                                                  |
| A deleted Pod leaves its stream open                             | envtest through the socket: deleting the Pod ends the stream with `deleted`. A target with another UID ends at once.                                                                                                                                                                                                                                        |
| A credential that may not read logs gets no answer               | envtest through the socket with a user who may get, list, and watch Pods but not `pods/log`: the stream ends with `error` and `forbidden`. A user who may not list Pods gets the same.                                                                                                                                                                      |
| The client mishandles the socket                                 | Vitest with a fake socket: `hello` is checked and a wrong hash ends the stream without a retry. `open` carries the params. Events, gaps, and the end reach the listener in order.                                                                                                                                                                           |
| Acknowledgements run ahead of the consumer                       | Vitest across the Worker boundary: `ack` is sent only after the main thread's `data` listener has returned, with the total bytes.                                                                                                                                                                                                                           |
| A lost socket duplicates or loses lines                          | Vitest: a socket that closes without `end` is opened again after the delay with `resume` holding each container's last instance and time, and lines keep their source numbers. An `end` is not followed by a reconnect.                                                                                                                                     |
| The cap is not kept                                              | Vitest: a ninth stream is `waiting` and starts when one closes or pauses. Closing a waiting stream removes it. Pause and resume keep the cursors.                                                                                                                                                                                                           |
| The codec decodes wrongly                                        | Vitest: every flag, a line without a timestamp, invalid UTF-8, and the golden frame.                                                                                                                                                                                                                                                                        |
| Log content is interpreted                                       | Vitest for the filter with 28 hostile inputs (clear screen, clear scrollback, alternate screen, cursor movement, title, hyperlink, clipboard, charset, C1 CSI, unterminated strings): none survives, colors and styles do, a progress line keeps its last state, and control bytes become symbols. `<script>` and `<img onerror>` reach the output as text. |
| The Facet is offered wrongly                                     | Vitest: Logs applies to the fixed types and to a Resource that owns a Pod, keeps applying after the Pod is gone, and `#logs` round-trips in a Resource URI.                                                                                                                                                                                                 |
| A state shows the wrong thing                                    | Vitest with jsdom and the editor replaced by a stand-in that records lines: each row of the states table, the toolbar's enabled and pressed states, the markers, the origin's text for a Deployment, a StatefulSet, and a Pod tab, and the timestamp's text.                                                                                                |
| The stream is opened, paused, or restarted at the wrong time     | Vitest with a controllable clock: it opens when the Resource exists, pauses 10 seconds after the Facet hides and not before, resumes when it shows, restarts on a container or previous-run change, and does not restart after an end until the button is pressed.                                                                                          |
| The feature does not work end to end                             | Playwright against k3d: create a Deployment of two Pods that print a counter. Open one Pod, see lines arrive in its Logs Facet, scroll up, see the Newest button and the same first line while its count grows, press it, and see the newest line. Open the Deployment's Logs Facet and see lines from both Pods with their origins.                        |

Each new test is run once against a deliberately broken implementation, to
see it fail at its assertion.

Following, holding still while lines leave, wrapping, search, selection, and
copy depend on the real editor's layout, so the Playwright test and the
check by hand cover them. The check by hand covers every row of the states
table at 330, 520, and 1040 px in both themes, then an independent
experience review does the same.

## Risks

- **Monaco is the most expensive of the three per appended line.** At 5,000
  lines a second it used 12% of the main thread, and half of it with the CPU
  slowed four times. Past what the main thread can take, acknowledgements
  slow, the Engine drops, and the user sees gap markers. That is the
  designed outcome, not a failure.
- **Many Pods cost requests.** 20 Pods with two containers each are 20
  watches and 40 follows. kubectl stops at 5. The limit is a constant and
  can be lowered.
- **A fast container costs the Cluster.** The Engine reads at full speed and
  drops, so the API server and the kubelet carry up to about 10 MiB a second
  for it while its Logs Facet is visible. Stopping the read is not an
  option, because of the rotation failure. A hidden Facet costs nothing.
- **Lines with equal timestamps at a disconnect.** ADR-0017 describes the
  case the resume rule misses.
- **History after a rotation is short,** because the API reads the current
  file only.
- **Firefox is unmeasured** for flow control and for the viewer. Nothing
  used is specific to Chromium, and both ran in WebKit.
- **A screen reader gets an editor.** Monaco exposes a text box, not a log
  region. This was not tested with a screen reader.
- **The find widget in a 330 px Pane** has no count. If that reads as
  unfinished, a search bar on `findMatches` is the alternative.

## Non-goals

- Exec Sessions, and anything that sends input to a container.
- A dock or bottom area for logs.
- Selecting a Log Stream with a Query, saving one, or downloading logs.
- Filtering by level, parsing structured logs, or highlighting.
- Loading older lines than the first history, and choosing how much history
  to load.
- Storing the timestamps and wrap setting across reloads.
- Separating standard output from standard error.
- Structured errors and cancelling requests on the control socket.

## Resolved questions

1. **Ctrl or Cmd+F opens search while an editor has focus,** in the log
   viewer and in the YAML Facet, which gains search with it. The coordinator
   approved it on 2026-10-13 and Jim can reverse it. Conditions:
   - It fires only while an editor has focus. Elsewhere the key does what it
     does today, including the browser's own find in the web Host.
   - Escape closes the find widget and returns focus to the editor. The
     toolbar's Search button stays as the visible way in.
   - Only the bindings that are about find are kept: find, next and previous
     match, the widget's own toggles, and close. Anything else the find
     feature binds is removed. "What changed while building" lists the
     bindings kept.
   - The editors do not take keys the app uses or will use. Ctrl or Cmd+K
     still opens the Go to Resource palette from inside both editors, and
     nothing in them answers Ctrl or Cmd+J.

## What changed while building

**Engine**

- **A status says when it is ready.** A status with no sources meant both
  "not looked up yet" and "owns no Pods". `LogStreamStatus` gained `ready`.
- **A target the index has not shown yet is waited for,** for up to 10
  seconds. The UI learns of a new Resource from its manifest before the
  index holds it, and the first version ended such a stream as `deleted`.
- **A response that ends while the status says running is always read
  again.** The first version marked the run as exited when the status
  changed during the wait, which skipped whatever a cut response had not
  delivered. The cost is one more request when a container exits before its
  status says so.
- **Opening a stuck follow again is not an error,** and happens at once.
- **The kubelet's error text is cut at 512 bytes** before it becomes a
  source's `Error`.
- **A previous run ends with an `exited` record too,** and ignores `resume`,
  because it is sent whole each time.
- **A refused log request ends the stream with hukube's own words:** `Your
credentials cannot read Pod logs in the <Namespace> Namespace.`
- **The first batch is also sent when it reaches 256 KiB,** so a large
  history does not wait for the slowest container.

**Client**

- **The codec drops a repeated `exited` record** for a run it has already
  passed one for, which a resume can produce, and forgets the cursor of a
  container that a ready status no longer lists.
- **A stream that is retrying keeps its place among the 8.**

**Logs Facet**

- **The viewer keeps the lines itself, and the editor shows them.** The plan
  had the editor's model as the only copy. A document of formatted rows
  outside Monaco made the states testable without an editor and made the
  two fixes below possible. Turning timestamps on builds the model again
  instead of editing each line.
- **One edit a frame, and a model that is built again.** Monaco's text
  buffer keeps every character an edit adds (ADR-0018). With an edit for
  every frame of lines, a 30 MB burst took the page's heap to 840 MB, and
  each burst left 30 MB more behind. The editor now applies what arrived
  once per animation frame and builds its model again from the rows after
  edits have added 8 million characters.
- **Following ignores Monaco's own re-measuring.** A scroll event that comes
  with a new content height is not the user. Without this, a font that
  finished loading stopped following on a short log.
- **A Log Stream opens once its view has first been shown.** A Workspace
  restored with Logs tabs behind other tabs opened a stream for each.
- **The editor theme waits for its element to be attached.** dockview can
  run a panel's effects first, and a detached element resolved every color
  to black, in the YAML Facet as well.
- **Origins on a Pod's own tab are colored by container,** since the Pod is
  the same for all of them.
- **An init container that completed is not "not running".**
- **A stream that ended stops reporting what its containers were doing.**

**After the experience review**

An independent review of the running app found nothing that blocks a user
and a list of rough edges. These were fixed:

- **A status is ready after the first lines.** `ready` meant "the containers
  are known", so every stream showed "No log lines yet" for a third of a
  second before its lines. It now follows the first batch, or a second
  without one.
- **The place is kept when timestamps are turned on or off,** as it is for
  wrap. It jumped to the oldest line.
- **Search starts from the newest line.** Opening it while following puts
  the caret at the end, the find box is no longer filled with the word the
  caret was in, typing does not move the view, and Enter goes to the newest
  match and then to older ones, as in VS Code's terminal. Shift+Enter goes
  the other way. The YAML Facet keeps the editor's order.
- **Right-click offers Copy.** The editors show Monaco's own context menu,
  which keeps the selection. The browser's menu selected the word under the
  pointer first.
- **Choosing a container or the previous run keeps focus** on the control
  that was used, and `Newest` hands focus to the lines. The toolbar is
  replaced when a stream starts, which had dropped focus to the page.
- **An origin is what tells the Pods apart.** It drops everything the Pod
  names have in common up to a hyphen, so the Pods of one ReplicaSet show as
  `p656b/clock` and not `6ddb47c784-p656b/clock`. During a rollout, with two
  ReplicaSets, the hash shows again. The plan dropped only the workload's
  name.
- **Selection and matches can be seen.** The selection was 1.2 to 1 against
  the background in both themes. It is now a tint of the Cluster's color,
  and matches are amber. A pressed toggle has the Cluster's tint too.
- **Notices say what is true.** The Pod limit shows only at the limit, not
  whenever fewer Pods are read than exist for a moment. A deleted Resource
  keeps its container's name and loses the limit notice. `1 of 4 containers
is not running`. A container that is not running shows its reason in one
  line and the kubelet's message as a tooltip.
- **A previous run whose logs are gone says so,** in place of "Lines appear
  here as it does".
- **One container is shown as its name,** not as a disabled menu, and the
  menu no longer stretches across a wide Pane.
- **Origin colors leave green and red to log levels:** cyan, magenta, blue,
  and yellow.
- **The YAML Facet has a Search button** beside `Show managed fields`.
- **A view that is first shown after its Resource was deleted** says `Not
found`, where it showed a loading state for 10 seconds.

Left as follow-ups: a marker that older lines exist and a way to load them,
blank frames when scrolled away during a burst, a hover with a line's full
Pod name and date, opening a Pod from its origin, and arrow keys within the
toolbar.

**Key bindings**

Loading Monaco's find and clipboard features binds more than search. These
are kept, in both editors, and only while an editor has focus:

| Command                                                                                      | Keys                                                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `actions.find`                                                                               | Ctrl or Cmd+F                                               |
| `editor.action.nextMatchFindAction`                                                          | Enter in the find box, F3, Cmd+G on macOS                   |
| `editor.action.previousMatchFindAction`                                                      | Shift+Enter in the find box, Shift+F3, Shift+Cmd+G on macOS |
| `toggleFindCaseSensitive`, `toggleFindWholeWord`, `toggleFindRegex`, `toggleFindInSelection` | Alt+C, Alt+W, Alt+R, Alt+L, with Cmd on macOS               |
| `closeFindWidget`                                                                            | Escape, Shift+Escape                                        |

In the log viewer, Ctrl or Cmd+F and the two Enter keys of the find box run
the viewer's own versions of the same commands, for the search order
described above. No key is added by them.

Every binding of these commands is removed: `actions.findWithSelection`
(Cmd+E), `editor.action.nextSelectionMatchFindAction` and
`previousSelectionMatchFindAction` (Ctrl or Cmd+F3, with Shift),
`editor.action.startFindReplaceAction` (Ctrl+H, Cmd+Alt+F),
`togglePreserveCase`, `editor.action.replaceOne`, `editor.action.replaceAll`,
`editor.action.selectAllMatches` (Alt+Enter), `history.showPrevious` and
`history.showNext` (Up and Down in the find box), `leaveEditorMessage`, and
the cut, copy, and paste commands, whose keys the browser handles itself,
and `editor.action.showContextMenu` (Shift+F10), which the context menu
feature binds. Copy still works.

The end-to-end test checks, in both editors, that Ctrl or Cmd+K opens the Go
to Resource palette, that nothing handles Ctrl or Cmd+J, that Escape returns
focus to the editor, and that Ctrl or Cmd+F outside an editor is left to the
browser.

## Measurements

Taken on an Apple M3 Max against the built app and the k3d test cluster, with
the `firehose` sample, which prints 300,000 lines (about 30 MB) every 30
seconds. Browsers are Playwright 1.63.0 builds.

**Flow control in the app.** The main thread was blocked for 4 of every 5
seconds, across two bursts:

| Browser      | Lines dropped by the Engine  | Lines kept by the viewer | Browser memory, most                            | Engine memory     |
| ------------ | ---------------------------- | ------------------------ | ----------------------------------------------- | ----------------- |
| Chromium 153 | 248,600, shown as one marker | 50,000                   | +48 MiB                                         | 53 MiB throughout |
| WebKit 26.6  | not counted                  | 50,000                   | +268 MiB at the first burst, +370 MiB after six | 48 to 55 MiB      |

With the main thread busy 90% of the time in slices of 45 ms, Chromium
dropped nothing: the viewer's document takes lines cheaply, so only a main
thread that cannot take messages at all makes the Engine drop. Its memory
grew by 92 MiB at most.

WebKit's figure is the memory of its processes with no way to ask for a
garbage collection, so it is not comparable to Chromium's, and why it rises
by about 15 MiB a burst was not established. Chromium's heap after a
collection did not rise (below).

**The viewer's memory.** Chromium, no slowdown, the heap after a forced
garbage collection every 10 seconds across four bursts:

|                                                                | Heap after collection | Heap at its largest |
| -------------------------------------------------------------- | --------------------- | ------------------- |
| An edit for every frame of lines, as first built               | 88, 82, 171, 204 MiB  | 840 MiB             |
| One edit a frame, model built again after 8 million characters | 37 to 41 MiB          | 129 MiB             |

**The Engine.** A client that acknowledged once a second received gaps of
7,676 and 96,842 lines during a burst, and the Engine's memory went from 35
to 47 MiB.
