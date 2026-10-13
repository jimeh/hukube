# The Engine's token grants writes, unless the Engine runs read-only

Until editing existed, the Engine's token gave whoever held it read access
to everything the kubeconfig's credentials could read. It now gives write
access too: a client with the token can change or delete any Resource those
credentials can. An Exec Session will add a process in a container to that.

The token is still the only check (ADR-0007). On the desktop Host it never
leaves the machine. `mise run dev:tailnet` is different: it prints a URL
with the token for other devices, and anyone on the tailnet who has that URL
has the kubeconfig's access.

The Engine therefore has a way to run without mutations.
`hukube-engine --read-only` refuses every request that changes a Cluster
with `forbidden`. Each such request is registered through one wrapper that
makes the check, so a new mutation cannot miss it. `resource.access` reports
the mode, and the UI disables Edit and Delete with the reason.

`mise run dev:tailnet` runs the Engine read-only unless
`HUKUBE_TAILNET_WRITE=1` is set.

## Considered Options

- **No such mode.** The token already guards the Engine, and a fresh one is
  made for each tailnet run. A leaked URL would then cost what the
  kubeconfig can do instead of what it can see.
- **A second token for writes.** It needs a way to hand two tokens to a
  client and a place in the UI to enter one. ADR-0007 defers real
  authentication, and this would be a piece of it built early.
- **Read-only credentials in the kubeconfig.** This is the strongest
  control and remains the right one for a Cluster that matters. It is the
  user's to set up, and hukube cannot assume it.
- **A setting per Cluster,** such as marking one as production. It is a
  separate feature with its own UI, and it restricts a user, not a token.

## Consequences

- The flag covers the whole Engine, not a Cluster or a client.
- Read-only is enforced in the Engine. The UI's disabled controls are a
  courtesy.
- Whatever changes a Cluster later, such as an Exec Session or a Port
  Forward, must decide whether it is a mutation and register accordingly.
- Trying an edit from another device on the tailnet takes an explicit
  `HUKUBE_TAILNET_WRITE=1`.
