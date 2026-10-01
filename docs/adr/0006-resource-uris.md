# Resource URIs as the single way to address Resources

Every reference to a Resource or Facet goes through one Resource URI format
that includes the Cluster, Resource Type, Namespace, and name. Tabs,
navigation history, links, bookmarks, persisted Workspaces, and deep links from
outside the app all use it. Using one format everywhere means any place that
can show a Resource can link to any other, and persisted state survives
refactors of the UI.

The Resource Type is identified by API group and resource name, not by API
version, because the same object is served under every version of its type.
URIs saved while a CRD served `v1beta1` must still resolve after it moves to
`v1`.

## Consequences

- Changing the URI format later requires migrating persisted Workspaces, so
  the format is versioned from the start.
