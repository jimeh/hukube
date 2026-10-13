# A Resource's Events come from a watch scoped to that Resource

The Engine indexes only metadata (ADR-0003), and what an Event is about is not
metadata. For the Events Facet, the Engine lists and watches the Events about
one Resource for as long as a client subscribes to them, and keeps nothing
afterwards. It does not index what every Event in the Cluster refers to.

The watch reads the core `v1` `events` type only. The API server serves the
same Events under `events.events.k8s.io` with the same UIDs, and the core type
is the one whose field selectors name the Resource directly, so reading one
type shows each Event once.

## How Events are selected

The API server filters by a field selector on the reference's kind, name, and
Namespace, as `kubectl describe` does. For a namespaced Resource the watch
covers its Namespace. For a cluster-scoped Resource it covers every
Namespace with an empty reference Namespace, because the API server only
accepts such Events in `default` or `kube-system`.

The Engine then drops an Event whose reference names another incarnation or
another API group:

- **Incarnation.** The reference's UID must be empty, the Resource's UID, or
  the Resource's name. `kubectl describe` matches the UID exactly, which
  hides Events from components that write something else. The kubelet wrote
  a Node's name as the UID up to at least Kubernetes 1.30 and writes no UID
  in 1.35, and hand-built references often have none. The reference may also
  hold another UID the client names for the same incarnation: the kubelet
  writes a static Pod's Events with the hash in the mirror Pod's
  `kubernetes.io/config.mirror` annotation, not with the mirror Pod's UID,
  which is why `kubectl describe` shows no Events for a control-plane Pod.
  When the client does not know the Resource's UID, because the Resource
  does not exist, every incarnation matches.
- **API group.** A kind is not unique across groups. When the reference
  carries an `apiVersion` and its UID is not one of the Resource's, its group
  must be the Resource Type's.

The client supplies the UIDs from the Manifest it shows. The Engine could read
it from its index, but the tab keeps showing the last Manifest of a deleted
Resource, and its Events should stay those of the same incarnation.

## Considered Options

- **Index every Event's reference.** A watch of all Events in full would
  answer any Resource at once and could mark Resources that have warnings in
  a list. It costs a full list of every Event on connect and memory for all
  of them, in Clusters that can hold tens of thousands, for a feature that
  shows one Resource's Events. ADR-0008 already plans to hold Events in full
  for the Timeline, and that design should decide the cost, not this Facet.
- **One shared watch per Namespace.** It would serve several tabs with one
  list, at the price of holding a Namespace's Events in memory and of
  reference counting. Not worth it before the Timeline exists.
- **Watching `default` and `kube-system` for a cluster-scoped Resource.** The
  API server accepts its Events nowhere else, so two namespaced watches would
  read far less than one over every Namespace, and would serve a user who may
  read Events there but not everywhere. They are two watches with their own
  permissions, errors, and retries to merge into one answer, such as when one
  Namespace is refused and the other is not. One watch with one outcome is
  what `kubectl describe node` does, and the Timeline will replace this
  source. Worth revisiting if cluster-scoped tabs prove costly in a large
  Cluster.

## Consequences

- An open Resource tab holds a second watch beside the one for its Manifest,
  whichever Facet it shows, so the switcher can say that a Resource has
  warnings. If the watches of hidden tabs become a cost, both should stop
  while a tab is hidden.
- The API server does not cache Events, so each list reads the Namespace's
  Events from etcd and filters them, and for a cluster-scoped Resource the
  Events of every Namespace. That is the cost of one `kubectl describe`,
  paid when a tab opens and again whenever its watch cannot resume. A watch that has delivered nothing cannot resume once etcd
  has compacted its resourceVersion, which took between 8 and 10 minutes
  against a test API server, because an uncached type sends no bookmarks.
  The watch therefore asks for a timeout of 30 to 60 minutes, so a quiet tab
  lists again about that often.
- Events about a cluster-scoped Resource need permission to list and watch
  Events in every Namespace, as `kubectl describe node` needs to list them. A
  user without it sees that they are not permitted, not an empty Facet. So
  does a user who may list Events but not watch them, although each retry's
  list reaches the client for a moment before the refused watch replaces it.
- An Event leaves the Facet when the Cluster deletes it, which by default is
  an hour after it was last updated. Keeping Events longer is the Timeline's
  job.
- When the Timeline holds every Event in the Replay Buffer, the
  `resource.events` topic can be answered from it without a change to the
  protocol, and the selection rule above becomes its lookup.
