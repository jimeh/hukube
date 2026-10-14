/* eslint-disable no-underscore-dangle -- These parser and mode internals are the xterm.js oracle. */
import { deepStrictEqual } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import xterm from "@xterm/headless";
import { expect, it } from "vitest";

type Terminal = InstanceType<typeof xterm.Terminal>;
interface Core {
  _writeBuffer: { writeSync(data: Uint8Array | string): void };
  _inputHandler: { _parser: { currentState: number }; _utf8Decoder: { interim: number[] } };
  coreService: {
    isCursorHidden: boolean;
    decPrivateModes: { cursorStyle: unknown; cursorBlink: unknown; synchronizedOutput: boolean };
  };
  coreMouseService: { activeEncoding: unknown };
  buffer: { scrollTop: number; scrollBottom: number };
  _charsetService: { glevel: number; _charsets: unknown[] };
}
const core = (term: Terminal) => (term as unknown as { _core: Core })._core;
const terminal = (cols = 80, rows = 24) =>
  new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 100, logLevel: "off" });
const write = (term: Terminal, data: Uint8Array | string) =>
  core(term)._writeBuffer.writeSync(data);
function modes(term: Terminal) {
  const c = core(term);
  return {
    ...term.modes,
    type: term.buffer.active.type,
    cursorHidden: c.coreService.isCursorHidden,
    mouseEncoding: c.coreMouseService.activeEncoding,
    scroll: [c.buffer.scrollTop, c.buffer.scrollBottom],
    glevel: c._charsetService.glevel,
    charsets: [0, 1, 2, 3].map((g) => {
      const charset = c._charsetService._charsets[g];
      return charset ? JSON.stringify(charset) : null;
    }),
    cursorStyle: c.coreService.decPrivateModes.cursorStyle,
    cursorBlink: c.coreService.decPrivateModes.cursorBlink,
    synchronizedOutput: c.coreService.decPrivateModes.synchronizedOutput,
    blinkOption: term.options.cursorBlink,
    convertEol: term.options.convertEol,
  };
}
function screen(term: Terminal) {
  const b = term.buffer.active;
  return {
    lines: Array.from(
      { length: term.rows },
      (_, y) =>
        b
          .getLine(b.baseY + y)
          ?.translateToString(true)
          .trimEnd() ?? "",
    ),
    cursor: [b.cursorX, b.cursorY],
  };
}
interface Event {
  o?: string;
  r?: [number, number];
  m?: string;
}
interface Golden {
  safe: string;
  samples: { at: number; restore: string }[];
  attachments: { mark: string; at: number; ring: number; cut: number; restore: string }[];
}
const dir = new URL("../../../../../engine/internal/execsession/testdata/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir));
const recordings = readdirSync(new URL("recordings/", dir)).filter((name) =>
  name.endsWith(".jsonl"),
);
const files = [
  ...recordings.map((name) => `recordings/${name}`),
  ...readdirSync(dir).filter((name) => name.endsWith(".bin")),
];
const load = (file: string) =>
  file.endsWith("jsonl")
    ? (read(file)
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Event[])
    : [];
const bytesOf = (events: Event[]) =>
  Buffer.concat(events.filter((e) => e.o).map((e) => Buffer.from(e.o!, "base64")));
function feed(term: Terminal, events: Event[], from: number, to: number) {
  for (const event of events.slice(from, to)) {
    if (event.o) write(term, Buffer.from(event.o, "base64"));
    if (event.r) term.resize(...event.r);
  }
}

it.each(files)("agrees with xterm.js at every safe cut and sampled restore: %s", (file) => {
  const events = load(file);
  const data = events.length ? bytesOf(events) : read(file);
  const golden = JSON.parse(read(`${file}.golden.json`).toString()) as Golden;
  const safe = Buffer.from(golden.safe, "base64");
  const samples = new Map(golden.samples.map((sample) => [sample.at, sample.restore]));
  const term = terminal();
  let fed = 0;
  try {
    for (let i = 0; i < data.length; i++) {
      if (!((safe[i >> 3] ?? 0) & (1 << (i % 8)))) continue;
      // Ending a write inside a character changes xterm.js's decoding, so
      // feed one write between consecutive safe positions.
      write(term, data.subarray(fed, i + 1));
      fed = i + 1;
      const c = core(term);
      if (
        c._inputHandler._parser.currentState !== 0 ||
        c._inputHandler._utf8Decoder.interim.some((b) => b !== 0)
      )
        throw new Error(`${file}: unsafe cut at ${fed}`);
      const restore = samples.get(fed);
      if (restore !== undefined) {
        const reset = terminal();
        try {
          write(reset, restore);
          deepStrictEqual(modes(reset), modes(term), `${file}: restore at ${fed}`);
        } finally {
          reset.dispose();
        }
      }
    }
    expect(fed).toBeGreaterThan(0);
    expect(samples.size).toBeGreaterThan(0);
  } finally {
    term.dispose();
  }
});

it.each(recordings)("restores recorded attachments and repainting programs: %s", (name) => {
  const file = `recordings/${name}`;
  const events = load(file);
  const data = bytesOf(events);
  const golden = JSON.parse(read(`${file}.golden.json`).toString()) as Golden;
  expect(golden.attachments.length).toBeGreaterThan(0);
  const marks = new Map(events.flatMap((event, i) => (event.m ? [[event.m, i] as const] : [])));
  for (const c of golden.attachments) {
    const mark = marks.get(c.mark)!;
    let cols = 80,
      rows = 24;
    for (const event of events.slice(0, mark)) if (event.r) [cols, rows] = event.r;
    const full = terminal();
    const replay = terminal(cols, rows);
    try {
      feed(full, events, 0, mark);
      write(replay, c.restore);
      write(replay, data.subarray(c.cut, c.at));
      const context = `${name}: ${c.mark}, ring ${c.ring}, cut ${c.cut}`;
      deepStrictEqual(modes(replay), modes(full), context);
      if (c.cut === 0 || name.includes("flood-midline"))
        deepStrictEqual(screen(replay), screen(full), context);
      const after = marks.get("after-restore");
      if (c.mark === "before-same" && after !== undefined) {
        feed(full, events, mark, after);
        feed(replay, events, mark, after);
        deepStrictEqual(modes(replay), modes(full), `${context}: after resize`);
        deepStrictEqual(screen(replay), screen(full), `${context}: after resize`);
      }
    } finally {
      full.dispose();
      replay.dispose();
    }
  }
});
