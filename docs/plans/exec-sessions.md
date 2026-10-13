# Plan: Exec Sessions

Status: implemented, not merged yet. "What changed while building" lists
where the result differs from the text below. The Windows and Linux rows of
"Keys" await Jim's confirmation.

## Outcome

After this work:

- A Pod's tab has a control that opens an Exec Session in one of its
  containers. The session runs a shell in a terminal that takes typing,
  full-screen programs, resizing, copy and paste, scrollback, and search.
- An Exec Session is its own Tab. It opens in the Pane of the Pod it was
  started from, and it can be moved to any Pane like any other Tab.
- A session that ends says why: the process exited, the container stopped, the
  Pod was deleted, the connection was lost, or it could not start. An ended
  session never looks live, and it offers to start again where that can work.
- Closing a live session asks first.
- `hukube-engine --read-only` refuses Exec Sessions, and the UI says why.

It does not add a dock for sessions, attaching to a container's main process,
debug containers, file copying, or a session that survives a reload.

## Current state

These observations come from the code at `18dd59f`:

- A stream socket (`engine/internal/server/stream.go`, ADR-0016) carries data
  from the Engine only. Its read loop accepts `ack` and closes the socket on
  anything else. `streamQueue.frame` never waits: it drops the oldest data and
  leaves a `gap`.
- `SocketStream` in `packages/engine-client/src/streams.ts` opens a stream
  again whenever its socket closes without an `end`. That is right for a Log
  Stream and wrong for a session, where it would start a second shell.
- `WorkerEngineClient` acknowledges a data message as soon as the listener
  returns. A terminal emulator takes data asynchronously.
- `handleMutation` covers requests only. Nothing makes a stream a mutation.
- `resource.access` reports `edit` and `delete`.
- A Tab is a `list` or a `resource` panel. `guardResource` and `guardCluster`
  in `features/edit/unsaved-edits.ts` ask before a close that would discard
  edits.
- The Engine's shutdown calls `http.Server.Shutdown`, which leaves upgraded
  connections alone.

## Evidence

### A probe of exec against the k3d cluster

A throwaway Go program ran client-go v0.37.1's executors against k3s v1.35.5
(containerd). It is not part of this change. It showed:

- **Both transports work, and which one is used is not ours to choose.** The
  WebSocket executor (`v5.channel.k8s.io`) and the SPDY executor both ran
  every case below. `kubectl` tries WebSocket first and falls back to SPDY
  when the upgrade fails.
- **The fallback check moved packages.** client-go returns
  `k8s.io/streaming/pkg/httpstream.UpgradeFailureError`. The helper of the
  same name in `k8s.io/apimachinery/pkg/util/httpstream` tests for its own
  type and returned `false` for that error, so a fallback built on it never
  falls back.
- **The two transports need different permissions.** WebSocket is a `GET`
  (`get pods/exec`) and SPDY is a `POST` (`create pods/exec`). A user with
  only `create` reaches a container through the fallback.
- **A refusal is not a Status error.** A forbidden user got
  `unable to upgrade streaming request: pods "x" is forbidden: User ...` from
  WebSocket and `unable to upgrade connection: ... is forbidden: ...` from
  SPDY, both as plain errors. A missing Pod or container reads the same way.
- **An exit status is an error value.** Exit 0 returns `nil`. Any other code
  returns `exec.CodeExitError` with the code.
- **A container without a shell fails after the connection is up.** The error
  is plain text ending in
  `exec: "sh": executable file not found in $PATH`. No output arrives first.
- **Resize works through the size queue.** `stty size` printed `24 80` and,
  after a new size, `43 132`.
- **A client that goes away leaves the process running.** After the context
  was cancelled, the shell and its children were still in the container 5
  seconds later, on both transports. Closing stdin does not end a shell on a
  TTY either. containerd's source agrees: nothing sends EOF, `SIGHUP`, or a
  kill when a TTY exec's client disconnects.
- **End-of-transmission ends an idle shell.** Writing `0x04` to stdin ended a
  shell at its prompt in about 10 ms. With `sleep`, `top`, or `cat` in the
  foreground it did nothing until that program ended, and `vi` ignored it.
- **A deleted Pod and a stopped container look like exit 137.** In both cases
  the executor returned exit code 137 within 60 ms. At that moment the Pod
  still existed (with a deletion timestamp, in the first case) and its status
  still showed the container as running.
- **Input is fast when the container reads it.** 1 MiB written to a raw TTY
  arrived whole in about 1 second, and 256 KiB of 80-column lines through a
  cooked TTY with echo arrived whole.
- **Held-back output kills a WebSocket session after 61 seconds.** client-go
  reads the connection and writes stdout on one goroutine, and its heartbeat
  deadline is renewed only while that goroutine reads. With a stdout writer
  that blocked for 20 seconds the session carried on. With one that blocked
  for 75 seconds it ended with
  `error reading from error stream: ... i/o timeout`. SPDY survived both.

### What other tools do

From their source at the versions named:

|                | Command                                                        | Choice | Container                                   | Ends                                                   |
| -------------- | -------------------------------------------------------------- | ------ | ------------------------------------------- | ------------------------------------------------------ |
| k9s 0.51       | `sh -c "command -v bash >/dev/null && exec bash \|\| exec sh"` | none   | default-container annotation, then a picker | returns to the list, flashes a failure                 |
| Headlamp 0.45  | `bash`, `/bin/bash`, `sh`, `/bin/sh`, one exec each            | none   | a select above the terminal                 | closes on a clean exit, offers to reconnect on failure |
| Freelens 1.10  | `sh -c "clear; (bash \|\| ash \|\| sh)"` through `kubectl`     | none   | default container, submenu for the rest     | prints `[Process exited with code N]`                  |
| Dashboard 7.14 | `bash`, `sh`, `powershell`, `cmd`, one exec each               | none   | a select in the title                       | closes with the error                                  |

- The action sits on the Pod: a header button in Headlamp, a toolbar and menu
  item in Freelens, a key on the row in k9s. The terminal is titled with the
  Pod's name.
- On close, the Dashboard writes end-of-transmission to stdin "to avoid
  resource leak", and Freelens types `exit` and Enter. kubectl does nothing.
- VS Code keeps a small set of keys from the shell
  (`terminal.integrated.commandsToSkipShell`). On Windows `Ctrl+C` copies when
  text is selected and `Ctrl+V` pastes. On Linux both go to the shell and
  `Ctrl+Shift+C` and `Ctrl+Shift+V` copy and paste. `Ctrl+K` never reaches the
  shell while chords are allowed, which is a known annoyance in `nano`.
  Headlamp, Freelens, and JupyterLab copy on `Ctrl+C` when text is selected.
  GNOME Terminal, Konsole, and Windows Terminal find with `Ctrl+Shift+F`.
- Chromium reserves only tab and window keys, so a page can take
  `Ctrl+Shift+C`. Firefox's developer-tools keys were not verified.

### xterm.js

`@xterm/xterm` 6.0.0 and its add-ons were published on 2025-12-22, well past
the 7-day cooldown. `latest` is 6.0.0; the 6.1.0 betas are not used.

- The DOM renderer is built in and is the default. The canvas renderer is
  gone. The WebGL add-on has open bugs in Safari and WKWebView, and a document
  can hold about 16 contexts.
- `write(data, callback)` calls back when the chunk has been parsed. The
  project's flow-control guide recommends acknowledging to the sender from
  that callback, which is what ADR-0016's window does.
- The fit add-on has no observer of its own and does nothing in a hidden
  element. In a visible element of zero size it proposes 2 by 1.
- The search add-on has `findNext`, `findPrevious`, and a result count, and
  ships no UI. Its match highlights need `allowProposedApi`.
- The clipboard add-on's default provider answers a process that asks for the
  clipboard's contents.
- `Buffer.resize` can throw when rows grow with scrollback (issue 6063, open).

## Decisions

### A session is a stream, `pod.exec`

```go
StreamPodExec = DeclareStream[ExecParams, None]("pod.exec")

type ExecParams struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	// UID is the Pod the session runs in. A Pod of the same name with
	// another UID is a different Pod.
	UID       string `json:"uid"`
	Container string `json:"container"`
	// Command replaces the default shell. The UI does not set it yet.
	Command []string `json:"command,omitempty"`
	Cols    uint16   `json:"cols"`
	Rows    uint16   `json:"rows"`
}
```

A session always has a TTY, so output is one channel: binary frames with the
channel byte 1 and the bytes as the container wrote them. The stream has no
events.

The stream socket gains what a session needs. A Log Stream that receives any
of the client messages below ends with `bad_request`.

| Direction | Message                           | Meaning                                               |
| --------- | --------------------------------- | ----------------------------------------------------- |
| client    | binary frame, channel 0           | input, at most `ExecInputFrame` (32 KiB) of it        |
| client    | text `resize` with `cols`, `rows` | the terminal's size                                   |
| Engine    | text `ack` with `bytes`           | the total input the Engine has passed to the Cluster  |
| Engine    | `end` with `exitCode`             | the process's exit status, with the reason `complete` |
| Engine    | `end` with the reason `stopped`   | the container stopped                                 |

`ExecInputFrame` and `ExecInputWindow` are protocol constants, generated for
the client.

### Both directions are acknowledged

ADR-0016 expected output to be held back for as long as the client is slow,
and input to rely on TCP. Both change. The ADR is amended.

**Output.** The executor's stdout writer waits while 1 MiB is queued for the
client, which holds the container's process back as a slow terminal does.
The wait is bounded by `Timing.ExecStall`, 30 seconds: if the client
acknowledges nothing for that long while output waits, the stream stops
waiting and drops the oldest output, leaving a `gap`, until the next
acknowledgement. The bound is half of client-go's heartbeat deadline. Without
it a browser tab that stops for a minute would end the session with a
timeout.

The client acknowledges a frame when the terminal has parsed it, which is the
`write` callback. A stream listener's `data` may return a promise, and the
acknowledgement waits for it.

**Input.** The Engine must never stop reading the socket, because the
client's acknowledgements of output arrive on it. Input therefore has its own
window instead of TCP's:

- The client sends at most `ExecInputWindow` (256 KiB) of input beyond what
  the Engine has acknowledged, in frames of at most `ExecInputFrame`. The rest
  of a paste waits in the Worker.
- The Engine queues what it receives and acknowledges input as the executor
  reads it. A client that exceeds the window ends the stream with
  `bad_request`.
- Resizes are not queued. The Engine keeps the latest size.

### A lost socket ends a session

A stream method is resumable or not. `resource.logs` is. `pod.exec` is not:
once its `open` has been sent, a socket that closes without an `end` puts the
stream in a new final state, `lost`, and the client does not connect again.
Before `open` is sent, nothing has started, so the client retries as it does
for any stream. A session cannot be paused, and `pause` does nothing to it.

### What runs

The default command is one exec:

```sh
sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
```

This is k9s's command. It costs one round trip, and typed input cannot be
lost between attempts, which the Dashboard's one-exec-per-shell approach
admits to. It needs `sh`, which every image with a shell has.

The user cannot choose a command in this layer. No comparable tool offers
one, and a shell runs anything else. `ExecParams.Command` is the extension
point. Windows containers get the no-shell notice; choosing `powershell` by
the Pod's OS is a follow-up.

### How a session ends

The Engine runs the executor under its own context, not the socket's, so that
it can end the process in order.

**The client goes away** (the Tab closes, the window closes, or the socket is
lost), or the Engine shuts down: the Engine discards input it has not yet
passed on, writes end-of-transmission (`0x04`) to stdin, waits up to
`Timing.ExecHangup` (1 second) for the process to exit, and then cancels the
executor. An idle shell exits. A command still running in the foreground
keeps running, as it does when `kubectl exec` loses its connection, and the
shell exits when that command ends. hukube says so wherever it matters, and
does not claim the process is gone.

Sending an interrupt first would end more commands, and would also end a
migration because a laptop slept. Typing `exit`, as Freelens does, would run
whatever is half-typed at the prompt with `exit` appended.

`Server.Shutdown` hangs up every session and waits for them, bounded by its
context. `main` calls it before `http.Server.Shutdown`.

**The Pod leaves the index** while the session runs: the Engine cancels the
executor and ends the stream with `deleted`.

**The executor returns.** The Engine classifies the result, in this order:

| Result                          | End                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `nil`                           | `complete`, exit code 0                                                                     |
| An exit code other than 137     | `complete`, with the code                                                                   |
| Exit code 137                   | What the Pod says (below), else `complete` with 137                                         |
| An error, after output was seen | What the Pod says, else `error` with the code `unavailable` and the reason `ConnectionLost` |
| An error, with no output seen   | A start failure (below)                                                                     |

137 is what a process reports when it is killed, which is what the runtime
does to a session's process when its container stops.

What the Pod says comes from reading it from the Cluster every 200 ms for up to
`Timing.ExecSettle` (2 seconds), until one of these holds:

- The Pod is gone, has another UID, or has a deletion timestamp: `deleted`.
- The container is not running, or started after the session did: `stopped`.

A start failure is an `error` whose code and reason come from the message,
because the executor returns text:

| Message contains                                                   | Code          | Reason    |
| ------------------------------------------------------------------ | ------------- | --------- |
| `is forbidden`                                                     | `forbidden`   |           |
| `not found` after `pods` or `container`, or `is not valid for pod` | `not_found`   |           |
| `executable file not found` or `no such file or directory`         | `not_found`   | `NoShell` |
| anything else                                                      | `unavailable` |           |

The message is passed on whole in every case, so a wrong guess still shows
the Cluster's words.

### A session is a mutation

A shell can change anything a write can, so `--read-only` refuses it. A
stream registered with `handleMutationStream` ends with `forbidden` and the
read-only reason before it does anything, in the way `handleMutation` guards
a request. `mise run dev:tailnet` is read-only by default, so it has no
sessions unless `HUKUBE_TAILNET_WRITE=1`.

### Permission

`resource.access` gains `exec`. For a Pod it is a
`SelfSubjectAccessReview` for `create` on `pods/exec`, cached like the other
two. For any other Resource Type it is not allowed, with no reason. In
read-only mode it carries the read-only reason.

`create` is the verb to ask about. It is what roles grant for exec, what
`kubectl auth can-i` documents, and what the SPDY fallback needs. The
`pod.exec` stream makes the same check before it starts, so a refusal has a
reason even when the UI did not ask first.

### Limits

Exec Sessions and Log Streams share the window's 8 stream sockets, first come
first served. A Log Stream gives its socket up while hidden. A session holds
its socket until it ends, hidden or not, because it cannot be resumed. A
session opened beyond the cap waits and says so, and no process starts until
it has a socket.

### The session outlives its component

`features/exec/sessions.ts` holds every session of the window, keyed by a
session ID: its params, its stream, its xterm.js terminal with the element the
terminal renders into, and its state. The panel component shows a session by
attaching that element. Nothing in the component owns the stream.

A session is ended by exactly these:

- Its stream ends or is lost.
- Its Tab closes: the Workspace disposes the session when dockview removes
  the panel.
- Its Workspace closes: the Workspace disposes its Cluster's sessions when it
  unmounts.
- The window unloads, which closes the socket.

Moving a Tab to another Pane, or a component that mounts again, ends nothing.

### After a reload

A stored Workspace layout keeps a session's Tab with its params. The store is
empty after a reload, so the Tab finds no session for its ID. It shows a
notice and a button that starts a new session there. It never starts one by
itself: a reload must not open shells.

### The terminal is xterm.js with the DOM renderer

`@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, and `@xterm/addon-search`
0.16.0, loaded on demand as Monaco is. ADR-0018 already assigns terminals to
xterm.js.

- The DOM renderer needs no fallback, has no Safari bugs open against it, and
  lets a test read the screen as text. A session's output is small next to
  what the WebGL renderer exists for.
- Not used: the clipboard add-on (a process in a container could read the
  user's clipboard), the web-links add-on (opening an address a container
  printed needs a decision about external links first), and the Unicode
  add-on.
- Scrollback is 5,000 lines. `convertEol` stays off.

## Keys

The coordinator approved this table to build on. The macOS column is
settled. The Windows and Linux column awaits Jim's confirmation, on the four
points listed below it.

While a live session's terminal has focus it takes every key, except:

| Key                | macOS                  | Windows and Linux                                                                                                           |
| ------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Go to Resource     | `Cmd+K`, as everywhere | `Ctrl+Shift+K`. `Ctrl+K` goes to the shell.                                                                                 |
| Copy               | `Cmd+C`                | `Ctrl+C` when text is selected, which also clears the selection; otherwise `Ctrl+C` goes to the shell. Also `Ctrl+Shift+C`. |
| Paste              | `Cmd+V`                | `Ctrl+V` and `Ctrl+Shift+V`                                                                                                 |
| Find in scrollback | `Cmd+F`                | `Ctrl+Shift+F`. `Ctrl+F` goes to the shell.                                                                                 |
| Select all         | `Cmd+A`                | none; the context menu has it                                                                                               |
| `Mod+J`            | not handled            | not handled, so the shell does not get `Ctrl+J`                                                                             |

The rule on Windows and Linux is the one their terminals use: the
application's version of `Ctrl+<key>` is `Ctrl+Shift+<key>`. macOS has no
conflict: every `Cmd` key stays the app's and every `Ctrl` key goes to the
shell.

`Tab` goes to the shell. The keyboard leaves a live terminal through Go to
Resource. A "Tab moves focus" switch, as VS Code has, would need a binding of
its own and is a follow-up.

Awaiting Jim's confirmation, each with the recommendation built:

1. **`Ctrl+Shift+K` is one new binding,** and it exists only while a session
   has focus on Windows and Linux. Recommended. The alternative is VS Code's:
   the app keeps `Ctrl+K` everywhere and the shell never receives it. That
   keeps "`Mod+K` always opens Go to Resource" as one rule, and costs shell
   users kill-to-end-of-line and `nano` users cut-line, which is a standing
   complaint about VS Code's terminal. Without either, a keyboard user on
   Windows or Linux has no way out of a focused terminal.
2. **Find is `Ctrl+Shift+F` on Windows and Linux,** not `Ctrl+F`, so `vi` and
   `less` keep page-forward. Recommended; GNOME Terminal, Konsole, and Windows
   Terminal do the same. VS Code takes `Ctrl+F`, which would match the
   editors here.
3. **`Ctrl+V` pastes on Linux too,** where VS Code and desktop terminals
   leave it to the shell. Recommended, because a web page that does not paste
   on `Ctrl+V` reads as broken; `vi` users have `Ctrl+Q` for the same command.
4. **`Ctrl+J` is withheld from the shell** on Windows and Linux, to keep
   `Mod+J` unhandled everywhere. Recommended. It costs the shell a duplicate
   of Enter.

Firefox lets a page take `Ctrl+Shift+C` and `Ctrl+Shift+K` from its developer
tools. Its key listener skips an event whose default was prevented, and the
developer-tools keys are not marked reserved (`GlobalKeyListener.cpp` and
`DevToolsStartup.sys.mjs`). This was read from source, not tried in a running
Firefox. A user who has set the site's "Override Keyboard Shortcuts"
permission to block keeps the browser's keys.

`features/exec/keys.ts` is one pure function from a key event and a platform
to what happens, so the table above is its test.

## UI and UX

### Where each control goes

| Control                              | Place                                                                                       | Why                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Open an Exec Session                 | An icon button in a Pod tab's header, left of Delete                                        | It acts on the Pod. Headlamp and Freelens put it in the Pod's header.                   |
| Container choice                     | A menu on that button, only for a Pod with more than one container                          | Freelens's submenu and k9s's picker. One container needs no choice.                     |
| The session                          | A Tab in the Pane of the Pod's tab                                                          | Jim's decision.                                                                         |
| What the session is attached to      | The session Tab's header                                                                    | A command must never be typed into the wrong Cluster.                                   |
| Find                                 | An icon button in the session's header, and a find bar over the terminal's top right corner | Where Monaco's find widget sits in the Logs and YAML Facets.                            |
| Copy, Paste, Select all, Find, Clear | The terminal's context menu                                                                 | The pointer's way to what the keys do. Windows Terminal and VS Code have the same menu. |
| Why it ended, and Start again        | A strip along the bottom of the session Tab                                                 | The bottom is where a terminal's user is looking.                                       |

### Starting a session

The button shows a terminal icon, with the tooltip and accessible name
"Open an Exec Session". It appears only on a Pod.

- **One container:** a click starts the session.
- **Several:** a click opens a menu headed "Exec Session in". It lists the
  Pod's containers, the one named by the
  `kubectl.kubernetes.io/default-container` annotation first, then the rest in
  spec order, then init and ephemeral containers with their kind beside the
  name. A container that is not running is disabled and says its state, such
  as "waiting" or "terminated".
- **Disabled,** focusable, with the reason as its tooltip, in this order: the
  Pod is deleted or not loaded ("The Pod is not available."), the connection
  is down ("Reconnecting to the Engine"), `access.exec` is refused (its
  reason, or "Not permitted"), or no container is running ("No container is
  running.").

The new Tab is a regular Tab, not a Preview Tab, opened in the Pod tab's Pane
and focused. Its ID is `exec:<session ID>`, so one container can have several
sessions. Starting a session does not ask for confirmation.

### The session Tab

**In the tab strip:** a terminal icon and the Pod's name. The icon and name
are muted when the session is not live. The close button asks first while the
session is starting or live.

**Header,** in the style of a Resource tab's header, with a 2 px line in the
Cluster's color along its top:

- A dot in the Cluster's color and the Cluster's name, in that color.
- "Pod", then the Pod's name as a button that opens the Pod's tab in the
  same Pane, then "in" and the Namespace.
- "Container" and its name.
- A status badge: "Starting…" until the first output, nothing while live,
  "Ended" afterwards, and "Terminating" while the Pod has a deletion
  timestamp and the session is live.
- The Find button, pushed to the right.

The parts wrap. At 1040 px they fit one line, at 520 px two, and at 330 px
three, and each name truncates with its full text as a title.

**Terminal:** fills the rest, in the editor's font and size, with the theme's
background, foreground, selection, and the `--ansi-*` colors the Logs Facet
uses. It takes focus when the session starts and when its Tab is activated.

### States

| State                            | Header badge | Body                                                                                                                                                                                                                                                   | Bottom strip                                                                                                                   |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Restored after a reload          | none         | Notice "This session is over": "An Exec Session does not survive a reload. Its shell was told to exit." Button "Start a new session".                                                                                                                  | none                                                                                                                           |
| Waiting for a socket             | "Waiting"    | Notice "Waiting for a free stream": "hukube runs 8 Log Streams and Exec Sessions at a time in a window. This session starts when one of them closes." Button "Cancel", which closes the Tab.                                                           | none                                                                                                                           |
| Connecting or starting           | "Starting…"  | The terminal, empty                                                                                                                                                                                                                                    | none                                                                                                                           |
| Live                             | none         | The terminal                                                                                                                                                                                                                                           | none                                                                                                                           |
| Process exited                   | "Ended"      | The terminal, dimmed, taking no input, cursor hidden                                                                                                                                                                                                   | "The process exited with code N." Start again                                                                                  |
| Container stopped                | "Ended"      | as above                                                                                                                                                                                                                                               | "The container stopped, which ended the session." Start again                                                                  |
| Pod deleted                      | "Ended"      | as above                                                                                                                                                                                                                                               | "The Pod was deleted, which ended the session."                                                                                |
| Connection to the Cluster failed | "Ended"      | as above                                                                                                                                                                                                                                               | "The session lost its connection to the Cluster: <message>" Start again                                                        |
| Connection to the Engine lost    | "Ended"      | as above                                                                                                                                                                                                                                               | "The session lost its connection to the Engine. A command that was running may still be running in the container." Start again |
| Not permitted                    | none         | Notice "Not permitted", with the reason                                                                                                                                                                                                                | none                                                                                                                           |
| Read-only Engine                 | none         | Notice "The Engine is read-only", with the reason                                                                                                                                                                                                      | none                                                                                                                           |
| No shell                         | none         | Notice "No shell in this container": "hukube runs `sh`, and this container has none, which is usual for distroless images. A debug container is the way into one, for example with `kubectl debug`." The Cluster's message below it, in the code font. | none                                                                                                                           |
| Pod gone before it started       | none         | Notice "The Pod is gone"                                                                                                                                                                                                                               | none                                                                                                                           |
| Could not start, other           | none         | Notice "The session could not start", with the message. Button "Try again".                                                                                                                                                                            | none                                                                                                                           |

- **Output dropped:** the terminal prints a line in a dim color where the
  output is missing: `[hukube: 1.2 MiB of output was dropped while this
window was not reading]`.
- **Start again** resets the terminal and starts a new session in the same
  Tab. It is absent when the Pod is gone or has another UID, and disabled
  with a reason while the connection to the Engine is down or no session may
  start. Headlamp and ttyd clear the screen on reconnect in the same way.
- **The window out of date:** the root layout freezes the window, as for
  everything else.
- **The Pod's tab, after its session's Tab is closed:** unchanged. A Pod can
  have any number of sessions.

### Closing

`guardResource` and `guardCluster` become guards for a panel and a Cluster
that count live sessions as well as unsaved edits, in the dialog layer 6
built. A session is live from the moment it has a socket until it ends.

- **A session's Tab,** by its close button or a middle click: "End the Exec
  Session in `<container>` of `<pod>`?", "Its shell is told to exit. A command
  still running in the container may keep running.", with "Keep session"
  focused and "End session".
- **A Cluster tab, or moving it to a new window:** one dialog for everything
  that would be lost. With sessions only: "End the Exec Sessions in
  `<cluster>`?", "1 Exec Session is running." or "N Exec Sessions are
  running.", then the sentence about a running command, with "Cancel" and
  "End sessions and close". With edits too, the title is "Close `<cluster>`?",
  the description names both counts, and the button is "Discard and close".
- **The window:** the browser's own prompt, as for unsaved edits.

### Find

The find bar holds a text field, the match count ("3 of 17", or "No
results"), previous and next buttons, and a close button. `Enter` finds the
next match, `Shift+Enter` the previous, and `Escape` closes the bar and
returns focus to the terminal. Matches are highlighted in the terminal, the
current one in the theme's find color.

### Copy and paste

The keys in "Keys" and the context menu. Copying goes through `copyText`,
which works on the plain-HTTP web Host. The menu's Paste reads the clipboard
through the Clipboard API, and is disabled with the reason "This Host cannot
read the clipboard; use the keyboard." where that API is absent. A paste by
key uses the browser's paste event, which works everywhere. xterm.js wraps a
paste in bracketed-paste markers when the shell asked for them.

### Packages

| Need              | Package                                                           | Considered                                                                 |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Terminal emulator | `@xterm/xterm` 6.0.0                                              | Monaco, which is not a terminal. Nothing else is maintained at this level. |
| Sizing            | `@xterm/addon-fit` 0.11.0                                         | Computing columns by hand, which the add-on exists to do.                  |
| Search            | `@xterm/addon-search` 0.16.0                                      | None. The find bar around it is ours because the add-on has no UI.         |
| Exec              | client-go's `remotecommand`, already a dependency of a dependency | None.                                                                      |

## Steps

The work ships as one pull request, built in two parts so the Engine is
inspected before the UI depends on it.

### Part 1: protocol, Engine, and client

1. Protocol: `pod.exec`, `ExecParams`, the `resize` and `ack` messages,
   `exitCode`, the `stopped` reason, the two constants, and
   `ResourceAccess.exec`. Run `mise run gen`.
2. Stream socket: input for a stream that accepts it, the waiting write with
   its stall bound, and `handleMutationStream`.
3. `engine/internal/execsession`: the session against an executor interface,
   with the rules above, and no dependency on `server`.
4. `Cluster`: the executor (WebSocket, falling back to SPDY on
   `k8s.io/streaming`'s upgrade failure), the exec access check, and reading
   a Pod for the end.
5. `Server.Shutdown`, called from `main`.
6. Client: `write` and `resize` on an exec stream, the input window in the
   Worker, bytes transferred across the Worker boundary in both directions,
   the deferred acknowledgement, and the `lost` state.

### Part 2: UI

1. The session store, the terminal wrapper, and `keys.ts`.
2. The session panel, its states, the find bar, and the context menu.
3. The Pod header's button and menu.
4. The close guards.
5. A sample Pod without a shell in the fixtures, named for what it is.
6. ADRs, `AGENTS.md`, and this plan's record of what changed.

## Testing strategy

| Risk                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input or output reaches the wrong channel, or is reordered | `execsession` test with a fake executor that echoes stdin: bytes sent on channel 0 return on channel 1 in order.                                                                                                                                                                                                                                                            |
| A resize is lost, or an old one overtakes a new one        | Fake executor that records sizes: the initial size from params, then the latest of several sent at once.                                                                                                                                                                                                                                                                    |
| An exit status is lost or misreported                      | Fake executor returning `nil`, `CodeExitError{3}`, and `CodeExitError{137}` with a Pod that is running: `complete` with 0, 3, and 137.                                                                                                                                                                                                                                      |
| A client that leaves does not end the process              | Fake executor that exits on `0x04`: closing the socket delivers it, and the executor's context is cancelled after `ExecHangup` when it does not exit. Input queued behind it is not delivered.                                                                                                                                                                              |
| A deleted Pod or stopped container is reported as an exit  | Fake executor returning 137 with a fake Pod reader that is gone, has a deletion timestamp, or shows a restarted container: `deleted`, `deleted`, `stopped`. The Pod leaving the index mid-session: `deleted`.                                                                                                                                                               |
| A refusal is reported as a failure, or without its words   | Errors with the probe's exact texts for forbidden, a missing Pod, and no shell, with no output: `forbidden`, `not_found`, and `not_found` with `NoShell`, each with the whole message. A denied access review ends the stream before the executor runs.                                                                                                                     |
| Read-only mode lets a session through                      | `server` test: a read-only Server ends `pod.exec` with `forbidden` and never builds an executor.                                                                                                                                                                                                                                                                            |
| Held-back output ends the session, or grows without bound  | `server` queue test with a short stall: a write waits while the window is full, returns when acknowledged, and after the stall drops with a `gap` and waits again after the next acknowledgement.                                                                                                                                                                           |
| Input overruns the Engine, or blocks its reads             | `server` test: input beyond the window ends the stream with `bad_request`; output acknowledgements are processed while the executor does not read stdin.                                                                                                                                                                                                                    |
| The fallback never falls back                              | Unit test: the fallback rule is true for `k8s.io/streaming`'s `UpgradeFailureError`.                                                                                                                                                                                                                                                                                        |
| A Log Stream accepts input                                 | `server` test: a binary frame or `resize` on `resource.logs` ends it with `bad_request`.                                                                                                                                                                                                                                                                                    |
| A large paste is lost, reordered, or sent at once          | `streams` test with a fake socket: 1 MiB written at once leaves in frames of at most 32 KiB, never more than 256 KiB beyond the acknowledged total, and arrives whole and in order as acknowledgements come.                                                                                                                                                                |
| Bytes or acknowledgements are lost at the Worker boundary  | `worker-client` test: `write` and `resize` reach the Worker's stream, data reaches the listener as bytes, and the acknowledgement is sent only after the listener's promise resolves.                                                                                                                                                                                       |
| A lost socket starts a second shell                        | `streams` test: after `open`, a close without `end` gives `lost` and no new socket; before `open`, it retries.                                                                                                                                                                                                                                                              |
| A key reaches the wrong place                              | `keys.ts` table test for each row of "Keys" on each platform, and that `Mod+J` is never handled.                                                                                                                                                                                                                                                                            |
| A closed Tab leaves a session, or a moved Tab ends one     | Store tests: disposing ends the stream; a second attach does not start one. Playwright: a session moved to another Pane still answers.                                                                                                                                                                                                                                      |
| A reload starts a shell                                    | Playwright: after a reload the Tab shows "This session is over" and no session starts until its button is pressed.                                                                                                                                                                                                                                                          |
| The feature does not work end to end                       | Playwright against k3d, web Host: open a session in a sample Pod, run a command and read its output, see the close prompt and keep the session, `exit 3` and read the exit code, start again, see the no-shell notice on a Pod without one, and check Go to Resource and `Mod+J` from a focused terminal. Desktop Host: run a command, and interrupt `sleep` with `Ctrl+C`. |

Each new test is shown to fail against a broken implementation once, by a
targeted change that is then undone.

Checked by hand in Chromium and WebKit, in both themes, at 330, 520, and
1040 px: every state in "States", `vi` and `top` through a resize, a 1 MiB
paste, the stream limit, a read-only Engine, a user without `pods/exec`, the
Cluster stopped mid-session, and a Tab restored after a reload.

## Risks

- **A process can outlive its session.** A command in the foreground when the
  session's client goes away keeps running. The close prompt and the
  lost-connection message say so. Tracking the process and killing it through
  a second exec is possible and is not built.
- **Classifying a start failure reads text.** Another runtime may word a
  missing shell differently. The message is always shown, so the cost is a
  generic title.
- **A background browser tab throttles timers,** which slows xterm.js's
  parsing to a crawl. A noisy command in a hidden browser tab can then stall
  for 30 seconds and lose output, shown as a gap. The desktop Host throttles
  only a hidden window.
- **xterm.js 6.0.0's resize bug** (issue 6063). The terminal wrapper catches
  an error from `fit` and tries again on the next resize.
- **Firefox's handling of `Ctrl+Shift+C` and `Ctrl+Shift+K`** was read from
  its source, not tried. If a page cannot take them after all, `Ctrl+C` with
  a selection, `Ctrl+V`, and the context menu still work there.
- **Electron's menu accelerators** could take `Ctrl+C` before the terminal
  does. The desktop test covers it.

## Non-goals

- A dock or bottom area for sessions.
- Attaching to a container's main process, debug containers, file copying,
  and Port Forwards.
- A session that survives a reload, an Engine restart, or a lost connection.
- Recording or sharing a session, and a local terminal.
- Choosing the command, and Windows containers.
- Starting a session from a list row.

## Unresolved questions

1. Jim's confirmation of the four points under "Keys".

## What changed while building

### Engine and client

- **A hang-up discards output.** A process that cannot write its output
  never reads the end-of-transmission, so once a session's client is gone
  the Engine stops holding output back and throws it away. Input that
  arrives during a hang-up is dropped, not refused.
- **The output bound is tighter.** A write waits while 1 MiB is queued or in
  flight together, not 1 MiB queued on top of the window.
- **Input acknowledgements coalesce.** Only the latest total matters, so one
  that is still queued is replaced. A client that holds output back cannot
  fill the queue by typing.
- **An Engine that shuts down says so.** Its hang-up makes the shell exit
  with code 0, which is not why the session ended. The stream ends with the
  reason `EngineStopped`, and the Tab says "The Engine shut down, which ended
  the session. Its shell was told to exit."
- **Only the Cluster can say a Pod is gone.** The plan had the session check
  the index. The index is empty while the Engine lists Pods, at its start and
  whenever it lists them again, so a session started just after an Engine
  restart was told its running Pod was gone. When the index has no entry the
  session now reads the Pod from the Cluster. Using the app found this; no
  test had.
- **"Started after the session did" compares two clocks,** the Engine's and
  the node's. A skew larger than a container's age at the session's start
  can report exit code 137 as a stopped container, or the reverse. Reading
  the container's ID when the session starts would remove the clocks, at the
  cost of a request per session. Not done.

### UI

- **A session starts at its terminal's real size.** The store waits for the
  terminal's first fit, for up to a second, before it opens the stream, and
  later fits wait for 80 ms of quiet. The first build started every session
  at 80 by 24 and resized it, and busybox's shell prints its prompt again on
  a resize and drops what was typed until then.
- **The header always has a status badge,** in a slot of one width beside
  the Find button: "Starting…", "Live", "Terminating", "Ended", "Waiting",
  "Not started", or "Not running". The plan had a badge that came and went.
  Its coming and going rewrapped the header, which resized the terminal just
  as its shell started.
- **A shell can still print its prompt twice.** A Cluster applies a
  session's first size after the process has started, as a resize. A shell
  that has already printed its prompt prints it again. `kubectl exec` shows
  the same. The end-to-end tests type their first command again until its
  output shows.
- **A Pod that is gone before any output is a failure to start,** shown as
  the notice "The Pod is gone", with "Try again" while the window still sees
  the Pod. A missing container is "The session could not start", with the
  Cluster's message.
- **Copy is disabled in the context menu when nothing is selected.**
- **The close guards kept their file,** `features/edit/unsaved-edits.ts`,
  which now also guards sessions under the names `guardPanel` and
  `guardWorkspace`. The file's name no longer says what it holds.
- **Moving a Tab between Panes is not in the end-to-end test,** which has one
  Pane. It was checked by dragging a live session's Tab to another Pane in
  Chromium and WebKit: one stream, no new process, and the shell kept its
  variables. The store's tests cover a panel that mounts again.

### Experience-review corrections

A reviewer with no history of the work used the running app in Chromium and
WebKit. It found the terminal sound and these problems around it, which are
fixed:

- **A dead session looked live in the tab strip.** The muted style of an
  ended session's Tab was the style of any Tab that is not active. A live
  session's icon is now in the Cluster's color, an ended one's is dimmed and
  its title struck through, in an active Tab or not, and the Tab's tooltip
  says which.
- **Sessions in one Pod could not be told apart.** A session's Tab is now
  titled `<container> in <pod>`. This was a planned follow-up.
- **A disabled Start again looked enabled.** It now dims and shows the
  not-allowed cursor, as the header's buttons do.
- **The keyboard was stuck in an ended terminal.** Focus moves to Start
  again when a focused session ends, and an ended terminal gives its keys
  back to the window, so `Tab` moves focus. This is one more argument to the
  key function, and a case in its test.
- **A new Tab could open out of sight** in a full tab strip. A Tab scrolls
  into view when it becomes the active one. This applies to every Tab.
- **Find went the wrong way.** It now starts at the newest match, `Enter`
  finds the previous one and `Shift+Enter` the next, as in VS Code's
  terminal, iTerm, and the Logs Facet. Asking for find again returns to its
  field, an empty query reports nothing, the query is kept between openings,
  and the current match is the strong one.
- **A second window called a live session over.** A Tab restored from the
  layout cannot know whether its session ended or runs in another window. It
  now says "No session is running here: An Exec Session belongs to the window
  that started it, and does not survive a reload."
- **The keys could not be learned.** The context menu shows each key, has a
  Go to Resource item, and the Find button's tooltip names its key.
- **The Namespace was the first thing to truncate** in a narrow Pane. It is
  now a part of its own, and wraps to its own line before it truncates.
- **Starting again printed three prompts.** The session now sizes its
  terminal to the changed layout before it opens the stream.
- **Smaller:** the Cluster's message under the no-shell notice is a
  left-aligned block, white text keeps a readable contrast in the light
  theme (`minimumContrastRatio`), the terminal's text lines up with the
  header's, and a dialog about one session says "session".

Not changed, and listed under "Follow-ups": a second way in from a list row,
a label on the header's button, and a warning before a multi-line paste.

### Code-review corrections

Two reviewers, one Codex and one Claude, read the change independently.
Neither found a blocker. What changed because of them:

- **The desktop Host's close prompt named only edits,** and quitting stopped
  the Engine before any window could ask. The prompt now names both edits and
  Exec Sessions, and the Engine stops in `will-quit`, once every window has
  agreed to close. The second fault predates this work: cancelling a quit
  with unsaved edits left a window without an Engine.
- **Input waiting in the Worker had no upper bound.** A container that never
  reads could take the window's memory one paste at a time. A stream now
  holds at most 8 MiB of unsent input, refuses a write beyond that, and the
  terminal prints that the input was not sent.
- **The stall rule could be held off by a trickle.** Any acknowledgement
  restarted the 30 seconds, whether or not it made room. The rule is now a
  floor: while writes have to wait, the client must take 4 MiB in each 30
  seconds, or the Engine drops output until the next acknowledgement.
- **A session ended by an Engine shutdown could be told its socket was
  lost,** because the Engine could exit before the `end` was written.
  `Server.Shutdown` now waits for each session's socket to send it.
- **A link printed by a container could be opened.** xterm.js turns an OSC 8
  sequence into a link that opens after a native confirm, without the
  web-links add-on. The terminal's link handler now does nothing.
- **`Ctrl+K` did nothing in an ended session's terminal** on Windows and
  Linux. An ended terminal now goes back to the window's rule for Go to
  Resource.
- **Tests:** the end-to-end test now checks that a paste arrived whole, that
  a printed link opens nothing, and that the shell does not receive `Mod+J`.
  The empty-index test waits for the session to ask the Cluster before it
  lets the process exit.

Using the corrected build past midnight found a test from the Log Streams
layer that passed only on 2026-10-13, the date in its fixture. Its clock is
now set.

## Measurements

On an Apple silicon laptop against the k3d cluster:

- A 1 MiB paste into a shell arrives whole in about 100 ms in Chromium and
  WebKit, in frames of at most 32 KiB.
- 20 MB of output through the Engine to a client that acknowledges at once
  takes 0.6 seconds, with no gap.
- A session whose Cluster connection is cut ends in 2.3 seconds, which is
  the wait for the Pod's status.

## Follow-ups

- Jim's confirmation of the Windows and Linux keys.
- Killing what a closed session left running, by tracking its process.
- Choosing the command, and `powershell` for Windows containers.
- Links in a session's output, once the app has a rule for external links.
- A "Tab moves focus" switch, so the keyboard can leave a live terminal
  without Go to Resource.
- Starting a session from a list row.
- A text label for the header's button, which is an icon among icons.
- A warning before a paste of several lines into a shell that does not ask
  for bracketed paste, as VS Code gives.
- Tabs of sessions that ended with a reload stay until they are closed.
- A name for `features/edit/unsaved-edits.ts` that covers sessions.
- A live check of the Windows and Linux keys in Firefox.
