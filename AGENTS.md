# Agent notes

Read `CONTEXT.md` for the project's vocabulary and `docs/adr/` for the
decisions behind the architecture. Use the terms from `CONTEXT.md` in code,
comments, and UI copy.

## Commands

Use Mise tasks (`mise tasks` lists them). `mise run check` must pass before
committing. `mise run e2e` needs Docker.

## Layout

- `engine/`: Go Engine. `internal/protocol` is the wire contract.
- `packages/engine-client/`: typed client, Web Worker connection, React hooks.
- `packages/ui/`: shadcn components (`src/components` is CLI-managed and
  excluded from oxlint; add components with `bunx --bun shadcn@latest add`
  from `packages/ui`), plus the design tokens in `src/styles/globals.css`.
- `apps/app/`: the UI; features live in `src/features/<feature>/`.
- `apps/desktop/`: Electron main and preload.
- `e2e/`: Playwright tests for the web and desktop hosts.

## Hazards

- **Protocol changes:** edit `engine/internal/protocol`, then run
  `mise run gen`. For tygo to generate TypeScript unions, enum constants must
  start with their type's name (`ClusterPhaseReady`). `tstype` tags must not
  contain commas.
- **Nil slices:** Go encodes nil slices as `null`, which crashes clients that
  expect arrays. Initialize slices that go on the wire.
- **Desktop bundling:** Bun inlines `__dirname` and `import.meta.dirname` at
  build time, so locate app files with `app.getAppPath()`. Keep the main
  process CommonJS, because Playwright's Electron launcher cannot drive an ES
  module entry point.
- **Chromium sandbox:** Ubuntu 24.04+ blocks the unprivileged user namespaces
  Chromium's sandbox uses. Pass `--no-sandbox` only to development and test
  launches, never in shipped code.
- **Test clusters:** the e2e k3d cluster's kubeconfig is written to
  `.data/e2e/kubeconfig`. Never merge it into `~/.kube/config`.
- **envtest:** `go test` skips Engine integration tests without
  `KUBEBUILDER_ASSETS`; use `mise run test:engine`.
