import Anser from "anser";

export type LogSpan = [
  start: number,
  end: number,
  foreground: number,
  background: number,
  flags: number,
];
const palette = [
  [0, 0, 0],
  [187, 0, 0],
  [0, 187, 0],
  [187, 187, 0],
  [0, 0, 187],
  [187, 0, 187],
  [0, 187, 187],
  [187, 187, 187],
  [85, 85, 85],
  [255, 85, 85],
  [85, 255, 85],
  [255, 255, 85],
  [85, 85, 255],
  [255, 85, 255],
  [85, 255, 255],
  [255, 255, 255],
];

/** Resolves progress output and strips escape sequences before parsing SGR. */
export function filterLogContent(input: string): string {
  const text = input.split("\r").findLast((part) => part !== "") ?? "";
  let output = "";
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i);
    const escape = code === 27;
    const next = escape ? text.charCodeAt(i + 1) : code;
    const start = i;
    if ((escape && next === 91) || code === 155) {
      i += escape ? 2 : 1;
      while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f) i++;
      if (i < text.length && text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e) {
        const sequence = text.slice(start, ++i);
        // oxlint-disable-next-line no-control-regex -- Matches an SGR introducer.
        if (escape && /^\x1b\[[0-9;:]*m$/.test(sequence)) output += sequence;
      }
      continue;
    }
    if (
      (escape && [93, 80, 95, 94, 88].includes(next)) ||
      [157, 144, 159, 158, 152].includes(code)
    ) {
      const osc = next === 93 || code === 157;
      i += escape ? 2 : 1;
      while (i < text.length) {
        if (text.charCodeAt(i) === 156 || (osc && text.charCodeAt(i) === 7)) {
          i++;
          break;
        }
        if (text.charCodeAt(i) === 27 && text[i + 1] === "\\") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    if (escape && i + 1 < text.length) {
      let end = i + 1;
      while (end < text.length && text.charCodeAt(end) >= 0x20 && text.charCodeAt(end) <= 0x2f)
        end++;
      if (end < text.length && text.charCodeAt(end) >= 0x30 && text.charCodeAt(end) <= 0x7e) {
        i = end + 1;
        continue;
      }
    }
    output +=
      code < 32 && code !== 9
        ? String.fromCharCode(0x2400 + code)
        : code === 127
          ? "\u2421"
          : code >= 128 && code <= 159
            ? "\ufffd"
            : text[i];
    i++;
  }
  return output;
}

function nearestColor(color: string): number {
  if (!color) return -1;
  const rgb = color.split(",").map(Number);
  let nearest = -1;
  let distance = Infinity;
  for (const [index, candidate] of palette.entries()) {
    const delta = candidate.reduce(
      (sum, value, channel) => sum + (value - (rgb[channel] ?? 0)) ** 2,
      0,
    );
    if (delta < distance) {
      distance = delta;
      nearest = index;
    }
  }
  return nearest;
}

function sgrForParser(sequence: string): string {
  const values = sequence
    .slice(2, -1)
    .split(";")
    .flatMap((part) => {
      const parameters = part.split(":");
      if (parameters.length === 6 && parameters[1] === "2") parameters.splice(2, 1);
      return parameters.map((value) => Number(value || "0"));
    });
  const kept: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === 38 || value === 48) {
      const mode = values[index + 1];
      const length = mode === 5 ? 3 : mode === 2 ? 5 : 2;
      if ((mode === 5 || mode === 2) && index + length <= values.length)
        kept.push(...values.slice(index, index + length));
      index += length - 1;
    } else if (
      [0, 1, 2, 3, 4, 22, 23, 24, 39, 49].includes(value) ||
      (value >= 30 && value <= 37) ||
      (value >= 40 && value <= 47) ||
      (value >= 90 && value <= 97) ||
      (value >= 100 && value <= 107)
    )
      kept.push(value);
  }
  return kept.length ? `\x1b[${kept.join(";")}m` : "";
}

/** Produces only text and indices into the fixed ANSI palette. */
export function parseLogContent(input: string): { text: string; spans?: LogSpan[] } {
  // oxlint-disable-next-line no-control-regex -- Only SGR reaches the parser.
  const clean = filterLogContent(input).replace(/\x1b\[[0-9;:]*m/g, sgrForParser);
  if (!clean.includes("\x1b")) return { text: clean };
  let text = "";
  const spans: LogSpan[] = [];
  for (const chunk of Anser.ansiToJson(clean, { remove_empty: true })) {
    const start = text.length;
    text += chunk.content;
    const foreground = nearestColor(chunk.fg_truecolor || chunk.fg);
    const background = nearestColor(chunk.bg_truecolor || chunk.bg);
    const flags =
      (chunk.decorations.includes("bold") ? 1 : 0) |
      (chunk.decorations.includes("dim") ? 2 : 0) |
      (chunk.decorations.includes("italic") ? 4 : 0) |
      (chunk.decorations.includes("underline") ? 8 : 0);
    if (spans.length < 32 && (foreground !== -1 || background !== -1 || flags))
      spans.push([start, text.length, foreground, background, flags]);
  }
  return { text, ...(spans.length ? { spans } : {}) };
}
