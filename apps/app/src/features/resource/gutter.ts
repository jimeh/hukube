import { diffLines } from "diff";
export interface GutterChange {
  kind: "added" | "modified" | "deleted";
  line: number;
  count: number;
  before?: boolean;
}
export interface GutterResult {
  changes: GutterChange[];
  summary: string;
  limited: boolean;
}
const normalize = (s: string) => s.replace(/\r\n/g, "\n");
export function gutterChanges(
  base: string,
  text: string,
  limits = { size: 512 * 1024, timeout: 30, maxEditLength: 4000 },
): GutterResult {
  const unavailable = {
    changes: [],
    summary:
      "Gutter changes unavailable: diff work limit reached. Review changes is still available.",
    limited: true,
  };
  if (base.length + text.length > limits.size) return unavailable;
  const parts = diffLines(normalize(base), normalize(text), {
    timeout: limits.timeout,
    maxEditLength: limits.maxEditLength,
  });
  if (!parts) return unavailable;
  const changes: GutterChange[] = [];
  let line = 1;
  let added = 0;
  let modified = 0;
  let deleted = 0;
  const last = normalize(text).split("\n").length;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      line += part.count;
      continue;
    }
    let removed = 0;
    let inserted = 0;
    while (i < parts.length && (parts[i]!.added || parts[i]!.removed)) {
      const hunk = parts[i]!;
      if (hunk.removed) removed += hunk.count;
      else inserted += hunk.count;
      i++;
    }
    i--;
    const shared = Math.min(removed, inserted);
    if (shared) {
      changes.push({ kind: "modified", line, count: shared });
      modified += shared;
    }
    if (inserted > shared) {
      changes.push({ kind: "added", line: line + shared, count: inserted - shared });
      added += inserted - shared;
    }
    if (removed > shared) {
      const boundary = line + inserted - 1;
      changes.push({
        kind: "deleted",
        line: Math.max(1, Math.min(last, boundary)),
        count: removed - shared,
        before: boundary < 1,
      });
      deleted += removed - shared;
    }
    line += inserted;
  }
  return {
    changes,
    summary: changes.length
      ? `${added} added, ${modified} modified, ${deleted} deleted lines.`
      : "No changed lines.",
    limited: false,
  };
}
/** One minimal replacement preserves Monaco's undo history and surrounding selections. */
export function replacement(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let afterEnd = after.length;
  while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) {
    end--;
    afterEnd--;
  }
  return { start, end, text: after.slice(start, afterEnd) };
}
