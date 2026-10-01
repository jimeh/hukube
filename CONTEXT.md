# hukube

A desktop and web application for monitoring, inspecting, and editing
Kubernetes clusters, built around a multi-pane workspace and fast navigation
across every resource type a cluster serves.

## Language

### Runtime

**Engine**:
The backend process that connects to clusters, holds their state, and serves
every UI client.
_Avoid_: Backend, server, sidecar, daemon

**Host**:
The environment a UI client runs in: the desktop app or a web browser.
_Avoid_: Shell (collides with pod exec shells), platform, runtime

### Clusters and workspaces

**Cluster**:
One Kubernetes API endpoint reached with one set of credentials, as defined by a
single kubeconfig context. Two contexts pointing at the same API server with
different credentials are two Clusters.
_Avoid_: Context (overloaded), connection, environment

**Workspace**:
The arrangement of Panes and Tabs for exactly one Cluster, shown as a top-level
cluster tab or as its own window.
_Avoid_: Session, layout, project

**Pane**:
A region of a Workspace holding a group of Tabs, created by splitting.
_Avoid_: Split, panel, group, editor group

**Preview Tab**:
A Tab opened by a single click that the next single click replaces, until it
is pinned.
_Avoid_: Temporary tab, transient tab

### Resources

**Resource**:
A single Kubernetes object instance, such as one Pod or one Certificate.
_Avoid_: Object, item, entity

**Resource Type**:
A kind of Resource served by a Cluster, built-in or from a CRD, identified by
its API group and name regardless of API version.
_Avoid_: Resource (for types), CRD (for the type itself), kind (alone)

**Manifest**:
The serialized YAML or JSON form of a Resource.
_Avoid_: Spec (which is one field of a Manifest), config

**Resource URI**:
The canonical address of a Resource, or a Facet of one, within a Cluster.
_Avoid_: Link, path, ref

**Facet**:
One way of looking at a Resource: Overview, Form, YAML, Logs, Events, Related,
or History.
_Avoid_: View, mode, sub-tab

### Navigation and understanding

**Query**:
A filter expression that selects Resources across Resource Types.
_Avoid_: Search, filter (alone)

**Saved Query**:
A named Query pinned to a Workspace's sidebar.
_Avoid_: View, smart folder, bookmark

**Relationship**:
A directed, typed link from one Resource to another, such as owns, selects,
mounts, binds, or routes to.
_Avoid_: Reference, edge, dependency

**App**:
A derived grouping of Resources that together make up one application,
inferred from labels, Helm releases, or GitOps ownership.
_Avoid_: Application (collides with the Argo CD kind), release, project, stack

### Observation

**Change**:
One observed addition, modification, or deletion of a Resource, as seen by the
Engine.
_Avoid_: Event (collides with the Kubernetes Event kind), update, diff

**Timeline**:
The ordered sequence of Changes and Kubernetes Events for a Cluster, Namespace,
App, or Resource.
_Avoid_: History (reserved for the Facet), audit log, journal

**Replay Buffer**:
The bounded, in-memory window of recent Changes the Engine keeps for each
connected Cluster.
_Avoid_: Cache, history, backlog

**Recording**:
An explicitly started capture of the Timeline for the Resources matched by a
Query, saved as a self-contained file that can be replayed without the Cluster.
_Avoid_: Capture, trace, snapshot, session

**Log Stream**:
A live tail of container logs from one or more Pods, possibly selected by a
Query or a workload.
_Avoid_: Log tail, logs (alone)

**Exec Session**:
An interactive terminal attached to a process in a container.
_Avoid_: Shell, terminal (alone), attach

**Port Forward**:
A managed, named forwarding of a local port to a Pod, Service, or workload,
re-resolved when the backing Pods change.
_Avoid_: Tunnel, proxy

### Editing

**Changeset**:
A set of staged edits across one or more Resources, reviewed as one diff and
applied together. Applying it is not atomic across Resources.
_Avoid_: Transaction, batch, patch
