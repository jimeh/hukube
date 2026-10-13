# A Resource tab shows one Facet at a time, named by its Resource URI

A Resource opens in one tab, and that tab switches between the Facets that
apply to the Resource. The Facet a tab shows is part of the Resource URI in
its params (ADR-0006), so a stored Workspace layout, a reload, and a link
return to the same Facet. A URI that names no Facet means the default one.

The tab's identity is the Resource: its ID is the Resource URI without a
Facet. Switching Facets changes the tab's params and nothing else, so the tab
keeps its place, its title, and whether it is a Preview Tab.

Each Facet is one entry in a registry: its name in the URI, its label, a rule
for which Resources it applies to, and the component that shows it. The
switcher and the URI handling read the registry and know no Facet by name.

## Considered Options

- **A tab per Facet.** Opening a Pod would fill a Pane with tabs for its
  YAML, Events, and Logs, and the tab strip would no longer read as a list of
  Resources. A user who wants two Facets side by side is better served by
  asking for that than by getting it every time.
- **The Facet as tab state outside the URI.** A separate `facet` param would
  work for layouts, but a link to a Resource's Events would need a second
  format. ADR-0006 already gives the URI a place for the Facet.

## Consequences

- Opening a Facet in its own tab, or beside the current one, remains possible:
  such a tab needs an ID that includes the Facet, and nothing may assume a
  Resource has only one open tab. Code finds a tab by its ID, never by
  searching for a Resource.
- A Facet's component mounts the first time it is shown and stays mounted,
  hidden, while the tab is open. Switching away and back keeps its state, such
  as the YAML Facet's scroll position. A Facet that does expensive work must
  stop it while it is hidden.
- A URI that names a Facet which does not apply to its Resource shows the
  default Facet. A URI that names a Facet this build does not know is not a
  Resource URI, as before.
- A Preview Tab that replaces another Resource's Preview Tab opens on the
  Facet the replaced tab showed, when that Facet applies. Moving through a
  list therefore keeps the Events Facet open, the way a browser's network
  inspector keeps its Response tab while requests are selected.
