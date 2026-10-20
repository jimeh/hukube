# A Log Stream reads each container on its own, decides from Pod status, and resumes by timestamp

A Log Stream is one stream socket (ADR-0016) that carries the lines of every
container it reads. The Engine holds one follow request to the Cluster per
container, merges their lines, and sends them with where each came from.
These are the rules it follows. The evidence for each is in
`docs/plans/log-streams.md`.

## Which Pods

A Log Stream is opened on a Resource. On a Pod it reads that Pod. On anything
else it reads the Pods the Resource owns, found through the ownership graph
(ADR-0015) and found again whenever the graph changes, so it follows a
rollout. This works for any Resource Type, including custom workload types,
with no code per kind.

It reads at most 20 Pods. It starts with the newest. A Pod it reads stays
until that Pod is gone, and a free place goes to the newest Pod it is not
reading. The stream reports how many Pods the Resource owns and how many it
reads. `kubectl logs` refuses to follow more than 5 containers and `stern`
stops at 50.

## The Engine watches each Pod it reads

A clean end of a follow request means the container exited, the Pod was
deleted, the Pod is not scheduled, the kubelet restarted, or the kubelet's
four-hour limit passed. The response does not say which. While a container
waits in `CrashLoopBackOff`, each new follow request returns its whole last
log and ends at once, so a loop that reconnects on every end replays it.

The Engine therefore watches the manifest of every Pod it reads, and decides
from the container's status: which instance to read, when a run is over, and
when to open the next. It also takes the container names from there. The
index holds metadata only (ADR-0003), so this is one more watch per Pod read,
which the limit of 20 bounds.

## Resuming

Every request asks for timestamps. For each container the Engine keeps a
cursor: the instance it read and the newest timestamp it sent. The client
keeps the same cursors and passes them when it opens the stream again, so a
lost socket, a restarted Engine, and a Facet that was hidden all resume the
same way as a follow request that broke.

The Pod log API's `sinceTime` has whole-second precision and is inclusive, so
a resumed request repeats up to a second of lines:

- **No duplicates.** Lines at or before the cursor are skipped, until the
  first line after it.
- **No silent loss.** A resumed request for the same instance must begin with
  a line at or before the cursor, which proves the cursor's line is still in
  the log file and nothing after it is missing. When it does not, the log
  was rotated or cut, and the Engine sends a gap marker for that container
  before the lines.
- **A restart while disconnected.** When the cursor's instance is now the
  container's previous run, the Engine first reads the rest of that run with
  `previous`, by the same rule, and then reads the current run from its
  start. When it is older than that, a gap marker is all it can give.

One case is not detected: two lines with the same nanosecond timestamp, or
written out of timestamp order by the container runtime, with the connection
lost between them. The second is skipped. The runtime stamps each line with
its own clock reading, so this needs a coincidence at the moment of a
disconnect.

## Order

Lines of one container always stay in the order the Cluster sent them. Lines
of different containers are merged by timestamp within each batch the Engine
sends, which is at most 100 ms of lines, and the first batch waits up to a
second so that the history of every container sorts together. Across batches
the order is the order of arrival. Timestamps come from each Node's clock, so
the merged order is as accurate as those clocks agree. A Pod that joins later
contributes its recent lines when it joins.

`kubectl` and `stern` print lines in the order they arrive and sort nothing.

## Volume

- **The Engine never stops reading a container.** A reader that falls behind
  a log rotation loses the lines in between and then receives nothing, with
  no error, until the Pod is deleted. Reading at full speed and dropping in
  the Engine (ADR-0016) is what avoids that state, and the dropped lines are
  counted in a gap marker.
- **A container that outruns its reader anyway** is noticed: a follow request
  that has carried more than 2 MiB in a second and then goes silent for 15
  seconds is opened again, and the resume rule shows a gap if lines were
  lost.
- **A line is cut at 64 KiB** and marked as cut. A longer line is read and
  discarded without being held in memory.
- **History is bounded.** A stream starts with about 2,000 lines in total,
  between 50 and 1,000 from each container.

## What a client sees besides lines

A status, sent whenever it changes: the containers read, each with its Pod,
its state from the Pod's status, and an error while its logs cannot be read,
plus the container names to choose from and the counts of Pods. Lines carry
only an index into it.

A stream ends with `deleted` when its Resource is gone or replaced, with
`error` when the credentials may not read Pod logs or list the Resource
Types involved, and with `complete` after a previous run has been sent.

## Considered Options

- **Find Pods by label selector,** as `kubectl logs deployment/x` and `stern`
  do. It needs each workload's spec and code per kind, and it answers which
  Pods a workload would adopt, not which it owns (ADR-0015).
- **Reconnect on every end and read the error text** to learn a container's
  state, as `kubectl logs -f` does since 1.37. Every waiting state is the
  same `400` with a different message, and a clean end says nothing.
- **Hold back the kubelet instead of dropping.** A slow reader would then
  show lines further and further behind the present, and would hit the
  rotation failure above.
- **One request per Pod with all containers.** The API has no such request:
  a log request names one container.
- **Sort the whole stream by timestamp,** holding lines until every container
  has passed a point in time. A quiet container would hold up the others, or
  need a timeout that is the same batch window.
- **Count the lines sent within the cursor's second and skip that many,** as
  `stern` does. It is exact for equal timestamps, but skips new lines when
  the file has been rotated since.

## Consequences

- A Log Stream of 20 Pods holds 20 Pod watches and one follow request per
  container. Requests for logs use their own client, with no request timeout
  and their own rate limit, so opening many does not delay lists and watches.
- Standard output and standard error cannot be told apart. The API offers a
  way only behind a feature gate that is off by default in Kubernetes 1.37.
- History comes from the current log file only, because that is all the API
  reads. Right after a rotation a container has little history to show.
- Selecting a Log Stream with a Query needs only another way to choose the
  Pods. The container readers, the merge, and the resume rule do not depend
  on how the Pods were found.
