import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { definitionJsonSchema, matches, parseDefinition } from "./definition.ts";
import { bundledDefinitions, bundledSources } from "./bundled.ts";
const definition = {
  version: 1,
  resourceType: "widgets.sample.hukube.dev",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        {
          id: "size",
          type: "field",
          label: "Size",
          path: ["spec", "size"],
          format: "number",
          edit: { type: "integer", min: 0 },
        },
      ],
    },
  ],
  title: "Widget",
};
const source = (value = definition) => JSON.stringify(value);
it("validates all 14 built-in YAML definitions and the independently installable Widget example", () => {
  expect(bundledDefinitions.size).toBe(14);
  for (const [key, text] of Object.entries(bundledSources))
    expect(parseDefinition(text).resourceType).toBe(key);
  expect(parseDefinition(readFileSync("docs/overview/widget.yaml", "utf8")).resourceType).toBe(
    "widgets.sample.hukube.dev",
  );
});
it("exports the checked-in schema without drift", () => {
  expect(JSON.parse(readFileSync("docs/overview/definition.schema.json", "utf8"))).toEqual(
    definitionJsonSchema(),
  );
});
it("matches exact Resource Type keys and API versions, retaining undecidable loading", () => {
  const d = parseDefinition(source());
  expect(matches(d, "widgets.other.dev", "v1")).toBe(false);
  d.apiVersions = ["sample.hukube.dev/v1"];
  expect(matches(d, d.resourceType, undefined)).toBeUndefined();
  expect(matches(d, d.resourceType, "sample.hukube.dev/v2")).toBe(false);
  expect(matches(d, d.resourceType, "sample.hukube.dev/v1")).toBe(true);
});
describe("invalid definitions", () => {
  it.each([
    "x".repeat(65537),
    "a: &a [*a]",
    "a: !!str hello",
    "a: 1\na: 2",
    "x: {<<: hi}",
    source().replace('"version":1', '"version":2'),
    source().replace('"spec","size"', '"__proto__","size"'),
    source().replace('"spec","size"', '"status","size"'),
    source().replace('"integer"', '"slider"'),
    source().replace('"min":0', '"min":4,"max":2'),
    source().replace('"format":"number"', '"format":"boolean"'),
  ])("rejects malformed, hostile, unsupported or incompatible source %s", (text) =>
    expect(() => parseDefinition(text)).toThrow(/./),
  );
  it("rejects table columns whose combined path is protected", () => {
    const d = structuredClone(definition) as unknown as Record<string, unknown>;
    d["sections"] = [
      {
        id: "main",
        title: "Main",
        fields: [
          {
            id: "rows",
            type: "table",
            label: "Rows",
            path: ["status", "conditions"],
            columns: [
              {
                id: "value",
                label: "Value",
                path: ["message"],
                format: "text",
                edit: { type: "string" },
              },
            ],
          },
        ],
      },
    ];
    expect(() => parseDefinition(JSON.stringify(d))).toThrow(/Protected/);
  });
  it("rejects duplicate ids, duplicate paths, too many fields, and excessive YAML nesting", () => {
    const d = structuredClone(definition);
    d.sections[0]!.fields.push(d.sections[0]!.fields[0]!);
    expect(() => parseDefinition(source(d))).toThrow(/Duplicate/);
    const duplicatePath = structuredClone(definition);
    duplicatePath.sections[0]!.fields.push({
      ...duplicatePath.sections[0]!.fields[0]!,
      id: "another",
    });
    expect(() => parseDefinition(source(duplicatePath))).toThrow(/Duplicate/);
    const excessive = structuredClone(definition);
    excessive.sections = ["first", "second"].map((section) => ({
      id: section,
      title: section,
      fields: Array.from({ length: 129 }, (_, index) => ({
        ...definition.sections[0]!.fields[0]!,
        id: `${section}${index}`,
        path: ["spec", `${section}${index}`],
      })),
    }));
    expect(() => parseDefinition(source(excessive))).toThrow(/256/);
    expect(() => parseDefinition("{a: ".repeat(20) + "1" + "}".repeat(20))).toThrow(/nesting/);
  });
});

it("bundles only supported Pod and Job inline edits and retains controller template edits", () => {
  const pod = bundledDefinitions.get("pods")!;
  const job = bundledDefinitions.get("jobs.batch")!;
  const fields = (selected: typeof pod) => selected.sections.flatMap((s) => s.fields);
  const podFields = fields(pod);
  expect(podFields.find((f) => f.id === "serviceAccount")).not.toHaveProperty("edit");
  const containers = podFields.find((f) => f.type === "table" && f.id === "containers");
  if (containers?.type !== "table") throw new Error("Missing containers");
  expect(containers.columns.find((c) => c.id === "pullPolicy")).not.toHaveProperty("edit");
  expect(containers.columns.find((c) => c.id === "image")?.edit).toEqual({ type: "string" });
  expect(fields(job).find((f) => f.id === "completions")).not.toHaveProperty("edit");
  const templateFields = fields(job).filter((field) => field.path.includes("template"));
  for (const field of templateFields) expect(field).not.toHaveProperty("edit");
  const templateColumns = templateFields.flatMap((field) =>
    field.type === "table" ? field.columns : [],
  );
  for (const column of templateColumns) expect(column).not.toHaveProperty("edit");
  for (const id of ["parallelism", "backoff"])
    expect(fields(job).find((f) => f.id === id)).toHaveProperty("edit");
  for (const type of ["deployments.apps", "cronjobs.batch"])
    expect(
      fields(bundledDefinitions.get(type)!).some(
        (f) => f.type === "table" && f.columns.some((c) => c.id === "image" && c.edit),
      ),
    ).toBe(true);
});
