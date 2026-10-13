import { describe, expect, it } from "vitest";

import { facetsFor, resolveFacet } from "./facets.ts";

describe("Facets", () => {
  it.each(["events", "events.events.k8s.io"])("offers only YAML for %s", (type) => {
    expect(facetsFor({ type }).map((f) => f.id)).toEqual(["yaml"]);
    expect(resolveFacet("events", { type })).toBe("yaml");
  });
  it.each(["pods", "unknown.example"])("offers YAML and Events before discovery for %s", (type) => {
    expect(facetsFor({ type }).map((f) => f.id)).toEqual(["yaml", "events"]);
    expect(resolveFacet("events", { type })).toBe("events");
    expect(resolveFacet(undefined, { type })).toBe("yaml");
  });
});
