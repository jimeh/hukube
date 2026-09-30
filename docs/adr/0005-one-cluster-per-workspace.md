# One Cluster per Workspace

A Workspace belongs to exactly one Cluster, and its Panes can only show that
Cluster's Resources. Multiple Clusters are handled with top-level cluster tabs,
and dragging one out opens it in its own window. Mixing Clusters inside one
Workspace makes it too easy to act on the wrong Cluster.

## Consequences

- A cross-Cluster comparison, if we build one, is an explicit and visually
  distinct feature, not two Panes side by side.
- Workspace layouts are persisted per Cluster.
