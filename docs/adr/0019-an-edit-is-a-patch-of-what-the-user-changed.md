# An edit is a patch of what the user changed, guarded by the version it was checked against

Editing is the first thing hukube does that changes a Cluster. This records
what an edit sends, what a conflict is, and what happens when the outcome of
a write is not known.

An edit is two Manifests: the one the user started from, and the one they
made. What the edit asks for is the difference between them. The Engine
fetches the Resource, applies that difference to it, and sends the result as
a JSON merge PATCH that carries the `resourceVersion` it fetched, with the
field manager `hukube` and strict field validation. The API server refuses
the PATCH if the Resource has changed again, and the Engine then fetches and
compares again.

This is what `kubectl edit` sends for a custom resource, with two additions:
the `resourceVersion`, which `kubectl edit` leaves out, and the comparison
below.

## What a conflict is

The Engine compares three Manifests: the base, the edited one, and the one
on the Cluster now.

- A field changed on the Cluster that the edit does not touch is kept. This
  is the common case: a controller wrote an annotation, or an autoscaler
  changed `replicas`, while the user edited an image.
- A field changed on the Cluster that the edit sets to another value is an
  **overlap**. A review reports it, with the Cluster's value on one side of
  the diff and the user's on the other. An apply refuses it.
- A change to `status` or another field the Cluster sets is not a change to
  compare. A Deployment's `resourceVersion` moves with every status update,
  and none of them is a conflict.

The user applies what they reviewed: the UI sends the review's own "before"
and "after" as the edit. An overlap at that moment is therefore a change the
user has not seen, and the review runs again and shows it.

A list is compared as one field, because a JSON merge patch replaces a list
whole. Two changes inside the same list overlap.

## The editable Manifest

An edit cannot change `status`, or the metadata the Cluster sets:
`managedFields`, `resourceVersion`, `uid`, `generation`,
`creationTimestamp`, `deletionTimestamp`, `deletionGracePeriodSeconds`, and
`selfLink`. Edit mode does not show them, and the Engine removes them from
every Manifest it compares, so the rule holds for any client. The review
lists one the user typed back in as ignored. `kubectl edit` shows `status`
and drops edits to it without a word.

An edit cannot change `apiVersion`, `kind`, `metadata.name`, or
`metadata.namespace`. The Engine refuses it, as `kubectl edit` does.

## A write, once sent, finishes, and a mutation is safe to repeat

If the socket drops after the Engine has sent a write and before the UI
hears the result, the UI does not know whether it happened.

- The Engine never abandons a write in flight. A lost socket or a `cancel`
  message stops a request only before its write is sent, when nothing has
  changed. A dry run is cancelled like a read.
- Repeating a mutation is harmless. A repeated apply finds the Cluster
  already holds every value and reports that. A delete carries the UID it
  means, and finding nothing to delete is success.
- The UI never reports a mutation as failed when the connection was lost. It
  says the outcome is unknown, waits for the connection, and sends the same
  request again while its owner still exists. A request rejected before an
  open connection is `not_connected`: nothing was sent. `disconnected` is
  reserved for a sent request whose answer was lost.
- A pending apply belongs to the edit. Its notice stays visible after the
  review closes. Ending or discarding the edit, closing its Tab, or unmounting
  its Facet stops checking and drops the repeated request. The discard prompt
  explains that the apply may already have reached the Cluster.
- A pending delete belongs to its confirmation. Its warning explains the
  unknown outcome, and Stop and close or Escape stops the resend. Ending
  checking cannot undo a write that has already reached the Cluster.

## Considered Options

- **Server-side apply of the edited Manifest.** A Manifest read from the
  Cluster and applied back makes `hukube` an owner of every field in it, in
  conflict with the controllers that own them, and applying cannot remove a
  field `hukube` never applied. Server-side apply fits a tool that owns a
  Resource's configuration, such as a GitOps controller, not an editor.
- **Server-side apply of only the changed fields.** Most fields already have
  an owner, so nearly every edit would need force, and a later edit that
  omits a field would remove it.
- **A full update (PUT) with `resourceVersion`.** Every write in between is a
  conflict, including status updates, so editing a busy Deployment fails
  again and again for changes the user cannot see. It also sends every field
  back through the browser, where an integer above 2^53 loses precision.
  Headlamp's create path works this way.
- **A patch without `resourceVersion`,** as `kubectl edit` sends. A change
  to the same field by someone else is then lost with no sign of it.
- **A strategic merge patch,** which merges a list by its key. It exists
  only for built-in types and needs their Go types or OpenAPI schemas. Two
  kinds of patch would mean two sets of conflict rules.
- **Any change on the Cluster is a conflict the user resolves by hand,** as
  VS Code treats a file changed on disk. A Resource is written by
  controllers all the time, so the user would be asked to re-apply other
  writers' changes by hand, and a mistake there reverts them.
- **Remember each mutation's outcome in the Engine** under a key the client
  chooses, and let the client ask after it reconnects. It answers exactly
  while the Engine lives and not at all after a restart, so repeating would
  still have to be safe. One mechanism is enough.

## Consequences

- `hukube` owns, in `managedFields`, only the fields users changed with it.
- An edit of one list element sends the whole list. A change by someone else
  inside that list is reported as an overlap, never merged.
- The review is a request to the Engine, not a comparison in the browser.
  The Engine returns both sides of the diff, so what the user reviews is
  what the Engine compared.
- A Changeset is a list of these edits, reviewed and applied with one
  request per Resource. Nothing here needs to change for it.
- A repeated apply answers `conflict` in one case: admission rewrote a value
  the edit set. The review that follows shows the Cluster's value.
- YAML is parsed in the UI as kubectl parses it (YAML 1.1 types), so
  `0644` and `yes` mean what they mean to `kubectl apply`. Comments and
  formatting are not part of a Resource and are not kept.
- A delete always sends a propagation policy, `Background` unless the user
  chooses another, because a Job or a ReplicationController deleted without
  one orphans what it owns.
- A cancelled request answers `cancelled` only when nothing was written.
