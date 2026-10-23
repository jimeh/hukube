# Declarative Resource Overviews with inline editing

## Outcome and scope

Add an Overview Facet whose layout and editable fields are described by versioned
YAML definitions. A Resource opens on Overview when a matching definition exists;
otherwise it opens on YAML. An explicit or inherited applicable Facet remains
authoritative. Users can add definitions for CRD Resource Types without changing
or rebuilding Hukube.

Overview fields edit in place. Changes remain local, have an amber indicator and
an accessible Changed label, and use the existing Review changes dialog and
Engine review/apply contract. Overview and YAML share one draft per Resource Tab.
Form edits appear in YAML, and valid YAML edits appear in Overview immediately.
The Resource Tab acts as one edit regardless of its selected Facet. Unsaved
changes remain visible while Overview, YAML, Logs, Events, or Related is selected.
YAML has VS Code-style line-change indicators in its left gutter.

Initial definitions cover Pods, Deployments, StatefulSets, DaemonSets,
Jobs, CronJobs, Services, Ingresses, ConfigMaps, Secrets, Namespaces, Nodes,
PersistentVolumeClaims, and PersistentVolumes. Include an installable example for
a small test CRD. Cover useful configuration rather than every Kubernetes field.
Status, Resource identity, and Engine-managed metadata cannot become editable
through a definition. Secrets remain masked until explicitly revealed.

The user confirmed this coverage, app-managed imports alongside bundled
definitions, custom definitions overriding bundled ones, and CodeRabbit review
after independent Codex and Claude review. Definition installs are app settings;
they remain available when the Engine runs with `--read-only`.

## Existing contracts

- `features/resource/facets.ts` owns applicability and selection. Resource URIs
  name the Facet; Tab IDs do not. `facet-rules.ts` and Workspace navigation own
  inheritance. Keep explicit YAML links and saved selections working.
- `YamlFacet` currently owns its draft, review hook, and the panel's unsaved-edit
  registration. Both editable Facets must use one owner rather than register
  competing drafts under the same panel ID.
- `features/edit/session.ts`, `yaml.ts`, `use-review.ts`, and `review-dialog.tsx`
  already implement editable Manifests, review, admission feedback, conflict
  refusal, and recovery of writes whose outcome is unknown (ADR-0019). Reuse
  those policies. A JSON merge patch treats a list as one field.
- Engine `settings.watch`/`settings.put` provide persisted state shared by both
  Hosts and all windows (ADR-0009). Resource access checks and read-only Engine
  behavior already exist. No Cluster access is needed to install a definition.

## Definition contract

Create a documented v1 format and a machine-readable schema alongside bundled
definitions. Use Zod 4.6.7, released on 2026-10-12 and past the seven-day cooldown,
for validation and JSON Schema export. Keep the checked-in JSON Schema aligned
with its source by a drift assertion and expose regeneration as a Mise task.
YAML contains data only: no JavaScript, executable templates,
network loads, raw HTML, arbitrary CSS, or expression language. Use explicit
Resource Type keys and optional API versions for matching, rather than inferring
plural names from kinds. One definition matches one Resource Type key. An API
version outside its optional allowlist means no match. Different API groups
never match accidentally. For example:

```yaml
version: 1
resourceType: deployments.apps
apiVersions: [apps/v1]
title: Deployment
sections:
  - id: workload
    title: Workload
    fields:
      - id: replicas
        type: field
        label: Replicas
        path: [spec, replicas]
        format: number
        edit: { type: integer, min: 0 }
      - id: containers
        type: table
        label: Containers
        path: [spec, template, spec, containers]
        columns:
          - id: image
            label: Image
            path: [image]
            format: text
            edit: { type: string }
```

The public building blocks are sections, labeled scalar fields, key/value maps,
and repeated rows with declared columns. Repeated rows must support nested field
paths so container images, ports, mounts, and CRD lists use the same renderer.
Paths use arrays of literal keys and list indexes, including keys containing
dots and slashes. A repeated row's column path is relative to that row; every
editor resolves to one concrete path in the original Manifest.

Scalar display formats include text, multiline text, number, boolean, timestamp,
badge, and sensitive text. Maps and repeated rows have explicit empty states.
Absent optional scalar values show Not set and remain addable when editable.
Definitions may opt to hide empty read-only sections. A bounded collection view
must disclose omitted rows and retain access to the complete value through YAML.

An optional `edit` block declares `type` (`string`, `integer`, finite `number`,
`boolean`, or string `enum`), optional removal, enum choices, numeric bounds,
and multiline string presentation. Integers must be safe JavaScript integers.
A live value with a different JSON type is read-only with an Edit in YAML
explanation. IntOrString values such as Service targetPort remain read-only
in v1. There is no null control: JSON merge patch cannot set an explicit null.
Removal makes the key absent; it is distinct from empty string, zero, or false.
String maps support adding unique non-empty keys, editing values, and removing
keys, without key renaming. Repeated rows support editing existing scalar
columns; adding/removing whole rows stays in YAML in v1.

Use YAML 1.2 core for definitions, with unique keys and no anchors, aliases,
merge keys, custom tags, or executable values. This is separate from Kubernetes
Manifest parsing, which retains the existing YAML 1.1 behavior.

Validation rejects unknown versions, malformed paths, unsupported controls,
duplicate identifiers and paths, incompatible field/control combinations, and
editable protected paths. Validate the complete concatenated table/column path.
Share an exported protected-path policy for status, server metadata, and
Resource identity. Validation and traversal use own
properties only and cannot mutate prototypes. Bound each source at 64 KiB,
the entire stored registry at 2 MiB, nesting at 16 levels, sections at 32, and
total declared fields/columns at 256. Reject excessive nesting before conversion
to plain values. Report useful definition path and YAML line
information when available. One invalid imported definition must not disable
bundled definitions or crash a Resource Tab.

Bundled definitions load through the build as YAML text. Imported definitions
use exactly the same parser and renderer. Precedence is explicit: one custom
definition for a match replaces its bundled definition; duplicate custom
matches require an explicit replacement. Removing a custom definition restores
the bundled match or YAML fallback. Pin a snapshot of the active definition
in the panel edit controller from the first inline input until that session
ends, including invalid or uncommitted text and pending/unknown applies. Keep
Overview available with that snapshot even if the registry entry is removed.
Show that the definition changed and will refresh after the edit ends. A clean
Tab adopts definition changes immediately. The draft remains independent of
the definition; pinning protects the inline controls and their unfinished text.

Document the versioning and matching rules, all supported properties, and a
complete CRD example. Include at least one bundled definition with a nested
collection and editable field as a realistic authoring example.

## User experience

### Overview

Overview appears first in the existing Facet switcher, followed by YAML and the
other applicable Facets. It uses the Resource header already provided by the
panel. Below it, a scrollable responsive layout shows compact sections with
labels and values. Use the existing warning token for changed-field emphasis.
Two columns fit a wide Pane; a narrow Pane stacks sections
and wraps long values. Repeated rows scroll within their section if necessary.
Use existing design tokens and shared shadcn/Base UI controls in both themes.

Click an editable value to focus its inline control. The same value is a named
button reachable by Tab; Enter or Space opens it. Every valid input change
updates the shared draft immediately, so YAML reflects it without requiring
blur. Escape restores the field value captured when the control opened;
confirmation or leaving a valid control finishes that field edit. Invalid raw
input stays visible with its error; YAML retains that field's last valid typed
value and Review is blocked until it is fixed or cancelled. No new app shortcut
is introduced. Multiline controls
provide a visible confirmation action. Edited values show their staged value,
amber emphasis, a Changed label, and a per-field revert action.

Place shared Cancel and Review changes controls in the existing Facet controls
row, preserving YAML's labels and disabled reasons. Cancel uses the existing
discard confirmation when necessary. The first inline input starts a session
and pins the Preview Tab, subject to the same access, connection, incarnation,
and availability gates as YAML's Edit action. YAML keeps its existing text-based
Review behavior, including focusing parse issues. Overview disables Review when
the draft is invalid and explains how to fix it in YAML. Review from either
Facet must flush a valid open inline field before submission and must be blocked
by invalid pending inline input with a visible reason naming that field.
Starting an edit pins a Preview Tab. Update the unsaved marker on both editable
Facets, with one panel-level unsaved registration. Applying clears only the
submitted draft; a newer edit cannot be cleared by an older result.

Show the Resource Tab's existing unsaved dot and an Unsaved changes notice in
the shared Resource header, independent of the selected Facet. Provide Review
changes there while a read-only Facet such as Events is selected, so users can
review the Tab's draft without returning to an editable Facet. Use the same
controller action and invalid-pending-input explanation everywhere. Do not mark
Logs or Events themselves as edited; the notice identifies the Resource edit.

Display status, conditions, and server metadata from the live Manifest. Once a
session exists, configuration comes from its draft. Freeze configuration while
dirty and show the existing changed-on-Cluster notice; leave three-way merging
to the Engine. Deletion, same-name replacement, lost connection, forbidden
editing, admission errors, and unknown apply outcomes retain the current YAML
editor's accurate notices and recovery behavior.

Loading shows section skeletons. A fetch error without data shows the existing
error notice; stale data has a visible error line. A missing Resource shows Not
found. Deleted Resources retain their last Overview read-only. Without a
matching definition, Overview is absent and YAML is available. A definition
error has an actionable notice and a reachable YAML Facet. Never render
Cluster-supplied values as markup.

### Definition management

Add a settings menu button beside the existing theme toggle in the top Cluster
strip, containing Overview definitions. Also link to management from a definition
error notice. This is Engine-wide user configuration, not a Cluster
mutation or a list filter. Open a modal listing built-in and custom definitions,
their matches, and validation errors. Built-ins are inspectable/exportable;
custom entries can be imported from a local YAML file or pasted text, replaced,
exported, or removed. Supply a downloadable Widget example using
`widgets.sample.hukube.dev`. File input and all actions are keyboard
reachable. No URL fetching or public registry is included.

Validate before saving. Keep invalid import text and actionable errors in the
dialog. Save errors retain the pending import and do not claim success. Disable
writes until the persisted registry has loaded. Reconnect reloads the Engine's
registry and updates other windows. Store YAML source text, not just parsed
values, so exports retain comments and errors retain source locations.

### Concurrent persistence

Add a revision to `Setting`, computed as the SHA-256 of its exact stored bytes
under the Store mutex; use the empty string for an unset key. A separate put
parameter type adds optional `ifRevision`, represented by `*string` in Go so an
explicit empty-string revision differs from an omitted unconditional write.
When present, compare it under the
same mutex as the write; a mismatch returns `conflict` without writing or
notifying watchers. Existing unconditional settings callers stay compatible.
Return/read the revision with the value as one atomic snapshot. Regenerate the
protocol types/hash and restart the Engine for integration checks.

Use one versioned registry at `overview/definitions`, mapping Resource Type keys
to YAML source entries. The client serializes local operations and retains the
observed entry for each import/replace/remove intent. A CAS conflict triggers
a fresh read, reapplies the intent if that entry is unchanged, and retries under
a bounded attempt count. Changes to unrelated entries are preserved. A changed
entry for the same Resource Type asks the user to review and confirm replacement
again; removal must not delete a replacement the user has not seen. A lost write
answer triggers a read: an exact requested entry means success; otherwise follow
the same conflict rule. Invalid stored entries get per-entry diagnostics while
unaffected definitions remain usable. Never replace unread or malformed registry
data with an empty registry. Read-only Engine mode still allows settings writes.
For a fresh read after a conflict or unknown answer, close and reopen
`settings.watch`, rather than retrying against a cached revision whose newer
watch event may still be queued.

### Shared editing

Lift draft and review ownership into a panel-scoped edit controller with a small
interface for starting, updating, reviewing, reverting, and discarding an edit.
Keep Monaco-specific state, selection, parsing markers, and focus in YAML.
Keep inline focus and field validation in Overview. The controller owns the
single review dialog, pending apply lifetime, and unsaved registration.

YAML reads and writes the same draft text. Overview updates the parsed YAML
Document with setIn/deleteIn, preserving comments, node styles, and fields its
definition does not show. Reparse synchronously for controller decisions;
Monaco's debounced markers remain local. Refuse inline updates to drafts with
parse errors, aliases, anchors, or merge keys and point to YAML. Use the existing
YAML 1.1 scalar rules when creating nodes, including correct quoting of strings
such as "0644" and "yes". Extract a shared stringifyManifest(Document) helper
from renderYaml: remove the merge schema tag and quote every literal "<<" key
before stringifying, including existing keys in parsed drafts. Use it for every
Overview update and revert. This preserves meaning when editing beside a quoted
"<<" key; a quoting visitor alone does not suffice. Exact whitespace preservation
is not promised. Invalid YAML remains intact; Overview explains why inline
editing is unavailable and offers the YAML Facet to fix it. Switching Facets
must neither apply nor discard. The panel controller retains pending field
text and its original value; Overview registers the active field's flush
callback and validation blocker with the controller.
Track the value the active control last wrote, so a form-origin draft update
does not look like a competing YAML edit and drop its own pending input.
Pending input also counts as unsaved work for Tab/Workspace/unload guards and
pins the definition. If YAML changes a pending field's draft value, drop that
pending field input because the shared draft is authoritative. Cancel cancels
both staged and pending field edits. Review focus returns to the originating
Facet/control, including after apply. Move the submitted-text equality check
into the controller and also track pending-input revisions, so a late apply
result cannot clear new uncommitted input merely because draft text still
equals the submitted text. Following a live Manifest must consider pending
input as unsaved work too. Keep pending input in panel-owned state, so moving
the Tab between Panes cannot lose it if dockview remounts a Facet.

Compare staged field values against the base with number-aware semantic equality.
Keep YAML dirty detection text-based. When an Overview update or per-field revert
restores the entire parsed base, reset text to baseText so it becomes clean.
Show a notice for draft changes outside the definition's rendered paths, with
a link to YAML. Refuse an inline change to a list when any enclosing list has
an unsafe integer, since the merge patch would send the entire rounded list.
Untouched unsafe numbers outside a changed list must not be written back.

For core Secrets, mask data/stringData regardless of custom definition settings.
Values are read-only in Overview v1. Reveal decodes base64 only when it is valid
UTF-8; binary values remain labeled as binary. Revealing is explicit and does
not place the value in accessible names, tooltips, or management exports.

### YAML change gutter

Compare the current draft text with the session's editable baseText. Controller
status updates and the omission of server metadata when entering edit must not
look like user edits. Overview changes and direct YAML changes update the same
gutter, even after switching Facets. A revert, successful apply with no newer
edits, or discard clears the matching markers.

Use Monaco's public editor decoration collection and line-decoration classes
in the existing single editor. Added lines get a green bar, changed lines get
an amber bar, and removed lines get a red boundary triangle anchored between
the surviving lines. Deletions at the beginning and end of the document must
remain visible. Use success, warning, and destructive tokens and text tooltips
that identify the change kind and line count. Include an accessible change
summary so the information does not depend on color or hovering.
Attach that summary as an editor description, rather than announcing every
keystroke with an aria-live region. Fit the shared unsaved notice and Review
action into narrow headers without hiding the Resource name or existing actions.

Use the maintained `diff` package (jsdiff 9.0.0, released 2026-04-13 and past
the cooldown) for line differencing rather than implementing a diff algorithm
or importing Monaco internals. Map each adjacent removed/added hunk to modified
lines for their shared count and added/removed markers for the remainder. The
remaining deleted count anchors at the hunk boundary, including all-lines-
removed and empty-document cases. Preserve CRLF/EOF semantics consistently with
Monaco's model. Bound diff work with the package's timeout/maxEditLength options
and an input-size limit. If exceeded, retain the draft and show a nonblocking
Gutter changes unavailable notice with Review changes still usable.

Updating form fields must preserve the YAML model's selection and scroll, and
use Monaco edit operations rather than replacing the whole model when feasible,
so Undo can undo a form edit. Dispose the decoration collection with the editor
and prevent late computations from installing markers for an older draft.
The transition from the read-only Manifest to editable text may use setValue;
subsequent form updates use the smallest replacement range and undo stops per
field edit. First mounting YAML mid-session computes markers from the existing
draft/base, independently of change events. After an apply with newer edits,
the original base remains until the session ends, matching the existing edit
contract; the gutter may still mark already-applied lines in that case.
No new key binding or inline diff review UI is introduced.

## Implementation sequence

1. Have Claude inspect this plan against source;
   resolve concrete objections and obtain an accepted plan before product edits.
2. Implement and test the definition parser, matching, safe paths, and pure draft
   updates. Add schema, authoring documentation, bundled YAML, and the CRD example.
   Add atomic settings revisions/CAS and focused Go/server tests before the
   management store. Keep architectural decisions in this authorized plan;
   update existing vocabulary/ADR text only where feature behavior makes it
   inaccurate, without introducing unrelated domain or architecture records.
3. Extract panel-scoped editing with existing YAML behavior unchanged. Run the
   existing focused YAML/review/unsaved tests during the extraction, then add
   cross-Facet draft and apply-lifetime regression coverage.
4. Add Overview rendering, inline editing, Facet/default selection, and the
   agreed definition-installation flow. Keep state and persistence errors visible.
5. Add real-cluster E2E coverage, run project checks, and inspect the running app
   in both themes at wide and narrow sizes. Fix UX defects before review.
6. Commit feature-owned changes, open a draft PR against refreshed `origin/main`,
   and run independent Codex and Claude reviews of the pushed exact head.
   Reconcile findings, correct confirmed defects, and revalidate affected evidence.
   Mark ready only after exact-head CI and required review coverage pass.

One fresh same-engine implementer owns product edits in the delivery checkout.
The parent owns Git, PR publication, evidence sufficiency, and browser review.
Read-only workers never mutate the checkout. Destructive test perturbations, if
needed, run only in a disposable checkout after implementation handoff.

## Evidence plan

| Concern                            | Planned evidence                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definitions really drive rendering | Parser/renderer tests for bundled YAML and an imported CRD definition; E2E installation shows fields with no app-code change.                                                                                                                                                                                                                                                                                 |
| Bad or hostile definitions         | Focused tests for malformed/oversized/aliased input, invalid controls/paths, protected paths, ambiguous matches, and prototype keys.                                                                                                                                                                                                                                                                          |
| Matching/defaults/navigation       | URI and Facet tests for built-ins, CRDs, API groups/versions, unsupported kinds, explicit YAML, inheritance, saved layouts, late registry load, removal, and definition replacement during an edit.                                                                                                                                                                                                           |
| Correct typed edits                | Pure update tests for string/number/boolean, absent vs empty/zero/false/null/removal, literal map keys, nested/repeated rows, range errors, and preservation of undisplayed data.                                                                                                                                                                                                                             |
| Precision and unexpected values    | Refuse unsafe numeric edits without rounding existing data; malformed live shapes remain readable and cannot crash the renderer. Include regression evidence for unchanged large numbers.                                                                                                                                                                                                                     |
| Shared edit ownership              | Component tests exercise Overview to YAML and back, invalid YAML, open inline input, per-field revert, global discard, Preview pinning, close guard, and one unsaved registration.                                                                                                                                                                                                                            |
| YAML gutter and unified Tab        | Pure hunk tests cover add/modify/remove, mixed-length hunks, first/last-line removal, empty text, CRLF and EOF; editor tests verify decorations update from either edit source and clear correctly without replacing selection. E2E verifies form-to-YAML-to-form synchronization, a YAML edit changing an Overview value, visible gutter markers, and Resource-level unsaved state while Events is selected. |
| Mutation lifecycle                 | Existing review tests plus focused new tests for Overview-origin review/apply, forbidden edits, changed-on-Cluster conflicts, same-name replacement/deletion, pending applies, late results, and disconnect recovery. No new write path.                                                                                                                                                                      |
| Secret handling                    | Tests for masking/reveal and a manual check that values do not enter labels/tooltips or appear before reveal. Secret values remain read-only in Overview v1.                                                                                                                                                                                                                                                  |
| Definition persistence             | Go tests for atomic value/revision snapshots and two writes at one revision yielding one conflict; store tests and E2E import/reload/remove, failed/unknown save and retry, unavailable or malformed initial state, reconnect, same-type replacement conflicts, and concurrent imports from two pages retaining both entries.                                                                                 |
| Real integration                   | E2E on the disposable k3d cluster: Deployment replicas/image edits, exact review/apply result, ConfigMap map changes, CRD import/edit, explicit YAML and layout persistence.                                                                                                                                                                                                                                  |
| UI and Hosts                       | `dev:verify` after E2E, reviewed with keyboard and pointer in both themes and at two widths; web and Electron E2E as supported by project tasks.                                                                                                                                                                                                                                                              |
| Repository gates                   | `mise run check` before pushing; intended-head CI; complete independent Codex and Claude review. Record exact revisions and environment limits.                                                                                                                                                                                                                                                               |

Use event/observable state synchronization in asynchronous tests. Existing green
suites provide regression evidence. New material behavior needs its own focused
assertions. Keep a compact revision-bound evidence ledger outside the repo.

## Risks, alternatives, and non-goals

- Reuse the existing renderer controls and YAML package, adding Zod for schema
  validation and export rather than maintaining two unrelated schemas. A generic JSON Schema
  form generator does not define a polished overview or the Engine edit
  lifecycle; a separate form engine would duplicate draft ownership. The v1
  vocabulary should stay small and support extension through versioned data.
- App imports offer the same workflow in web and desktop Hosts. An Engine
  directory avoids a management UI but needs a server-side loader, reload and
  diagnostics policy, and local filesystem access. Bundled-only definitions
  would not satisfy user-added CRD support without a rebuild.
- Kubernetes admission remains authoritative. A field declared editable may be
  immutable for a particular Resource; dry-run errors must be attached to the
  relevant inline field when possible and always remain visible in review.
- No separate Form Facet, multi-Resource Changeset, schema-derived automatic
  layout, remote definition catalog, executable plugin system, new shortcuts,
  or edits to status. YAML stays available for configuration not described in
  an Overview definition.

## Navigation details

Pass a registry snapshot and discovered Resource Type information to Facet
resolution and Workspace navigation. Inherit only an explicit active Facet that
applies to the destination. Otherwise leave the destination URI Facet unset,
so it continues to mean default. Never persist a fallback as an explicit YAML
choice. An explicit unavailable Overview resolves to YAML while retaining its
URI; a newly installed match can then enable it. Explicit YAML stays YAML.

Bundled definitions are available synchronously. With an unset Facet and no
bundled match, show loading until custom definitions load or fail, then resolve
the default. A registry read failure retains usable bundled definitions and
shows a diagnostic with retry. Saved Facet-less layouts now default to Overview
when available; saved explicit selections retain their meaning. Existing Tab
identity and focusing behavior stays unchanged.

Match API versions from discovery or, when discovery is not ready, from the
Manifest's apiVersion. An undecidable match stays loading, including restored
Tabs. Latch the resolved default while any edit session or pending input exists,
even when that session started in YAML, so a registry change cannot hide the
editor under the user's cursor. Existing saved fallback #yaml URIs cannot be
distinguished from explicit choices and stay on YAML.

## API references

- [YAML Document and node APIs](https://eemeli.org/yaml/).
- [Zod JSON Schema export](https://zod.dev/json-schema).
- [jsdiff line-diff API and work limits](https://github.com/kpdecker/jsdiff).

## Unresolved questions

None. Claude accepted the architecture and the gutter extension, conditional
on the shared literal-key serialization helper now specified above.
