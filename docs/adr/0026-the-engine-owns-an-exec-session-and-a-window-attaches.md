# The Engine owns an Exec Session, and a window attaches to it

ADR-0021 tied a session to its socket: a reload, a dropped connection, or a
second window ended it. ADR-0016 had the Engine hold a container's output
back for a slow client, by a rule that failed review four times and shipped
with a known limit. Both are replaced by one design, the one Jim's project
Hubris uses: the Engine keeps a session and its recent output, and a window
attaches. This supersedes ADR-0021's "A session cannot be resumed" and "A
session is owned by the window", and the parts of ADR-0016 and ADR-0022 that
those two sections now point here for.

## The Engine keeps the session

A session lives in the Engine's registry under an ID its window chose when
the user started it, which is the ID of its Tab in the stored Workspace
layout. It is removed when an attached window has received its `end`, when a
window asks for it to end because its Tab closed, when no window has been
attached for 10 minutes, or when the Engine shuts down. Nothing else removes
it. A socket that closes only detaches.

After a reload a Tab attaches to the session with its ID, checked against
the Tab's Pod, UID, and container. A Tab whose session the Engine no longer
has says so and offers to start a new one. Attaching never starts a session.

A Tab keeps the command line its session runs (ADR-0025). Attaching joins the
process that line started and never runs or splits the line again. Only the
user starting the session again, from the Tab or from a notice, runs it anew.

10 minutes is a compromise. The Engine cannot tell a reload from a window
closed for good, so a closed window leaves a shell running for that long,
and a connection lost for longer loses the session. The limit is a flag.

## Output goes to a ring and is never held

The executor's writer appends to a ring of 256 KiB and returns. It never
waits for a client. Each attached window has a position in the session's
output and is sent what follows it, under ADR-0016's acknowledged window.
client-go's heartbeat deadline, which a held writer could reach, cannot be
reached by a slow window any more.

A window gives its position when it attaches. If the ring still holds what
follows, the window is sent exactly those bytes. If not, including a window
that stopped reading during a flood, it is told to clear its terminal and
how much was skipped, and is sent the ring from a safe place to cut it.

## Modes come from a tracker, and a screen from the program

What a ring cannot replay is what was set or painted before its start. A
tracker reads the bytes as they leave the ring and keeps the terminal's
modes: the alternate screen, cursor keys, bracketed paste, mouse tracking,
the scroll region, and the rest of what xterm.js keeps. A window that is cut
in gets a sequence that sets them. The tracker also knows where a control
sequence or a character ends, so the cut is never inside one.

The tracker is a port of xterm.js's parser table, UTF-8 decoder, and mode
handlers, because xterm.js is what replays the bytes and the two must agree
at every byte. A test compares them over recorded sessions and generated
streams.

A full-screen program's screen is not tracked. When a window is cut in while
the alternate screen is on, the Engine resizes the session to one row fewer
and back, and the program repaints. Measured on the test cluster, `vi`,
`vim`, `less`, and `htop` repainted their whole screen within 13 ms. A
resize to the same size does nothing, and a shell is never resized this way,
because busybox's shell drops a half-typed line when it is.

Rows on the normal screen that were painted before the ring's start are not
restored. They are lost as scrollback is.

## One window at a time

A session is attached to one window, and has that window's size. A stream
from another window is refused, and that window offers to take the session
over, which detaches the first. A stream from the same window replaces the
one before it, so a reload is never locked out by its own old socket.

## Input

A window sends input only while it is attached and has parsed everything
replayed to it. What is typed while the connection is down is dropped, not
sent later. Input the Engine holds when a window detaches is discarded.

A terminal that takes no input also answers no query, which is how xterm.js
is built. So a query in replayed output is never answered into the shell.

## Considered Options

- **A snapshot of the screen from a terminal emulator in the Engine,** as
  Hubris takes from Rust's `vt100`. It would keep the normal screen's rows
  that this design loses. Go has no equal to that crate: the candidates were
  a package tagged two days before this was written, a small one, and an
  untagged port. Each costs a pass over every byte of every session and a
  screen of cells, and its snapshot is that emulator's reading of the bytes,
  not xterm.js's. It was not tried, because the tracker passed its test. It
  remains the way to get those rows.
- **A screen tracker of our own.** A larger form of the same cost.
- **Ask every program to repaint,** shells too. busybox's shell prints a
  new prompt and drops what was typed.
- **Keep the rule that holds output,** corrected. It needs time-based
  judgment about a client the Engine cannot see, which is what failed.
- **Both windows attached, sharing a size,** as Hubris does. Both terminals
  would answer a program's queries, and input would interleave.
- **The newest window always takes the session.** Opening a second window
  would take a terminal away from someone typing in the first.
- **Keep a session until its window ends it, with no limit.** A browser tab
  closed for good would leave a shell running for as long as the Engine did.
- **Queue input typed while disconnected.** A command would run when the
  connection returned, unseen.

## Consequences

- A session costs the Engine its ring and its waiting input, about 544 KiB
  at most, and the registry holds at most 64.
- Closing a Cluster tab, moving it to a new window, and reloading no longer
  ask about sessions, because none of them ends one. Closing a session's Tab
  and quitting the desktop app still do.
- A window that falls behind loses its own scrollback when it is caught up,
  and is told how much output was skipped. There is no gap marker in a
  session any more.
- An upgrade of xterm.js must pass the tracker's comparison test.
- An Engine restart ends every session. Nothing is kept on disk.
