# An Exec Session is a Tab of its own, and one that ended stays ended

An Exec Session opens in its own Tab, not as a Facet of its Pod. A Facet is a
way of looking at a Resource, and it is there for as long as the Resource is.
A session is something a user starts and that ends. A Pod can have several
at once, and each has a process behind it.

The Tab opens in the Pane of the Pod's tab and is an ordinary Tab from then
on. Its header names the Cluster, Namespace, Pod, and container in the
Cluster's color, because what is typed into it takes effect there.

## A session is owned by the window, not by a component

The window keeps its sessions in one store: each session's stream, its
terminal, and the element the terminal renders into. The Tab's component
attaches that element and reads the session's state. A session is ended only
by its stream ending, its Tab closing, its Workspace closing, or the window
unloading. A component that mounts again, as it may when a Tab moves between
Panes, ends nothing and starts nothing.

Closing a Tab, a Cluster tab, or the window with a live session asks first,
through the dialog that guards unsaved edits (ADR-0019).

## A session cannot be resumed

A session's socket that closes without an `end` is the end of the session.
The client does not open the stream again as it does for a Log Stream
(ADR-0016), because that would start a second shell and present it as the
first.

A stored Workspace layout can hold a session's Tab. After a reload, that Tab
shows that its session is over and offers to start a new one. It never starts
one by itself.

An ended session keeps its scrollback, dimmed and without a cursor, with the
reason it ended. Starting again in the same Tab clears it.

## Sessions share the stream cap

A session holds one of the window's 8 stream sockets from the moment it
starts until it ends, visible or not. A Log Stream gives its socket up while
hidden and takes one again when shown, which a session cannot do. A stream
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
- The terminal is xterm.js (ADR-0018 assigns terminals to it), with its DOM
  renderer, so a test can read the screen and Safari needs no fallback.
