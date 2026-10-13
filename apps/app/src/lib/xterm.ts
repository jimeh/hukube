import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import type { ExecTerminal } from "@/features/exec/sessions.ts";
import { execKey } from "@/features/exec/keys.ts";
import { copyText } from "@/features/edit/clipboard.ts";
import { cssColor } from "@/features/resource/editor-theme.ts";

const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The DOM renderer and add-ons of an Exec Session, loaded only when one starts. */
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
  let fitted: (() => void) | undefined;
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
    const action = execKey(mac, event, terminal.hasSelection());
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
      const off = () => {
        clearTimeout(settle);
        cancelAnimationFrame(frame);
        observer.disconnect();
        if (element.parentElement === body) element.remove();
      };
      detach = off;
      return off;
    },
    theme,
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
    find: (text, previous, incremental) => {
      if (!opened) return;
      const options = {
        incremental,
        decorations: {
          matchBackground: `${findColor}40`,
          matchBorder: findColor,
          matchOverviewRuler: findColor,
          activeMatchBackground: `${findColor}8c`,
          activeMatchBorder: findColor,
          activeMatchColorOverviewRuler: findColor,
        },
      };
      if (previous) search.findPrevious(text, options);
      else search.findNext(text, options);
    },
    clearSearch: () => search.clearDecorations(),
    onSearchResults: (fn) => {
      const d = search.onDidChangeResults(fn);
      return () => d.dispose();
    },
  };
}
