# The Engine owns cluster state and serves live queries

The Engine holds each Cluster's state and answers Queries. UI clients subscribe
to a Query and receive a snapshot followed by patches, scoped to what they
display (for example, one sorted and filtered window of rows). The UI never
downloads full lists of Resources. This keeps protocol traffic proportional to
what is on screen and lets search, sorting, and Relationships work across every
Resource Type without the UI knowing about them.

## Consequences

- The Engine watches metadata for every listable Resource Type so it can
  index all Resources cheaply. Full objects are fetched and watched only for
  what a client is looking at or what a feature needs.
- The Engine maintains the Relationship graph and derives Apps.
- The Engine records observed Changes from the moment it connects to a
  Cluster, because the Timeline cannot be reconstructed after the fact.
  Retention is covered by ADR-0008.
