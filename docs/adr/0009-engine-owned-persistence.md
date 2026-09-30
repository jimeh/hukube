# The Engine stores Workspaces and settings

Workspace layouts, Saved Queries, Port Forward definitions, and user settings
are stored by the Engine, not in each UI client. Every window and both Hosts
then see the same state, and dragging a Cluster tab out into a new window only
needs to open that Workspace, not move state between clients.

## Consequences

- UI clients read and write this state through the protocol and receive
  changes made by other clients, so two windows never overwrite each other
  with stale copies.
- Once the web Host has real authentication, stored state must be keyed per
  user.
