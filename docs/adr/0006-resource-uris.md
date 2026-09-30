# Resource URIs as the single way to address Resources

Every reference to a Resource or Facet goes through one Resource URI format
that includes the Cluster, Namespace, group, version, kind, and name. Tabs,
navigation history, links, bookmarks, persisted Workspaces, and deep links from
outside the app all use it. Using one format everywhere means any place that
can show a Resource can link to any other, and persisted state survives
refactors of the UI.

## Consequences

- Changing the URI format later requires migrating persisted Workspaces, so
  the format is versioned from the start.
