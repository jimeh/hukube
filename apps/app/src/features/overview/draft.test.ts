import { expect, it } from "vitest";
import { parseManifest } from "../edit/yaml.ts";
import { fieldReason, inlineReason, parseInput, updateDraft, valueAt } from "./draft.ts";
const base =
  'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: test}\n# keep this comment\ndata:\n  "<<": literal\n  mode: "0644"\n  answer: "yes"\n  note: |\n    first\n    second\nspec:\n  count: 1\n  enabled: true\n  list: [{nested: {image: old}, untouched: 3}]\n  large: 9007199254740993\n';
const string = { type: "string" as const, remove: true };
it("preserves literal merge-looking keys, scalar meaning, comments, style, nested lists/maps and unseen unsafe numbers", () => {
  const next = updateDraft(base, base, ["spec", "list", 0, "nested", "image"], "yes", string);
  const parsed = parseManifest(next);
  expect(parsed.issues).toEqual([]);
  expect(valueAt(parsed.object, ["data"])).toEqual({
    "<<": "literal",
    mode: "0644",
    answer: "yes",
    note: "first\nsecond\n",
  });
  expect(valueAt(parsed.object, ["spec", "list"])).toEqual([
    { nested: { image: "yes" }, untouched: 3 },
  ]);
  expect(next).toContain("# keep this comment");
  expect(next).toContain("note: |");
  expect(next).toContain("9007199254740993");
  expect(updateDraft(next, base, ["spec", "list", 0, "nested", "image"], "old", string)).toBe(base);
});
it("distinguishes absent, empty, false, zero and removal, and literal dotted/slashed keys", () => {
  let text = updateDraft(base, base, ["data", "example.dev/key.with.dot"], "", string);
  expect(valueAt(parseManifest(text).object, ["data", "example.dev/key.with.dot"])).toBe("");
  text = updateDraft(text, base, ["spec", "enabled"], false, { type: "boolean" });
  text = updateDraft(text, base, ["spec", "count"], 0, { type: "integer" });
  expect(valueAt(parseManifest(text).object, ["spec"])).toMatchObject({ count: 0, enabled: false });
  text = updateDraft(text, base, ["data", "example.dev/key.with.dot"], undefined, string);
  expect(valueAt(parseManifest(text).object, ["data", "example.dev/key.with.dot"])).toBeUndefined();
});
it.each(["x: [", "x: &a { y: z }", "x: &a {}\ny: *a", "x: {<<: {y: z}}"])(
  "refuses inline changes to invalid/anchored/aliased/merged YAML: %s",
  (text) => expect(inlineReason(text)).toBeDefined(),
);
it("blocks a list replacement containing any unsafe integer while allowing unrelated map edits", () => {
  const text = "spec:\n  list: [{image: old}, {n: 9007199254740993}]\n  other: ok\n";
  const object = parseManifest(text).object;
  expect(fieldReason(object, ["spec", "list", 0, "image"], string)).toMatch(/unsafe integer/);
  expect(() => updateDraft(text, text, ["spec", "other"], "new", string)).not.toThrow(/./);
});
it("uses own properties and refuses unexpected types", () => {
  expect(valueAt({}, ["toString"])).toBeUndefined();
  expect(fieldReason({ spec: { count: null } }, ["spec", "count"], { type: "integer" })).toMatch(
    /different type/,
  );
});
it.each([
  ["", "integer"],
  ["9007199254740992", "integer"],
  ["9007199254740992", "number"],
  ["9007199254740993", "number"],
  ["Infinity", "number"],
  ["-1", "integer"],
] as const)("rejects invalid input %s for %s", (raw, type) =>
  expect(() => parseInput(raw, { type, min: 0 })).toThrow(/./),
);
