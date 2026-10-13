import {
  LineCounter,
  isMap,
  parseDocument,
  stringify,
  type Document,
  type ParseOptions,
  type DocumentOptions,
  type SchemaOptions,
  type ToStringOptions,
  type CreateNodeOptions,
} from "yaml";

// Match kubectl's scalar resolution without YAML's non-JSON collection tags.
export const yamlOptions: ParseOptions &
  DocumentOptions &
  SchemaOptions &
  ToStringOptions &
  CreateNodeOptions = {
  version: "1.1",
  resolveKnownTags: false,
  customTags: (tags) =>
    tags.filter((tag) =>
      typeof tag === "string"
        ? !["timestamp", "binary", "intTime", "floatTime", "set", "omap", "pairs"].includes(tag)
        : !["timestamp", "binary", "set", "omap", "pairs"].some(
            (name) => tag.tag === `tag:yaml.org,2002:${name}`,
          ) && tag.format !== "TIME",
    ),
  lineWidth: 0,
  aliasDuplicateObjects: false,
};
export function renderYaml(object: Record<string, unknown>): string {
  return stringify(object, yamlOptions);
}
export interface YamlIssue {
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}
export interface ParsedManifest {
  document: Document;
  object?: Record<string, unknown>;
  issues: YamlIssue[];
  lines: LineCounter;
}
export function parseManifest(text: string): ParsedManifest {
  const lines = new LineCounter();
  const document = parseDocument(text, { ...yamlOptions, lineCounter: lines });
  const issues = document.errors.map((error) => {
    const start = lines.linePos(error.pos[0]);
    const end = lines.linePos(error.pos[1]);
    return {
      message: error.message.split(" at line ")[0]!,
      line: start.line,
      column: start.col,
      endLine: end.line,
      endColumn: end.col,
    };
  });
  if (!issues.length && !isMap(document.contents))
    issues.push({
      message: "The Manifest must be one YAML document with a mapping at its root.",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 2,
    });
  let object: Record<string, unknown> | undefined;
  if (!issues.length) {
    try {
      object = document.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
    } catch (error) {
      issues.push({ message: String(error), line: 1, column: 1, endLine: 1, endColumn: 2 });
    }
  }
  return { document, object, issues, lines };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const serverFields = new Set([
  "managedFields",
  "resourceVersion",
  "uid",
  "generation",
  "creationTimestamp",
  "deletionTimestamp",
  "deletionGracePeriodSeconds",
  "selfLink",
]);
export function editableManifest(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => key !== "status")
      .map(([key, value]) => [
        key,
        key === "metadata" && isRecord(value)
          ? Object.fromEntries(Object.entries(value).filter(([field]) => !serverFields.has(field)))
          : value,
      ]),
  );
}
export function metadata(object: Record<string, unknown> | undefined): Record<string, unknown> {
  return isRecord(object?.["metadata"]) ? object["metadata"] : {};
}

export function metadataString(object: Record<string, unknown> | undefined, field: string): string {
  const value = metadata(object)[field];
  return typeof value === "string" ? value : "";
}
