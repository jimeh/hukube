import { isMap, isSeq, type Node } from "yaml";
import { parseManifest } from "./yaml.ts";

interface Position {
  lineNumber: number;
  column: number;
}
interface Anchor {
  keys: (string | number)[];
  first: number;
  last: number;
}

/** Keep the caret on its field when Edit hides fields above it. */
export function caretInEditableManifest(
  before: string,
  after: string,
  position: Position | null,
): Position {
  if (!position) return { lineNumber: 1, column: 1 };
  const old = anchors(before);
  const next = anchors(after);
  const source = old.findLast(
    (anchor) => anchor.first <= position.lineNumber && anchor.last >= position.lineNumber,
  );
  const target =
    source && next.find((anchor) => JSON.stringify(anchor.keys) === JSON.stringify(source.keys));
  const lineNumber = target
    ? Math.min(target.last, target.first + position.lineNumber - source.first)
    : 1;
  return {
    lineNumber,
    column: Math.min(position.column, (after.split("\n")[lineNumber - 1]?.length ?? 0) + 1),
  };
}

function anchors(text: string): Anchor[] {
  const parsed = parseManifest(text);
  const out: Anchor[] = [];
  const walk = (node: Node | null, keys: (string | number)[]) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key as Node;
        const value = pair.value as Node | null;
        const child = [...keys, String(pair.key)];
        if (key.range)
          out.push({
            keys: child,
            first: parsed.lines.linePos(key.range[0]).line,
            last: parsed.lines.linePos(value?.range?.[1] ?? key.range[1]).line,
          });
        walk(value, child);
      }
    } else if (isSeq(node)) {
      for (const [index, item] of node.items.entries()) walk(item as Node | null, [...keys, index]);
    }
  };
  walk(parsed.document.contents, []);
  return out;
}
