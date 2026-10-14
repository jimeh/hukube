# An Exec Session is a Tab of its own, and one that ended stays ended

Superseded in part by ADR-0025: the Engine now owns a session, and a window
attaches to it again after a reload or a lost connection. The two sections
that said otherwise are marked below. The rest stands.

An Exec Session opens in its own Tab, not as a Facet of its Pod. A Facet is a
way of looking at a Resource, and it is there for as long as the Resource is.
A session is something a user starts and that ends. A Pod can have several
at once, and each has a process behind it.

The Tab opens in the Pane of the Pod's tab and is an ordinary Tab from then
on. Its header names the Cluster, Namespace, Pod, and container in the
Cluster's color, because what is typed into it takes effect there.

## A session's view is owned by the window, not by a component

The Engine owns the session (ADR-0025). The window keeps what shows it in
one store: each session's stream, its terminal, and the element the terminal
renders into. The Tab's component attaches that element and reads the
session's state. A component that mounts again, as it may when a Tab moves
between Panes, ends nothing and starts nothing.

Closing a session's Tab ends the session, and asks first, through the dialog
that guards unsaved edits (ADR-0019). Closing its Workspace or its window
only detaches.

## A Tab attaches to its session, and never starts one

This section said a session cannot be resumed. ADR-0025 replaces it.

A stored Workspace layout holds a session's Tab. After a reload the Tab
attaches to the session with its ID. If the Engine no longer has it, the Tab
says so and offers to start a new one. It never starts one by itself.

An ended session keeps its scrollback, dimmed and without a cursor, with the
reason it ended. Starting again in the same Tab clears it.

## Sessions share the stream cap

A session holds one of the window's 8 stream sockets for as long as the
window is attached to it, visible or not. A Log Stream gives its socket up
while hidden and takes one again when shown. A session does not, because a
session with no window attached is ended after a time. A stream
opened beyond the cap waits and says so.

## Considered Options

- **A Facet on the Pod,** as Headlamp and the Dashboard have. One Pod could
  then run one session, a session would end when its Pod's tab was replaced
  by a Preview Tab, and the Facet would be the only one with a process to
  lose.
- **The component owns the session.** It is less code, and it ties a
  process's life to React's and dockview's decisions about mounting.
- **Start a restored Tab's session again after a reload.** A reload with
  five session Tabs would open five shells nobody asked for.
- **A separate cap for sessions.** Two caps would need two messages at the
  limit, and the browser's limit on sockets per host does not tell them
  apart.

## Consequences

- A window with 8 sessions has no socket left for a Log Stream, which then
  waits. The message at the limit names both.
- A dock or bottom area for sessions remains possible. Nothing assumes where
  a session's Tab sits.
- The terminal is xterm.js (ADR-0018 assigns terminals to it). ADR-0024
  says which renderer draws it.
