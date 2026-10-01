# Timeline retention: an in-memory replay buffer, plus explicit Recordings

Retaining every Change for every connected Cluster indefinitely costs memory
and disk that most sessions never use. The Engine therefore keeps a bounded,
in-memory Replay Buffer per connected Cluster, limited by both a time window
and a memory cap (whichever is reached first), which supports replaying recent
activity. Anything longer-lived is a Recording: the user explicitly starts it,
scopes it with a Query, and it is saved to disk as a self-contained file that
can be replayed later without access to the Cluster.

## Consequences

- Nothing about the Timeline is persisted unless a Recording is running.
- A new Recording starts with whatever the Replay Buffer holds for its scope,
  so noticing a problem and then pressing record still captures its lead-up.
- Replay fidelity depends on what the Engine was fully watching. Types it only
  watches as metadata yield Changes without full before-and-after Manifests.
  A Recording fully watches whatever its Query matches from the moment it
  starts.
- Kubernetes Events are always kept in the Replay Buffer in full, regardless
  of what else is fully watched, because they are small and are usually the
  most useful part of a replay.
- Because a Recording replays offline, the file must carry everything replay
  needs: the initial state of its scope, the Resource Type definitions it
  touches, and the Changes and Events that follow.
- Recordings are files that get shared, so Secret data is excluded by default
  and only Secret metadata is recorded. Including Secret data is an explicit
  opt-in.
