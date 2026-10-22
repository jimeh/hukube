# Plan: Exec Sessions that survive a reload

Status: implemented, not merged yet. "What changed while building" lists
where the result differs from the text below.

## Outcome

After this work:

- The Engine owns an Exec Session. A window attaches to it, and a reload, a
  dropped connection, or a closed Cluster tab only detaches. The window
  attaches again and finds the terminal where it was, live, and taking input.
- The Engine never holds a container's output back. It reads all of it, keeps
  the most recent 256 KiB, and sends each window what that window has not
  seen. A window that falls further behind than that is caught up from what
  the Engine kept, and its terminal says how much was skipped.
- A session still ends clearly: the process exits, the container stops, the
  Pod goes away, the user closes the Tab, or the Engine stops. The Tab says
  which. A Tab whose session the Engine no longer has says so, and never
  starts one by itself.
- A session that no window is attached to is told to exit after 10 minutes.

It does not keep a session across an Engine restart, keep a session's output
after it ends, change Log Streams, or add a key binding.

## Current state

These observations come from the code at `3f742b0`:

- `pod.exec` runs `execsession.Run` inside its stream handler, under the
  socket's context. A socket that closes hangs the session up
  (`engine/internal/server/exec.go`).
- `streamQueue.write` holds the executor's writer while the client's window
  is full, by the 3-second invariant of ADR-0016, with a known limit: a
  client that keeps up can still lose output. `stream_hold_test.go` tests it.
- `SocketStream` treats `pod.exec` as not resumable: a socket that closes
  after `open` puts the stream in the final state `lost`. The same flag,
  `resumable`, also decides whether a stream takes input and may pause.
- The window's store (`features/exec/sessions.ts`) owns each session's
  stream and terminal. A Tab restored from a layout has no session and shows
  "No session is running here".
- Closing a Tab, a Cluster tab, or the window with a live session asks first.
  The Workspace ends a session when dockview removes its panel and when the
  Workspace unmounts.

## Evidence

A recorder ran scripted sessions in two containers on the k3d cluster
(k3s v1.35.5, containerd 2.2.3) through client-go v0.37.1's executor:
busybox 1.36 (`ash`, `vi`, `less`, `top`) and alpine 3.20 with `bash`, `vim`,
GNU `less`, procps `top`, and `htop`. The 13 recordings and the recorder are
in `engine/internal/execsession/testdata`. `@xterm/headless` 6.0.0 read them.

### What a resize does through client-go's executor

Each recording resizes a quiet program three ways: to the size it already
has, to one row fewer, and back. A fourth sends the last two together.

| Program                     | Same size  | One row fewer                   | Back               | Both together                 |
| --------------------------- | ---------- | ------------------------------- | ------------------ | ----------------------------- |
| busybox `vi`                | no output  | repaints, 1,954 bytes           | repaints, 2,041    | 2 repaints, done in 13 ms     |
| `vim`                       | no output  | repaints, 1,113                 | repaints, 1,161    | 2 repaints, 4 ms              |
| GNU `less`                  | no output  | repaints, 1,070                 | repaints, 1,118    | 2 repaints, 5 ms              |
| busybox `less`              | no output  | repaints, 1,139                 | repaints, 1,190    | 2 repaints, 2 ms              |
| `htop`                      | (own tick) | repaints, 2,991                 | repaints, 2,913    | 1 repaint, 3 ms               |
| `bash`, a line half typed   | no output  | redraws the line, 27            | redraws it, 27     | screen unchanged              |
| `ash`, a line half typed    | no output  | **prints a new prompt, 28**     | prints another, 14 | **the typed text is dropped** |
| `top` (both, normal screen) | (own tick) | repaints at once or at its tick | the same           | the same                      |

- **A resize to the same size does not reach the process.** The kernel
  signals a change of size only. A repaint has to be asked for with two
  resizes: one row fewer, then back.
- **Every full-screen program repainted its whole screen** within 13 ms of
  the pair, in at most two paints of 1 to 3 KiB. After it, the screen and the
  cursor were what they were before. `vim` does not repeat a one-time message
  on its last line.
- **busybox `ash` loses what was typed.** After the resizes, the half-typed
  `echo hello wor` was gone and the rest of the line ran as its own command.
  Layer 7 saw the same at a session's start. So a repaint may be asked for
  only while a full-screen program is known to be running.

### What tracks the screen

The brief names three options, to be tried in order. The first was tried and
is chosen. The other two were not run.

**Option 1: no screen tracking.** The Engine replays the ring. When older
bytes have left it, a small tracker supplies the modes that were set before
the ring's start, and a full-screen program is asked to repaint by a resize.

The test: for each recording, at three moments (the program has painted, the
program is quiet, the program has exited), and for rings of 512 bytes, 2 KiB,
8 KiB, 64 KiB, and everything, compare a terminal that read the whole stream
with a new terminal given the tracker's restore sequence and the ring. 165
cases, in 64 of which bytes had left the ring.

| What was compared                                              | Result                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The ring still holds everything (a reload, usually)            | Screen, cursor, and modes the same in all 101 cases, including recordings that were resized on the way.                                                            |
| Modes, after bytes left the ring                               | The same in all 64 cases: alternate screen, cursor keys, keypad, bracketed paste, mouse tracking and its encoding, focus events, cursor visibility, scroll region. |
| A full-screen program, after bytes left the ring               | Screen differs until the program paints (`vi`, `vim`, GNU `less`, `htop`). After the recorded resizes, screen and cursor the same in all 14 cases measured.        |
| A shell with a line half typed, after a 129 KiB flood          | Screen and cursor the same at every ring size, in all 16 cases.                                                                                                    |
| `top` on the normal screen                                     | The same once the ring holds one of its repaints (0.5 to 4 KiB).                                                                                                   |
| A progress bar that rewrites its line, 19 KiB of it            | **The bar is right and live, and the rows above it are missing:** it is drawn at the top of an empty screen.                                                       |
| After a full-screen program that started before the ring exits | **The rows that were on the normal screen before it started are missing.** The prompt returns at the top of an empty screen.                                       |

So option 1 restores everything a program will draw from then on, every
mode, and a full-screen program's whole screen. What it loses is what any
ring loses: rows painted before the ring's start that nothing paints again.
With the real ring that needs 256 KiB of output that never scrolls a
screenful, such as a progress bar running for minutes, or a long `vim`
session after which the shell's earlier lines are gone. The terminal says
output was skipped. This is accepted. A snapshot from an emulator (option 2)
would keep those rows, and is the follow-up if they turn out to matter.

**The tracker must read bytes exactly as xterm.js does,** because xterm.js
replays them. A first tracker written from the VT500 state machine disagreed
with xterm.js 6.0.0 in three ways, each found by comparing the two byte by
byte: xterm.js drops an invalid UTF-8 sequence without leaving a control
sequence, an ESC that ends a string goes on to start an escape sequence, and
a full reset leaves a hidden cursor hidden. The tracker is now a port of
xterm.js's own transition table, UTF-8 decoder, and mode handlers. Compared
at every byte of the 13 recordings (442 KB) and of 1 MB of generated streams
that mix text, controls, and whole and cut-short sequences:

- At each of the 845,313 positions the tracker calls safe to cut at,
  xterm.js's parser was at ground with no character part read.
- At 31,314 sampled positions, a reset terminal given the restore sequence
  had the modes of the terminal that read the stream.

**Options 2 and 3 were not run.** The candidates for option 2, as of
2026-10-14: `github.com/charmbracelet/x/vt` v0.1.0, tagged two days ago;
`github.com/vito/midterm` v0.2.5, from August; and
`github.com/gitpod-io/xterm-go`, untagged. Each would cost a pass over every
byte of every session's output and a screen of cells per session, and its
snapshot would be the emulator's reading of the stream, not xterm.js's.

### A character split across two writes is dropped by xterm.js

xterm.js 6.0.0 drops a character when its bytes arrive in two writes and the
bytes it holds over include `0x80`. `E2 80 94` (an em dash) written as
`E2 80` and then `94` prints nothing, and so do the curly quotes, the
ellipsis, and the rest of U+2000 to U+203F. Layer 7 has this fault at every
frame boundary. The Engine now cuts frames from its ring, so it can end each
frame between characters.

### What a query does on replay

xterm.js answers a query (cursor position, device attributes, a color) by
calling the function that sends typed input. That function returns at once
when the terminal's `disableStdin` option is set
(`CoreService.triggerDataEvent`). So a terminal that takes no input answers
no query.

## Decisions

ADR-0026 records the decisions below. It supersedes the parts of ADR-0021
that say a session belongs to a window and cannot be resumed, and ADR-0016
and ADR-0022 are revised where they describe holding output and when a
session is hung up.

### The Engine owns a session

The Server keeps a registry of sessions by ID. A session's ID is chosen by
the client when the user starts it, 128 random bits, and is the ID of its
Tab, which the stored Workspace layout already holds. A session remembers
its Cluster, Namespace, Pod, UID, and container.

A session is **running** until its executor returns, then **over**, with the
`end` it would have sent. It is removed from the registry when one of these
happens, and never otherwise:

| What happens                                                             | Effect                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| An attached window has received the session's `end`                      | Removed. "Received" means the socket's closing handshake completed after `end` was written. |
| A window asks for the session to end (`exec.end`: its Tab closed)        | Hung up if running, then removed.                                                           |
| No window has been attached for 10 minutes (`--exec-unattached-timeout`) | Hung up if running, then removed.                                                           |
| The Engine shuts down                                                    | Hung up if running. Attached windows get `EngineStopped`.                                   |

"Hung up" is ADR-0022's hang-up: end-of-transmission to stdin, one second,
then the executor is cancelled. It runs under the session's own context,
which no socket owns.

A session that is over stays for a window that was away to learn how it
ended, and counts as unattached like any other.

The registry holds at most 64 sessions. Starting one more fails with
`unavailable` and the reason `TooManySessions`.

**Memory.** A session costs the Engine its ring, at most 256 KiB
(`--exec-buffer`, 16 KiB to 4 MiB) and allocated as output arrives, at most
256 KiB of input waiting for the process, and a tracker of under 1 KiB. An
attached window adds one frame, at most 32 KiB. At the defaults the total is
bounded by 64 times 544 KiB, about 34 MiB.

### Output goes to a ring and is never held

The executor's writer appends to the session's ring and returns. It never
waits, for any client, for any length of time, so client-go's 61-second
heartbeat deadline cannot be reached by a slow window. When the ring is full
its oldest bytes leave it, through the tracker.

- `total` counts every byte the process has written. `start` is the position
  of the ring's first byte. The tracker has read the bytes before `start`.
- `streamQueue.write`, its `hold` limit, its list of sent output, and
  `stream_hold_test.go` are removed. Nothing is put in their place: a
  session's output is never in the stream's queue except as one frame that
  the socket is about to send.
- The acknowledged window of ADR-0016 stays as it is for the socket: the
  Engine sends a window only while less than 1 MiB is unacknowledged.

### Starting and attaching are one stream, `pod.exec`

`open` names the session and says what the client wants:

```go
StreamPodExec = DeclareStream[ExecParams, ExecSync]("pod.exec")
RequestExecEnd = DeclareRequest[ExecEndParams, None]("exec.end")

type ExecParams struct {
	Cluster, Namespace, Pod, UID, Container string // as now
	Command []string                               // as now
	// Session identifies the session, and Window the window that attaches.
	Session string `json:"session"`
	Window  string `json:"window"`
	// Start asks for a new session when none has this ID. Without it the
	// stream only attaches.
	Start bool `json:"start,omitempty"`
	// Takeover attaches although another window is attached.
	Takeover bool `json:"takeover,omitempty"`
	// Resume is the position the client's terminal has read to. It is absent
	// when the terminal has read nothing of this session.
	Resume *uint64 `json:"resume,omitempty"`
	// Cols and Rows are the terminal's size. Start requires them. An
	// attachment gives them only when its terminal has been sized.
	Cols, Rows uint16 `json:"cols,omitempty"`
}

type ExecEndParams struct{ Cluster, Session string }
```

| A session with this ID                  | `start` | The Engine                                                                                                                                                                |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None                                    | no      | Ends the stream with `not_found` and the reason `SessionGone`.                                                                                                            |
| None                                    | yes     | Starts one, as layer 7 does, and attaches the stream to it.                                                                                                               |
| Running                                 | either  | Attaches. A start that is sent again is the same start.                                                                                                                   |
| Over                                    | no      | Attaches: the window gets what it missed and the `end`.                                                                                                                   |
| Over                                    | yes     | Removes it and starts a new one. This is "Start again" in the same Tab. The same start sent again, with the same `run`, attaches instead (see "Merging chosen commands"). |
| Any, for another Pod, UID, or container | either  | Ends the stream with `bad_request`.                                                                                                                                       |

A read-only Engine refuses the stream before any of this, as now. `exec.end`
is registered with `handleMutation`. It succeeds when the session is already
gone.

### One window is attached at a time

A session has at most one attached stream, and its terminal size is that
window's.

| Attached now      | The new stream     | Result                                         |
| ----------------- | ------------------ | ---------------------------------------------- |
| Nothing           | any                | Attaches.                                      |
| The same `window` | any                | Attaches. The old stream ends with `detached`. |
| Another window    | with `takeover`    | Attaches. The old stream ends with `detached`. |
| Another window    | without `takeover` | The new stream ends with `detached`.           |

`detached` is a new reason for a stream's `end`: the session carries on, and
this stream is not attached to it. A window that gets it does not attach
again until the user asks.

A window's ID is random, kept in `sessionStorage`, so a reload keeps it and
another window has another. That makes the reload's race harmless: the new
page's stream replaces the old page's if the old socket is still open.

Two windows both attached was rejected: both terminals would answer a
program's queries, each would need the other's size, and input from two
places would interleave.

### What an attaching window is sent

The first message on a session's stream is the event `ExecSync`, and the
Engine sends another whenever the output that follows does not continue what
the window has:

```go
type ExecSync struct {
	// Offset is the position of the next byte of output.
	Offset uint64 `json:"offset"`
	// Reset is set when Offset is not the client's position: the client
	// clears its terminal before what follows.
	Reset bool `json:"reset,omitempty"`
	// Skipped counts the output the client will not receive.
	Skipped uint64 `json:"skipped,omitempty"`
	// Restore sets a reset terminal's modes to what they were at Offset.
	Restore string `json:"restore,omitempty"`
	// Replay counts the bytes that follow which the process had written
	// when this was sent. The client answers no query in them.
	Replay uint64 `json:"replay,omitempty"`
	// Cols and Rows are the session's terminal size.
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}
```

With `r` the client's position (`resume`, or 0 when absent):

| Case                                                   | `ExecSync`                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `start <= r <= total`: the ring holds what it missed   | `offset` is `r`, no reset, `replay` is `total - r`. The missed bytes follow, exactly.                              |
| `r < start`, or `r > total`                            | `offset` is the cut `c`, `reset`, `skipped` is `c - r` (`c` when `r > total`), `restore`, `replay` is `total - c`. |
| An attached window whose position falls behind `start` | The same, sent in the middle of the stream, with `r` its position.                                                 |

A new session's first `ExecSync` is the first row with everything at 0.

**The cut** is the first position at or after `start` where the tracker,
having read every byte before it, is at ground: no control sequence, no
string, and no UTF-8 character is part read. If the ring holds no such
position, the stream sends nothing and tries again when more output arrives.

**The tracker** (`execsession`, in its own file) is a port of xterm.js
6.0.0's parser table, UTF-8 decoder, and the handlers that change a mode. It
tracks: the alternate screen, cursor keys, keypad, bracketed paste, origin,
wraparound, reverse wraparound, focus events, cursor visibility, cursor
blink (mode 12), mouse tracking and encoding, insert mode, new-line mode,
the cursor's style, each buffer's scroll region, the four character sets,
and which is shifted in. It does not track the cursor's position, colors and
attributes, the saved cursor, tab stops, or the title. `restore` holds only
what differs from a reset terminal, except cursor visibility, which a reset
of xterm.js leaves as it was. A panic in the tracker is recovered: the
tracker starts again from a reset terminal's modes and the session carries
on.

**The repaint.** When an `ExecSync` with `reset` is sent and the modes at
the cut have the alternate screen on, the Engine resizes the session to one
row fewer and back. A session with one row is not resized. The shell is
never resized for this.

**Frames.** The stream takes output from the ring at its position, in frames
of at most 32 KiB, only while the acknowledged window has room. A frame ends
between characters: bytes that start a UTF-8 character and do not finish it
wait for the rest, or for the session's end. A frame also ends where `replay`
ends, so replayed and live output are never in one frame.

**The end.** When the session is over and the stream has sent everything up
to `total`, it sends the session's `end`. A window that does not acknowledge
for the queue's drain time (10 seconds) is sent the `end` without the rest.

### Input

- The Engine takes input only from the attached stream. Input from a stream
  that is no longer attached is dropped, not refused.
- When a stream detaches, for any reason, input the Engine holds that the
  process has not read is discarded. Input acknowledgements count from the
  attachment's start.
- **A window sends input only while it is attached and has parsed all
  replayed output.** Otherwise its terminal takes none, shows that, and what
  is typed is dropped. Nothing typed while the connection is down is sent
  later: a command that runs when the connection returns, unseen, is worse
  than one that has to be typed again.
- Input waiting in the Worker when a socket closes is dropped, and the
  terminal prints how much (`inputDropped`, as now).
- A resize to the size the session has is dropped.

### The client's stream

- `resumable` goes. Every stream opens a new socket when one is lost. A
  codec says separately whether its stream takes input (`pod.exec`) and
  whether it may pause (`resource.logs`). The stream state `lost` goes.
- `ExecCodec` counts the bytes of every frame it decodes, and takes its
  count from each `ExecSync`'s `offset`. It opens a socket with `resume` set
  to the count once it has seen an `ExecSync`, and with `start` and
  `takeover` only until it has seen one. So an intent is carried out once.
- A stream that ends with `detached` or `SessionGone` is ended, like any
  other `end`.

### The window's store

`features/exec/sessions.ts` still owns each session's stream and terminal.

- `startSession` (the user asked), `attachSession` (a Tab restored from the
  layout), and `takeSession` ("Use it here") each open a stream. Nothing else
  does. `attachSession` never sets `start`.
- The Workspace attaches every session Tab of a restored layout, shown or
  not, because a hidden Tab's panel may never mount and its session would
  end as unattached.
- `endSession` (the Tab closed) closes the stream and sends `exec.end` if
  this window holds the session: its phase is starting, attaching, live, or
  reconnecting. If the request fails because the Engine cannot be reached,
  it is sent again when the connection returns, for as long as the window
  lives. Otherwise the 10 minutes end the session.
- `detachClusterSessions` (the Workspace closed) closes streams and disposes
  terminals. It ends nothing. It runs before dockview removes the panels.
- The store handles a stream's events and data in the order they arrive. On
  an `ExecSync` with `reset` it writes a full reset to the terminal, then the
  skipped notice, then `restore`. On any `ExecSync` it stops the terminal's
  input until output up to `offset + replay` has been parsed.
- A terminal that has never been sized takes the session's size from
  `ExecSync` before it reads the output. One that has been sized keeps its
  own, and the session is resized to it.

Phases: `waiting`, `starting`, `attaching`, `live`, `reconnecting`,
`elsewhere`, `ended`, `failed`, `gone`.

### Engine flags

- `--exec-buffer`: bytes of recent output kept for each session, default
  262144, from 16384 to 4194304.
- `--exec-unattached-timeout`: how long a session with no window attached
  is kept, default `10m`, at least `10s`.

## UI and UX

Nothing new is added to a Pod's tab or a session's header. The work is in
the states of a session's Tab and in the prompts.

### States of a session's Tab

The header's badge keeps one slot of fixed width, widened to fit
"Reconnecting…". Rows marked "over the terminal" are drawn on top of the
terminal's area and do not change its height, because a change of height
while a session is live resizes the session, and a resize makes `ash` drop
what was typed (ADR-0021's rule for the header, and the measurement above).

| State                             | Badge           | Body                                                                                                                                                                                                          |
| --------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attaching, after a reload         | "Attaching…"    | The terminal, empty, taking no input, until the first output arrives.                                                                                                                                         |
| Live                              | "Live"          | As now.                                                                                                                                                                                                       |
| Replaying, after attaching        | "Live"          | The terminal fills. It takes no input until it has caught up, which takes milliseconds.                                                                                                                       |
| Connection to the Engine lost     | "Reconnecting…" | The terminal, dimmed, taking no input. Over the terminal, along its bottom edge: "Reconnecting to the Engine. The session keeps running, and the Engine keeps its recent output."                             |
| Attached in another window        | "Not attached"  | The terminal, dimmed. Over the terminal, centered: "This session is open in another window", "An Exec Session shows in one window at a time. Using it here detaches the other window.", button "Use it here". |
| Session gone, terminal empty      | "Gone"          | Notice "This session is gone": "The Engine no longer has it. It ended, the Engine restarted, or it was told to exit after 10 minutes with no window attached." Button "Start a new session".                  |
| Session gone, terminal has output | "Gone"          | The terminal, dimmed, as an ended one. Bottom strip: "This session is gone. It ended, the Engine restarted, or it was told to exit after 10 minutes with no window attached." Start a new session             |
| Ended while this window was away  | "Ended"         | The terminal with what it missed, then as any ended session, with its reason.                                                                                                                                 |
| Too many sessions                 | "Not started"   | Notice "Too many Exec Sessions": "The Engine runs at most 64 at a time. End one and try again." Button "Try again".                                                                                           |
| Waiting for a socket              | "Waiting"       | As now. Cancel closes the Tab, which ends a session the Tab was waiting to attach to.                                                                                                                         |

Every other state of layer 7 is unchanged, except that "The session lost its
connection to the Engine" no longer exists.

- **Skipped output** is one dim line at the top of the cleared terminal:
  - a new terminal: `[hukube: 1.2 MiB of earlier output is not shown. The
    Engine keeps only a session's most recent output.]`
  - after a lost connection: `[hukube: 1.2 MiB of output was skipped while
    this window was disconnected]`
  - while attached: `[hukube: 1.2 MiB of output was skipped because this
    window was not keeping up]`

  Amounts under 1 MiB are given in KiB. The terminal's own scrollback is
  cleared with it. A window that far behind would have lost most of it to
  the output that follows.

- **In the tab strip,** a session that is not attached here but not over
  (attaching, reconnecting, elsewhere) has a muted icon and no strike, and
  its tooltip says which. A gone session looks like an ended one.
- **Focus.** When a focused terminal's session becomes gone or attached
  elsewhere, focus moves to the button, as it does for "Start again". A
  terminal that takes no input gives its keys back to the window, as an
  ended one does.
- **Keyboard and pointer.** Each new button is a button: Tab reaches it, and
  Enter or a click presses it. No key binding is added.
- **Widths.** At 330 px the centered notice wraps inside the terminal's
  area and its button stays on screen. The reconnecting line wraps to two
  lines.
- **Patterns.** A terminal that reconnects in place with a status line is
  what VS Code's remote terminals and ttyd do. One window at a time with an
  explicit take-over is `screen -d -r`.

### Closing

| Action                                                     | A session this window holds                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Close its Tab                                              | Ends it. Asks first, as now: "End the Exec Session in `<container>` of `<pod>`?"                                                                                                                                                            |
| Close a Tab of a session over, gone, or attached elsewhere | Closes the Tab. No prompt, and the session is not ended.                                                                                                                                                                                    |
| Close a Cluster tab, or move it to a new window            | Detaches. No prompt for sessions. Opening the Cluster again within 10 minutes attaches them. Unsaved edits still ask.                                                                                                                       |
| Reload, or close a window                                  | Detaches. No prompt for sessions.                                                                                                                                                                                                           |
| Quit the desktop app                                       | Stops the Engine, which ends every session. Asks: "Quit and end the Exec Sessions?", "Quitting stops the Engine, which ends N Exec Sessions in this window. A command still running in a container may keep running.", "Cancel" and "Quit". |

VS Code does the same with its terminals: closing one asks, and closing a
window does not, because the terminals come back.

The desktop Host needs to know why a window refuses to unload. The UI
reports its counts of unsaved edits and held sessions through the Host
(`reportOpenWork`), and on the desktop Host it still refuses an unload while
it holds a session. The main process then asks only when the unload ends
something: always for edits, and for sessions only when the app is quitting
or, on Windows and Linux, the last window is closing. A reload passes
without a prompt. The web Host refuses an unload for unsaved edits only.

### Packages

| Need                         | Package                                   | Considered                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comparing screens in tests   | `@xterm/headless` 6.0.0, a dev dependency | A browser, which is slower and reads the same parser.                                                                                                                                                    |
| Tracking modes in the Engine | None: a port of xterm.js's parser         | `charmbracelet/x/ansi`'s parser and the emulators above. The tracker must agree with xterm.js at every byte, which a test checks, and another project's parser would differ where the first tracker did. |

## Steps

One pull request, built in two parts so the Engine is inspected before the
UI depends on it.

### Part 1: protocol, Engine, and the client library

1. Protocol: `ExecParams`' new fields, `ExecSync`, `exec.end`, the `detached`
   reason, `SessionGone` and `TooManySessions`. Run `mise run gen`.
2. `execsession`: the tracker, from the prototype, with the golden files its
   tests and the TypeScript tests share; the ring; the session with its
   attachment, lifecycle, and limits; the registry.
3. `server`: the `pod.exec` handler over the registry, `exec.end`, frames
   pulled from the ring, the two flags, shutdown. Remove `streamQueue.write`
   and everything only it used.
4. `engine-client`: the codec's count, `resume`, `start`, and `takeover`;
   input and pause as separate properties; `lost` removed.

### Part 2: UI

1. The store: start, attach, take, end, detach, the ordered handling of
   `ExecSync`, the input rule, and `exec.end` sent again.
2. The terminal wrapper: reset, the notice, holding input.
3. The panel's states, the Workspace's attaching of restored Tabs, the tab
   strip.
4. The close guards, the Host's `reportOpenWork`, and the desktop prompt.
5. End-to-end tests, ADR and `AGENTS.md` updates, and this plan's record.

## Testing strategy

Engine tests use the fake executor and `testing/synctest`, at the real
limits: a 256 KiB ring, 10 minutes, a 1 MiB window.

| Risk                                                        | Evidence                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A window that attaches again gets the wrong bytes           | `execsession`: after output, detach, more output: an attachment with `resume` gets exactly the bytes after it, no reset, and `replay` equal to their count.                                                                                                                                                                            |
| A window that fell out of the ring is not caught up or told | More than a ring of output while detached: `reset`, `skipped` equal to the bytes not sent, and output from the cut. The same for an attached stream that stops acknowledging and then does.                                                                                                                                            |
| The Engine waits for a slow window                          | A stalled attachment for 62 seconds of fake time while the fake executor writes 64 MiB: every write returns without the clock advancing, and the session is still running.                                                                                                                                                             |
| A cut lands inside a sequence or a character                | Table of streams cut inside a CSI, an OSC, a DCS, and 2-, 3-, and 4-byte characters: the cut is the next safe position. A ring with no safe position sends nothing until one arrives. Golden: at every position the tracker calls safe in the recordings and generated streams, xterm.js is at ground (TypeScript, `@xterm/headless`). |
| A mode set before the ring's start is lost                  | Per recording and ring size, golden restore sequences; TypeScript checks that a reset terminal given one has the modes of a terminal that read the stream.                                                                                                                                                                             |
| A full-screen program's screen is wrong after catching up   | TypeScript, per recording: screen and cursor equal after the recorded resizes. `execsession`: a reset `ExecSync` with the alternate screen on sends one row fewer and back; with it off, or with one row, sends nothing.                                                                                                               |
| A session nobody is attached to lives on                    | Fake clock: unattached for 10 minutes hangs up and removes; attaching at 9 minutes 59 seconds restarts the count; a session that is over is removed the same way.                                                                                                                                                                      |
| Two windows share a session, or a reload is locked out      | The four rows of "One window is attached at a time": who is attached, who gets `detached`, and that the session's size is the attached window's.                                                                                                                                                                                       |
| The tracker ends a session                                  | A tracker made to panic: the session keeps running, later output is kept, and a later attachment gets a restore sequence from the reset tracker.                                                                                                                                                                                       |
| A start runs twice, or an attach starts                     | The six rows of the start table, including `start` sent again for a running session, and a 65th session refused.                                                                                                                                                                                                                       |
| A session's end is lost while its window is away            | A process that exits while detached: the next attachment gets the output and the `end`, and the session is removed only after a socket that closes cleanly.                                                                                                                                                                            |
| Input from a detached window reaches the process            | Input queued then detach: the executor reads none of it. Input on a replaced stream: dropped, stream not ended.                                                                                                                                                                                                                        |
| A character split across frames is dropped                  | A frame boundary inside `E2 80 94` moves to before it; the character is sent whole when its last byte arrives, and at the session's end if it never does.                                                                                                                                                                              |
| A Log Stream changes                                        | The Log Stream tests pass unchanged, and a Log Stream still ends with `bad_request` on input.                                                                                                                                                                                                                                          |
| The client counts wrong, or repeats an intent               | `streams` tests: `resume` is the bytes decoded since the last `offset`; `start` and `takeover` are sent until the first `ExecSync` and not after; a lost socket reconnects; waiting input is dropped and reported.                                                                                                                     |
| A replayed query is answered                                | Store test with a real `@xterm/headless` terminal: `ESC [ 6 n` and `ESC [ c` inside `replay` send nothing; the same after it send an answer; keys typed during replay are dropped.                                                                                                                                                     |
| A restored Tab starts a session, or a hidden one expires    | Store and Workspace tests: a restored layout attaches every session Tab without `start`; `SessionGone` shows the gone state and no stream is opened until the button is pressed.                                                                                                                                                       |
| A closed Workspace ends sessions, or a closed Tab does not  | Store tests: detach sends no `exec.end`; end sends it once, and again after a failed attempt when the connection returns.                                                                                                                                                                                                              |
| The feature does not work end to end                        | Playwright against k3d: start a session, set a shell variable, open `vi` on a file, reload, see the same screen, type into `vi`, quit it, read the variable, `exit`, and read the exit code. A second test runs its own Engine, starts a session, restarts that Engine, and reads "This session is gone".                              |

Each new test is shown to fail once against a broken implementation, by a
targeted change that is then undone.

Checked by hand in Chromium and WebKit, in both themes, at 330, 520, and
1040 px: attaching after a reload at a prompt, in `vi`, and in `top`;
catching up after a flood with the window throttled; the connection lost and
regained; the session gone; two windows, with a take-over each way; every
row of "Closing", on the web Host and the desktop Host.

## Risks

- **A full-screen program that ignores a change of size** stays as the ring
  left it until it paints again. Every program tried repaints.
- **Rows painted before the ring's start are not restored** on the normal
  screen. See "What tracks the screen".
- **The tracker follows xterm.js 6.0.0.** An upgrade of xterm.js can change
  how it reads bytes. The golden tests run against whatever version is
  installed, so an upgrade that matters fails them.
- **Output replayed after a resize** was written for the old size. A shell's
  old lines wrap differently, as they do when a terminal is resized. A
  scroll region set before a resize is restored as it was set.
- **A closed Cluster tab or window leaves shells running for up to 10
  minutes.** That is the price of surviving a reload, since the Engine
  cannot tell one from the other.
- **`sessionStorage` copied by "Duplicate tab"** gives two windows one ID,
  so the second takes the first's sessions without being asked.

## Non-goals

- Keeping a session across an Engine restart, or its output after it ends.
- Changing Log Streams, which keep their queue, gaps, and resume by
  timestamp.
- A snapshot of the screen from an emulator.
- A bottom area or dock, sharing a session, recording one, or any new key
  binding. The Windows and Linux key rows of layer 7 stay as they are.

## Unresolved questions

None.

## What changed while building

### Engine and client

- **A replay ends before an unfinished character.** The first build held an
  attaching window's sync until a character at the ring's end was complete,
  which would leave a window attaching for as long as a process left a
  partial character as its last output. The unfinished character is now
  live output, sent when the rest of it arrives, or at the session's end.
- **A failure in the tracker while cutting** cuts at the ring's start with a
  reset terminal's modes. The tracker already recovered a panic while
  reading bytes; a cut ran on a copy of it without that guard.
- **The tracker keeps only the last three bytes of a sequence's
  intermediates.** xterm.js shifts them into a 32-bit identifier with the
  final byte, so earlier ones cannot change what a sequence does. The
  prototype kept them all, without bound.
- **Input written while a stream is not attached is dropped without a
  report.** The terminal already shows that it takes no input. Input that
  was accepted and then lost with its socket is still reported, as
  "[hukube: 3.0 KiB of input was not sent]".
- **A client closes its socket with a normal closure after an `end`,** so
  the Engine can tell the `end` was received and remove the session.

### UI

- **"Use it here" resumes from the terminal's position,** so the window
  that takes a session over keeps what its terminal shows and gets only
  what it missed.
- **The desktop Host's prompts name what is lost.** A window with unsaved
  edits only asks "Discard unsaved edits?"; quitting with Exec Sessions
  only asks "Quit and end the Exec Sessions?"; both together keep the
  combined wording.

### Experience-review corrections

A reviewer with no history of the work used the running app in Chromium and
WebKit. It found reload, reconnection, and the closing prompts sound, and
these problems, which are fixed:

- **A session Tab could vanish on reload.** Workspace layouts are saved per
  Cluster and the last window to save wins (ADR-0009), so a reload could
  restore another window's layout without this window's session Tab, and
  the session ran on with no way back to it. Each window now keeps its
  session Tabs in `sessionStorage` (`features/exec/window-tabs.ts`) and adds
  back any the restored layout lacks, inactive, and attaches them.
- **Skipped output went untold.** The notice line at the top of the cleared
  terminal is pushed out of the 5,000 lines of scrollback at once by a
  256 KiB tail of short lines. Measured: a window throttled 50 times during
  `seq 1 1500000` skipped 10.5 MiB and showed nothing. The message is now
  also a line over the bottom of the terminal, until dismissed, typed past,
  or the session leaves the live phase.
- **"Use it here" left focus on the page,** so typing went nowhere. It now
  focuses the terminal.
- **The reconnecting line was see-through** over the prompt. It is opaque,
  with a top border. The other-window notice is on an opaque card.
- **The gone text claimed a cause it could not know.** A window that showed
  the session open elsewhere learns it is gone only when it tries to use
  it, and it may simply have ended. The text is now "The Engine no longer
  has it. It ended, the Engine restarted, or it was told to exit after 10
  minutes with no window attached."

Not changed, and listed under "Follow-ups": a window showing the session
open elsewhere is not told when it ends; the status badges share one grey
style; "Start again" and "Start a new session" name one action twice; a
take-over by a window of another size resizes the session, which makes
`ash` print its prompt again.

### Code-review corrections

Two reviewers, one Codex and one Claude, read the change independently. Each
reproduced its findings with a scratch test. What changed because of them:

- **A replay could freeze a session.** A frame that ended exactly at the
  replay's end was trimmed to a character boundary like any other. When the
  bytes before that end were an invalid, cut-short sequence, the frame was
  trimmed to nothing, the replay never finished, live output never followed,
  and the terminal took no input, in every window that attached. Such a
  frame is no longer trimmed.
- **The repaint could reach a shell.** It was asked for when the alternate
  screen was on at the cut, even if the program had left it since. It is now
  asked for only when the alternate screen is on both at the cut and at the
  ring's end.
- **Closing a Tab could lose to its own start.** If `exec.end` reached the
  Engine before the stream's `open`, the end found nothing and the start
  then made a session that ran until the unattached limit. The Engine now
  remembers an ended ID it did not have for a minute, at most 256 of them,
  and refuses one start for it as `SessionGone`.
- **Only a Tab the user closes ends its session.** dockview also removes
  panels when a layout is replaced, including when an unreadable one is
  cleared, which ended the window's sessions. The close button, middle
  click, and the waiting notice's Cancel now end the session; any other
  removal only detaches.
- **The tracker took scroll regions xterm.js refuses.** It now applies
  xterm.js's rule with the session's current rows, and keeps the previous
  region when one is refused. It reads bytes after they were written, so a
  resize in between can still make it judge a region against the wrong
  height. It also tracks synchronized output (mode 2026).
- **The limit of 64 counts sessions still hanging up,** so ending and
  starting quickly cannot run more than 64 processes at once.
- **CI's end-to-end run failed on Linux:** a restored session Tab now
  attaches and takes focus, and there a focused terminal sends `Ctrl+K` to
  the shell. The helpers move focus out of the terminal before they open Go
  to Resource.

Not changed, and accepted: when the ring holds no safe place to cut, an
attaching window's stream scans the whole ring again each time output
arrives, which slows the writer while one control string longer than the
ring is in it; a window cut in mid-stream takes no input, and answers no
query, from the moment the catch-up arrives, so a query that live output
was still being parsed for goes unanswered.

### Merging chosen commands

Layer 7 added choosing the command a session runs (ADR-0025,
`docs/plans/exec-session-commands.md`) after this layer branched. Merging it
forward settled how the two work together:

- **Only a start runs a command.** `startSession` splits the Tab's
  `commandLine` and sends `command` with `start`. An attachment, a
  take-over, and a socket that reconnects after the first sync never send or
  split it, so a Tab restored after a reload joins the process its line
  started.
- **A start that is sent again cannot run its command twice.** A stream
  repeats `start` when its socket closes before the Engine has answered. If
  the process had already ended, the Engine took that as "Start again" and
  ran the command again, which a chosen command makes unsafe. Each start now
  carries its own `run`, and an ended session is replaced only by a start
  with another `run`. A reviewer of the merge found this. The guard holds
  while the Engine still has the ended session: a retry that arrives after
  it was removed, which needs 10 minutes of failed reconnects or an Engine
  restart between the start and its answer, starts the command again.
- **The window's record keeps the command line,** and a same-Tab restart
  from the no-shell or not-found notice updates the record, so a Tab
  restored from it keeps its command and title. A Tab whose line is too long
  to keep is not restored from the record, because without its line it
  would start the default shell.
- **Removing a missing command from the recent ones** runs in the ordered
  end handler. A window that attaches after a reload can be sent the same
  end again, and removing a command that is already gone does nothing.
- This layer's ADR is ADR-0026, after layer 7's ADR-0025.

Not changed: a Tab in both the shared layout and this window's record takes
the layout's params. If another window saved the layout after this window
restarted the Tab with a new command, a reload shows the old command line
until the session is started again. The session itself still attaches
correctly.

## Measurements

On an Apple silicon laptop against the k3d cluster, with a hand-started
Engine (`--exec-buffer=16384 --exec-unattached-timeout=10s`) and a WebSocket
client:

- A window that dropped its socket and attached again with its position got
  exactly the 12 bytes it missed, once, and the shell took input.
- A `start` sent again by the same window attached to the running shell; a
  window with another ID was refused, and took the session over with
  `takeover`, which gave the session its size (`stty size`: `30 100`).
- A window that stopped acknowledging during 2 MB of output was caught up
  repeatedly, each time with `reset` and the bytes skipped.
- A window cut in while busybox `vi` was open got a restore sequence with
  `ESC [ ? 1049 h`, then 3,995 bytes of repaint after the two resizes, the
  same two paints the recording shows.
- `exit 3` reached the window as `complete` with code 3, after which the
  session was gone. A session with no window attached was still there at 8
  seconds and gone at 12.5, and its shell had exited in the container.

## Follow-ups

- Tell a window that shows a session open elsewhere when the session ends,
  through a subscription to the window's sessions.
- List the running sessions of a Pod in its "Exec Session in" menu, so a
  session can be reached from another window or after its Tab was closed
  elsewhere.
- A snapshot of the screen from an emulator, if the normal screen's rows
  lost with the ring's start turn out to matter.
- A heartbeat on stream sockets, so a stalled connection to a remote Engine
  is noticed before the operating system gives up on it.
- Distinct tones for the status badges, and one label for starting a
  session again.
