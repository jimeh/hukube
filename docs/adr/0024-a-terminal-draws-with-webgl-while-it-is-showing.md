# A terminal draws with WebGL in Chromium, while it is showing

An Exec Session's terminal is xterm.js. It has two renderers: one that draws
with DOM elements, and an add-on that draws on a WebGL canvas, which is
faster for a screen that changes a lot.

hukube uses the WebGL renderer in Chromium, which is the desktop Host and
Chrome. Every other browser keeps the DOM renderer.

- **Safari and other WebKit** keep it because the add-on has rendering bugs
  open against them.
- **Firefox** keeps it because it was not tried.

## The DOM renderer is always underneath

A terminal starts with the DOM renderer and then takes a WebGL context. It
keeps the DOM renderer when the add-on cannot start, and then no terminal in
the window tries again.

When the browser takes a context back, the terminal returns to the DOM
renderer at once, with its buffer as it was, and stays on it until it is
next shown. The add-on would wait 3 seconds for the context to return, with
nothing drawn and keys still reaching the process. The terminal does not
wait for that.

## Only a terminal that is showing holds a context

A document can hold about 16 WebGL contexts, and the browser takes the
oldest when one more is made. A window can hold more session Tabs than that,
because an ended session keeps its terminal and a hidden Tab keeps its own.

So a terminal holds a context only while it is showing, and at most 8 do. A
hidden terminal gives its context up, and takes one again when it is shown.
The number showing is bounded by the Panes a window has, not by its Tabs.

## Considered Options

- **The DOM renderer everywhere,** the first choice. It needs no fallback
  and no rule for contexts, and a test can read it. It is slower on a busy
  screen.
- **WebGL in every browser, relying on the fallback,** as Jim's Hubris does
  with one terminal per tab. The bugs open against WebKit draw wrongly
  without losing the context, so nothing would fall back.
- **Every terminal keeps its context.** A window with 17 session Tabs would
  take one from a terminal that is showing.
- **Release a context when a session ends.** An ended session that is
  showing would change renderer, and with it the size of its grid, under
  the user's eyes.

## Consequences

- The two renderers measure a cell differently, so a change of renderer can
  change the grid's size, which a shell sees as a resize. A terminal takes
  its context before it is first sized, and a hidden one is not sized, so
  in practice only a lost context does this to a live session: once when
  the context is lost, and once more when the terminal is next shown.
- A canvas cannot be read by a test. The setting `hukube.terminal.renderer`
  keeps the DOM renderer when it holds `dom`. The end-to-end tests set it,
  and one test reads a WebGL terminal through Find instead.
- Two faults reported against the add-on's current release are worked
  around in `apps/app/src/lib/xterm.ts`: it leaves a context it is done
  with to the garbage collector, and terminals of the same colors share a
  glyph texture that one of them can spoil for another. The plan names the
  upstream issues and says which was seen here. Both workarounds can go
  when a release carries the fixes.
