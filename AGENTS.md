# Agent notes

Read `CONTEXT.md` for the project's vocabulary and `docs/adr/` for the
decisions behind the architecture. Use the terms from `CONTEXT.md` in code,
comments, and UI copy.

## Commands

Use Mise tasks (`mise tasks` lists them). Run `mise run setup` in a fresh
clone or worktree: it installs JavaScript dependencies and a pre-commit hook
that formats staged files, then lints and typechecks what they affect.
`mise run check` runs every check, including tests, and must pass before
pushing. Format, lint, and TypeScript test tasks require the checkout's installed
binaries; run `mise run setup` if they are missing. `mise run e2e` needs Docker.

Pass a file or test name to run focused tests:
`mise run test:ts -- packages/k8s/src/age.test.ts` or
`mise run test:engine -- -run TestFind`. The `fmt:*` and `lint:*` tasks also
take files; Go paths are relative to `engine/`.

## Checking UI changes

`mise run dev:verify` rebuilds the Engine and UI, seeds the sample Resources
in `e2e/fixtures/sample` into the e2e k3d cluster, and starts a web Host in
the background on a free port. It prints the URL with its token, also saved in
`.data/verify/url`, and logs to `.data/verify/engine.log`. Rerun it after a
change and stop it with `mise run dev:verify:stop`; do not `pkill -f`, which
can match your own shell. It never touches the clusters in your kubeconfig.

## Designing features

- **Plan the UI and UX.** For anything a user sees or touches, the plan says
  where each control goes and why, which common pattern or comparable tool it
  follows, how the keyboard and the pointer reach it, and what the empty,
  loading, and error states show. Placement decided while coding is rarely
  where a user looks.
- **Follow common patterns.** A user should understand a feature from the
  tools they already know. Put a control where the thing it acts on is:
  column actions belong on the column header, not in a list's filter toolbar.
- **Use established packages for solved problems.** Do not hand-roll a common
  interaction or component, such as drag-and-drop, menus, virtual lists,
  editors, or terminals, to avoid a dependency. The hand-rolled version costs
  more to own and usually does less. Check a package's current version and
  maintenance first, and say in the plan why nothing fit before writing your
  own.
- **Review the running app before calling a feature done.** Use it as a new
  user would, in both themes and at more than one width. Fix what would
  confuse or slow a user, or looks unfinished. Tests do not judge this.
- **Ask before adding a key binding.** Shortcuts are scarce, and one taken
  casually is not there for the feature that needs it.

## Layout

- `engine/`: Go Engine. `internal/protocol` is the wire contract.
- `packages/engine-client/`: typed client, Web Worker connection, React hooks.
- `packages/ui/`: shadcn components (`src/components` is CLI-managed and
  excluded from oxlint; add components with `bunx --bun shadcn@latest add`
  from `packages/ui`, piping `yes n` to keep existing components, because
  `--yes` still asks before overwriting), plus the design tokens in
  `src/styles/globals.css`.
- `packages/host/`: the `Host` interface the UI uses for platform features.
- `packages/k8s/`: Kubernetes helpers: Resource URIs, type keys, and ages.
- `apps/app/`: the UI; features live in `src/features/<feature>/`.
- `apps/desktop/`: Electron main and preload.
- `e2e/`: Playwright tests for the web and desktop hosts.

## Hazards

- **Cluster mutations:** register requests that change a Cluster with
  `handleMutation`, so `--read-only` covers them. Run preflight and dry runs
  under the request context. Never run a real PATCH or DELETE under it:
  use `context.WithoutCancel` with `Timing.WriteTimeout`, so a write already
  sent finishes after a cancel or a lost socket.
- **Protocol changes:** declare methods in `engine/internal/protocol/methods.go`
  and edit wire types in `engine/internal/protocol`, then run `mise run gen`.
  It writes `protocol.gen.ts`, `methods.gen.ts`, and `hash.gen.go`. Rebuild and
  restart the Engine after a protocol change, or the UI shows the out-of-date
  notice. For tygo to generate TypeScript unions, enum constants must
  start with their type's name (`ClusterPhaseReady`). `tstype` tags must not
  contain commas. Stage or stash all protocol source changes before the hook
  checks the staged generated types.
- **Wire encoding:** Go encodes nil slices as `null`, which crashes clients
  that expect arrays, so initialize slices that go on the wire. It encodes
  `[]byte` as a base64 string, so put pre-encoded JSON in an `any` field such
  as `ServerMessage.Data` as `json.RawMessage`.
- **Resource identity:** a UID is not unique across Resource Types. A Resource
  served under two types, such as an Event under `events` and
  `events.events.k8s.io`, appears under both with the same UID, so keys must
  include the type, as Resource URIs do.
- **Query windows:** `QueryResult` and `FindResult` hold at most `limit` rows,
  and `total` counts every match. Code that needs every match, such as a
  Namespace list, must check `total` rather than assume it has them all.
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
  launches, never in shipped code. agent-browser takes it as
  `--args --no-sandbox`.
- **Stream sockets:** a Log Stream runs on its own socket at `/ws/stream`
  (ADR-0016). The Engine sends data only while the client acknowledges it,
  so a client that reads frames without sending `ack` stalls after 1 MiB.
- **Pod logs:** envtest has no kubelet, so a log request cannot succeed
  there. Tests replace the log opener (`openPodLogs` in `server`) or use the
  fakes in `logstream`. A `rest.Config` with a `Timeout` ends a follow at
  that duration, which is why log requests have their own client.
- **Monaco:** `monaco-editor/editor/editor.api` has no find, clipboard, or
  icon font. `apps/app/src/lib/monaco.ts` imports them and removes the key
  bindings they add beyond find, so import Monaco from there. Its text
  buffer keeps every character an edit adds, a lone `\r` in inserted text
  starts a line, and the view moves when lines above it are deleted
  (ADR-0018).
- **Panels attach late:** dockview can run a panel's effects before it
  attaches the panel's element, and a detached element resolves every CSS
  custom property to nothing. Check `isConnected` before reading styles.
- **Test clusters:** the e2e k3d cluster's kubeconfig is written to
  `.data/e2e/kubeconfig`. Never merge it into `~/.kube/config`.
- **End-to-end lists:** tests share one Engine and one Workspace within a run,
  so a test finds lists earlier tests opened. Scope each list's locators to its
  tab panel. A run's Namespace is deleted without waiting, so a second run
  started within a minute can find the first run's Resources by name.
- **envtest:** without `KUBEBUILDER_ASSETS`, `go test` reports `ok` for the
  `cluster` and `server` packages without running any of their tests, unit
  tests included; use `mise run test:engine`.
- **Dependency cooldown:** `bunfig.toml`, `mise.toml`, and Dependabot skip
  releases younger than 7 days. For an urgent security fix, add the package to
  Bun's `minimumReleaseAgeExcludes` or pin the exact tool version.
- **Tool lockfile:** CI installs tools with `mise install --locked`, which
  fails if `mise.lock` lacks a tool or its download URL. Run `mise lock` after
  changing `[tools]`; `mise run lint:mise` checks it.
- **GitHub Actions:** `uses:` references are pinned to commit SHAs, and
  `mise run lint` fails on unpinned ones. Run `mise run pin:actions` after
  adding or bumping an action.
