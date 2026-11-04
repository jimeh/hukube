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
in [`GLOSSARY.md`](GLOSSARY.md).

## Development

Tools are managed with [mise](https://mise.jdx.dev):

```sh
mise install --locked # Bun, Go, linters, Treeboot, k3d, kubectl
mise run setup        # JavaScript dependencies and the pre-commit hook
```

Run the web host against your kubeconfig, then open
<http://localhost:5173/#token=dev>:

```sh
mise run dev
```

Share the web host with other devices on your Tailscale network. The task
binds the dev server to this node's Tailscale IP only, keeps the Engine on
loopback, and prints a URL with a fresh Engine token:

```sh
mise run dev:tailnet  # → http://<node>.<tailnet>.ts.net:5173/#token=...
```

The Engine token grants the kubeconfig credentials' read and write access,
unless the Engine runs with `--read-only`. This task is read-only by default.
Anyone with its URL has that access. To allow editing and deleting Resources:

```sh
HUKUBE_TAILNET_WRITE=1 mise run dev:tailnet
```

It serves plain HTTP, which Tailscale encrypts in transit. To use another
hostname that resolves to the Tailscale IP, set it in an ignored
`mise.local.toml`:

```toml
[env]
HUKUBE_TAILNET_HOST = "hukube.example.com"
```

Run the desktop host:

```sh
mise run dev:desktop
# On Linux hosts that block unprivileged user namespaces (Ubuntu 24.04+):
HUKUBE_ELECTRON_FLAGS=--no-sandbox mise run dev:desktop
```

Check a change against sample Resources in the e2e k3d cluster (needs
Docker). The Engine runs in the background until you stop it:

```sh
mise run dev:verify       # prints a URL including the Engine's token
mise run dev:verify:stop
```

Serve the built UI from the Engine, as the web host does outside development:

```sh
mise run web          # prints a URL including the Engine's token
```

The Engine only listens on loopback and requires a token. It has no user
authentication yet, so do not expose it on a network.

## Worktrees and private test Clusters

In a linked worktree, `mise run worktree:bootstrap` runs Treeboot 0.16.0 and
then the existing setup task. Repeat bootstrap runs setup again. It does not
copy configuration, credentials or ignored files, or create a Cluster. In the
root checkout Treeboot bootstrap is a no-op; run `mise run setup` directly.
CI runs the ordinary install/check/e2e entrypoints without bootstrap.

`mise run e2e:cluster`, `mise run dev:verify` and `mise run e2e` resolve the
canonical Git checkout path with Treeboot's public `worktree id` command.
Each checkout, including the root, owns `hukube-e2e-<12-character-id>` and
`.data/e2e/kubeconfig`. The wrapper exports the validated identity to child
processes. Direct Playwright invocation without that environment fails.
Inherited Cluster names, kubeconfig paths and Engine URLs cannot select a
target. The old shared `hukube-e2e` Cluster is never adopted or deleted.

Repeat runs reuse only a Cluster whose full canonical path matches the
`dev.hukube.test-owner` Docker label (UTF-8 encoded as base64url). A verified
stopped Cluster is started explicitly. Lifecycle commands serialize through
`.data/e2e/lifecycle.lock`. A live, stale or unverifiable lock fails with its
exact path, process evidence and recovery instruction; it is never reclaimed
automatically. Query errors and foreign or unprovable partial resources also
fail closed. Failed creates retain resources for inspection and disable k3d's
by-name rollback. k3d subprocesses also use checkout-local default and
standalone config paths, because k3d deletion otherwise edits user config.

Each E2E web Engine binds `127.0.0.1:0`. Playwright captures its spawned
process's ready URL and probes `/healthz` before using it. Worktrees can run
concurrently. Within one checkout, run only one `dev:verify` or E2E workflow
at a time, including repeated E2E runs: they share the Cluster, Engine data
and UI bundle. Use separate worktrees for concurrent verification.

Before relocating or removing a linked worktree:

```sh
mise exec -- treeboot teardown --yes
# Or explicitly, including in the root checkout:
mise run worktree:teardown
```

Teardown stops the recorded verification Host and deletes only the verified
private Cluster. Treeboot rejects teardown of the root checkout and never
removes a worktree itself. `mise run e2e:cluster:delete` deletes just the owned
Cluster; it does not stop a verification Host.

A relocated path gets a new ID. Changing `.treeboot.toml`'s ID length also
renames Clusters and requires updating the harness's twelve-character guard.
Clean up using the old path and configuration first. Removing a worktree with
another tool can leave a Cluster behind. There is no automatic orphan manager:
deliberately inspect the exact container name and decode its complete
`dev.hukube.test-owner` label before operator cleanup. Another checkout will
neither adopt nor delete that orphan. Unlabelled auxiliary resources left by a
failed create require deliberate inspection of the exact names in the error.

## Checks

```sh
mise run check        # format, lint, typecheck, generated code, unit and integration tests
mise run e2e          # end-to-end tests in a k3d cluster (needs Docker)
```

Run `mise tasks` for everything else.
