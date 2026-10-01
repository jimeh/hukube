# The Engine stores Workspaces and settings

Workspace layouts, Saved Queries, Port Forward definitions, and user settings
are stored by the Engine, not in each UI client. Every window and both Hosts
then see the same state, and dragging a Cluster tab out into a new window only
needs to open that Workspace, not move state between clients.

## Consequences

- Several clients can have the same Cluster open at once, such as desktop
  windows and browser tabs on the web Host, so the Engine never assumes one
  owner per Workspace.
- For now, a Workspace layout is read when its Cluster opens and saved after
  each change, and the last save wins. A client does not pick up layout
  changes another client makes while both are open, and its next save
  replaces them. Live syncing, or rejecting stale saves, can replace this
  later without changing where the state lives.
- Once the web Host has real authentication, stored state must be keyed per
  user.
