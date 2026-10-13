import { expect, it } from "vitest";
import { caretInEditableManifest } from "./caret.ts";
import { editableManifest, renderYaml } from "./yaml.ts";

it("keeps the same field and column when server-set lines above it disappear", () => {
  const live = {
    metadata: { uid: "u", creationTimestamp: "now", name: "web" },
    spec: { template: { metadata: { name: "web" } } },
  };
  const before = renderYaml(live);
  const after = renderYaml(editableManifest(live));
  const line = before.split("\n").findLastIndex((text) => text.includes("name: web")) + 1;
  const expected = after.split("\n").findLastIndex((text) => text.includes("name: web")) + 1;
  expect(caretInEditableManifest(before, after, { lineNumber: line, column: 8 })).toEqual({
    lineNumber: expected,
    column: 8,
  });
});
it("starts at the first line when there is no caret or its field was hidden", () => {
  expect(
    caretInEditableManifest("metadata:\n  uid: u\n", "metadata: {}\n", {
      lineNumber: 2,
      column: 1,
    }),
  ).toEqual({ lineNumber: 1, column: 1 });
  expect(caretInEditableManifest("", "kind: Pod\n", null)).toEqual({ lineNumber: 1, column: 1 });
});
