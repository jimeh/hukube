# Agent notes

Read `CONTEXT.md` for the project's vocabulary and `docs/adr/` for the
decisions behind the architecture. Use the terms from `CONTEXT.md` in code,
comments, and UI copy.

## Commands

Use Mise tasks (`mise tasks` lists them). Run `mise run setup` in a fresh
clone or worktree: it installs JavaScript dependencies and a pre-commit hook
that formats staged files, then lints and typechecks what they affect.
`mise run check` runs every check, including tests, and must pass before
pushing. `mise run e2e` needs Docker.

Pass a file or test name to run focused tests:
`mise run test:ts -- packages/k8s/src/age.test.ts` or
`mise run test:engine -- -run TestFind`. The `fmt:*` and `lint:*` tasks also
take files; Go paths are relative to `engine/`.

## Layout

- `engine/`: Go Engine. `internal/protocol` is the wire contract.
- `packages/engine-client/`: typed client, Web Worker connection, React hooks.
- `packages/ui/`: shadcn components (`src/components` is CLI-managed and
  excluded from oxlint; add components with `bunx --bun shadcn@latest add`
  from `packages/ui`), plus the design tokens in `src/styles/globals.css`.
- `packages/host/`: the `Host` interface the UI uses for platform features.
- `packages/k8s/`: Kubernetes helpers: Resource URIs, type keys, and ages.
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
- **Custom-scheme origins:** `new URL("hukube://app/...").origin` is `"null"`,
  so compare scheme and host (`originOf` in `apps/desktop/src/main.ts`), not
  `URL.origin`.
- **Engine hostnames:** the Engine refuses requests whose `Host` is not a
  loopback name, to block DNS rebinding. Anything that serves or proxies it
  under another name must pass `--allow-host`, as `dev:tailnet` does.
- **Chromium sandbox:** Ubuntu 24.04+ blocks the unprivileged user namespaces
  Chromium's sandbox uses. Pass `--no-sandbox` only to development and test
  launches, never in shipped code.
- **Test clusters:** the e2e k3d cluster's kubeconfig is written to
  `.data/e2e/kubeconfig`. Never merge it into `~/.kube/config`.
- **envtest:** `go test` skips Engine integration tests without
  `KUBEBUILDER_ASSETS`; use `mise run test:engine`.
- **Dependency cooldown:** `bunfig.toml` and `mise.toml` skip releases younger
  than 7 days. For an urgent security fix, add the package to Bun's
  `minimumReleaseAgeExcludes` or pin the exact tool version.
- **GitHub Actions:** `uses:` references are pinned to commit SHAs, and
  `mise run lint` fails on unpinned ones. Run `mise run pin:actions` after
  adding or bumping an action.
