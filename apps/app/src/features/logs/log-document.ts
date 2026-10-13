import type { LogLine, LogSource, LogStreamStatus } from "@hukube/engine-client";

export interface TextSpan {
  start: number;
  end: number;
  className: string;
}
export interface LogRow {
  sequence: number;
  text: string;
  spans: TextSpan[];
}
interface Entry {
  sequence: number;
  line?: LogLine;
  marker?: string;
}
export const logBudgets = { lines: 50_000, characters: 32_000_000, decorations: 200_000 };
// Cyan, magenta, blue, and yellow: red and green are left to log levels.
const originColors = [6, 5, 4, 3];

const pad = (value: number, width = 2) => value.toString().padStart(width, "0");

export function formatLogTime(time: number, now = new Date()): string {
  if (!time) return "";
  const date = new Date(time);

  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return `${today ? "" : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `}${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * The length of what every Pod name starts with, up to and including a
 * hyphen, and never a whole name: the Pods of one ReplicaSet differ only in
 * their last part, and that is all a line has room for.
 */
export function commonPodPrefix(pods: Iterable<string>): number {
  const names = [...pods];
  let common = names[0] ?? "";
  for (const pod of names) {
    let length = 0;
    while (length < common.length && length < pod.length && common[length] === pod[length])
      length++;
    common = common.slice(0, length);
  }
  // A whole name leaves nothing to show, so it gives up its last part.
  return names.includes(common)
    ? common.lastIndexOf("-", common.length - 2) + 1
    : common.lastIndexOf("-") + 1;
}

export function logOrigin(
  source: LogSource,
  type: string,
  prefix: number,
  multipleContainers: boolean,
): string {
  if (type === "pods") return source.container;
  return source.pod.slice(prefix) + (multipleContainers ? `/${source.container}` : "");
}

function ansiClass(foreground: number, background: number, flags: number): string {
  const classes: string[] = [];
  if (foreground >= 0 && foreground < 16) classes.push(`log-fg-${foreground}`);
  if (background >= 0 && background < 16) classes.push(`log-bg-${background}`);
  for (const [bit, name] of [
    [1, "bold"],
    [2, "dim"],
    [4, "italic"],
    [8, "underline"],
  ] as const)
    if (flags & bit) classes.push(`log-${name}`);
  return classes.join(" ");
}

/** Retains bounded text and decorations independently of React and Monaco. */
export class LogDocument {
  readonly sources = new Map<number, LogSource>();
  /** Colors by Pod, or by container when the stream reads one Pod. */
  readonly #originColors = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #entries: Entry[] = [];
  rows: LogRow[] = [];
  #sequence = 0;
  #characters = 0;
  #decorations = 0;
  #multipleSources = false;
  #multipleContainers = false;
  #podPrefix = 0;
  #timestamps = false;
  revision = 0;
  /** Counts the times every row was formatted again, or dropped. */
  rewrites = 0;
  constructor(
    readonly type: string,
    readonly budgets = logBudgets,
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  snapshot = (): number => this.revision;
  #changed(): void {
    this.revision++;
    for (const listener of this.#listeners) listener();
  }
  clear(): void {
    this.#entries = [];
    this.rows = [];
    this.#characters = 0;
    this.#decorations = 0;
    this.rewrites++;
    this.#changed();
  }
  status(status: LogStreamStatus): void {
    for (const source of status.sources) {
      this.sources.set(source.id, source);
      const key = this.#colorKey(source);
      if (!this.#originColors.has(key))
        this.#originColors.set(key, originColors[this.#originColors.size % originColors.length]!);
    }
    const prefix = commonPodPrefix(new Set([...this.sources.values()].map((source) => source.pod)));
    const multipleSources = this.#multipleSources || status.sources.length > 1;
    const multipleContainers =
      this.#multipleContainers ||
      new Set(status.sources.map((source) => source.container)).size > 1;
    if (
      multipleSources !== this.#multipleSources ||
      multipleContainers !== this.#multipleContainers ||
      prefix !== this.#podPrefix
    ) {
      this.#multipleSources = multipleSources;
      this.#multipleContainers = multipleContainers;
      this.#podPrefix = prefix;
      this.#rebuild();
    }
  }
  #colorKey(source: LogSource): string {
    return this.type === "pods" ? source.container : source.podUid;
  }
  timestamps(value: boolean): void {
    if (value !== this.#timestamps) {
      this.#timestamps = value;
      this.#rebuild();
    }
  }
  append(lines: LogLine[]): void {
    for (const line of lines) this.#add({ sequence: this.#sequence++, line });
    this.#trim();
    this.#changed();
  }
  marker(text: string): void {
    this.#add({ sequence: this.#sequence++, marker: text });
    this.#trim();
    this.#changed();
  }
  #add(entry: Entry): void {
    const row = this.#format(entry);
    this.#entries.push(entry);
    this.rows.push(row);
    this.#characters += row.text.length + 1;
    this.#decorations += row.spans.length;
  }
  #trim(): void {
    let count = 0;
    while (
      this.rows.length - count > this.budgets.lines ||
      this.#characters > this.budgets.characters ||
      this.#decorations > this.budgets.decorations
    ) {
      const row = this.rows[count++];
      if (!row) break;
      this.#characters -= row.text.length + 1;
      this.#decorations -= row.spans.length;
    }
    if (count) {
      this.rows.splice(0, count);
      this.#entries.splice(0, count);
    }
  }
  #rebuild(): void {
    this.rows = this.#entries.map((entry) => this.#format(entry));
    this.#characters = this.rows.reduce((sum, row) => sum + row.text.length + 1, 0);
    this.#decorations = this.rows.reduce((sum, row) => sum + row.spans.length, 0);
    this.#trim();
    this.rewrites++;
    this.#changed();
  }
  #format(entry: Entry): LogRow {
    const muted = (text: string): LogRow => ({
      sequence: entry.sequence,
      text,
      spans: [{ start: 0, end: text.length, className: "log-muted" }],
    });
    if (entry.marker !== undefined) return muted(entry.marker);
    const line = entry.line!;
    const source = this.sources.get(line.source);
    const origin =
      source && this.#multipleSources
        ? logOrigin(source, this.type, this.#podPrefix, this.#multipleContainers)
        : "";
    if (line.gap) return muted(`··· ${origin ? `${origin}: ` : ""}some lines may be missing ···`);
    if (line.exited) return muted(`··· ${origin || "the container"} exited: ${line.text} ···`);
    let text = "";
    const spans: TextSpan[] = [];
    const timestamp = this.#timestamps ? formatLogTime(line.time) : "";
    if (timestamp) {
      text += `${timestamp} `;
      spans.push({ start: 0, end: text.length, className: "log-muted" });
    }
    if (origin) {
      const start = text.length;
      text += `${origin} `;
      spans.push({
        start,
        end: text.length,
        className: `log-fg-${this.#originColors.get(this.#colorKey(source!)) ?? 6}`,
      });
    }
    const offset = text.length;
    text += line.text;
    for (const [start, end, foreground, background, flags] of line.spans ?? []) {
      const className = ansiClass(foreground, background, flags);
      if (className) spans.push({ start: offset + start, end: offset + end, className });
    }
    if (line.cut) {
      const start = text.length;
      text += " … cut at 64 KiB";
      spans.push({ start, end: text.length, className: "log-muted" });
    }
    return { sequence: entry.sequence, text, spans };
  }
}
