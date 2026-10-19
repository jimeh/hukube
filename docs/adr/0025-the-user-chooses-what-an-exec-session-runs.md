# The user can choose what an Exec Session runs, and remember it per image

An Exec Session runs a shell by default (ADR-0022). A container without a
shell, such as a distroless image with only its own binary, then has no way
in, and a container with one may need `ash`, `bash -l`, or a REPL instead.
So the user can choose the command.

## What the user types runs without a shell

The command is a line split into words as a POSIX shell splits them, by
`shell-quote`: quotes and backslashes work. The words run directly. A line
with an operator, glob, variable, or comment flagged by `shell-quote` is refused,
with guidance to quote literal text or use `sh -c '…'`. Backticks, `~`, and
bracket patterns such as `[ab]` are not flagged and pass as literal text;
hukube adds no detection of its own. An unterminated quote is accepted as
closed. The field labels its preview "Runs:" and shows each word as a chip,
including an empty argument, so these parser rules are visible before running.

A shell is not added around the line, because the containers that most need
a chosen command have none.

## It is chosen where a session starts, and where one failed to

The Pod header's Exec button gains a menu with "Run a command…", which opens
a dialog. The notice for a container without a shell offers the same field,
and runs the command in the same Tab.

## It is remembered per image, when the user asks

What a container can run is what its image contains. A command the user
chooses to remember belongs to the image's repository, without its tag or
digest, and applies wherever that image runs, in any Cluster. It is stored in
the Engine's settings (ADR-0009), with the 10 most recent commands.

A remembered command runs when the user starts a session from the button.
The menu, the button's tooltip, and the Tab's title name it, so it never
runs unannounced.

## The Engine tells a missing command from a missing shell

A start that fails because the program is missing is `NoShell` for the
default command and `CommandNotFound` for a chosen one. The Engine refuses a
command with an empty first word, more than 256 words, or more than 16 KiB.

## Considered Options

- **Run the line through `sh -c`.** Pipelines would work without asking, and
  a container without `sh` could not run anything.
- **Run it through `sh -c` only when it needs a shell.** What runs would
  depend on characters the user may not notice, and a missing `sh` would
  fail far from the cause.
- **One field per argument,** as kubecove offers. Exact, and slow to type for
  `python3 -c "…"`.
- **Remember per container name or per workload.** A container name says
  nothing about what is installed, and a workload's key changes with its
  Pods, so a workload key needs its owners walked. No comparable tool
  remembers either.
- **Remember every command run, without asking.** One `python3` would turn
  every later session in that image into a REPL.
- **Named profiles,** as VS Code has. More to manage than a short list of
  recent commands, for a choice made per image.

## Consequences

- Two tags of one image share a remembered command. A wrong one fails with
  the not-found notice, which identifies the remembered line and offers to
  correct it or forget it and use the default shell. Missing commands are
  removed from recents.
- A command that prints nothing shows "Starting…" until it does, because the
  Engine cannot tell when a process has started.
- The remembered commands are shared by every window and both Hosts, and,
  as for every setting, two windows that write at once keep the later write.
