# A focused Exec Session takes every key, except a short list

A terminal needs nearly every key, and the app has shortcuts of its own.
While a live Exec Session's terminal has focus, each key goes to the process
in the container, except these:

| Key                | macOS       | Windows and Linux                                                                                                       |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Go to Resource     | `Cmd+K`     | `Ctrl+Shift+K`. `Ctrl+K` goes to the process.                                                                           |
| Copy               | `Cmd+C`     | `Ctrl+C` when text is selected, which also clears the selection; otherwise it goes to the process. Also `Ctrl+Shift+C`. |
| Paste              | `Cmd+V`     | `Ctrl+V` and `Ctrl+Shift+V`                                                                                             |
| Find in scrollback | `Cmd+F`     | `Ctrl+Shift+F`. `Ctrl+F` goes to the process.                                                                           |
| Select all         | `Cmd+A`     | none                                                                                                                    |
| `Mod+J`            | not handled | not handled, so the process does not receive `Ctrl+J`                                                                   |

Status: the macOS column is settled. The Windows and Linux column was built
on the coordinator's approval and awaits Jim's confirmation. The four points
to confirm are in `docs/plans/exec-sessions.md`, under "Keys".

On macOS there is no conflict. The app's shortcuts use `Cmd`, which no
process in a terminal receives, and every `Ctrl` key goes to the process.

On Windows and Linux the app's shortcuts and a shell's both use `Ctrl`. The
rule is the one terminals on those platforms use: the application's version of
`Ctrl+<key>` is `Ctrl+Shift+<key>`. GNOME Terminal, Konsole, and Windows
Terminal copy, paste, and find that way. Two exceptions follow what users of
a web page expect: `Ctrl+V` pastes, and `Ctrl+C` copies when text is
selected, as it does in VS Code on Windows, Windows Terminal, Headlamp, and
JupyterLab.

`Mod+J` is reserved and nothing may handle it. In a terminal on Windows and
Linux that means withholding `Ctrl+J` from the process, which costs a
duplicate of Enter.

The decision is one pure function, `execKey` in
`apps/app/src/features/exec/keys.ts`, from the platform, the key, and whether
text is selected, to what happens. The terminal and Go to Resource both ask
it, and its test has a case for each cell of the table.

## Considered Options

- **The app keeps `Ctrl+K` everywhere,** as VS Code does by default. Go to
  Resource would open by one key in every context. A shell would never get
  kill-to-end-of-line, nor `nano` its cut-line, which VS Code's users report
  as a defect of its terminal.
- **`Ctrl+F` finds on Windows and Linux,** as in the editors and in VS Code's
  terminal. `vi` and `less` would lose page-forward.
- **`Ctrl+V` goes to the process on Linux,** as in desktop terminals and VS
  Code there. A page that ignores `Ctrl+V` reads as broken, and `vi` has
  `Ctrl+Q` for the same command.
- **Copy on select,** as ttyd and Wetty do. It replaces the clipboard without
  being asked.
- **A setting for which keys skip the terminal,** as VS Code has. One rule
  is easier to learn, and to change.

## Consequences

- `Ctrl+Shift+K` is a binding that exists only while a session has focus on
  Windows and Linux.
- `Tab` goes to the process, so the keyboard leaves a live terminal through
  Go to Resource. A switch that makes `Tab` move focus, as VS Code has, would
  need a binding of its own.
- A browser can keep a key for itself. Chromium reserves only tab and window
  keys. Firefox's source shows a page can take `Ctrl+Shift+C` and
  `Ctrl+Shift+K` from its developer tools unless the user has blocked
  shortcut overriding for the site; this was not tried in a running Firefox.
- Copy, Paste, Select all, Find, and Clear are also in the terminal's context
  menu, so no key is the only way to any of them.
