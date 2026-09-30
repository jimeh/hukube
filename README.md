# hukube

A desktop and web app for monitoring, inspecting, and editing Kubernetes
clusters, built around a VSCode-style workspace of tabs and split panes.

hukube is early. It can browse every resource type a cluster serves, including
CRDs, with live counts and lists, and show any resource's YAML as it changes.

## How it fits together

```
 Desktop (Electron) ─┐                        ┌─ kube-apiserver
                     ├─ WebSocket ─ Engine ───┤   (one per kubeconfig context)
 Browser ────────────┘   (token)    (Go)      └─ ...
```

- `engine/`: the Go Engine. It connects to clusters, indexes metadata for
  every resource type, and serves live queries to UI clients.
- `apps/app/`: the React UI, shared by both hosts.
- `apps/desktop/`: the Electron host, which starts its own Engine.
- `packages/`: the Engine client and generated protocol types, host
  abstraction, Kubernetes helpers, and shared UI components.

Design decisions live in [`docs/adr/`](docs/adr), and the project's vocabulary
in [`CONTEXT.md`](CONTEXT.md).

## Development

Tools are managed with [mise](https://mise.jdx.dev):

```sh
mise install          # Bun, Go, linters, k3d, kubectl
mise run install      # JavaScript dependencies
```

Run the web host against your kubeconfig, then open
<http://localhost:5173/#token=dev>:

```sh
mise run dev
```

Run the desktop host:

```sh
mise run dev:desktop
# On Linux hosts that block unprivileged user namespaces (Ubuntu 24.04+):
HUKUBE_ELECTRON_FLAGS=--no-sandbox mise run dev:desktop
```

Serve the built UI from the Engine, as the web host does outside development:

```sh
mise run web          # prints a URL including the Engine's token
```

The Engine only listens on loopback and requires a token. It has no user
authentication yet, so do not expose it on a network.

## Checks

```sh
mise run check        # format, lint, typecheck, generated code, unit and integration tests
mise run e2e          # end-to-end tests in a k3d cluster (needs Docker)
```

Run `mise tasks` for everything else.
