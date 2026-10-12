# A list's columns are a default plus a stored layout, per Resource Type

Which columns a Resource list shows, and in what order, is decided in the UI
from two things: a default built into hukube for the Resource Type, and a
layout the user has stored for that type. The stored layout lives in the
Engine's settings store (ADR-0009) under `columns/<type key>`, so it is
shared by every Cluster, window, and Host. It is the whole ordered list of
columns, each shown or hidden, with the columns a Cluster serves identified
by name.

The Engine keeps sending every column (ADR-0010) and knows nothing about
layouts. The UI resolves the default, the stored layout, and the columns the
Cluster serves each time any of them changes.

The alternatives were a layout per Cluster, and storing only the differences
from the default. Per Cluster, a user would arrange Pods again for every
Cluster they open. Differences would let a later change to a default reach
users who have edited that type, but an order has no natural difference form.

## Consequences

- Clusters can serve different columns for one type, such as two versions of
  a CRD. A column the stored layout does not know appears where the default
  puts it, and a stored column the Cluster does not serve is skipped but
  kept, so one layout works across them.
- A column is known by its name. A column a CRD renames is a new column, and
  two columns that share a name are one.
- Once a user edits a type's layout, later changes to that type's built-in
  default do not reach them until they reset it.
- A list reads its layout live, unlike a Workspace layout, so an edit in one
  window shows in the others. Two clients editing at once still follow
  ADR-0009: the last write wins.
- A default sort, column widths, and other per-type list preferences can join
  the same setting later.
