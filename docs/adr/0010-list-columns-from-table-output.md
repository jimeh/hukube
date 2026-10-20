# List columns come from the API server's Table output

A Resource list shows the columns `kubectl get` shows for its Resource Type.
The Engine does not compute them. It asks the API server for the Table form of
the type (`Accept: application/json;as=Table;v=v1;g=meta.k8s.io`) and passes
the column definitions and cells on to the UI. The API server already knows
how to summarize every built-in type, and CRD authors declare their columns in
`additionalPrinterColumns`, so every type a Cluster serves gets useful columns
with no per-type code in hukube.

The alternative was to watch full objects and compute the columns in the
Engine. That would give typed values, but it means porting and maintaining
kubectl's printers for dozens of types and evaluating JSONPath for CRDs.

## Consequences

- Cells are what the API server rendered, mostly as text. A count can arrive
  as `"3"`, a ratio as `"1/1"`, and a time as an age such as `"5m"`. The
  Engine orders cells by what they hold, not by the column's declared type,
  and nothing in hukube can rely on a cell's meaning. A feature that needs
  real values, such as health, must read the Resource itself.
- A rendered age is only correct when the API server sends the row. It is not
  sent again as time passes, so such a cell is stale until the Resource next
  changes, as in `kubectl get -w`. The Engine drops the `Age` column for this
  reason and the UI shows a live age from the index instead.
- Fetching a type's Table is a second list and watch beside the metadata
  watch from ADR-0003. The Engine therefore runs it only while a list of that
  type is open, and for a short time afterwards. Lists of one type share it,
  and it covers every Namespace.
- A Query's rows still come from the index, and cells are joined to them by
  Namespace and name. A row can briefly have no cells, and a type whose Table
  the Cluster cannot serve has no columns at all.
- Filtering by a cell and choosing which columns to show can be built on the
  stored cells without changing where they come from.
