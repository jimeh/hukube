# Plan: edit, apply, and delete a Resource

Status: Parts 1 and 2 implemented; parent browser review pending. Decisions are recorded in ADR-0019 and ADR-0020.

## Outcome

After this work:

- The YAML Facet has an Edit mode. The user changes the Manifest in the editor
  they read it in.
- Nothing reaches the Cluster without a review. The review shows a diff of
  what will change, and the Engine asks the API server for a dry run first.
- An apply reports what happened: applied, refused with the fields at fault,
  not permitted, or changed on the Cluster first.
- A change on the Cluster during an edit neither overwrites the user's text
  nor is overwritten without the user seeing it.
- A Resource can be deleted after a confirmation that names it and its
  Cluster.
- The protocol carries structured errors, a request can be cancelled, and a
  mutation is safe to repeat.

It edits one Resource at a time. It does not build a Changeset, a form,
creation, or actions such as scale and restart.

## Current state

Observed at `23a51b3`:

- `resource.get` sends the full Manifest as JSON. `YamlFacet` renders it with
  the `yaml` package in a read-only Monaco editor (`yaml-editor.tsx`), and
  hides `metadata.managedFields` unless asked.
- A request handler runs under the session's context and cannot be cancelled
  (`session.go:86`). A request in flight when the socket drops is rejected as
  `disconnected` (`connection.ts:260`).
- `ErrorDetail` is a code and a message. `toProtocolError` maps `Forbidden`
  and `Unauthorized` to `forbidden`, unknown Clusters and types to
  `not_found`, and everything else to `internal` (`outbox.go:91`).
- The Worker boundary forwards a failed request as `{code, message}`
  (`worker.ts`), so any detail added to `ErrorDetail` is lost there today.
- A client message over 4 MiB closes the control socket (`session.go:18`).
- dockview 8.3.1 has no event that can veto closing a panel. Tabs close
  through `PanelTab`, and Cluster tabs through `ClusterTabs`.
- The end-to-end key bindings test lists every binding of a live editor. The
  list does not depend on whether the editor is read-only.
- The research in `docs/research/engine-protocol-tooling.md`, step 1e, lists
  what a mutation needs: details on errors, codes for mutations, cancelling,
  and an answer for a lost connection. Its `done` message was settled by
  ADR-0016: nothing on the control protocol ends.

## Evidence

### What other tools send

Read from source at Kubernetes v1.37.1, which matches the Engine's client-go
v0.37.1, and from the tools' default branches on 2026-10-13:

- **`kubectl edit`** sends a PATCH of the difference between the Manifest it
  fetched and the edited one: a strategic merge patch for built-in types and
  a JSON merge patch for custom resources
  (`kubectl/pkg/cmd/util/editor/editoptions.go`). The patch carries no
  `resourceVersion`, so a concurrent change merges silently. It hides only
  `managedFields`, shows `status`, and refuses a change of `apiVersion`,
  `kind`, or `metadata.name`. On a validation error it reopens the file with
  the causes as comments.
- **A PATCH that carries `metadata.resourceVersion`** is refused with 409
  when the Resource has another version
  (`apiserver/pkg/registry/generic/registry/store.go`, the comparison in
  `Update`). This holds in a dry run too.
- **A PUT or a non-apply PATCH** gives its field manager only the fields whose
  values changed (`structured-merge-diff/merge/update.go`). Server-side apply
  of a whole Manifest makes its manager an owner of every field in it, and
  cannot remove a field the manager never applied.
- **`fieldValidation=Strict`** is what kubectl sends. For a merge patch an
  unknown or duplicate field is a 422 with one cause on the field `patch`.
  Other validation failures are 422 with a cause per field.
- **A dry run** (`dryRun=All`) runs defaulting, admission, and validation and
  returns the Resource as it would be stored. A webhook that declares side
  effects makes the API server refuse the dry run with 400 "does not support
  dry run".
- **Delete.** Only Pods honour a grace period. Without a propagation policy,
  a Job and a ReplicationController orphan what they own, so kubectl always
  sends one, `Background` by default. A `preconditions.uid` that does not
  match is a 409.
- **Headlamp** sends a JSON Patch from the opened Manifest to the edited one,
  shows "This resource was modified while you were editing", and has a diff
  tab and a dry-run button. **Freelens** sends a JSON Patch and has no
  conflict handling. **k9s** runs `kubectl edit`, and its delete dialog
  offers the propagation policy and a force checkbox.

### A probe of the `yaml` package

`yaml` 2.9.1, run in this checkout:

| Text typed  | `yaml` default (1.2) | `yaml` with `version: "1.1"`        | kubectl (go-yaml v2) |
| ----------- | -------------------- | ----------------------------------- | -------------------- |
| `0644`      | 644                  | 420                                 | 420                  |
| `yes`, `on` | the string           | `true`                              | `true`               |
| `1_000`     | the string           | 1000                                | 1000                 |
| `1:30`      | the string           | 90                                  | the string           |
| a timestamp | the string           | a `Date`, unless the tag is removed | the string           |

With any one configuration, `parse(stringify(x))` returned `x` for every
value tried, because `stringify` quotes what the same configuration would
read as another type. A syntax error carries a line and column, a second
document is the error `MULTIPLE_DOCS`, and a repeated key is `DUPLICATE_KEY`.
Integers above 2^53 lose precision in both configurations.

## Decisions

### An edit is a patch of what the user changed

ADR-0019 records this. In short:

- An edit is the pair of the Manifest the user started from (the base) and
  the Manifest they made (the edited Manifest). What the edit asks for is the
  difference between the two, as a JSON merge patch. Fields the user did not
  touch are not part of it.
- The Engine applies that difference to the Resource as it is on the Cluster
  now, and sends the result as a JSON merge PATCH that carries the
  `resourceVersion` it was computed against, with the field manager `hukube`
  and `fieldValidation=Strict`.
- A change on the Cluster to a field the edit does not touch is kept. A
  change to a field the edit also changes, to a different value, is an
  overlap. A review reports overlaps. An apply refuses them.

Server-side apply and a full update were rejected. The ADR says why.

### The editable Manifest

Edit mode shows the editable Manifest: the Manifest without the fields the
Cluster sets. Those are `status`, and under `metadata`: `managedFields`,
`resourceVersion`, `uid`, `generation`, `creationTimestamp`,
`deletionTimestamp`, `deletionGracePeriodSeconds`, and `selfLink`.

- Reading mode is unchanged and still shows them.
- The Engine owns the rule. It removes these fields from every Manifest it
  compares, so an edit cannot change them whatever a client sends. The UI
  removes the same fields to make the text. A server-set field the user types
  back in is listed in the review as ignored.
- `apiVersion`, `kind`, `metadata.name`, and `metadata.namespace` stay in the
  text, because a Manifest without them does not read as one. Changing any of
  them is refused in the review with a cause on that field.
- Everything else is editable, including `metadata.finalizers`, which is how
  a Resource stuck terminating is released.

`kubectl edit` shows `status` and ignores edits to it silently. Hiding it
means no edit is ignored without the user being told.

### YAML is read as kubectl reads it

The UI parses and renders YAML with one configuration of the `yaml` package:
version 1.1, without the timestamp, binary, sexagesimal, set, and ordered-map
tags. Rendering also excludes the merge tag and quotes a literal `<<` key;
parsing keeps merge keys working in user-typed text. A user who types `defaultMode: 0644` or `enabled: yes` gets what
`kubectl apply` would send. The reading view uses the same configuration, so
it quotes strings such as `"yes"` and `"0644"` as `kubectl get -o yaml` does.

The edited text must be one YAML document whose root is a mapping. Comments
and formatting are not part of a Resource and are not kept. Non-finite numbers,
including `.inf`, `.nan`, `-.inf`, and overflowing floats, are YAML issues
at each scalar, including in nested mappings and lists. They cannot be reviewed.

### A review is a request, and an apply is the reviewed edit

Four requests are added. A Changeset later is a list of `ResourceEdit`
values, reviewed and applied with one request per Resource, which matches
"not atomic across Resources".

```go
// ClientTypeCancel cancels the request with the same ID.
ClientTypeCancel ClientType = "cancel"

// MaxClientMessageBytes is the largest message the Engine reads from a
// control socket.
const MaxClientMessageBytes = 8 << 20

// New codes: conflict, invalid, cancelled, unavailable, too_large.

type ErrorDetail struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
	// Reason is the API server's reason when the error came from a Cluster,
	// such as "Invalid".
	Reason string `json:"reason,omitempty"`
	// Causes lists what was wrong, one per field when the field is known.
	Causes []ErrorCause `json:"causes,omitempty"`
}

type ErrorCause struct {
	// Field is the path the API server names, such as "spec.replicas".
	Field   string `json:"field,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message"`
}

// FieldPath addresses a field of a Manifest by its keys from the root. A
// list is addressed as a whole.
type FieldPath []string

// ResourceEdit is an edit of one Resource: one entry of a Changeset.
type ResourceEdit struct {
	Cluster   string  `json:"cluster"`
	Type      TypeKey `json:"type"`
	Namespace string  `json:"namespace,omitempty"`
	Name      string  `json:"name"`
	// UID is the Resource the edit was made to.
	UID string `json:"uid"`
	// Base is the Manifest the edit started from, and Manifest the edited one.
	Base     json.RawMessage `json:"base"`
	Manifest json.RawMessage `json:"manifest"`
	// Expected is the review's dry-run result, used to recognize a completed apply.
	Expected json.RawMessage `json:"expected,omitempty"`
}

type EditReview struct {
	// Before is the editable Manifest on the Cluster when the review was made.
	Before json.RawMessage `json:"before"`
	// Desired is Before with the edit applied. resource.apply takes Before
	// and Desired as its Base and Manifest.
	Desired json.RawMessage `json:"desired"`
	// After is what the Cluster would store. It is absent unless the dry run
	// succeeded.
	After json.RawMessage `json:"after,omitempty"`
	// Edited lists the fields the edit changes. Empty means nothing to apply.
	Edited []FieldPath `json:"edited"`
	// ChangedOnCluster lists the fields changed on the Cluster since Base.
	ChangedOnCluster []FieldPath `json:"changedOnCluster"`
	// Overlaps lists the fields of ChangedOnCluster the edit sets to another
	// value.
	Overlaps []FieldPath `json:"overlaps"`
	// SetByCluster lists the fields the Cluster would store differently from
	// Desired, through defaulting or admission.
	SetByCluster []FieldPath `json:"setByCluster"`
	// Ignored lists server-set fields the edited Manifest changed.
	Ignored  []FieldPath `json:"ignored"`
	Warnings []string    `json:"warnings"`
	// Refusal is why the edit cannot be applied as it is.
	Refusal *ErrorDetail `json:"refusal,omitempty"`
	// DryRunUnsupported says the Cluster could not dry-run the edit, and
	// Refusal holds its explanation. The apply may still be attempted.
	DryRunUnsupported bool `json:"dryRunUnsupported,omitempty"`
}

type ApplyResult struct {
	// ResourceVersion is the Resource's version after the apply.
	ResourceVersion string `json:"resourceVersion"`
	// Unchanged says the Cluster already had every value, so nothing was sent.
	Unchanged bool     `json:"unchanged,omitempty"`
	Warnings  []string `json:"warnings"`
}

type DeleteParams struct {
	// Cluster, Type, Namespace, Name, and UID, as in ResourceEdit.
	Propagation DeletePropagation `json:"propagation"` // background, foreground, orphan
	// Immediate deletes a Pod without waiting for its containers to stop.
	Immediate bool `json:"immediate,omitempty"`
}

type ResourceAccess struct {
	Edit   Access `json:"edit"`
	Delete Access `json:"delete"`
}

type Access struct {
	// Allowed is false only when the Engine knows the action would be refused.
	Allowed bool `json:"allowed"`
	// Reason says why not, in words for the user.
	Reason string `json:"reason,omitempty"`
}

RequestResourceAccess = DeclareRequest[ResourceRef, ResourceAccess]("resource.access")
RequestResourceReview = DeclareRequest[ResourceEdit, EditReview]("resource.review")
RequestResourceApply  = DeclareRequest[ResourceEdit, ApplyResult]("resource.apply")
RequestResourceDelete = DeclareRequest[DeleteParams, None]("resource.delete")
```

Every slice in a result is initialized, so none is `null` on the wire.

### How the Engine reviews and applies an edit

The comparison is a pure package, `engine/internal/edit`, with no client. It
uses `evanphx/json-patch` for RFC 7386, at the version the module graph
already has, as kubectl does. It is not written by hand.

Given `base`, `manifest`, and the live Resource `live`:

1. `B`, `M`, and `L` are their editable Manifests.
2. `mine` is the merge patch from `B` to `M`. `theirs` is the merge patch
   from `B` to `L`.
3. `desired` is `L` with `mine` applied. `effective` is the merge patch from
   `L` to `desired`, which is what the Cluster is asked to change.
4. `Edited`, `ChangedOnCluster` are the leaf paths of `effective` and
   `theirs`. A leaf is anything that is not an object: a scalar, a list, or a
   removal.
5. An overlap is a path of `theirs` that equals, is above, or is below a path
   of `effective`. Two sides that set the same value do not overlap, because
   that value is not in `effective`.
6. A server-set field whose value differs between `manifest` and `base` is
   `Ignored`.
7. A `manifest` whose `apiVersion`, `kind`, `metadata.name`, or
   `metadata.namespace` differs from `live` is refused as `invalid`, with one
   cause per field.

`resource.review`:

1. Get the Resource from the API server. If it is gone, or its UID is not the
   edit's, the request fails with `not_found`, and the message says whether
   it was deleted or replaced by a Resource of the same name.
2. Compute the comparison. If it is refused, or `effective` is empty, return
   the review without a dry run. With nothing to apply, `After` is `Desired`.
3. Send `effective` plus `metadata.resourceVersion` of `live` as a merge
   PATCH with `dryRun=All`.
4. A 409 means the Resource changed between steps 1 and 3. Start again from
   step 1, at most 5 times, then fail with `unavailable`.
5. On success, `After` is the result's editable Manifest and `SetByCluster`
   the leaf paths of the merge patch from `Desired` to `After`.
6. Any other answer from the API server is the review's `Refusal`, not a
   failed request, so the review still shows what was asked. A 400 whose
   message contains "does not support dry run" sets `DryRunUnsupported`.

`resource.apply` runs the same steps with these differences:

- Before refusing overlaps, compare the live editable Manifest with the optional
  `Expected` editable Manifest, using number-aware equality. If they match,
  return `Unchanged` with the live `resourceVersion` and write nothing.
  `resource.review` ignores `Expected`.
- An overlap fails the request with `conflict`. Because the UI sends the
  review's `Before` and `Desired`, an overlap here is a change the user has
  not seen.
- A refusal fails the request with its code and causes.
- An empty `effective` returns `Unchanged` and writes nothing.
- The PATCH is real, and a 409 after 5 attempts fails with `conflict`.

Warnings the API server sends with the PATCH are collected through
`rest.Config.WarningHandlerWithContext` on a client used only for writes, and
returned.

### A write, once sent, finishes, and a mutation is safe to repeat

ADR-0019 records this.

- Everything before the write runs under the request's context. A `cancel`
  message or a lost socket stops it there, and nothing has been written.
- The write itself, the PATCH or DELETE, runs under a context that neither
  ends, with a 30 second limit. Cancelling a write in flight would make its
  outcome unknown, so the Engine does not.
- A dry run is cancelled like any other read.
- `resource.apply` repeated with the same params returns `Unchanged` if
  the live editable Manifest matches `Expected`, or `effective` is empty.
  `Expected` recognizes API server defaults and admission changes present in
  the review's dry-run result. `resource.delete` carries the UID as a
  precondition, and "not found" is success.
- The UI therefore never reports an apply or a delete as failed after
  `disconnected`. It says the outcome is unknown, waits for the connection,
  and sends the same request again while its edit or confirmation still exists.

A repeat remains imprecise when another writer changes an edited field
between the lost answer and the repeat, or admission differs from the dry
run. A `conflict` or refusal does not prove the earlier write never landed.
The UI keeps the outcome unknown until an apply succeeds, the user starts
a new review with Review changes, or the edit is discarded.

A real PATCH or DELETE error that is neither an API status nor an existing
`ErrorDetail` is `unavailable`: the API server did not answer, and the write
may or may not have happened. This includes response read and decode failures.

### Cancelling a request

`{id, type: "cancel"}` cancels the context of the request with that ID. The
session keeps the cancel function of each request in flight. The Engine still
answers, with `cancelled`.

`EngineClient.request` takes an optional `AbortSignal`. Aborting sends
`cancel`, rejects the promise with `cancelled` at once, and drops the late
answer. The Worker boundary gains a `cancel` message.

### Errors keep their structure

`toProtocolError` maps every Kubernetes API error, for every method:

| API server answer                                             | Code          |
| ------------------------------------------------------------- | ------------- |
| Forbidden, Unauthorized                                       | `forbidden`   |
| NotFound                                                      | `not_found`   |
| Conflict                                                      | `conflict`    |
| Invalid, BadRequest, and other 4xx such as a webhook's denial | `invalid`     |
| RequestEntityTooLarge                                         | `too_large`   |
| Timeout, ServerTimeout, TooManyRequests, 5xx, a network error | `unavailable` |
| a cancelled context                                           | `cancelled`   |

`Reason` and `Causes` come from the API server's `Status`, and `Message` is
its readable message. Long quoted Resource payloads are stripped from causes.
Strict decoding errors name each unknown or duplicate field separately; wrong
types keep the server-named field and expected type. Rewritten causes rebuild
Message, and every message is capped at 1,000 characters. The Worker forwards the whole `ErrorDetail` for a failed
request, and `EngineRequestError` exposes `reason` and `causes`.

Existing UI code branches only on `forbidden`, so the wider mapping changes
no behaviour there.

### Size

The control socket's read limit becomes 8 MiB. An apply can carry three copies of
a Manifest, including `Expected`, and the API server refuses a request body over 3 MiB.

`EngineConnection.request` measures the encoded message before sending. One
over the limit is rejected with `too_large` and never sent, because sending
it would close the socket and every subscription with it. The review then
says the Manifest is too large to edit in hukube and to use kubectl.

### Permissions

The Engine asks before the user edits, and the apply remains the authority.

`resource.access` answers from, in order:

1. `--read-only`: neither action is allowed.
2. The type's discovered verbs: no `patch` means no editing, no `delete`
   means no deleting.
3. A `SelfSubjectAccessReview` for `patch` and one for `delete` on the named
   Resource, as `kubectl auth can-i` does. Answers are cached for 30 seconds.

A review that fails or cannot be evaluated counts as allowed, so a Cluster
that cannot answer does not lock a permitted user out. Admission is not
covered by an access review, so an allowed edit can still be refused. That
arrives as `forbidden` from the review or the apply, with the API server's
message.

The UI asks once the Manifest has first arrived, and aborts the request when
the tab closes.

### The Engine can run without mutations

ADR-0020 records this. `hukube-engine --read-only` refuses every request that
changes a Cluster with `forbidden`. Mutating requests register through one
wrapper, `handleMutation`, which makes the check. `resource.access` reports
it, so the UI disables Edit and Delete with the reason.

`mise run dev:tailnet` passes `--read-only` unless `HUKUBE_TAILNET_WRITE=1`
is set. The README says so where it describes the task.

### Delete

`resource.delete` always sends a propagation policy and the UID as a
precondition.

- **Dependents.** The confirmation offers "Delete them too" (background, the
  default), "Delete them first" (foreground), and "Leave them" (orphan). It
  shows the choice only when the Resource owns something, or when that is
  not known yet.
- **Grace period.** For a Pod only, a checkbox "Delete immediately" sends a
  grace period of 0, with kubectl's warning that the containers may keep
  running.
- **Finalizers.** hukube has no button to remove them. A Resource that stays
  after a delete shows a `Terminating` badge, and the YAML Facet can edit
  `metadata.finalizers`.
- A 409 on the UID precondition fails with `conflict`: the Resource was
  replaced and nothing was deleted by that attempt. After a lost answer,
  the original Resource may already have been deleted and replaced.

## UI and UX

### Where each control goes

| Control                | Place                                                                    | Follows                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Edit                   | The YAML Facet's controls in the switcher row, rightmost                 | The Facet's own controls live there (layer 4). Headlamp and Lens put Edit beside the Manifest.                    |
| Cancel, Review changes | The same slot, replacing Edit and Show managed fields                    | GitHub's web editor: "Cancel changes" and "Commit changes…" where Edit was.                                       |
| The review             | A dialog over the window                                                 | GitHub's commit dialog. It is not tied to a Pane's width, and can list several Resources when a Changeset exists. |
| Apply, Back to editing | The review's footer                                                      | Dialog convention.                                                                                                |
| Delete                 | An icon button at the right end of the Resource tab's header             | Headlamp and Lens put delete at the top right of a Resource's header. It acts on the Resource, not on a Facet.    |
| Unsaved mark           | A dot on the tab in place of its close icon, and on the YAML Facet's tab | VS Code's dirty tab.                                                                                              |
| Applied                | A status pill over the top right of the editor area, without reflow      | Inline success feedback.                                                                                          |
| Notices                | One strip between the switcher row and the editor                        | VS Code's banner for a file changed on disk.                                                                      |

A Monaco diff editor shows the diff. It is side by side when it has 900 px
and inline below that, which is Monaco's own rule, with unchanged regions
collapsed.

No toast package is added. An apply's success shows as the dialog closing,
the editor returning to the live Manifest, and a small check icon and "Applied"
pill over its top right corner for 4 seconds, announced politely. The pill is
absolutely positioned, so the Facet tabs and controls do not move.

### The YAML Facet

**Reading mode** is as today, plus Edit. Typing in the editor shows Monaco's
read-only message, set to "Choose Edit to change this Manifest."

Edit is disabled, with the reason as its tooltip and focusable so a keyboard
user can read it, when:

- the Manifest has not arrived, or the Resource is deleted or not found;
- `resource.access` says editing is not allowed. The tooltip is its reason.

Enabled Edit and Review changes have no tooltip. Disabled controls show their
reason on pointer hover and keyboard focus, with `aria-disabled` and guarded
actions so the button remains focusable and receives pointer events.

**Edit mode** starts when Edit is chosen:

- Focus moves into the editor on the same content line, mapped by its YAML
  field when server-set fields disappear. With no caret, or a hidden field,
  it starts on the first line. Cancel, a confirmed discard, and a completed
  apply that ends the edit return focus to Edit.
- The base is the live Manifest at that moment. The text is its editable
  Manifest. The tab stops being a Preview Tab, so the next click in a list
  cannot replace it.
- The controls are Search, Cancel, and Review changes. Below 26rem Search and
  Cancel are icon buttons and Review changes reads "Review". The primary
  action keeps a label at every width.
- The strip reads "Editing. Fields the Cluster sets, such as status, are
  hidden. Nothing changes on the Cluster until you review and apply."
- The edit has unsaved edits when the text differs from the base's text.
  Review changes is enabled only then.
- Cancel leaves Edit mode. With unsaved edits it asks first: "Discard your
  edits to ConfigMap web-config?", with Keep editing and Discard edits.

**The live Manifest during an edit:**

| Situation                                                  | What happens                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No unsaved edits, the Resource changes                     | The base follows it, and the text updates only if the editable Manifest changed.                                                                                                                                                                                        |
| No unsaved edits, the Resource is deleted                  | Edit mode ends.                                                                                                                                                                                                                                                         |
| Unsaved edits, only server-set fields change               | Nothing.                                                                                                                                                                                                                                                                |
| Unsaved edits, the editable Manifest changes               | The text is not touched. The strip reads "ConfigMap web-config changed on the Cluster while you were editing. Review changes shows how your edit applies to it."                                                                                                        |
| Unsaved edits, the Resource is deleted, or its UID changes | The text is not touched. The strip reads "ConfigMap web-config was deleted on the Cluster while you were editing. Your edits cannot be applied." (or "was replaced by a new ConfigMap of the same name"), with Copy YAML and Discard edits. Review changes is disabled. |

The strip shows one notice, the first that applies of: an unconfirmed apply,
deleted or replaced, a pending apply, the last review's refusal, a YAML error, changed on the
Cluster, the editing hint. A pending apply says "An apply of this edit was
in flight when the connection to the Engine was lost. hukube checks the
result when it reconnects." Once a repeat ends without success, the strip
warns: "hukube could not confirm whether your apply went through. Review
changes shows the Cluster as it is now." It stays until an apply succeeds,
Review changes starts a new review, or the edit is discarded. A closed
review dialog never starts a background review after the repeat.

The strip is at most 8rem tall and scrolls beyond that; text wraps anywhere.
The editing hint is neutral with an information icon. Cluster changes and a
pending or unconfirmed apply use the warning token and a warning icon. Refusals, YAML errors,
and deleted or replaced Resources use the destructive token and an error icon.
Text uses the foreground token to keep it readable in both themes.

**Errors in the editor:**

- The text is parsed 200 ms after it last changed. A YAML error, a second
  document, or a root that is not a mapping is a Monaco marker at its line,
  and the strip names the first one with its line. Review changes then moves
  the cursor to it instead of opening the review.
- A review's refusal is kept after Back to editing. Each cause whose field
  resolves to a node of the YAML is a marker on that node, and the strip
  lists up to three causes as `field: message`, then "and N more". Both go
  when the text next changes.

**`Ctrl/Cmd+S`** opens the review while the editor has focus and the edit has
unsaved edits. It does nothing else and never applies.

### The review

The dialog is as wide as the window allows up to 72rem and as tall up to
48rem. From the top:

1. A strip in the Cluster's color with the Cluster's name, as the status bar
   shows it. The dialog is outside the Workspace's element, so it applies the
   Cluster's color itself.
2. The title, "Review changes to ConfigMap web-config", and its Namespace.
3. Callouts, in this order when they apply:
   - a refusal or a failure (see the states below);
   - overlaps: "You and the Cluster both changed `data.greeting`. Applying
     replaces the Cluster's value with yours. The diff shows both.";
   - other changes on the Cluster: "Also changed on the Cluster while you
     were editing, and kept: `metadata.labels.tier`.";
   - "The Cluster also sets: `spec.template.spec.containers[1].imagePullPolicy`.";
   - "Not applied, because the Cluster sets these itself: `status`.";
   - each warning from the API server.
     A list of paths shows five and then "and N more".
4. The diff, labelled "On the Cluster now" and "After applying". The right
   side is `After` when the dry run succeeded and `Desired` otherwise.
5. The footer: a status on the left, Back to editing and Apply on the right.

Focus starts on Back to editing, so Enter cannot apply by accident. Escape
and Back to editing return to the editor with the text and its undo history
as they were. All modal dialogs make the window content inert until the
last modal closes, in addition to Base UI's focus guards. Focus returns to
the editor after the review's close commits and its animation completes,
when the window content is no longer inert.

| State                          | The dialog shows                                                                                                                                                                               | Apply                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Checking                       | A skeleton where the diff will be. Status: "Checking with the Cluster…"                                                                                                                        | Disabled                                       |
| Not connected                  | "Reconnecting to the Engine…"; the existing review is kept. A raced unsent apply says "Not connected to the Engine. Nothing was sent."                                                         | All Apply labels disabled until connected      |
| Ready                          | The diff and callouts. Status: "The Cluster accepts this edit."                                                                                                                                | "Apply"                                        |
| Ready, with overlaps           | The same, with the overlap callout                                                                                                                                                             | "Overwrite and apply"                          |
| Nothing to apply               | In place of the diff: "Nothing to apply", and either "Comments and formatting are not part of a Resource." or "The Cluster already has these values."                                          | Hidden                                         |
| Refused                        | "The Cluster refused this edit" with each cause, "This edit cannot be applied" when there is no API server reason, or "Not permitted" with the API server's message. The diff shows `Desired`. | Disabled                                       |
| Dry run not supported          | A warning with the API server's message: the edit is validated only when it is applied                                                                                                         | "Apply without a dry run"                      |
| The review failed              | The message. Try again, except for `too_large` and `not_found`                                                                                                                                 | Disabled                                       |
| Applying                       | Status: "Applying…". The dialog cannot be dismissed                                                                                                                                            | Disabled                                       |
| Changed while reviewing        | The apply failed with `conflict`. The review runs again, with "The Resource changed on the Cluster while you were reviewing. Nothing was applied."                                             | As the new review says                         |
| Refused on apply               | As Refused, ending "Nothing was applied."                                                                                                                                                      | Disabled until the text changes                |
| The Cluster did not answer     | "The Cluster did not answer. The edit may or may not have been applied.", with Check again, which reviews again                                                                                | Disabled                                       |
| Connection lost while applying | "Lost the connection to the Engine while applying. hukube checks the result when it reconnects.", with Close                                                                                   | Disabled. The apply is sent again on reconnect |
| Applied                        | The dialog closes when the live Manifest reaches the result's `resourceVersion`, or after 2 seconds                                                                                            |                                                |

While the review is open and not applying, a change of the live editable
Manifest from the review's `Before` runs the review again after 300 ms. The
old diff stays, dimmed, until the new one arrives.

The apply sends the review's `Before` as `Base`, its `Desired` as
`Manifest`, and its `After` as `Expected` when present. A review that runs
again sends the edit's own base and text.

An apply's outcome is unknown once its answer was lost, whether between the
UI and the Engine (`disconnected`) or between the Engine and the API server
(`unavailable`). It stays unknown until an apply succeeds, a new review
starts, or the edit is discarded. While it is unknown, a conflicting repeat
reviews again only while the dialog is open, and its warning replaces the
changed-while-reviewing line: "The answer to an earlier apply of this edit
was lost, so it may already have been applied. This review shows the
Cluster as it is now." A refused repeat replaces "Nothing was applied." with
"The answer to an earlier attempt was lost, so the edit may already have
been applied." A conflict is never kept as a refusal in the editor's strip,
because it is about the Cluster and not about the text.

After an apply, Edit mode ends and the editor shows the live Manifest.

### Unsaved edits and the Workspace

| Event                                              | What happens                                                                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit is chosen in a Preview Tab                    | The tab becomes a regular tab.                                                                                                                                                                                               |
| Another Facet is chosen                            | The edit is kept. The YAML Facet stays mounted, and its tab shows the dot.                                                                                                                                                   |
| Ending an edit with an apply pending               | Discarding or unmounting stops checking its result and drops the captured request. The discard prompt says "An apply of these edits may already have reached the Cluster. Discarding stops hukube from checking the result." |
| The tab is closed, by its button or a middle click | "Discard your edits to ConfigMap web-config?", with Keep editing (focused) and Discard edits.                                                                                                                                |
| The Cluster tab is closed or moved to a new window | "Discard unsaved edits in k3d-hukube-e2e?" with the number of Resources, Cancel, and Discard and close.                                                                                                                      |
| The window is closed or reloaded                   | The browser's own prompt, from `beforeunload`. The desktop Host shows a dialog with Cancel and Discard, from `will-prevent-unload`.                                                                                          |
| The Resource is deleted by someone else            | See the table above. Copy YAML keeps the work.                                                                                                                                                                               |
| The connection to the Engine is lost               | The edit is kept and can go on. Review changes is disabled with "Reconnecting to the Engine".                                                                                                                                |
| The window is out of date                          | The notice adds "N Resources have unsaved edits, which reloading discards." and Copy unsaved edits, which copies each as a YAML document.                                                                                    |

A small store holds which tabs have unsaved edits, their labels, and a way to
read each text. The tab, the Cluster tabs, the window, and the out-of-date
notice read it. dockview cannot veto a close, so the guard is in the two
places that close a tab.

### Delete

The Delete button is a trash icon in the tab's header with the tooltip
"Delete". It is disabled, with the reason, when `resource.access` says no,
when the Resource is already deleted, and while the Engine is not connected.

The confirmation is an alert dialog. From the top:

1. The Cluster strip, as in the review.
2. "Delete ConfigMap web-config?" and its Namespace.
3. What will go with it:
   - a Namespace: "This deletes every Resource in the Namespace: at least
     42 Resources." The count is the total of a Query for that Namespace;
   - a CustomResourceDefinition: "This deletes every Widget in the Cluster:
     3 Resources." The count appears only when the Resource Type is known
     and `ready`; otherwise it says "This deletes every Widget in the
     Cluster. The number of Resources is not known." An unknown kind uses
     "Resource of this type";
   - a Resource that owns others: "It owns 3 Resources: ReplicaSet (1) and
     Pod (2).", with the dependents choice;
   - a Resource with finalizers: "It has finalizers (a, b), so it stays
     terminating until they are removed.";
   - one already terminating: "It is already terminating and waits for
     finalizers: a, b. Removing them from metadata.finalizers in the YAML
     Facet releases it." Without finalizers it waits for the Cluster to
     finish deleting it.
4. For a Pod, the Delete immediately checkbox and its warning.
5. For a Namespace or a CustomResourceDefinition, a field: "Type the name to
   confirm". Delete is disabled until it matches, as GitHub does for a
   repository and Headlamp for a protected Namespace.
6. Cancel, focused first unless the name field is shown, and a destructive
   Delete.

| State                          | The dialog shows                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counting                       | A skeleton line for the count. Delete does not wait for it.                                                                                                                                    |
| Deleting                       | "Deleting…" on the button. The dialog cannot be dismissed.                                                                                                                                     |
| Deleted                        | The dialog closes. The tab shows `Terminating`, then `Deleted`, from the live Manifest.                                                                                                        |
| Not permitted                  | "Not permitted" with the API server's message.                                                                                                                                                 |
| Replaced                       | "This ConfigMap was replaced by a new one of the same name. Nothing was deleted."                                                                                                              |
| The Cluster did not answer     | "The Cluster did not answer. The delete may or may not have happened.", with the API message and Try again.                                                                                    |
| Connection lost while deleting | "Lost the connection to the Engine while deleting. The delete may or may not have reached the Cluster. hukube sends it again when it reconnects." Stop and close, or Escape, stops the resend. |
| Not connected                  | "Reconnecting to the Engine…"; Delete is disabled. A raced unsent request says "Not connected to the Engine. Nothing was deleted."                                                             |

After a delete whose answer was lost, by `disconnected` or `unavailable`, a
conflicting repeat instead says "The answer to an earlier attempt was lost.
The Resource may have been deleted and then replaced by a new one of the
same name." Other refused repeats end with "The answer to an earlier attempt
was lost, so the delete may already have happened." Neither claims nothing
was deleted.

A Resource with a `deletionTimestamp` shows a `Terminating` badge in the
header, whose tooltip says "Waiting for finalizers: a, b", or "Waiting for the Cluster
to finish deleting it" when there are none. Delete stays available.

### Widths and themes

The Facet's states are designed for a Pane of 330, 520, and 1040 px: the
controls take their compact form below 26rem, the strip wraps, and its
actions move under its text when they do not fit beside it. The two dialogs
are sized by the window, so they are checked at window widths of 900 and
1280 px. Both themes are checked for the strip, the markers, the diff, and
the Cluster strip.

### Packages

- **Monaco's diff editor** for the diff. It is already the editor.
- **`yaml`** for parsing, errors with positions, and finding a field's node.
- **`evanphx/json-patch`** in the Engine for merge patches.
- **shadcn `alert-dialog` and `checkbox`** are added with the shadcn CLI for
  the confirmations. `dialog`, `alert`, `select`, and `tooltip` exist.
- A three-way text merge package, such as `node-diff3`, is not needed: the
  Engine compares Manifests as data, so the user's text is never rewritten.

### Key bindings

- Added: `Ctrl/Cmd+S` in the YAML editor with unsaved edits, as approved.
- The allow-list gains the action's command ID and nothing else. Editing
  itself adds no binding, because Monaco registers the same bindings for a
  read-only editor.
- Any binding the diff editor brings is removed in `apps/app/src/lib/monaco.ts`
  and listed under "What changed while building".

## Steps

The work ships as one pull request, in two parts. The Engine part is
inspected before the UI part starts.

### Part 1: protocol, Engine, and client

1. Protocol: the types above, `cancel`, the codes, and
   `MaxClientMessageBytes`. Run `mise run gen`.
2. Session: cancellable requests, the read limit, and the error mapping.
3. `engine/internal/edit`: the comparison.
4. Cluster: review, apply, delete, and access, with the write client and its
   warning collector.
5. Server: the four handlers, `handleMutation`, and `--read-only`.
6. Client: `AbortSignal`, the whole `ErrorDetail` across the Worker, and the
   size check.
7. `dev:tailnet`, the README, and ADR-0019 and ADR-0020.

### Part 2: UI

1. The YAML configuration, the editable Manifest, and field paths.
2. Edit mode in the YAML Facet: the session, the strip, markers, and
   `Ctrl/Cmd+S`.
3. The review dialog and the diff editor.
4. The unsaved-edits store and its guards, including the desktop Host.
5. Access, the Delete button, the confirmation, and the `Terminating` badge.
6. Sample Resources in `e2e/fixtures/sample`, in a Namespace of their own:
   ConfigMaps to edit and delete, one held by a finalizer, a Deployment that
   owns Pods, a Widget, a Namespace to delete, and a second CRD with one
   Resource.
7. End-to-end tests, the key bindings allow-list, and `AGENTS.md`.

## Testing strategy

Each new test is shown to fail against a broken implementation before it is
accepted.

| Risk                                                          | Evidence                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The comparison is wrong                                       | Unit tests in `edit`: untouched fields stay out of `effective`; a field removed; a list replaced; both sides setting the same value; overlaps above and below a path; server-set fields ignored; identity changes refused; `1` and `1.0` equal; an integer above 2^53 in an untouched field survives.                                       |
| An edit is not applied, or takes fields it did not change     | envtest: apply an edit to a ConfigMap and read it back; `managedFields` gives `hukube` only the changed field.                                                                                                                                                                                                                              |
| A dry run writes, or hides what the Cluster would set         | envtest: review an edit that adds a container without an image pull policy; the Resource's `resourceVersion` is unchanged and `SetByCluster` names the defaulted fields.                                                                                                                                                                    |
| A refusal loses its fields                                    | envtest: a negative `spec.replicas` gives a `Refusal` with the cause's field; an unknown field gives one; apply fails with `invalid` and the same causes.                                                                                                                                                                                   |
| A user without permission is not told                         | envtest with `testenv.User`: `resource.access` denies both actions with a reason; review returns a `forbidden` refusal; delete fails with `forbidden`.                                                                                                                                                                                      |
| A concurrent change is overwritten or blocks needlessly       | envtest: change another field first, and the apply keeps it; change the same field first, and review reports the overlap and apply fails with `conflict`; change only `status`, and nothing is reported.                                                                                                                                    |
| A deleted or replaced Resource is patched                     | envtest: review and apply after a delete, and after a delete and re-create, fail with `not_found`.                                                                                                                                                                                                                                          |
| Each delete option does something else                        | envtest: background removes the Resource; foreground and orphan leave it with the matching finalizer; `Immediate` removes a Pod bound to a Node at once, and without it the Pod stays with a `deletionTimestamp`; a stale UID fails with `conflict`; a repeat succeeds.                                                                     |
| A cancelled request keeps running, or a write is cut short    | `server` tests with a replaced client: `cancel` during a dry run answers `cancelled` and the call's context ends; `cancel` and a closed socket during a write let it finish.                                                                                                                                                                |
| A repeated apply fails or writes twice                        | envtest: the same `resource.apply` twice returns `Unchanged` the second time with the same `resourceVersion`.                                                                                                                                                                                                                               |
| `--read-only` lets a write through                            | `server` test: apply and delete fail with `forbidden`, and `resource.access` says why.                                                                                                                                                                                                                                                      |
| A large message closes the socket                             | `connection` test: a request over the limit rejects with `too_large` and nothing is sent. `server` test: a message just under the limit is read.                                                                                                                                                                                            |
| The client loses error detail or leaks a cancelled request    | `connection` and `worker` tests: `causes` reach the caller; abort sends `cancel`, rejects, and ignores the late answer.                                                                                                                                                                                                                     |
| YAML is read differently from kubectl, or does not round-trip | Vitest: the probe's table, and `parse(render(x))` equal to `x` for the values in it.                                                                                                                                                                                                                                                        |
| Unsaved edits are lost                                        | Component tests with jsdom: an incoming change during an edit leaves the text and shows the notice; a change with no unsaved edits updates the text; switching Facets and back keeps the text; Edit in a Preview Tab pins it; closing the tab asks, and Keep editing keeps it; a delete during an edit keeps the text and offers Copy YAML. |
| The review misreports                                         | Component tests with a fake client for each state in the table, including the repeat after `disconnected` and the re-review after `conflict`.                                                                                                                                                                                               |
| A key binding slips in                                        | The end-to-end allow-list, with an editable editor and an open review. `Ctrl/Cmd+S` opens the review only with unsaved edits and never applies.                                                                                                                                                                                             |
| The feature does not work end to end                          | Playwright, on Resources the test creates in its own Namespace: add a key to a ConfigMap, review, apply, and see the list's Data cell change without a reload; change the same key with kubectl during an edit, see the overlap, and choose Overwrite and apply; delete a ConfigMap after confirming and see the row go.                    |

Checked by hand in Chromium and WebKit, in both themes, at the widths above:
no edits, unsaved edits, the review, a dry run that fails, an apply that
fails for each reason, a conflict, a Resource deleted while it is being
edited, a Resource stuck terminating, not permitted, read-only, and the
connection lost during an apply.

## Risks

- **A list is one field.** A merge patch replaces a changed list whole, so
  two changes inside the same list overlap even when they touch different
  elements. That is reported as an overlap, never merged silently. It is
  coarser than a strategic merge patch.
- **Numbers pass through JavaScript.** A value the user edits is a double in
  the browser, so an integer above 2^53 in an edited field or an edited list
  loses precision. Untouched fields are not sent.
- **Two lists of server-set fields.** The Engine's is the rule and the UI's
  makes the text. If they differ, the review lists the difference as
  ignored, and nothing wrong is written.
- **An access review can be wrong.** A Cluster whose authorizer answers "no"
  for a permitted user would disable Edit. That is how `kubectl auth can-i`
  behaves too.
- **Monaco in a dialog.** The diff editor must lay out after the dialog's
  animation and keep focus inside the dialog. This is checked in two
  browsers straight after the UI is built.

## Non-goals

- A Changeset across Resources, and staging edits across tabs.
- Creating a Resource, or applying a Manifest from a file or the clipboard.
- Scale, restart, cordon, roll back, and other actions.
- A Form Facet, and editing `status` or another subresource.
- Deleting from a list, and deleting several Resources at once.
- Removing finalizers with a button.
- Marking a Cluster as production.

## Unresolved questions

None that block the work. Two choices are recorded for Jim to confirm at the
end: `dev:tailnet` is read-only unless asked otherwise, and a write in flight
is never cancelled.

## What changed while building

Part 1 implements the settled contract. These details were left to the
implementation:

- Manifest values generate as TypeScript mappings of `unknown`, like
  `ResourceData.Object`. `request(method, params, { signal })` is the public
  cancellation API. `RequestErrorDetail` widens the protocol error with the
  client-only `not_connected` and `disconnected` codes; Worker failures carry it in `error`.
- The pinned `json-patch/v5` version is `v5.9.11`, promoted from indirect to
  direct without adding or updating another dependency. Its patch builder
  preserves numbers as `json.Number`, but compares their literal encodings.
  The comparison retains an original encoding when two values are numerically
  equal. Decimal comparison uses significant digits and an exponent, so a
  huge exponent cannot cause an equally huge allocation. RFC 7386 patch
  construction and application remain the library's job.
- A patch that adds an empty object counts that object's path as edited.
  Otherwise a real patch such as `{"data":{}}` would look empty to the apply
  path. Lists and removals remain single leaf paths.
- `json-patch.Equal` in this version panics when comparing two JSON `null`
  values. The comparison uses decoded values with exact decimal equality
  instead. The regression is covered by the server-field tests, which include
  a null `deletionTimestamp`.
- A request waits for initial discovery, but an unknown Resource Type fails
  immediately once discovery is ready. It does not wait indefinitely for a
  CRD that might appear later, as the existing Resource subscription does.
- Missing delete propagation means `background`; an unknown value is
  `invalid`. An empty delete UID is also `invalid`, rather than allowing an
  unguarded delete. `Immediate` is ignored outside the core `pods` type.
- Access answers are cached per Cluster, preferred group/version/resource,
  Namespace, name, and verb. Discovery's verbs are checked before cached
  answers. Indeterminate answers are cached for the same 30 seconds as
  decisions. Expired entries are removed when storing a fresh answer.
  Read-only access is answered before resolving a Cluster.
- The write client's REST timeout is cleared. `Timing.WriteTimeout` supplies
  the whole write's limit, independently of a kubeconfig's request timeout.
  Successful writes keep their successful answer even if the request context
  ended while they were in flight.
- API error mapping is shared by Cluster review refusals and the server in
  `internal/apierror`, so they retain the same code, reason, and causes.
  End-of-stream transport errors (`EOF` and `UnexpectedEOF`) are
  `unavailable`. A deleted Resource keeps the API server's structured detail
  while adding the edit-specific explanation.
- Abort listeners are removed on completion, cancellation, and disconnection.
  Closing `WorkerEngineClient` also rejects its pending requests with
  `disconnected`, since terminating its Worker prevents any later answer.
- The control socket now accepts 8 MiB. The stream socket retains its existing
  4 MiB limit; subscriptions and streams have no new behavior.

The envtest API server confirmed field ownership, strict validation causes,
container defaulting during dry runs, and delete finalizers and grace periods.
No material contradiction with the settled contract was found. Admission
change coverage uses container defaulting; unsupported dry runs, repeated
409s, warnings, and indeterminate access reviews use controlled HTTP boundaries.
No MutatingAdmissionPolicy or real Cluster was needed.

### Part 2

Part 2 implements the UI contract. These details were left to the
implementation:

- The edit session stays in the YAML Facet, which ADR-0013 already keeps
  mounted across Facet changes. Its pure session functions and the review
  hook are exercised without Monaco. The Resource panel owns access and
  Delete, so both remain available across Facets.
- Review parses the current text immediately, even when the 200 ms marker
  debounce has not fired. Parsing and rendering share `yamlOptions`, with
  `resolveKnownTags: false` as well as the removed tags, so an explicit tag
  cannot re-enable a removed type. Alias expansion has the package's limit
  of 100; an expansion failure is reported at line 1.
- Cause lookup walks YAML nodes, including list indices and literal dotted
  label keys. Displayed field paths quote keys that cannot be written as
  plain dot notation. Counts of owned kinds and unsaved tabs use Maps.
- The unsaved-edits store belongs to the window. Resource and Cluster close
  paths ask through one alert dialog; `beforeunload` supplies the web Host's
  prompt and Electron's `will-prevent-unload` supplies Cancel and Discard.
- Copy first uses the standard Clipboard API and falls back to a selected
  textarea and `document.execCommand("copy")` on plain HTTP or permission
  failure. The textarea is inside an open dialog's focus trap when needed.
  Copy YAML reports a failure in the Facet; Copy unsaved edits reports one
  in the out-of-date notice.
- A review and access request are aborted when their owner goes away. A
  write has no AbortSignal. Reconnection repeats the captured params, and
  also checks the connection when entering the lost-connection state, to
  cover a reconnect that finished before the rejection reached React.
- Closing the connection-lost apply dialog lets editing continue. A later
  successful result clears only the submitted text; newer edits remain.
  Another review waits while that apply's outcome is pending.
- Delete captures the UID when the confirmation opens, so a replacement
  received while the confirmation is open cannot become its new target.
  Repeated deletes keep that UID and every chosen option.
- A Namespace count failure says the count is unavailable, and Delete still
  does not wait. The dependents select displays the three user-facing
  labels rather than the protocol's propagation values. A disconnected
  Delete confirmation can be dismissed; doing so ends its repeat.
- The new samples are in `edit.yaml`, with their own `sample-edit` Namespace
  and a separate disposable `sample-delete` Namespace. The seed task named
  files explicitly, so it now includes `edit.yaml`. Existing sample
  Resource definitions are unchanged.

The only new shortcut is `hukube.edit.review`, Ctrl/Cmd+S. Monaco adds its
editor ID to an action's precondition; the action also requires this
editor's dirty context and `editorTextFocus`. The end-to-end test checks
reading, clean editing, dirty editing, focus outside the editor, and focus
in the review. S never applies.

The diff editor registers three bindings removed in `lib/monaco.ts`:

- `diffEditor.exitCompareMove`: Escape.
- `editor.action.accessibleDiffViewer.next`: F7.
- `editor.action.accessibleDiffViewer.prev`: Shift+F7.

The live end-to-end resolver allow-list has only the new review command ID
added. No material contradiction with the settled UI contract was found.
Playwright's `keyboard.insertText` feeds multiline YAML through Monaco's
_typing_ indentation and accumulates indentation. The new flow pastes its
Manifest instead, using the same Clipboard permission setup as the existing
Log Stream test. This is a test-input distinction, not a production API.

Verification covers scalar parity and round trips, session/live updates,
refusal markers' field locations, every review outcome, reviewed apply
params, conflict re-review, reconnect repeats, access lifetime, close and
unload guards, plain-HTTP copying, Delete options/identity, and the real
edit/review/apply/overlap/delete flow. Representative perturbations changed
YAML to 1.2, removed dirty-text protection, sent the session base on apply,
skipped the reconnect apply and delete, dropped the delete UID, used the
replacement UID, bypassed the close prompt and copy fallback, requested
access before the Manifest, and removed S. Each failed at its intended assertion and was
restored exactly. The parent still owns the two-browser, widths, and
both-theme visual review described above.

### Experience-review corrections

- `not_connected` means the client sent nothing. `disconnected` means the
  request was sent but its answer was lost. Both the connection and Worker
  client refuse requests before an open connection. Apply and Delete are
  disabled until it is open; raced unsent requests leave their review or
  confirmation usable. An unsent retry of a previously in-flight write
  retains the original unknown outcome instead of claiming nothing happened.
- A pending apply belongs to its edit. Closing its dialog keeps checking,
  while Cancel, Discard edits, closing its Tab, or unmounting its Facet ends
  checking. A pending delete belongs to its confirmation; Stop and close
  and Escape drop the repeated request. This cannot undo a write already sent.
- The envtest API server reports a wrong type on `patch`, quoting the whole
  Resource, followed by `json: cannot unmarshal string into Go struct field
DeploymentSpec.spec.replicas of type int32`. The shared mapper extracts
  `spec.replicas: expected int32, got string`. It also splits strict decoding
  problems into field causes and bounds every message without cutting UTF-8.
- Base UI's correctly configured modal roots redirect their hidden Tab guards
  on an animation frame. Rapid Tab presses can reach background controls
  before that frame, since `aria-hidden` does not prevent keyboard focus.
  Both shared dialog roots now keep `#root` inert with a reference count that
  preserves its previous inert state. The real browser test records any
  focus entering the background while cycling past every dialog control.
- Monaco's `features/readOnlyMessage/register` loads the read-only contribution
  and its message controller. Its `leaveEditorMessage` binding was already
  removed in `lib/monaco.ts`, so it adds no active key binding. The browser
  verifies the displayed message and the unchanged resolver allow-list.
- Successful Copy YAML and Copy unsaved edits say "Copied" for two seconds,
  announced politely. Resource counts use the singular at one. Finalizer
  copy names both the wait and how an already terminating Resource is released.
  Owned kinds use `Kind (count)`, matching the sidebar's kind-and-count pattern,
  rather than guessing the English plural of a Cluster-supplied kind such as
  Policy or Ingress. The surrounding Resource count still uses the singular
  at one.
- The success pill uses the foreground text and a success icon on the popover
  token. Warning and error strips retain foreground text, with token-colored
  backgrounds, borders, and icons, so the small text keeps its contrast.

### Scoped review corrections

- Applies carry the review's `After` as optional `Expected`. Comparing its
  editable Manifest before overlap checking recognizes an apply that landed
  with API server defaulting, including a default inside an edited list.
  Another writer changing an edited field before a repeat, or admission
  differing from the dry run, still leaves the original outcome unknown.
- Unknown outcome and reconnect checking are separate states. Re-reviewing
  after a conflict preserves uncertainty; Review changes deliberately starts
  a new review. A closed dialog keeps an unconfirmed warning without a
  background review. Delete retains uncertainty across refused repeats too.
- Once a real PATCH or DELETE is sent, a non-status response failure is
  `unavailable`, not a refusal. Controlled transport tests let the API server
  finish the write before failing the response read or PATCH decode.
- Non-finite YAML scalars are rejected at their node positions before JSON
  encoding can turn them into removals. Rendering removes only the merge tag
  from its schema and quotes literal `<<` mapping keys; parsing still supports
  typed merge keys. Both reading and editing use this renderer.
- Review close uses Base UI's `onOpenChangeComplete` to return focus after
  the window loses `inert`. The end-to-end flow types without clicking after
  Escape and verifies the existing undo history.
- A CustomResourceDefinition confirmation states a Resource count only for a
  known Resource Type in `ready`. Missing, syncing, forbidden, and failed
  types say the count is not known.
- The refusal end-to-end test creates a `pause` container using
  `rancher/mirrored-pause:3.6`, already present in k3s.
