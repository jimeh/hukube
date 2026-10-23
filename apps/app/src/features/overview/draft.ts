import { isAlias, isScalar, isMap, visit, parseDocument } from "yaml";
import {
  isRecord,
  parseManifest,
  stringifyManifest,
  yamlOptions,
  type ParsedManifest,
} from "../edit/yaml.ts";
import { protectedPath, type EditControl, type FieldPath } from "./definition.ts";

/** Secret values stay protected regardless of the installed definition. */
export function secretPath(type: string, path: FieldPath): boolean {
  const annotation = [
    "metadata",
    "annotations",
    "kubectl.kubernetes.io/last-applied-configuration",
  ];
  return (
    type === "secrets" &&
    (["data", "stringData"].includes(String(path[0])) ||
      annotation.slice(0, path.length).every((key, i) => path[i] === key))
  );
}
export function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
export function semanticEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b) || (typeof a === "number" && typeof b === "number" && a === b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => semanticEqual(v, b[i]));
  if (isRecord(a) && isRecord(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && semanticEqual(a[k], b[k]))
    );
  return false;
}
export function inlineReason(source: string | ParsedManifest): string | undefined {
  const parsed = typeof source === "string" ? parseManifest(source) : source;
  if (!parsed.object) return "Fix invalid YAML in the YAML Facet before editing inline.";
  let unsafe = false;
  visit(parsed.document, {
    Node: (_key, node) => {
      if (isAlias(node) || ("anchor" in node && node.anchor)) unsafe = true;
    },
    Pair: (_key, pair) => {
      if (
        isScalar(pair.key) &&
        (pair.key.tag === "tag:yaml.org,2002:merge" || typeof pair.key.value === "symbol")
      )
        unsafe = true;
    },
  });
  return unsafe ? "Edit aliases, anchors, or merge keys in YAML." : undefined;
}
function unsafeNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  return !!value && typeof value === "object" && Object.values(value).some(unsafeNumber);
}
export function fieldReason(
  object: unknown,
  path: FieldPath,
  control: EditControl,
): string | undefined {
  if (protectedPath(path)) return "This field is read-only.";
  const current = valueAt(object, path);
  if (
    current !== undefined &&
    (current === null ||
      typeof current !==
        (control.type === "enum"
          ? "string"
          : ["integer", "number"].includes(control.type)
            ? "number"
            : control.type))
  )
    return "This value has a different type. Edit in YAML.";
  if (
    typeof current === "number" &&
    (!Number.isFinite(current) || (Number.isInteger(current) && !Number.isSafeInteger(current)))
  )
    return "This number cannot be edited safely. Edit in YAML.";
  for (let i = 0; i < path.length; i++) {
    const parent = valueAt(object, path.slice(0, i));
    if (
      typeof path[i] === "number" &&
      (!Array.isArray(parent) || (path[i] as number) >= parent.length)
    )
      return "Add or remove list rows in YAML.";
    if (Array.isArray(parent) && typeof path[i] !== "number")
      return "This value is a list. Edit in YAML.";
    if (Array.isArray(parent) && unsafeNumber(parent))
      return "This list contains an unsafe integer. Edit in YAML.";
    if (parent !== undefined && parent !== null && typeof parent !== "object")
      return "The parent value has a different type. Edit in YAML.";
    if (parent === null) return "The parent value is null. Edit in YAML.";
  }
}
export function parseInput(raw: string, control: EditControl): string | number | boolean {
  switch (control.type) {
    case "string":
      return raw;
    case "enum":
      if (!control.choices?.includes(raw)) throw new Error("Choose one of the listed values.");
      return raw;
    case "boolean":
      if (!["true", "false"].includes(raw)) throw new Error("Choose true or false.");
      return raw === "true";
    default: {
      if (!raw.trim()) throw new Error("Enter a number.");
      const n = Number(raw);
      if (Number.isInteger(n) && !Number.isSafeInteger(n))
        throw new Error("Integers must be within the safe number range. Edit in YAML.");
      if (!Number.isFinite(n) || (control.type === "integer" && !Number.isSafeInteger(n)))
        throw new Error(
          control.type === "integer" ? "Enter a safe whole number." : "Enter a finite number.",
        );
      if (control.min !== undefined && n < control.min)
        throw new Error(`Minimum is ${control.min}.`);
      if (control.max !== undefined && n > control.max)
        throw new Error(`Maximum is ${control.max}.`);
      return n;
    }
  }
}
export function updateDraft(
  text: string,
  baseText: string,
  path: FieldPath,
  value: unknown,
  control: EditControl,
  restoreText = baseText,
): string {
  const parsed = parseManifest(text);
  const reason = inlineReason(parsed);
  if (reason) throw new Error(reason);
  const blocked = fieldReason(parsed.object, path, control);
  if (blocked) throw new Error(blocked);
  if (value === undefined && !control.remove) throw new Error("This field cannot be removed.");
  // Preserve untouched integer lexemes beyond JavaScript precision while changing the AST.
  // The controller's JSON values still follow the Engine's existing number-aware patch contract.
  const document = parseDocument(text, { ...yamlOptions, intAsBigInt: true });
  if (value === undefined) {
    if (!document.hasIn(path)) return text;
    document.deleteIn(path);
    const original = parseManifest(restoreText).document;
    for (let length = path.length - 1; length > 0; length--) {
      const ancestor = path.slice(0, length);
      const node = document.getIn(ancestor, true);
      if (original.hasIn(ancestor) || !isMap(node) || node.items.length) break;
      document.deleteIn(ancestor);
    }
  } else document.setIn(path, document.createNode(value));
  const next = stringifyManifest(document);
  return semanticEqual(parseManifest(next).object, parseManifest(baseText).object)
    ? baseText
    : next;
}
/** Leaf differences are used only for the notice, never to construct a write. */
export function changedPaths(base: unknown, current: unknown, prefix: FieldPath = []): FieldPath[] {
  if (semanticEqual(base, current)) return [];
  if (isRecord(base) && isRecord(current))
    return [...new Set([...Object.keys(base), ...Object.keys(current)])].flatMap((k) =>
      changedPaths(base[k], current[k], [...prefix, k]),
    );
  if (Array.isArray(base) && Array.isArray(current))
    return Array.from({ length: Math.max(base.length, current.length) }, (_, i) =>
      changedPaths(base[i], current[i], [...prefix, i]),
    ).flat();
  return [prefix];
}
export function isLivePath(path: FieldPath): boolean {
  return protectedPath(path);
}
