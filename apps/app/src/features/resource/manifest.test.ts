import { describe, expect, it } from "vitest";

import { manifestYaml } from "./manifest.ts";

const configMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: {
    name: "settings",
    managedFields: [{ manager: "kubectl", operation: "Apply" }],
  },
  data: { long: "x".repeat(200), same: "value", again: "value" },
};

describe("manifestYaml", () => {
  it("hides managed fields and keeps the server's key order", () => {
    const yaml = manifestYaml(configMap, { managedFields: false });
    expect(yaml).not.toContain("managedFields");
    expect(yaml.split("\n").slice(0, 4)).toEqual([
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: settings",
    ]);
  });

  it("shows managed fields when asked", () => {
    expect(manifestYaml(configMap, { managedFields: true })).toContain("manager: kubectl");
  });

  it("does not fold long values or alias repeated ones", () => {
    const yaml = manifestYaml(configMap, { managedFields: false });
    expect(yaml).toContain(`long: ${"x".repeat(200)}\n`);
    expect(yaml).not.toMatch(/[&*]a\d/);
  });
});
