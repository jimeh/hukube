import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { ExecTerminal } from "@/features/exec/sessions.ts";
import { execKey } from "@/features/exec/keys.ts";
import { copyText } from "@/features/edit/clipboard.ts";
import { cssColor } from "@/features/resource/editor-theme.ts";
import { isMac as mac } from "@/lib/platform.ts";

const channel = (color: string, at: number) => Number.parseInt(color.slice(at, at + 2), 16);

/** Mixes #rrggbb color a towards b by the given share of b. */
function mix(a: string, b: string, share: number): string {
  return `#${[1, 3, 5]
    .map((at) =>
      Math.round(channel(a, at) * (1 - share) + channel(b, at) * share)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The setting that makes every terminal use the DOM renderer when it holds "dom". */
export const rendererSetting = "hukube.terminal.renderer";

// The WebGL renderer is used where it is known to be sound: Chromium, which
// is the desktop Host and Chrome. Its add-on has rendering bugs open against
// Safari and WKWebView, and it was not tried in Firefox.
const chromium =
  (
    navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }
  ).userAgentData?.brands?.some(({ brand }) => brand === "Chromium") ??
  /\bChrom(e|ium)\//.test(navigator.userAgent);

// A document can hold about 16 WebGL contexts, and the browser takes the
// oldest when one more is made. Only a terminal that is showing holds one,
// and at most this many do.
const maxWebglTerminals = 8;
let webglTerminals = 0;
// Set when the add-on could not start. A start that fails part of the way
// leaves listeners nothing can remove, so no terminal in this window tries
// again.
let webglFailed = false;
// The numbers of the terminals that exist, each of which has its own.
const terminalNumbers = new Set<number>();

const loseContext = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("webgl2");
  if (context && !context.isContextLost())
    context.getExtension("WEBGL_lose_context")?.loseContext();
};

/** The renderers and add-ons of an Exec Session, loaded only when one starts. */
export function createExecTerminal(): ExecTerminal {
  const element = document.createElement("div");
  element.className = "h-full w-full min-h-0 overflow-hidden";
  element.setAttribute("role", "group");
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 5000,
    convertEol: false,
    fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
    fontSize: 12,
    allowProposedApi: true,
    cursorBlink: true,
    // Programs choose colors for a dark screen. White text stays readable on a light one.
    minimumContrastRatio: 4.5,
    // xterm.js turns an OSC 8 sequence into a link that opens after a native
    // confirm. A process in a container must not get the user to open an
    // address until the app has a rule for links in output.
    linkHandler: { activate: () => {} },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  let opened = false;
  let ended = false;
  let visible = false;
  let wantedFocus = false;
  let findColor = "#000000";
  let detach: (() => void) | undefined;
  let webgl: WebglAddon | undefined;
  // Set when the browser took this terminal's context. It then keeps the DOM
  // renderer until it is next shown, because each change of renderer can
  // change the grid's size.
  let lostWebgl = false;
  // Terminals with the same colors share one glyph texture in the add-on, and
  // in this version a change one of them causes can leave another showing the
  // wrong glyphs. A color no program is likely to use, different for each
  // terminal by an amount nobody can see, gives each its own texture: at
  // most 6 of 255 in each channel of color 16, which is black.
  let number = 0;
  while (terminalNumbers.has(number)) number++;
  terminalNumbers.add(number);
  const ownTexture = `#${[1, 7, 49].map((place) => `0${Math.floor(number / place) % 7}`).join("")}`;
  // The add-on keeps a glyph as it first drew it. A font that arrives in
  // parts, by range of characters, would leave text drawn before its part
  // came in the fallback font.
  const redrawGlyphs = () => webgl?.clearTextureAtlas();
  // Takes a WebGL context for this terminal if it may have one. The DOM
  // renderer stays when it may not, or when the add-on cannot start.
  const takeWebgl = () => {
    if (webgl || lostWebgl || webglFailed || !chromium) return;
    if (webglTerminals >= maxWebglTerminals) return;
    if (localStorage.getItem(rendererSetting) === "dom") return;
    const before = new Set(element.querySelectorAll("canvas"));
    let addon: WebglAddon | undefined;
    try {
      addon = new WebglAddon();
      terminal.loadAddon(addon);
    } catch {
      // The DOM renderer is already drawing. A start that failed after it
      // made a context leaves canvases that the add-on does not remove.
      webglFailed = true;
      try {
        addon?.dispose();
      } catch {
        // Nothing more can be undone.
      }
      for (const canvas of element.querySelectorAll("canvas")) {
        if (before.has(canvas)) continue;
        loseContext(canvas);
        canvas.remove();
      }
      return;
    }
    webgl = addon;
    webglTerminals++;
    document.fonts.addEventListener("loadingdone", redrawGlyphs);
  };
  // Gives the context back, which returns the terminal to the DOM renderer.
  const releaseWebgl = () => {
    if (!webgl) return;
    const addon = webgl;
    webgl = undefined;
    webglTerminals--;
    document.fonts.removeEventListener("loadingdone", redrawGlyphs);
    // Disposing the add-on removes its canvas and leaves the context to the
    // garbage collector, so contexts that nothing shows count against the
    // document's limit (xterm.js issue 6068). Losing them here frees them.
    const canvases = [...element.querySelectorAll("canvas")];
    try {
      addon.dispose();
    } catch {
      // A context that is already lost can make the add-on's cleanup throw.
    }
    canvases.forEach(loseContext);
  };
  // A browser can take a context back at any time. The add-on then waits 3
  // seconds for it to return, drawing nothing. The terminal does not wait: it
  // carries on with the DOM renderer at once, with its buffer as it was, and
  // is sized again because the two renderers measure a cell differently.
  element.addEventListener(
    "webglcontextlost",
    () => {
      if (!webgl) return;
      lostWebgl = true;
      releaseWebgl();
      refit?.();
    },
    true,
  );
  let fitted: (() => void) | undefined;
  let refit: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    fitted = resolve;
  });
  const finds = new Set<() => void>();
  const theme = () => {
    if (!element.isConnected) return;
    const color = (token: string) => cssColor(element, token);
    const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    const colors: ITheme = {
      background: color("--background"),
      foreground: color("--foreground"),
      cursor: ended ? color("--background") : color("--foreground"),
      cursorAccent: color("--background"),
      selectionBackground: `${color("--cluster")}59`,
      selectionInactiveBackground: `${color("--cluster")}33`,
    };
    for (const name of ansi) {
      colors[name as Exclude<keyof ITheme, "extendedAnsi">] = color(`--ansi-${name}`);
      colors[
        `bright${name[0]!.toUpperCase()}${name.slice(1)}` as Exclude<keyof ITheme, "extendedAnsi">
      ] = color(`--ansi-bright-${name}`);
    }
    if (chromium) colors.extendedAnsi = [ownTexture];
    terminal.options.theme = colors;
    findColor = color("--warning");
  };
  const focus = () => {
    wantedFocus = true;
    if (opened && visible && element.isConnected && element.clientWidth && element.clientHeight) {
      terminal.focus();
      wantedFocus = false;
    }
  };
  const copy = () => {
    const selected = terminal.getSelection();
    if (!selected) return;
    void copyText(selected)
      .then(() => {
        if (!mac) terminal.clearSelection();
      })
      .catch(() => {});
  };
  terminal.attachCustomKeyEventHandler((event) => {
    const action = execKey(mac, event, terminal.hasSelection(), !ended);
    if (action === "terminal") return true;
    // The browser's paste event supplies clipboard text, including on plain HTTP.
    if (action === "leave" || action === "paste" || action === "goToResource") return false;
    if (event.type === "keydown") {
      event.preventDefault();
      event.stopPropagation();
      if (action === "copy") copy();
      else if (action === "selectAll") terminal.selectAll();
      else if (action === "find") for (const fn of finds) fn();
    }
    return false;
  });
  return {
    element,
    ready,
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    write: (data, done) => terminal.write(data, done),
    reset: () =>
      new Promise<void>((done) => {
        // Reset after queued writes, so old output cannot enter the next run.
        terminal.write("", () => {
          search.clearDecorations();
          terminal.reset();
          done();
        });
      }),
    dispose: () => {
      detach?.();
      releaseWebgl();
      terminalNumbers.delete(number);
      terminal.dispose();
      element.remove();
    },
    setEnded: (value) => {
      if (value === ended) return;
      terminal.write(value ? "\x1b[?25l" : "\x1b[?25h");
      ended = value;
      terminal.options.disableStdin = value;
      terminal.options.cursorBlink = !value;
      terminal.options.cursorInactiveStyle = value ? "none" : "outline";
      element.style.opacity = value ? "0.6" : "1";
      theme();
    },
    focus,
    attach: (body, showing) => {
      detach?.();
      body.append(element);
      visible = showing;
      let frame = 0;
      const resize = () => {
        if (!visible) return;
        if (!body.isConnected || !body.clientWidth || !body.clientHeight) {
          if (!opened) frame = requestAnimationFrame(resize);
          return;
        }
        theme();
        if (!opened) {
          terminal.open(element);
          terminal.textarea?.setAttribute("aria-label", element.getAttribute("aria-label")!);
          opened = true;
        }
        // Before the terminal is sized: the two renderers measure a cell
        // differently, so the one that will draw must do the measuring.
        takeWebgl();
        try {
          const screen = element.querySelector<HTMLElement>(".xterm-screen");
          if (!screen?.clientWidth || !screen.clientHeight) {
            frame = requestAnimationFrame(resize);
            return;
          }
          // The add-on clamps its proposal to two columns, even in a narrower body.
          if (
            body.clientWidth < (2 * screen.clientWidth) / terminal.cols ||
            body.clientHeight < (2 * screen.clientHeight) / terminal.rows
          )
            return;
          const size = fit.proposeDimensions();
          if (!size || size.cols < 2 || size.rows < 2) return;
          fit.fit();
          fitted?.();
        } catch {
          // A scrollback resize can throw; the next resize tries again.
          return;
        }
        if (wantedFocus) focus();
      };
      // A layout that is still settling resizes several times in a row, and
      // each size sent redraws the prompt of a shell.
      let settle: ReturnType<typeof setTimeout> | undefined;
      const observer = new ResizeObserver(() => {
        clearTimeout(settle);
        settle = setTimeout(resize, opened ? 80 : 0);
      });
      observer.observe(body);
      resize();
      refit = () => {
        clearTimeout(settle);
        resize();
      };
      const off = () => {
        // A later attachment has replaced this one, and its state is not
        // this one's to end.
        if (detach !== off) return;
        detach = undefined;
        refit = undefined;
        // A terminal that is not showing gives its context to one that is.
        releaseWebgl();
        lostWebgl = false;
        clearTimeout(settle);
        cancelAnimationFrame(frame);
        observer.disconnect();
        if (element.parentElement === body) element.remove();
      };
      detach = off;
      return off;
    },
    theme,
    refit: () =>
      new Promise<void>((resolve) => {
        // Two frames let a layout change that came with the caller's state
        // reach the terminal. A hidden window runs no frames.
        const timer = setTimeout(resolve, 250);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            refit?.();
            resolve();
          }),
        );
      }),
    onData: (fn) => {
      const d = terminal.onData(fn);
      return () => d.dispose();
    },
    onBinary: (fn) => {
      const d = terminal.onBinary(fn);
      return () => d.dispose();
    },
    onResize: (fn) => {
      const d = terminal.onResize(fn);
      return () => d.dispose();
    },
    hasSelection: () => terminal.hasSelection(),
    copy,
    paste: (text) => {
      if (!ended) terminal.paste(text);
    },
    selectAll: () => terminal.selectAll(),
    clear: () => terminal.clear(),
    onFind: (fn) => {
      finds.add(fn);
      return () => {
        finds.delete(fn);
      };
    },
    find: (text, direction, incremental) => {
      if (!opened) return;
      const options = {
        incremental,
        // The DOM renderer paints these opaque, so the other matches get a
        // color mixed towards the background and the current one stands out.
        decorations: {
          matchBackground: mix(findColor, terminal.options.theme?.background ?? "#000000", 0.7),
          matchOverviewRuler: findColor,
          activeMatchBackground: findColor,
          activeMatchBorder: terminal.options.theme?.foreground ?? findColor,
          activeMatchColorOverviewRuler: findColor,
        },
      };
      if (direction === "older") search.findPrevious(text, options);
      else search.findNext(text, options);
    },
    clearSearch: () => search.clearDecorations(),
    onSearchResults: (fn) => {
      const d = search.onDidChangeResults(fn);
      return () => d.dispose();
    },
  };
}
