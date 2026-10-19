# Plan: choosing what an Exec Session runs

An addition to Exec Sessions (`docs/plans/exec-sessions.md`), asked for by
Jim after his review of that layer.

## Outcome

A user can choose the command an Exec Session runs, where they start it. A
container without a shell, such as a distroless image with only its own
binary, can still be reached, and a container with a shell can run `ash`,
`bash -l`, or a REPL instead. When the default shell is missing, the notice
that says so offers to run something else in the same Tab. A command chosen
for an image can be remembered, so the next session in that image runs it
without asking.

## Current state

Verified in the code at `3f742b0`:

- `protocol.ExecParams.Command` exists ("Command replaces the default
  shell"), and `cluster.Exec` passes it to the Cluster. With none it runs
  `sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`.
- Nothing in the UI sets it. `ExecSessionParams` in
  `features/exec/sessions.ts` omits `command`, and `startSession` never
  sends one.
- `execsession.startFailure` reports `NoShell` for any "executable file not
  found" or "no such file or directory", whatever ran. With a chosen command
  that would claim the container has no shell when only that command is
  missing.
- The Engine checks that `ExecParams` names a Cluster, Pod, UID, container,
  and size, and does not look at `Command`.

## Evidence

### What other tools do

From their source or documentation at the versions named:

| Tool                     | Choose a command                                             | Text to argv                      | Remembered                               | No shell                                    |
| ------------------------ | ------------------------------------------------------------ | --------------------------------- | ---------------------------------------- | ------------------------------------------- |
| Freelens 1.10.3          | No: `sh -c "clear; (bash \|\| ash \|\| sh)"`                 | n/a                               | No                                       | kubectl's error                             |
| Headlamp 0.46.0          | No: tries `bash`, `/bin/bash`, `sh`, `/bin/sh`               | n/a                               | No                                       | "Failed to run" per attempt, then reconnect |
| k9s 0.51.0               | Not for `s`; a plugin can ask for input                      | YAML `args` array                 | Plugins, globally or per context         | "Shell exec failed"                         |
| Dashboard 7.14.0         | No: tries `bash`, `sh`, `powershell`, `cmd`                  | n/a                               | No                                       | Closes with the error                       |
| VS Code 1.142 profiles   | A dropdown beside the new-terminal "+"                       | `args` is an array; never split   | A default profile per platform           | n/a                                         |
| VS Code Kubernetes 1.4.1 | From the command palette, an input box prefilled with `bash` | One argument, or the local shell  | No                                       | kubectl's error                             |
| Portainer 2.45.2         | A "Command" field above Connect (Kubernetes console)         | Spaces, single quotes; no escapes | No; Docker presets from container labels | The error in the terminal                   |
| JetBrains 2026.2         | One "Pod shell" field in settings                            | Not documented                    | An IDE setting                           | Not documented                              |
| OpenShift 4.23           | No: `sh -i -c 'TERM=xterm sh'`                               | n/a                               | No                                       | Says to run `oc exec … <command>` instead   |

What follows for hukube:

- Few tools offer a choice at all, and those that do put it where a session
  starts: a dropdown beside the button (VS Code), or a field beside Connect
  (Portainer). No tool offers it from the no-shell failure, which is where
  OpenShift tells the user to go elsewhere.
- None remembers a command per container, workload, or image. Portainer's
  presets from container labels are the nearest thing, and they belong to
  the image. Remembering per image is therefore new, so it is a choice the
  user makes, and what will run is always shown.
- Splitting is either an array (VS Code, k9s) or a small split of a typed
  line (Portainer). A typed line with shell quoting is the familiar form for
  a field, and showing the words it makes covers the parser's lenience.

### What the test cluster says

Run against the e2e k3d cluster's `no-shell` sample (`rancher/mirrored-pause:3.6`):

- `/pause -v` prints `pause.c v3.6-` and exits with code 0. It is the one
  binary in the image, so it is the end-to-end test's custom command.
- A missing program fails with
  `exec: "python": executable file not found in $PATH`, and a missing path
  with `exec: "/nope/x": stat /nope/x: no such file or directory`. The
  program's name is in the message in both, which the notice can quote.

### Splitting a command line

`shell-quote` 1.12.0 (ljharb, published 2026-10-02, types included) splits a
line into words as a POSIX shell does and returns what it cannot turn into a
word as an object: an operator (`|`, `&&`, `;`, `>`), a glob, a variable
(through a callback, so nothing is expanded), or a comment. Probed:

| Typed                      | Result                           |
| -------------------------- | -------------------------------- |
| `bash -l`                  | `bash`, `-l`                     |
| `sh -c 'ps aux \| grep x'` | `sh`, `-c`, `ps aux \| grep x`   |
| `python3 -c "print(1+1)"`  | `python3`, `-c`, `print(1+1)`    |
| `a\ b "c d" 'e'`           | `a b`, `c d`, `e`                |
| `a \| b`                   | `a`, operator `\|`, `b`          |
| `echo $HOME`               | `echo`, variable `HOME`          |
| `ls *.log`                 | `ls`, glob `*.log`               |
| `x # note`                 | `x`, comment                     |
| `echo 'open`               | `echo`, `open` (no error)        |
| `curl http://x/#a`         | `curl`, `http://x/`, comment `a` |

Its `quote` does not always turn words back into a line that splits the
same way: `quote(["ls", "*.log"])` is `ls \*.log`, which `parse` reads as a
glob. So hukube keeps the line the user typed and splits it when a session
starts, and never rebuilds a line from words.

It is lenient in two ways that matter here: an unterminated quote is taken as
closed, and a `#` inside a word starts a comment. The field therefore shows
the words it will run as the user types, so what runs is never a guess.
`shlex` 3.0.0 reports an unterminated quote but returns operators as plain
words, so a quoted `'|'` and a bare `|` could not be told apart. A full shell
parser such as `sh-syntax` is far more than a field needs.

## Decisions

### The field takes a command and its arguments, not a shell line

A container without a shell is the main reason to choose a command, so what
the user types runs directly, with no shell. The line is split into words by
`shell-quote`: spaces separate words, and single quotes, double quotes, and
backslashes work as in a shell.

Operators, globs, variables, and comments flagged by `shell-quote` are refused.
Variables recorded by the env callback are reported before parsed tokens, so
`ls $DIR/*.log` identifies `$DIR`, without exposing the parser's internal token.
The messages render tokens and the shell example as code:

- Operator: "The `|` operator needs a shell. To use one, write `sh -c '…'`."
- Glob: "The pattern `*.log` needs a shell to expand. Quote it to pass it as text,
  or write `sh -c '…'`." This includes backslash-escaped `\*.log`.
- Variable: "The variable `$HOME` needs a shell to expand. Quote it with single
  quotes to pass it as text, or write `sh -c '…'`."
- Comment: "`#` starts a comment here. Quote it, or put a backslash before it,
  to pass it as text." This also applies inside a word.

Backticks, `~`, and bracket patterns such as `[ab]` are not flagged by
`shell-quote` and pass as literal text. No additional detection is added.
An unterminated quote is accepted as closed. The preview is labelled "Runs:"
and shows each word as a bordered code chip, including an empty argument.
An empty field means the default shell. The placeholder says so. A line is
at most 4,096 characters and 256 words; its first word cannot be only whitespace.

### The Engine checks a command and says when it is missing

- `ExecParams.Command`, when given, must have a non-empty first word, at
  most 256 words, and at most 16 KiB in all. Otherwise the stream ends with
  `bad_request`. A Cluster limits a request's URL, which carries the
  command, so this keeps the failure readable.
- A start that fails because the program is missing reports `NoShell` only
  for the default command. For a chosen command it reports a new reason,
  `CommandNotFound`, with the Cluster's message.
- Nothing else changes. A chosen command is still a mutation, checked as a
  session is, and is still hung up with end-of-transmission (ADR-0022). A
  REPL exits on it; a program that does not read stdin is dropped a second
  later, as a shell's foreground command is.

### Where a command is chosen: on the Pod's Exec button

The Pod header's button becomes a split button, as VS Code's new-terminal
button is: the button starts a session at once, and a chevron beside it
opens a menu.

- **The button** starts a session in the default container with the command
  remembered for its image, or the default shell. For a Pod with several
  containers this is a change: today the whole button opens the container
  menu. The default container first is what Freelens and k9s do, and the
  menu is one click away.
- **The menu** has the containers under "Exec Session in", as today, each
  showing a muted "runs `<line>`" when a command is remembered, and below them
  "Run a command…".
- **"Run a command…"** opens a dialog, "Run a command in `<pod>`", with:
  - a container select, when the Pod has more than one;
  - the command field, focused, with the placeholder `Default shell: bash,
or sh`;
  - the words it will run, under the field, as the user types, or the reason
    it cannot run;
  - the recent commands, up to 10, as buttons that fill the field;
  - the remembered line for the selected image, prefilled with remembering
    checked. Changing the container changes the prefill until the field is edited;
  - "Use this command for `<image>` from now on", otherwise unchecked;
  - Run and Cancel. `Enter` runs, `Escape` cancels.

The tooltip and accessible name of the button name a remembered command:
"Open an Exec Session, running `<line>`". Run uses the Cluster's primary
button color, including in the dialog's portal.

### When the shell is missing, the notice offers a command

The "No shell in this container" notice says that hukube's default shell needs
`sh`, which this container lacks, and offers a program the image contains or a
debug container such as `kubectl debug`. It shows the Cluster's message and the
same field, words, recent buttons, and Run button as the dialog. Remembering a
nonempty command defaults to checked: the default cannot work for that image. Run starts the session again in the same Tab with that command. The
Tab's title and header change to show it.

A chosen command that is missing gets its own notice, "`python3` is not in
this container", with the Cluster's message and the field holding the
command, ready to correct, and the same recent buttons. It checks remembering
only when the failing line is the image's remembered command. In that case it
says "You chose `<line>` for `<image>`." and offers "Use the default shell", which
forgets that image's command and starts the default shell in the same Tab.
A missing chosen command is removed from recents even if its panel is unmounted.

In every form an empty field has no checkbox if no command is remembered.
Otherwise it shows "Forget the command chosen for `<image>`", unchecked.
Crossing between empty and nonempty resets the checkbox to that state's default,
so a checked box never changes meaning. Notices scroll when too tall for their
Pane and stay centred when they fit.

### A command is remembered per image, by choice

What a container can run is what its image contains, so a remembered command
belongs to the image: the repository without its tag or digest, such as
`gcr.io/distroless/static` or `registry:5000/app`. It then applies to every
Pod and workload that uses the image, in any Cluster, and survives rollouts
and new Pod names, which a key by Pod or container name would not.

- It is remembered only when the user asks, with the checkbox. Running the
  default shell with the box checked forgets it.
- Recent commands are remembered without asking, newest first, at most 10,
  across all images.
- Both live in one setting, `exec/commands`, in the Engine's store
  (ADR-0009), so every window and both Hosts share them:
  `{ "images": [{ "image": "…", "command": "…" }], "recent": ["…"] }`,
  where each command is the line as the user typed it,
  at most 100 images, the least recently used dropped first.
- Image names come from the Cluster. They are compared as strings in a list,
  never used as keys of a plain object.
- A window writes the setting one write at a time, each from the last value
  it saw or wrote. Two windows that write at once keep the later write, as
  for every setting.

### The Tab shows a chosen command

- The title is `<program>: <container> in <pod>` for a chosen command,
  where the program is the last part of its first word: `python3: app in
web-7d9f`. The program comes first because a narrow Tab truncates its
  end. A default session keeps `<container> in <pod>`.
- The header gains a "Command" part after the container, in the same style,
  with the line as the user typed it. A default session shows none.
- The line is part of the Tab's params, as `commandLine`, so Start again,
  Try again, and a Tab restored after a reload run the same command. It is
  split into words when the session starts. A line that no longer splits,
  such as one edited in the settings file, fails to start with the reason.
- The header must not change height while a session is live (`AGENTS.md`,
  "Sessions outlive their panel"). The command is set before a session
  starts, and a notice that runs a new command changes the header before it
  starts the session again, so the terminal is sized to the new header.

### No key bindings

Everything is reached from the Pod header with `Tab` and `Enter`, and from
the menu with the arrow keys. Nothing is added.

## UI and UX

### Where each control goes

| Control            | Place                                     | Why                                                      |
| ------------------ | ----------------------------------------- | -------------------------------------------------------- |
| Start a session    | The Exec button in the Pod header         | Unchanged: a session starts where its Pod is shown       |
| Choose a container | The chevron's menu                        | Unchanged list, one click further for multi-container    |
| Run a command      | The chevron's menu, then a dialog         | VS Code's terminal profiles: a dropdown beside the "+"   |
| Run something else | The no-shell and not-found notices        | The failure is where the user sees that a command is due |
| What will run      | The menu item, the tooltip, the Tab title | A remembered command must never run unannounced          |

### Keyboard and pointer

- `Tab` reaches the button, then the chevron. `Enter` or `Space` on the
  chevron opens the menu; the arrow keys move in it.
- In the dialog the field has focus. `Tab` moves to the recent commands, the
  checkbox, and the buttons. `Enter` in the field runs; `Escape` closes.
- In a notice the field takes focus only while its panel is showing and selected,
  so a failure in another Pane cannot steal typing. Selecting that panel focuses
  its command field, as it does for a live terminal.

### States

| State                          | What the user sees                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Field empty                    | Placeholder "Default shell: bash, or sh"; Run starts the default                     |
| Field valid                    | The words it will run, under the field                                               |
| Field refused                  | The reason in the field's error style; Run disabled                                  |
| No recent commands             | No recent section                                                                    |
| Settings not yet read          | No recent section, and no remembered command in the menu, until they arrive          |
| Settings cannot be written     | The session runs; the command is not remembered, and a warning goes to the console   |
| Starting                       | The Tab opens with "Starting…", as today                                             |
| Default shell missing          | "No shell in this container", the Cluster's message, and the field with Run          |
| Chosen command missing         | "`python3` is not in this container", the message, and the field holding the command |
| A command that prints nothing  | "Starting…" until it does, because the Engine cannot tell when a process started     |
| Not permitted, read-only, gone | As today; the menu's "Run a command…" is disabled with the same reason as the button |

## Steps

One part, in this order:

1. Protocol and Engine: `ExecReasonCommandNotFound`, the check of
   `Command`, the classification by whether a command was chosen, and
   `mise run gen`.
2. A module `features/exec/command.ts`: splitting a line into words or a
   refusal, an image's key, and the program's
   name for a title.
3. A store `features/exec/commands-store.ts` for `exec/commands`: read by
   watch, remembered and recent commands, serialized writes.
4. `ExecSessionParams.commandLine`, split and sent by `startSession`; the Tab title from
   it; the header part.
5. The split button, its menu item, and the dialog.
6. The notices' field.
7. `AGENTS.md` and this plan's "What changed while building". ADR-0025 and
   the amendment to ADR-0022 are written with this plan.

## Testing strategy

| Concern                                  | Evidence                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Splitting and typed-line reuse           | Unit tests of `command.ts`: each row of the probe table, each refusal, empty, the limit  |
| Image key                                | Unit tests: tag, digest, both, a registry port, no tag                                   |
| Remembering                              | Unit tests of the store: remember, replace, forget, the 100 and 10 bounds, order, writes |
| Engine check                             | Go test: each bad `Command` ends with `bad_request`; a good one reaches the executor     |
| Engine classification                    | Go test: a missing program is `NoShell` without a command, `CommandNotFound` with one    |
| The command reaches the stream           | Unit test of `startSession`: params carry `command` to `pod.exec`                        |
| Button, menu, dialog                     | Component tests: the menu item shows a remembered command, the dialog runs and refuses   |
| Notices                                  | Component tests: the no-shell form runs in the same Tab; the not-found copy              |
| The whole path, against a real container | End-to-end: the no-shell container runs `/pause -v`, remembered, run again from the Pod  |
| A pipeline through `sh -c` and a refusal | End-to-end in the busybox container                                                      |
| Placement, copy, both themes, widths     | Experience review of the running app, then by hand in Chromium and WebKit                |

New tests are shown to fail first, or with a targeted perturbation when the
code is already there.

## Risks

- **A remembered command runs without a prompt.** The menu, the tooltip,
  and the title name it, and only an explicit choice remembers one.
- **The image key is coarse.** Two tags of one image with different
  contents share a remembered command. A wrong one fails with the
  not-found notice, which offers the fix.
- **Layer 8 moved session ownership into `execsession.Registry`.** This
  change touches `ExecParams`, `startFailure`, the stream's check in
  `server/exec.go`, `startSession`, and the Tab's params. The report to the
  coordinator lists what the merge must keep.

## Non-goals

- Environment variables, a working directory, or a user for the command.
- Named profiles, or a list of commands per Cluster.
- Choosing `powershell` for Windows containers by the Pod's OS.
- Detecting when a silent command has started.

## Unresolved questions

None.

## What changed while building

- **The typed line is kept, not rebuilt from words.** A unit test showed
  that `shell-quote`'s `quote` does not round-trip: `quote(["ls", "*.log"])`
  is `ls \*.log`, which its `parse` reads as a glob, so a recent command put
  back in the field would be refused. The Tab's params, the remembered
  commands, and the recent commands therefore hold the line as typed, which
  is split again when a session starts, and the header shows that line.
  `quote` is not used.
- A fresh settings watch is opened after serialized writes settle, following
  the column-layout store's pattern. Watch values have no revision, so an old
  echo must not replace a newer local value. This keeps queued edits based on
  the last value seen or written.
- The command dialog suppresses the container menu's focus restoration when
  it opens; otherwise the closing menu can steal focus from the command field.
- A same-Tab command restart commits its params, title, and header with
  `flushSync` before starting the session. The existing terminal reset/refit
  path then sizes it before opening the stream.
- If the default container is stopped but another container is running, the
  main button is disabled with that reason. The menu still lets the user
  choose a running container.
- Explicit Start again, Try again, and restored-Tab starts also record command
  reuse, so recent commands and image recency include those entry points.
- Runs made before the settings watch answers are queued as intents and applied
  to its first value, preserving existing remembered and recent commands. A
  read error discards those intents and suppresses persistence until a
  successful read; it never blocks the session from running.
- Refusals carry a kind and token for rendering code elements, with plain text
  for session errors. The no-shell notice names the custom-program option, and
  empty command fields now offer explicit forgetting only when a command exists.
- Review corrections made checkbox defaults explicit for each entry point and
  reset them when empty/nonempty changes the action. The dialog prefills an image's
  remembered line until edited, and both notices offer recent commands. If the
  setting arrives after typing starts, it neither replaces the typed line nor
  checks remembering: the field was never prefilled from that value.
- `CommandNotFound` removes the line from recents in the session store, independent
  of panel lifetime. The remembered image choice stays available for correction;
  "Use the default shell" explicitly forgets it and restarts the same Tab.
- The parser contract follows only tokens flagged by `shell-quote`. Backticks,
  tilde, bracket patterns, and unterminated quotes follow the literal/lenient rules
  above. Variable callbacks take precedence over globs, and the UI enforces the
  Engine's 256-word and whitespace-only first-word limits.
- The words preview now uses labelled chips. The dialog names the Pod and carries
  the Cluster's color into its portal so Run retains the primary style.
- Failed-session content scrolls in short Panes. Notice focus follows the panel's
  visibility and selection, without focusing its detached terminal.
- The existing shared dialog focus defect was reproduced in Chromium in both the
  command dialog and the unsaved-edits dialog. Base UI's `FloatingFocusManager`
  hands focus from an invisible guard to the first/last control on the next
  animation frame (`enqueueFocus`), so Tab before that frame can reach `body`.
  `useModalInert` blocks the application root, but not the portal's guards or
  `body`. The Container select is tabbable and receives the normal completed
  wrap. Shared dialog components were left unchanged as requested; fixing this
  focus handoff is a separate follow-up.
- Verification must run sequentially: rebuilding with `dev:verify` during an
  end-to-end run briefly removed their shared `apps/app/dist` and caused an
  unrelated page navigation to return 404. This workflow hazard is recorded in
  `AGENTS.md`; the suite was rerun without overlapping builds.
- **In the dialog, remembering is checked only while the field holds the
  remembered command.** A follow-up review found that typing a one-off
  command over the prefilled one kept the box checked, so the one-off
  replaced the remembered command. The box now returns to unchecked when the
  line differs from the remembered one.

Not changed, and accepted after the follow-up reviews: `$(…)` and a lone `$`
are refused as "the variable `$`"; Run in the no-shell notice is enabled
with an empty field, which runs the default shell again; a recent command
removed after a not-found start is computed from the window's last value of
the setting, which can be stale if no component in the window watches it;
and Tab in a dialog can reach `<body>` for one frame, in every dialog.
