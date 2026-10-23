# Overview definitions

A definition is YAML data describing the Overview Facet for one Resource Type.
Open **Settings > Overview definitions** beside the theme toggle to inspect or
export built-ins, paste YAML or import a local file, validate it, then install it.
Installing changes an Engine setting. It does not access a Cluster and works
with a read-only Engine. No URL imports, templates, HTML, CSS, or executable
values are supported.

Custom definitions override a bundled definition with the same Resource Type
key. There is one custom entry per key. Replacing or removing it requires an
explicit confirmation. Another window's changes to other entries are preserved.
If that window changes the same entry, use **Review current definition**, inspect
the current source, then confirm again. Failed saves keep the import text.
Malformed or unread settings are never replaced with an empty registry.

## Version and matching

The required `version` is `1`. Unknown versions and unknown properties are
rejected. `resourceType` is an exact plural Resource Type key, such as `pods`,
`deployments.apps`, or `widgets.sample.hukube.dev`. It is never inferred from a
kind. Optional `apiVersions` restricts the definition to exact API versions,
such as `[apps/v1]`. Matching waits for discovery or the Manifest's API version.
Groups cannot match one another accidentally.

A Facet-less Resource URI defaults to Overview when matched and YAML otherwise.
An explicit or inherited applicable Facet stays selected. Explicit YAML links
and saved selections keep their meaning. An unavailable explicit Overview shows
YAML while retaining its URI. A default is held during an edit session.

A definition is pinned from the first inline input until the edit ends. Changes
to the registry then show a notice. A clean Tab adopts definition changes.
Invalid custom entries have individual diagnostics and leave built-ins usable.

## Format reference

[definition.schema.json](definition.schema.json) describes the structural
schema. The application also enforces the semantic policies below.
`mise run gen:overview` regenerates the schema from the Zod source; a test checks
for drift. Built-in YAML lives in
`apps/app/src/features/overview/builtins/`. The Deployment definition is a
complete example of editing an image inside a nested container list.

| Property       | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `version`      | Required integer `1`.                                                                 |
| `resourceType` | Required exact Resource Type key.                                                     |
| `apiVersions`  | Optional non-empty list of allowed API versions.                                      |
| `title`        | Required human-readable title.                                                        |
| `sections`     | Ordered list of sections. Each has `id`, `title`, `fields`, and optional `hideEmpty`. |
| `hideEmpty`    | Hides a section only when all its fields are empty and read-only.                     |

Every field has a globally unique `id`, a `type`, a `label`, and a `path`.
Paths are non-empty arrays of literal string keys or non-negative integer list
indexes. Dots and slashes inside keys are literal: `[metadata, annotations,
example.dev/key.with.dot]` addresses one annotation. Traversal uses own
properties. Prototype-related keys are rejected in declared paths.

| Field type | Additional properties                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `field`    | Required `format`; optional `edit`.                                                                                                                                                                            |
| `map`      | Optional `empty`, `sensitive`, and `edit: {type: string, remove: true}`. String maps allow unique non-empty new keys, value edits, and removal. Keys cannot be renamed.                                        |
| `table`    | Required non-empty `columns`, optional `empty`. Each column has `id`, `label`, relative `path`, `format`, and optional `edit`. Existing scalar cells can be edited. Whole row insertion/removal stays in YAML. |

Formats are `text`, `multiline`, `number`, `boolean`, `timestamp`, `badge`, and
`sensitive`. Absent scalars show **Not set**. Maps and tables show their empty
state. Collections show at most 100 entries or rows, disclose omitted items,
and retain the full value in YAML. Unexpected shapes stay readable and direct
the user to YAML. Values are always rendered as text.

An `edit` block has required `type`: `string`, `integer`, `number`, `boolean`,
or `enum`. Optional `remove: true` removes the key, distinct from `""`, `0`, or
`false`. `enum` requires unique string `choices`. Numeric controls accept `min`
and `max`; string controls accept `multiline: true`. Numbers must be finite and
integers safe JavaScript integers. Numeric and boolean display formats require
compatible controls. Timestamps and sensitive fields are read-only. There is
no null control. A live JSON type mismatch, including IntOrString, requires YAML.

The application refuses edits to `status`, `apiVersion`, `kind`, identity
metadata (`name`, `namespace`), and server metadata (`managedFields`,
`resourceVersion`, `uid`, `generation`, creation/deletion timestamps, deletion
grace period, `selfLink`). Ancestor paths and full table/column paths are checked.
Core Secret `data` and `stringData` are always masked and read-only, including
custom definitions. Reveal is explicit; valid UTF-8 base64 is decoded, while
binary values are labeled. Secret values are excluded from accessible names and
tooltips. Definition exports contain definition source, never Resource values.

Definitions use YAML 1.2 core with unique keys. Anchors, aliases, merge keys,
explicit tags, duplicate ids/paths, unsupported controls, and incompatible
controls are rejected. Limits are 64 KiB per source, 2 MiB per stored registry,
16 nesting levels, 32 sections, and 256 total declared fields and columns.
Errors include the definition path or YAML line information where available.
Kubernetes Manifests still use Hukube's existing YAML 1.1 scalar rules.

## Shared editing

Click or focus an editable value and press Enter or Space. Every valid input
updates the same draft used by YAML. Invalid text remains visible and blocks
Review from every Facet. Escape restores the value from when the field opened;
Done finishes the field; multiline controls have a visible Done action.
Changed fields have an amber marker, a Changed label, and Revert.

Cancel discards the Resource edit after confirmation. Review uses the existing
Engine dry-run and apply dialog. Nothing reaches the Cluster before Apply.
The Tab's unsaved dot and shared Unsaved changes notice remain across Facets;
Events, Logs, and Related offer the same Review action in that notice. There
is one close/unload guard and one apply/retry owner per Resource Tab.

Valid YAML edits update Overview. Invalid YAML, anchors, aliases, or merge keys
keep YAML usable and block inline edits. Literal quoted `<<` keys are safe.
Inline AST edits preserve comments, node styles, literal string types, and
undisplayed fields; exact whitespace is not guaranteed. A changed list is sent
as a whole by JSON merge patch, so inline edits refuse enclosing lists that
contain unsafe integers. Untouched large integers outside the list are retained.

The YAML gutter marks added, modified, and deleted lines relative to the editable
base, with an accessible description. Diff work is bounded. If the limit is
reached, the draft and Review remain usable. Form changes enter Monaco's Undo
history when the editor has mounted. No new app shortcut is added.

## Widget example

[widget.yaml](widget.yaml) is the installable definition.
[widget-crd.yaml](widget-crd.yaml) is a complete CRD plus example Resource for a
disposable Cluster. Apply the CRD and Resource to that Cluster using its explicit
kubeconfig, then import `widget.yaml` through Settings. Open the Widget and edit
Size, Message, Replicas, Enabled, Options, or an existing endpoint URL. Remove
the custom definition to restore YAML fallback.
