# The web Host is supported from day one, with placeholder auth

Because the UI is a client of the Engine (ADR-0002), the browser is a
first-class Host alongside the desktop app from the start. Real multi-user
authentication is deferred. For now, the Engine uses the kubeconfig of the
machine it runs on, for development and testing only.

## Consequences

- UI code reaches platform features (windows, file dialogs, clipboard,
  notifications, opening external links) only through a Host interface with
  desktop and browser implementations.
- Until real authentication exists, the Engine binds to loopback only and
  requires a per-launch token on every socket. It must not be exposed on a
  network.
- The Engine resolves Cluster credentials through a single seam, so per-user
  identity (such as OIDC with impersonation) can replace the kubeconfig later
  without touching the protocol.
- Port Forwards bind on the Engine's machine, so they are only useful to a
  user when the Engine runs locally.
