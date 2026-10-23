import { z } from "zod";
import { LineCounter, parseDocument, visit, isAlias, isCollection, isScalar, isNode } from "yaml";
import { serverFields } from "../edit/yaml.ts";

export type FieldPath = (string | number)[];
export const sourceLimit = 64 * 1024;
export const registryLimit = 2 * 1024 * 1024;
const key = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !["__proto__", "prototype", "constructor"].includes(v), "Unsafe path key");
const path = z
  .array(z.union([key, z.number().int().min(0).max(1000000)]))
  .min(1)
  .max(16);
const id = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  .max(80);
const edit = z.strictObject({
  type: z.enum(["string", "integer", "number", "boolean", "enum"]),
  remove: z.boolean().optional(),
  choices: z.array(z.string()).min(1).max(100).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  multiline: z.boolean().optional(),
});
const formats = z.enum([
  "text",
  "multiline",
  "number",
  "boolean",
  "timestamp",
  "badge",
  "sensitive",
]);
const column = z.strictObject({
  id,
  label: z.string().min(1).max(160),
  path,
  format: formats,
  edit: edit.optional(),
});
const field = z.discriminatedUnion("type", [
  column.extend({ type: z.literal("field") }),
  z.strictObject({
    id,
    type: z.literal("map"),
    label: z.string().min(1).max(160),
    path,
    sensitive: z.boolean().optional(),
    edit: z
      .strictObject({
        type: z.literal("string"),
        remove: z.boolean().optional(),
        multiline: z.boolean().optional(),
      })
      .optional(),
    empty: z.string().max(256).optional(),
  }),
  z.strictObject({
    id,
    type: z.literal("table"),
    label: z.string().min(1).max(160),
    path,
    columns: z.array(column).min(1).max(64),
    empty: z.string().max(256).optional(),
  }),
]);
export const definitionSchema = z.strictObject({
  version: z.literal(1),
  resourceType: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9.-]+)?$/)
    .max(253),
  apiVersions: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
  title: z.string().min(1).max(160),
  sections: z
    .array(
      z.strictObject({
        id,
        title: z.string().min(1).max(160),
        hideEmpty: z.boolean().optional(),
        fields: z.array(field).min(1).max(256),
      }),
    )
    .min(1)
    .max(32),
});
export type Definition = z.infer<typeof definitionSchema>;
export type OverviewField = Definition["sections"][number]["fields"][number];
export type EditControl = z.infer<typeof edit>;

/** Identity and Engine-managed data are never editable, including through parent paths. */
export function protectedPath(p: readonly (string | number)[]): boolean {
  if (["status", "apiVersion", "kind"].includes(String(p[0]))) return true;
  return (
    p[0] === "metadata" &&
    (p.length === 1 || ["name", "namespace", ...serverFields].includes(String(p[1])))
  );
}
export function parseDefinition(source: string): Definition {
  if (new TextEncoder().encode(source).length > sourceLimit)
    throw new Error("Definition exceeds 64 KiB.");
  const lines = new LineCounter();
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    lineCounter: lines,
  });
  if (document.errors.length || document.warnings.length)
    throw new Error([...document.errors, ...document.warnings].map((e) => e.message).join("\n"));
  inspect(document.contents, 0);
  visit(document, {
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === "<<")
        throw new Error("Merge keys are not allowed.");
    },
  });
  if (document.directives.yaml.version !== "1.2") throw new Error("Definitions require YAML 1.2.");
  const parsed = definitionSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => {
          const node = document.getIn(issue.path, true);
          const line = isNode(node) && node.range ? lines.linePos(node.range[0]).line : undefined;
          return `${issue.path.join(".")}${line ? ` (line ${line})` : ""}: ${issue.message}`;
        })
        .join("\n"),
    );
  const d = parsed.data;
  const ids = new Set<string>();
  const paths = new Set<string>();
  let count = 0;

  for (const section of d.sections) {
    unique(ids, section.id);
    for (const f of section.fields) {
      unique(ids, f.id);
      unique(paths, JSON.stringify(f.path));
      count++;
      const check = (p: FieldPath, control: EditControl | undefined) => {
        if (p.length > 16) throw new Error(`${f.id}: Combined path exceeds 16 levels.`);
        if (!control) return;
        if (protectedPath(p)) throw new Error(`${f.id}: Protected path cannot be edited.`);
        if (
          control.type === "enum"
            ? !control.choices || new Set(control.choices).size !== control.choices.length
            : !!control.choices
        )
          throw new Error(
            `${f.id}: Enum choices are required only for enum controls and must be unique.`,
          );
        if (
          (control.min !== undefined || control.max !== undefined) &&
          !["integer", "number"].includes(control.type)
        )
          throw new Error(`${f.id}: Bounds require a numeric control.`);
        if (control.min !== undefined && control.max !== undefined && control.min > control.max)
          throw new Error(`${f.id}: Minimum exceeds maximum.`);
        if (control.multiline && control.type !== "string")
          throw new Error(`${f.id}: Multiline requires a string control.`);
      };
      if (f.type === "table")
        for (const c of f.columns) {
          unique(ids, c.id);
          unique(paths, JSON.stringify([...f.path, "*", ...c.path]));
          count++;
          check([...f.path, 0, ...c.path], c.edit);
          checkFormat(c.format, c.edit);
        }
      else {
        if (f.type === "map" && f.sensitive && f.edit)
          throw new Error(`${f.id}: Sensitive maps are read-only.`);
        check(f.path, f.edit);
        if (f.type === "field") checkFormat(f.format, f.edit);
      }
    }
  }
  if (count > 256) throw new Error("Definition exceeds 256 fields and columns.");
  return d;
}
function checkFormat(format: string, control?: EditControl) {
  if (!control) return;
  if (
    (format === "number" && !["number", "integer"].includes(control.type)) ||
    (format === "boolean" && control.type !== "boolean") ||
    (format === "multiline" && control.type !== "string") ||
    ["timestamp", "sensitive"].includes(format)
  )
    throw new Error(`Incompatible ${format} display and ${control.type} control.`);
}
export function matches(
  definition: Definition,
  type: string,
  apiVersion: string | undefined,
): boolean | undefined {
  if (definition.resourceType !== type) return false;
  if (!definition.apiVersions) return true;
  return apiVersion === undefined ? undefined : definition.apiVersions.includes(apiVersion);
}
export function definitionJsonSchema() {
  return z.toJSONSchema(definitionSchema);
}

function inspect(node: unknown, depth: number): void {
  if (depth > 16) throw new Error("Definition nesting exceeds 16 levels.");
  if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor))
    throw new Error("Anchors and aliases are not allowed.");
  if (node && typeof node === "object" && "tag" in node && node.tag)
    throw new Error("Explicit tags are not allowed.");
  if (isCollection(node)) for (const item of node.items) inspect(item, depth + 1);
  else if (node && typeof node === "object" && "key" in node && "value" in node) {
    inspect(node.key, depth);
    inspect(node.value, depth);
  }
}

function unique(set: Set<string>, value: string) {
  if (set.has(value)) throw new Error(`Duplicate identifier or path: ${value}`);
  set.add(value);
}
