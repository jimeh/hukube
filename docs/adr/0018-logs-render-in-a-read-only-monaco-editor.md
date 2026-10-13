# Logs render in a read-only Monaco editor

A Log Stream's lines are shown in a read-only Monaco editor whose text is the
lines themselves, the way VS Code's Output panel shows a channel. Monaco is
already a dependency, loaded on demand for the YAML Facet. xterm.js is left
for Exec Sessions, which need a terminal.

Three approaches were built and measured in Chromium and WebKit with 50,000
and 100,000 lines of about 150 characters
(`docs/plans/log-streams.md`, Viewer):

|                                      | Virtual list and an ANSI parser | xterm.js 6.0                | Monaco 0.57  |
| ------------------------------------ | ------------------------------- | --------------------------- | ------------ |
| Memory at 50,000 lines               | 12 MB                           | 183 to 313 MB               | 29 to 43 MB  |
| Longest task at 5,000 lines a second | 3.6 to 4.7 ms                   | 1.6 to 2.3 ms               | 4.4 to 11 ms |
| Select all and copy, 100,000 lines   | 54 lines                        | all                         | all          |
| Line wrapping off                    | yes                             | not possible                | yes          |
| Turn timestamps on, 50,000 lines     | 2 ms                            | 447 ms, rewrites the buffer | 228 ms       |
| Search with a count                  | to build                        | addon, no interface         | built in     |

- **xterm.js** cannot show a line unwrapped, bounds its buffer in rows
  instead of lines, and stores 12 bytes for every cell of every row. It also
  acts on escape sequences: one unfiltered log line erased the scrollback,
  switched screens, and set the window title.
- **A virtual list** is the lightest, but text can only be selected in the
  rows that are rendered. Selecting and copying across lines is the first
  thing a log viewer is used for after reading, and the alternative is a
  selection model written by hand.
- **Monaco** met every requirement through its public API: selection and
  copy of everything retained, search with a count, wrapping on and off, and
  bounded memory.

## What Monaco does not do for a log

Each of these was observed, and the viewer handles it:

- It does not keep the view still when lines above it are removed. The
  viewer measures the removed height and scrolls back by it.
- A lone carriage return in inserted text starts a new line, so carriage
  returns are resolved before the text reaches the editor.
- A color is a decoration of about 320 bytes. Decorations are removed with
  the lines they belong to, and are one of the three budgets that bound what
  the viewer keeps.
- The find, clipboard, and icon-font features are separate imports from the
  editor API the app uses.

## Log content is filtered before it is shown

No ANSI parser that was tested removes every escape sequence that is not a
color, so the lines pass a filter of hukube's own first. It keeps color and
style sequences, removes every other sequence, and replaces the remaining
control characters with visible symbols. Colors are then parsed by `anser`
and shown as decorations. The text reaches the editor as text and nothing in
it is interpreted as markup. The filter and the parse run in the Worker.

## Considered Options

- **xterm.js for both logs and Exec Sessions,** as Headlamp does. One text
  renderer fewer, and color is native. Its three failures above are of
  requirements, not of polish. If a Log Stream always wrapped and always
  showed timestamps, this would be the simpler choice.
- **A virtual list with "copy all" in place of free selection.** About a
  third of Monaco's memory and half its work on the main thread.
- **`@melloware/react-logviewer`,** the maintained fork of react-lazylog. It
  took 63.8 seconds and 765 MB to append 100,000 lines, and has no line cap.
- **`@patternfly/react-log-viewer`.** It takes the whole log as one prop and
  brings PatternFly's design system with it.
- **A search bar of hukube's own** on Monaco's `findMatches`. Monaco's find
  widget already has the count, next and previous, case, whole word, and
  regular expressions, and behaves as VS Code users expect. Its count is
  hidden in a Pane narrower than about 380 px and stops at 19,999.

## Consequences

- The viewer keeps the newest lines within three budgets: 50,000 lines,
  32 million characters, and 200,000 decorations.
- Timestamps and origins are part of the text, so copying and searching
  include them, and they wrap with the line in a narrow Pane.
- A screen reader meets an editor, not a log: Monaco exposes a text box and
  reads the text around the caret.
- The app has two text renderers once Exec Sessions arrive: Monaco for YAML
  and logs, xterm.js for terminals.
