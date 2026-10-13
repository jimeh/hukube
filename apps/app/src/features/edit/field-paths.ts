import type { ErrorDetail } from "@hukube/engine-client";
import { isMap, isSeq, type Node } from "yaml";
import type { ParsedManifest, YamlIssue } from "./yaml.ts";

export function fieldLabel(keys: string[]): string {
  return keys
    .map((key, index) =>
      /^[a-zA-Z_]\w*$/.test(key) ? `${index ? "." : ""}${key}` : `[${JSON.stringify(key)}]`,
    )
    .join("");
}
export function pathsLabel(paths: string[][]): string {
  return (
    paths.slice(0, 5).map(fieldLabel).join(", ") +
    (paths.length > 5 ? `, and ${paths.length - 5} more` : "")
  );
}
/** What a refusal says: its causes when the API server named any, else its message. */
export function refusalLines(refusal: Pick<ErrorDetail, "message" | "causes">): string[] {
  const causes = refusal.causes ?? [];
  if (!causes.length) return [refusal.message];
  return causes.map((cause) => (cause.field ? `${cause.field}: ${cause.message}` : cause.message));
}
/** API causes use dots, list indices, and sometimes unquoted label keys. */
export function fieldIssue(
  parsed: ParsedManifest,
  field: string,
  message: string,
): YamlIssue | undefined {
  const node = locate(parsed.document.contents, field);
  if (!node?.range) return;
  const start = parsed.lines.linePos(node.range[0]);
  const end = parsed.lines.linePos(node.range[1]);
  return { message, line: start.line, column: start.col, endLine: end.line, endColumn: end.col };
}

function locate(node: Node | null, remaining: string): Node | undefined {
  if (!node) return;
  if (!remaining) return node;
  if (isMap(node)) {
    // A map key that is not a plain name is written in brackets, as in labels[app.kubernetes.io/name].
    const bracket = /^\[([^\]]*)\]\.?/.exec(remaining);
    if (bracket) {
      const pair = node.items.find((item) => String(item.key) === bracket[1]);
      return pair
        ? locate(pair.value as Node | null, remaining.slice(bracket[0].length))
        : undefined;
    }
    for (const pair of node.items) {
      const key = String(pair.key);
      if (remaining === key || remaining.startsWith(`${key}.`) || remaining.startsWith(`${key}[`)) {
        const rest = remaining.slice(key.length).replace(/^\./, "");
        const found = locate(pair.value as Node | null, rest);
        if (found) return found;
      }
    }
  } else if (isSeq(node)) {
    const match = /^\[(\d+)\]\.?/.exec(remaining);
    if (match)
      return locate(node.items[Number(match[1])] as Node | null, remaining.slice(match[0].length));
  }
  return undefined;
}
