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

Run `dev:verify` and `e2e` sequentially. Both Hosts serve `apps/app/dist`,
and a Vite rebuild replaces it, so rebuilding for one can give the other
Host a 404 during a test.

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
  confuse or slow a user, or looks unfinished. Tests do not judge this. For a
  feature a user sees or touches, also run the `ux-review` skill before the
  code review: a fresh reviewer finds the feature without being told where it
  is, covers the not-permitted, Cluster-unreachable, and Engine-lost states,
  and re-checks the fixes. Your own check does not replace it.
- **Ask before adding a key binding.** Shortcuts are scarce, and one taken
  casually is not there for the feature that needs it.

## Layout

- `engine/`: Go Engine. `internal/protocol` is the wire contract.
- `packages/engine-client/`: typed client, Web Worker connection, React hooks.
- `packages/ui/`: shadcn components (`src/components` is CLI-managed and
  excluded from oxlint; add components with `bunx --bun shadcn@latest add`
  from `packages/ui`, piping `yes n` to keep existing components, because
  `--yes` still asks before overwriting), plus the design tokens in
  `src/styles/globals.css`. `dialog.tsx` and `alert-dialog.tsx` carry a local
  change, `useModalInert`, which keeps Tab inside an open modal dialog, and
  `combobox.tsx` adds `ComboboxStatus` and `useComboboxFilteredItems`, which
  the registry's version lacks; keep them when the CLI offers to overwrite
  these files.
- `packages/host/`: the `Host` interface the UI uses for platform features.
- `packages/k8s/`: Kubernetes helpers: Resource URIs, type keys, and ages.
- `apps/app/`: the UI; features live in `src/features/<feature>/`.
- `apps/desktop/`: Electron main and preload.
- `e2e/`: Playwright tests for the web and desktop hosts.

## Hazards

- **Cluster mutations:** register requests that change a Cluster with
  `handleMutation`, and streams that do with `handleMutationStream`, so
  `--read-only` covers them. Run preflight and dry runs
  under the request context. Never run a real PATCH or DELETE under it:
  use `context.WithoutCancel` with `Timing.WriteTimeout`, so a write already
  sent finishes after a cancel or a lost socket.
- **Protocol changes:** declare methods in `engine/internal/protocol/methods.go`
  and edit wire types in `engine/internal/protocol`, then run `mise run gen`.
  It writes `protocol.gen.ts`, `methods.gen.ts`, and `hash.gen.go`. Export new
  runtime constants from `packages/engine-client/src/index.ts` too. Rebuild and
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
- **Stream sockets:** a Log Stream or an Exec Session runs on its own
  socket at `/ws/stream` (ADR-0016). The Engine sends data only while the
  client acknowledges it, so a client that reads frames without sending
  `ack` stalls after 1 MiB.
- **Pod logs:** envtest has no kubelet, so a log request cannot succeed
  there. Tests replace the log opener (`openPodLogs` in `server`) or use the
  fakes in `logstream`. A `rest.Config` with a `Timeout` ends a follow at
  that duration, which is why log requests have their own client.
- **Exec Sessions:** envtest has no kubelet, so nothing can be executed
  there. Tests replace the executor (`newPodExecutor` in `server`) or use the
  fakes in `execsession`. The fallback from WebSocket to SPDY must test for
  the upgrade error with `k8s.io/streaming/pkg/httpstream`; the helper of
  the same name in `k8s.io/apimachinery` returns false for the error
  client-go returns. The Engine owns a session (ADR-0026): a socket that
  closes only detaches, and the Engine hangs the session up (ADR-0022) under
  its own context when its Tab closes (`exec.end`), when no window has been
  attached for 10 minutes, or when the Engine stops. Nothing may make the
  executor's output writer wait, or client-go ends the session after 61
  seconds. The index is empty while a type is listed, so only the Cluster
  can say a Pod is gone.
- **The mode tracker follows xterm.js:** `execsession/tracker.go` is a port
  of xterm.js 6.0.0's parser table, UTF-8 decoder, and mode handlers, and
  decides where a session's output may be cut. It must read bytes exactly as
  the installed xterm.js does. `features/exec/tracker-golden.test.ts` checks
  the Engine's golden files against xterm.js, so run it after upgrading
  xterm.js. After changing the tracker or the recordings, regenerate the
  golden files from `engine/` with
  `mise exec -- go test ./internal/execsession -run TestTrackerGolden -update`.
- **Session keys:** every key decision for a focused Exec Session is in
  `features/exec/keys.ts` (ADR-0023). `Mod+J` must stay unhandled there too.
- **Sessions outlive their panel:** the window's store in
  `features/exec/sessions.ts` owns each session's stream and terminal. A
  panel that mounts again must not start, end, or reset a session. Only a
  closed Tab ends one (`endSession`); a closed Workspace detaches its
  sessions first (`detachClusterSessions`). The Workspace, not the panel,
  attaches a restored session Tab, because a hidden panel may never mount. A resize
  sent just after a session starts makes a shell print its prompt again and
  drop what was typed, so a session starts at its terminal's real size, and
  a change to the session Tab's header must not change its height while a
  session is live. When a notice runs a new command, commit the new Tab params
  and header before calling `startSession`, so it refits to the new layout.
- **Exec commands:** keep the typed line in Tab params and settings. Split it
  with `features/exec/command.ts` only when the user starts a session; an
  attachment never runs or splits it again (ADR-0026). Never rebuild a line
  with `shell-quote`'s `quote`: escaped literal globs do not round-trip through
  its `parse` (ADR-0025).
- **xterm.js:** import it only through `apps/app/src/lib/xterm.ts`, which
  loads it on demand. It cannot be sized in a hidden or detached element. In
  Chromium a terminal that is showing draws with WebGL (ADR-0024), so its
  screen is a canvas: a test that reads the screen sets `localStorage`'s
  `hukube.terminal.renderer` to `dom` first. Playwright's `deviceScaleFactor`
  does not reach the WebGL canvas, which then draws at the wrong scale. To
  look at a high-density screen, launch with `--force-device-scale-factor`
  and a `null` viewport.
- **Monaco:** `monaco-editor/editor/editor.api` has no find, clipboard, or
  icon font. `apps/app/src/lib/monaco.ts` imports them and removes the key
  bindings they add beyond find, so import Monaco from there. Its text
  buffer keeps every character an edit adds, a lone `\r` in inserted text
  starts a line, and the view moves when lines above it are deleted
  (ADR-0018).
- **Edit reviews and writes:** reviews and access requests are cancellable;
  apply and delete requests must never receive an AbortSignal. A write that
  fails with `not_connected` was never sent. One that fails with
  `disconnected` has an unknown outcome: keep its params and repeat them when
  the Engine reconnects, but only while its edit or its confirmation still
  exists, so nothing is written after the user backed out. Delete
  confirmations retain the UID they opened for, even if the live Manifest is
  replaced while the dialog is open.
- **YAML parsing:** rendering and parsing use `features/edit/yaml.ts`, which
  matches kubectl's YAML 1.1 scalar rules. Using `yaml` defaults changes the
  meaning of values such as `0644` and `yes`.
- **Panels attach late:** dockview can run a panel's effects before it
  attaches the panel's element, and a detached element resolves every CSS
  custom property to nothing. Check `isConnected` before reading styles.
- **Test clusters:** the e2e k3d cluster's kubeconfig is written to
  `.data/e2e/kubeconfig`. Never merge it into `~/.kube/config`.
- **End-to-end lists:** tests share one Engine and one Workspace within a run,
  so a test finds lists earlier tests opened. Scope each list's locators to its
  tab panel, and select the Facet a test needs, because a Resource tab opens
  on the Facet an earlier test left. A test that reloads must first wait for
  the Engine to acknowledge the layout it depends on (`savedLayout` in
  `e2e/tests/exec.ts`), or the reload restores an older one. A run's
  Namespace is deleted without waiting, so a second run started within a
  minute can find the first run's Resources by name.
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
