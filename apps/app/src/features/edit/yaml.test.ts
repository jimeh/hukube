import { describe, expect, it } from "vitest";
import { editableManifest, parseManifest, renderYaml } from "./yaml.ts";
import { fieldIssue, fieldLabel } from "./field-paths.ts";

describe("kubectl YAML", () => {
  it.each([
    ["0644", 420],
    ["yes", true],
    ["on", true],
    ["1_000", 1000],
    ["1:30", "1:30"],
    ["1:30.5", "1:30.5"],
    ["2026-10-13T10:20:30Z", "2026-10-13T10:20:30Z"],
  ])("reads %s as kubectl does", (text, value) => {
    expect(parseManifest(`value: ${text}`).object).toEqual({ value });
  });
  it("round-trips scalar strings and values without non-JSON tags", () => {
    const values = {
      octal: "0644",
      yes: "yes",
      on: "on",
      number: "1_000",
      time: "1:30",
      timestamp: "2026-10-13T10:20:30Z",
      integer: 420,
      boolean: true,
      null: null,
      list: ["yes", 1],
      data: Object.fromEntries([
        ["constructor", "safe"],
        ["__proto__", "literal"],
      ]),
    };
    expect(parseManifest(renderYaml(values)).object).toEqual(values);
  });
  it.each(["a: 1\na: 2", "a: 1\n---\nb: 2", "- one", "a: ["])(
    "rejects invalid Manifest %s with a position",
    (text) => {
      const result = parseManifest(text);
      expect(result.object).toBeUndefined();
      expect(result.issues[0]?.line).toBeGreaterThan(0);
    },
  );
  it("removes only server-set fields", () => {
    expect(
      editableManifest({
        kind: "Pod",
        status: {},
        metadata: {
          uid: "u",
          resourceVersion: "1",
          creationTimestamp: "now",
          name: "p",
          finalizers: ["keep"],
        },
        spec: {},
      }),
    ).toEqual({ kind: "Pod", metadata: { name: "p", finalizers: ["keep"] }, spec: {} });
  });
  it("locates list indices and literal dotted label keys for refusal markers", () => {
    const parsed = parseManifest(
      "metadata:\n  labels:\n    app.kubernetes.io/name: web\nspec:\n  containers:\n    - image: bad\n",
    );
    expect(fieldIssue(parsed, "metadata.labels.app.kubernetes.io/name", "invalid")?.line).toBe(3);
    expect(fieldIssue(parsed, "spec.containers[0].image", "invalid")?.line).toBe(6);
    expect(fieldIssue(parsed, "spec.missing", "invalid")).toBeUndefined();
    expect(fieldLabel(["metadata", "labels", "__proto__"])).toBe("metadata.labels.__proto__");
    expect(fieldLabel(["metadata", "labels", "app.kubernetes.io/name"])).toBe(
      'metadata.labels["app.kubernetes.io/name"]',
    );
  });
});
