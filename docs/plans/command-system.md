# Commands, palette, and keyboard shortcuts

Deliver one PR based on Settings PR #29, `feat/settings-log-retention` at
`783f7383855e4d171cc15a0855fdbe69a2180c60`. This plan implements Jim's approved
contract. It does not include the alternative Settings implementation, Pane zoom
PR #30, Log Stream filtering, or the draft test-isolation harness.

## Source and decisions

- `routes/__root.tsx` owns the window and keeps hidden Workspaces and visited
  Settings mounted. Put one command runtime and keyboard arbiter here.
- `workspace/workspace.tsx` owns Dockview and navigation APIs. Its current
  `GoToResource` component owns a per-Workspace key listener; remove that
  listener when moving palette ownership to the window. Preserve its input
  parser, Namespace completeness, query windows and results semantics.
- `workspace/panel-tab.tsx` uses `guardPanel` and `closeSessionTab`; commands
  and pointer actions must share those guards. `use-panel-edit.ts` owns review
  and permission checks. Never reproduce its write workflow.
- `lib/xterm.ts` and `exec/keys.ts` own terminal bytes, selection, input-held
  state and the browser paste path. `lib/monaco.ts` removes extra Monaco
  bindings but installs Find. Central arbitration must avoid executing it twice.
- `settings/preferences.ts` has revision guards and confirmed state, but its
  scalar field queue is unsuitable for arrays. Reuse the guarded-write
  principles in a bounded keyboard store, not a persistence-framework rewrite.
- Huterm's `docs/keybindings.md`, protocol catalog and GPUI dispatch are
  references for typed commands, argument collection and last-good reload.
  Hukube uses its existing React and Engine owners, not native GPUI routing.
- Use existing Zod, shadcn/cmdk `CommandDialog`, inputs, buttons, menus and
  dialogs. Pin headless `@tanstack/hotkeys` **0.18.0** and `jsep` **1.6.0**.
  Registry publication dates and published declarations were checked Nov 1;
  both meet the seven-day cooldown. No React hotkeys adapter is needed.
  The core exports parser, normalization, matching, formatting, sequences and
  `HotkeyRecorder`; accept it only after focused installed-version seam tests.
  If a required capability fails, compare eligible tinykeys 4.0.1 and report
  the concrete seam issue before replacing the approach.

## Runtime and feature adapters

Create `features/commands/` for a static typed catalog, argument validation,
captured targets, execution, context, keyboard normalization, conditions,
keymap compilation/resolution, persistence and palette. Keep these modules
separate with small typed boundaries. Use stable namespaced IDs and named JSON
arguments. Each definition supplies title, category, description, Zod schema,
prompt field metadata, target requirement, availability reason and repeat
policy (single execution unless explicitly repeatable).

All catalog-covered menus, buttons, palette choices and keyboard invocations
use one validate/resolve/availability/execute path. Feature owners expose small
adapters for their existing APIs; registering an owner is not evidence that it
is active. Resolve ownership from the active route and Dockview's actual
Workspace/Pane/Tab identity. A registry stores capability references, not a
second copy of feature state. Registration and cleanup are identity-safe.

Capture an immutable invocation origin before any palette focus movement:
route, Workspace generation, Pane and Tab identity, Tab component/params,
Resource URI with Resource UID when known, session identity and focus element.
An explicit Resource argument is separate from that origin. Before execution,
resolve the same surviving owners and revalidate identity and current
availability. Replaced Preview Tabs, a removed/recreated Workspace or Resource,
closed Tabs and moved targets fail readably rather than choosing a new active
target. A delayed guard callback rechecks its captured owner too.

Implement Workspace generation as a per-mount token, and Tab identity as its
Dockview panel object or a WeakMap token. IDs alone are insufficient because
layout restore and reopen reuse them. Each Workspace registers live capability
references including its `WorkspaceValue`, so root Resource mode can use its
types and opening APIs without a Workspace React context.

Route the bounded existing caller inventory through this path: Exec context
menu and Go to Resource event; YAML Find/Review controls and Monaco actions;
Resource panel Review controls; Log toolbar wrap/timestamps and search; PanelTab
close, middle-click and pin; theme toggle; Settings entry; Resource Type sidebar,
Resource list/Related/URI navigation that invokes the covered opening APIs.
Keep low-level owner operations separate to avoid recursive command dispatch.

Catalog:

| ID                                                                        | Arguments and behavior                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `app.commandPalette`                                                      | Open command mode.                                                                                     |
| `app.goToResource`                                                        | Open unchanged Resource search mode for the captured Workspace.                                        |
| `app.openSettings`                                                        | Optional `section`: existing categories or `keyboard-shortcuts`.                                       |
| `resource.openType`                                                       | Required `type`; optional `preview` and `beside` options using the existing opening API.               |
| `resource.open`                                                           | Required canonical `uri`; optional `preview` and `beside`, constrained to a live captured Workspace.   |
| `tab.close`                                                               | Close captured Tab through existing unsaved/session guards.                                            |
| `tab.pin`                                                                 | Pin captured Preview Tab.                                                                              |
| `editor.find`                                                             | Find in captured Manifest editor, Log Stream, or Exec terminal through its owner.                      |
| `manifest.review`                                                         | Review current captured edit through `reviewChanges`, retaining all permission and confirmation rules. |
| `appearance.setTheme`                                                     | Required `theme`: `light` or `dark`, through parent preference persistence.                            |
| `logs.setWrap`                                                            | Required boolean `enabled`, through existing Log Stream preference owner.                              |
| `logs.setTimestamps`                                                      | Required boolean `enabled`, through existing Log Stream preference owner.                              |
| `terminal.copy`, `terminal.paste`, `terminal.selectAll`, `terminal.clear` | Captured terminal actions, available only where the Host and current terminal support them.            |

Preference commands require loaded preferences without an error before calling
`change`, so unavailable stores cannot create orphaned drafts. For both opening
commands, boolean `beside: true` resolves to the captured Tab's panel ID and
fails if it no longer exists. Forward `beside`/`pane` in `openList` to the existing
`openPanel` owner, matching `openResource` instead of silently ignoring them.

Programmatic execution requires complete validated arguments. Palette and user
shortcuts may omit prompted fields; supplied invalid or unknown arguments fail.
Opening a settings form or palette never runs a remembered Exec command.
No generic Engine method, eval, shell interpolation, macro, apply or delete
command, extension host, global OS shortcut or new sibling implementation.
Pane zoom and filtering registrations remain explicitly deferred until their
real APIs arrive through an authorized base update.

## Palette experience

Provide a discoverable labelled Command palette control in the window's top
strip next to Settings. Command mode and Go to Resource are two modes of one
window-owned modal, using existing `CommandDialog`. Resource mode retains the
current grammar and Go to Resource keys. A labelled mode control supplies a
pointer and keyboard alternative without inventing another shortcut.

The same mode's shortcut toggles it closed; the other mode's shortcut switches
mode within the same modal. Connection state `outdated` closes the palette and
refuses reopening, preserving the parent's freeze. Hiding the captured
Workspace closes Resource mode and refuses its pending target commands.

Search commands by title, category, description and ID. Rows show effective
shortcut, availability reason and a target summary. Unavailable entries remain
discoverable. Empty search lists commands even with no Cluster; missing
Workspace/target commands explain why they cannot run. Refresh availability
while open, and check it again on execute. A topmost unrelated modal prevents
opening another palette; switching modes does not stack dialogs.

Enter executes complete/defaulted arguments. Otherwise show a labelled form or
picker inside the same modal; offer an explicit Edit arguments action for
optional values. Metadata creates typed string, boolean and enum fields, with
Resource Type choices when available and inline validation. Display the
captured target throughout. Escape backs out of arguments then closes search;
cancel never leaks keys to Exec. Return focus to a connected, visible origin,
or a surviving owner fallback. Loading/search failures/permission refusal use
readable status and recovery text, not silent empty results.

Commands opening follow-on UI explicitly hand over the captured return-focus
target: Review calls `edit.setFocus` before `reviewChanges`, Settings records
the real origin with `rememberSettingsOrigin` (the root must not overwrite it
with a palette input), and guarded Close hands focus to its confirmation.
Suppress palette auto-return in these handoffs. Otherwise defer focus return
until the triggering key is released or the next frame, and test that Enter,
Escape and their keypress/keyup events send no bytes to the origin terminal.

## Keyboard policy and conditions

The domain adapter uses the pinned library's normalization, matching,
formatting and recording without registering a callback per rule. One window
capture listener arbitrates once, with editor/terminal adapters as necessary.
One normalized representation powers matching, display, recorder and conflicts.

The arbiter writes one per-event verdict read by the xterm adapter. Remove the
second hard-coded execution of `execKey` in xterm; keep terminal-first byte
policy and the compiled default rules as the source of allowed commands.
Remove `opensGoToResource` and the per-Workspace shortcut listener. Disabled
terminal defaults must actually stop executing. Consume a key only when the
winning command is available for its exact target; unavailable Find in an
unowned editor or diff dialog falls through to Monaco/native browser behavior.

After consuming a stroke, consume repeats and keyup for that physical key until
release without executing twice, even if the palette changes focus. Native
paste's original keydown remains exempt from preventDefault. Test held
Mod+Shift+P on the non-macOS terminal path and the keyup/input boundary.

Carry forward every existing app shortcut and terminal allowlist entry. The
only approved new default is **Mod+Shift+P** for command palette, also an
explicit live-Exec exception. Preserve immediate Go to Resource (macOS Cmd+K;
elsewhere Ctrl+K outside live Exec and Ctrl+Shift+K inside it), and Find and
terminal defaults. **Mod+J is reserved and cannot be bound, including inside
a chord.** No illustrative sample shortcut is shipped. Update ADR-0023 and
its table/tests for the palette and explicit terminal-scoped override decision.

The default inventory uses separate stable IDs (below); platform/selection and
owner conditions narrow each rule. Existing editor/terminal shortcuts are
preserved, not new approvals. No default is inferred from a sample rule.

| Default ID                                                     | Key and context                                        | Executor                                           |
| -------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `default.resource.app`                                         | Mod+K outside a live terminal                          | Root runtime                                       |
| `default.resource.terminal.mac`                                | Cmd+K in a live macOS terminal                         | Root/runtime terminal adapter                      |
| `default.resource.terminal.other`                              | Ctrl+Shift+K in a live non-macOS terminal              | Root/runtime terminal adapter                      |
| `default.palette.app`                                          | Mod+Shift+P outside a live terminal                    | Root runtime                                       |
| `default.palette.terminal`                                     | Mod+Shift+P in a live terminal                         | Explicit approved terminal exception               |
| `default.find.editor`, `default.find.log`                      | Mod+F in a registered YAML/Log editor                  | Runtime owner callback, once                       |
| `default.find.terminal.mac`                                    | Cmd+F in a macOS terminal                              | Runtime terminal adapter                           |
| `default.find.terminal.other`                                  | Ctrl+Shift+F in a non-macOS terminal                   | Runtime terminal adapter                           |
| `default.manifest.review`                                      | Mod+S when editor text has focus and Manifest is dirty | Runtime review adapter                             |
| `default.copy.terminal.mac`                                    | Cmd+C in a macOS terminal with selection               | Runtime terminal adapter                           |
| `default.copy.terminal.other`                                  | Ctrl+C in a non-macOS terminal with selection          | Runtime terminal adapter                           |
| `default.copy.terminal.shift`                                  | Ctrl+Shift+C in a non-macOS terminal                   | Runtime terminal adapter                           |
| `default.paste.terminal.mac`                                   | Cmd+V in a macOS terminal                              | Native browser paste event through runtime verdict |
| `default.paste.terminal.other`, `default.paste.terminal.shift` | Ctrl+V / Ctrl+Shift+V in a non-macOS terminal          | Native browser paste event through runtime verdict |
| `default.selectAll.terminal.mac`                               | Cmd+A in a macOS terminal                              | Runtime terminal adapter                           |

Match the parent's ended/held-terminal exception behavior too; generic app keys
return when input is held, while supported terminal editing commands still
work. Disable the owned YAML/Log Find and YAML Review keybindings in Monaco;
retain their actions as owner operations. Keep global native Monaco Find only
for unowned editor contexts (including review diffs and Find widgets). Keep Log
Find's Enter/Shift+Enter navigation in Monaco. Effective menu/tooltip labels
come from the compiled map, replacing hard-coded Exec shortcut labels.

Rules have stable IDs, command, optional named args, one or two normalized
strokes, `when`, enabled state, and explicit `scope: app | terminal`.
Stable default IDs allow a document to disable one exact default independently
of other arguments or keys for its command. Defaults precede ordered user
rules; the last eligible matching entry wins. Show duplicates/shadowing and the
effective winner. A single stroke that competes with a chord prefix is
rejected unless disabled or proven disjoint. Be conservative: a small bounded
truth-assignment check over the typed vocabulary can prove disjointness; an
unproved pair conflicts. Exact-sequence precedence remains deterministic.

Generic app rules cannot take live terminal input. Users may deliberately
choose terminal scope; explain that it takes keys from the process. Terminal
scope still requires a focused live terminal and matches current conditions.
Default terminal exceptions are explicit, not generic app rules. Ended/held
terminals retain the parent's input behavior. Native browser paste keeps its
keydown-to-paste-event path and user activation; do not prevent it merely to
mark a command consumed. Unsupported palette paste explains the limitation.

Ignore IME/composing input including legacy keyCode 229, Dead/Process keys and
AltGraph before the library matcher/recorder can turn them into shortcuts.
Ordinary text, native text editing and list navigation stay with their owners.
Repeated action keydowns do not execute again or add recorder/chord strokes.

Use one explicit platform source for every library call. Record with
`recordBy: 'key'` so recording Mod+K equals the logical default, including
current non-Latin code fallback. The library calls a single stroke a chord and
a multi-stroke chord a sequence; adapt its names at the boundary. Use its
per-stroke matcher with our injected-clock state machine because the published
sequence helper reads `Date.now()` internally. Recorder owns its document
capture listener; window arbitration stands down while recording, while an
adapter pre-filter still excludes unsafe composition/229/Dead/AltGraph events.

Context keys are flat and typed: `platform` (`mac`, `windows`, `linux`), `host`
(`web`, `desktop`), `route` (`clusters`, `workspace`, `settings`), `workspace`
(boolean), `focus` (`input`, `editor`, `log`, `terminal`, `other`), `tabKind`
(`none`, `list`, `resource`, `exec`), `facet` (known Facets or `none`),
`terminalLive`, `terminalSelection`, `manifestDirty`, `engineConnected`,
`modalOpen`, `paletteOpen`, `recording` (booleans). Expose help and examples.

Expose a subscribed modal count from the existing `useModalInert` hook, and
subtract the palette's own known registration when computing unrelated
`modalOpen`. This also cancels chords promptly on other dialogs. Preserve the
hook's existing inert restoration behavior and document its local extension.

Compile `when` once using jsep with a whitelisted AST, then interpret it.
Allow only identifiers, `!`, `&&`, `||`, parentheses, `==`/`!=` against quoted
strings or booleans. Reject unknown identifiers, wrong value types, calls,
members, arithmetic, regex and all other AST forms. Bound conditions to 1 KiB,
32 levels and 256 nodes before/while parsing so parser recursion cannot escape
the limit. No JavaScript evaluation. Conditions are matching policy, not
permission checks.

jsep has no depth hook: pre-scan length and delimiter/unary nesting before
parsing, then validate node count/depth iteratively. Do not change its global
operator tables. Include deep unary chains and nested parentheses in tests.

Chords consume only an eligible prefix. Show an announced pending-chord hint
with Escape to cancel. Use a controllable timer (one-second default). Cancel
on timeout, Escape, blur, origin Workspace/target change, modal/recorder opening
or keymap replacement. Never replay a synthetic prefix. Recheck eligibility
and exact captured origin for the second stroke; unmatched strokes retain
normal input behavior after cancellation, without replaying consumed input.

## Keyboard shortcuts Settings

Add `/settings/keyboard-shortcuts` to the parent's responsive category
navigation. Show searchable command/default/user rows with platform labels,
IDs, args, condition, scope, enabled status, effective winner and conflicts.
Each command offers Add binding; default rows offer Disable/reset; user rows
offer Edit/record, Disable, Remove and reorder. Reset removes user changes and
default-disable IDs within the keyboard section, with explicit review/save.

Use labelled Move up/Move down buttons for reordering. Give the keyboard section
its own render branch, bypassing the parent's scalar Log Stream fields/status.

Editing uses the existing labelled controls in a draft form: command selector,
record or type one/two strokes, typed argument fields (with JSON validation
where useful), condition input with key help and terminal-scope choice.
Record mode owns keyboard input, announces pending steps and has visible
Stop/Cancel controls. Enter commits a recorded single stroke, a second stroke
completes a chord, Escape cancels recording. It cannot dispatch commands.

Explain that Backspace/Delete edit recorded steps, Enter accepts and Escape
cancels, and that Host/OS-reserved shortcuts may never reach the recorder.

Rule edits have explicit Save rule/Cancel; the full keyboard draft has Save
shortcuts/Cancel changes. Validate the entire candidate before saving. Draft
identity follows stable IDs through reorder, reload, duplicate-looking rows and
remote conflicts. Integrate keyboard dirty/pending work into existing Settings
window-close/unload protections without touching preference ownership.

Add a separate `keybindings` flag in `settings/open-work.ts` and include it in
both the desktop open-work report and beforeunload check in `UnsavedGuard`.

Loading keeps defaults active and explains loading. Conflict keeps the local
draft and last active map, shows remote revision and offers reload/discard or
an explicit reviewed retry. Offline/failed/unknown saves retain the draft and
show pending/failed/checking state accurately. Invalid/future data offers
copyable recovery data and diagnostics; unsupported versions are read-only.

## Persistence

Store a separate version-1 `app/keybindings` Engine setting containing ordered
user rules and disabled-default IDs. Preserve unknown document/rule fields and
raw recovery data. Unknown command IDs or rules carrying unrecognized future
semantic fields remain inert with diagnostics, preserved verbatim for recovery.
They never execute another action. Malformed rules for known commands fail
compilation atomically, retaining the last good map; startup uses defaults with
diagnostics. Future document versions are never overwritten by this client.

Add a protocol constant and bounded Go structural validator at settings.put.
Require `ifRevision` including empty revision. Bound the document to 64 KiB,
256 rules, unique stable IDs, two strokes, bounded strings and JSON args; Go
does not know the command catalog or expression semantics. Preserve future
fields. Regenerate wire outputs and export constants from engine-client.

Bound disabled-default IDs to 256 unique entries with bounded strings too.
The Engine accepts only version 1 writes; future stored versions remain
read-only in this client. Validate JSON argument nesting and size structurally.

The app keybinding store watches continuously once per Engine client. Save the
whole edited keyboard document with CAS and activate only after successful
settlement and matching confirmed fresh readback. No optimistic keymap switch.
Concurrent keyboard edits visibly conflict, never last-write-overwrite. On a
lost response, fresh readback can confirm the intended document; never retry
over an unseen remote edit or after the draft owner discarded it. Appearance
and Log Stream saves remain independent.

## Verification and delivery

| Risk                               | Required evidence                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package API/normalization mismatch | Installed-version seam tests for parser/matcher/format/recorder and sequence cancellation; physical/logical/platform aliases, punctuation and legacy IME filters.                                                                                                                                                                                                     |
| Wrong command or target            | Pure schema/default/unknown/missing-arg tests; integration tests for palette capture, removed/recreated Workspace/Tab/Resource, stale UID, target movement, and one dispatch with several mounted Workspaces.                                                                                                                                                         |
| Guard bypass                       | Dirty close/cancel and review permission/validation regression tests; no raw apply/delete/session rerun path.                                                                                                                                                                                                                                                         |
| Unsafe conditions/keymaps          | Typed grammar/operator/depth/size tests; ordered overrides and exact-default disable, platform normalization, conflict/prefix/disjointness, unknown commands, atomic last-good reload.                                                                                                                                                                                |
| Input leakage/duplicates           | Repeat, composition/229/Dead/AltGraph; controllable chord deadlines and every cancellation boundary; Monaco once-only Find; live/ended/held Exec bytes, explicit terminal override versus generic rule, reserved Mod+J, browser paste parity, recorder ownership/Escape.                                                                                              |
| Persistence/draft loss             | CAS/two-window, failed/unknown/not-sent writes, disconnect/reconnect/discard, confirmed activation, unsupported versions/unknown fields, malformed rules, reorder/duplicate-looking stable draft IDs, disable/remove/reset, simultaneous Appearance/Log Stream saves.                                                                                                 |
| User experience                    | Implementer's running web and scripted Electron checks, then fresh discovery UX, both themes at 1280x800 and 640x600 (and supported desktop minimum); keyboard and pointer, no Cluster, dirty Manifest, Log Stream and real fixture Exec, argument forms, recorder/chords/modals, not-permitted/Cluster-unreachable/Engine-lost and cross-window activation/conflict. |

Use focused `mise run test:ts -- ...`, `test:engine -- -run ...`, typecheck and
lint early. For material new behavior prefer test-first intended failures;
otherwise perturb a representative behavior only when needed to rule out a
false positive, restore exactly, and confirm the named tests ran. Do not use
fixed sleeps for asynchronous assertions. Keep a revision-bound evidence ledger
outside the repo, distinguishing executed evidence, supplied evidence and gaps.

Coordinate a shared fixture lease with the coordinator before any legacy
dev:verify/fixture/E2E task. Run dev:verify and E2E sequentially. Empty-kubeconfig
owned Engines/free ports/profiles are safe without that lease. Do not access
user kubeconfig or live Clusters. Stop only exact owned processes using project
tasks. Do not import PR #34 or build a replacement isolation harness.

Apply the fetched Vercel web guidelines: native labelled controls, announced
status/errors, visible unobscured focus, modal trap and focus return, at least
24px targets, pasteable inputs, inline errors, unsaved-work protection, reduced
motion and responsive layouts without horizontal overflow. Keep input names,
autocomplete and spellcheck appropriate. Avoid transition:all, layout reads
during render, index keys and unbounded lists; reuse project style tokens.

Commit the plan separately, then use a fresh Codex implementer with exclusive
source/test ownership and no Git/delegation authority. Delivery Git stays with
the orchestrator. After own runtime checks and fresh UX/re-check, run check
before pushing the one draft stacked PR, independent exact-head Codex+Claude
reviews, and the selected CodeRabbit review after internal acceptance.
Run `mise run e2e` under the shared fixture lease before readiness, including
focused live-Exec palette/held-key/no-byte-leak tests and preserving the existing
Ctrl+K, Ctrl+J and Monaco binding allowlist contracts. Tests saving keyboard
rules must restore the shared Engine's original document in cleanup.
Checkpoint before a fifth combined UX/code correction batch. Ready requires
the current parent contained, checks and required reviews accepted, no valid
blocking feedback and an honest list of remaining open threads. Never merge.

Real OS/HID/IME, system clipboard and non-macOS native checks remain Jim's
deferred pre-merge checks; renderer/synthetic evidence cannot establish them.
No repeat workflow, palette-shortcut, editor-scope or terminal-override question
is needed. Material departures or failed gates go to the coordinator.

## Open questions

None about approved product scope. Source-grounded plan review and package seam
tests must pass before the approach is accepted; a material mismatch goes to
the coordinator before implementation proceeds.

Add the new Command, Command palette, Shortcut and Chord vocabulary to
`CONTEXT.md`, distinguishing an app Command from an Exec command line. Update
the Session keys hazard in `AGENTS.md`; document the runtime/scopes/CAS decision
in a short ADR. The plan review's 17 source-backed findings are incorporated
above; Enter-to-terminal timing remains a required runtime probe, not a claimed
observed defect.
