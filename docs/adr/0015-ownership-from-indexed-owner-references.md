# Ownership comes from indexed owner references, resolved as the garbage collector resolves them

Ownership is the first kind of Relationship the Engine knows (ADR-0003). It
needs no extra watch: a Resource's `metadata.ownerReferences` arrive with the
metadata the Engine already indexes for every Resource Type. The index keeps
each Resource's owner references, and a reverse index from an owner's UID to
the Resources that name it. The Engine answers "what owns this" and "what
does this own" from those two, for any Resource, with no request to the
Cluster.

## What identifies an owner and an owned Resource

A Resource in the Relationship graph is identified by its Resource Type,
Namespace, and name, as a Resource URI identifies it (ADR-0006), together with
its UID, which tells one incarnation from the next. A UID alone is never a
key: a Resource served under two Resource Types, such as an Event, has one
UID under both.

An owner reference names an API version, a kind, a name, and a UID. The
Engine resolves it the way the garbage collector's `isDangling` does
(`pkg/controller/garbagecollector/garbagecollector.go` in Kubernetes
v1.37.1): find the type that serves the kind, read the Resource with that
name in the dependent's Namespace, or in no Namespace when the type is
cluster-scoped, and accept it only when its UID is the reference's UID.

- **Type.** The reference's API group and kind select the Resource Type. The
  version is ignored, because a type is the same type under every version it
  is served in (ADR-0006). The garbage collector asks its REST mapper for the
  exact version and cannot resolve a reference to a version the Cluster no
  longer serves. The Engine resolves it, which shows the owner a user would
  expect.
- **Namespace.** A namespaced owner must be in its dependent's Namespace, and
  a cluster-scoped dependent cannot have a namespaced owner. Kubernetes
  treats any other reference as absent or unresolvable ("Cross-namespace
  owner references are disallowed by design", Kubernetes documentation,
  Owners and Dependents), and so does the Engine.
- **Incarnation.** A Resource with the right name and another UID is not the
  owner. The reference names an earlier incarnation, which is gone. The
  garbage collector logs this as "item's owner is not found, UID mismatch".

One function applies this rule, and both directions use it. A Resource is
shown as owned by another exactly when its reference resolves to that
Resource, so the two views of one Relationship cannot disagree.

A reference that does not resolve is still shown, as `kubectl describe`
prints `Controlled By: Kind/name` from the reference without looking the
owner up. The Engine says why it did not resolve: no Resource with that name
and UID exists, the Cluster serves no type for the kind, or the type cannot
be listed.

## Considered options

- **Key the graph by UID alone,** as the garbage collector's `uidToNode` map
  does. The garbage collector then checks every edge against the API server.
  In the Engine a UID-only key would merge the two types an Event is served
  under and lose one when the other type stops being indexed.
- **Find a workload's Pods by its label selector,** as Lens, Headlamp, and
  k9s do. That needs each workload's spec, which the Engine does not index,
  and code per kind. It also answers a different question: a selector says
  which Pods a workload would adopt, not which it owns. Selects is a later
  kind of Relationship.
- **Scan the index for each answer** instead of keeping a reverse index. A
  walk down from a Deployment would scan every Resource once per level, on
  every Change, for every open tab.

## Consequences

- The index grows by each Resource's owner references and one reverse index
  entry per reference. `docs/plans/relationships.md` records the measured
  cost.
- Ownership of a Resource whose type the Engine does not index is unknown.
  Resources of a type the user may not list are missing from what an owner
  owns, and an owner of such a type shows as a reference that cannot be
  listed.
- Other kinds of Relationship need Manifests, which the Engine does not
  index, so each will bring its own source. They share what clients see: the
  `resource.related` topic answers with one section per kind of Relationship
  and direction, and the Go package that answers ownership is where other
  kinds are added. Nothing in the protocol or the Related Facet assumes that
  ownership is the only kind.
- Another part of the Engine, such as a Log Stream that follows a workload's
  Pods, asks the same graph for everything a Resource owns and asks again
  when the graph signals a change.
- A Query cannot filter by ownership yet. The reverse index answers one
  owner at a time, which is what the graph needs. An operator would also
  need syntax in a list's filter and the Go to Resource palette.
