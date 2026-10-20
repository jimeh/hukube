import { describe, expect, it } from "vitest";

import { facetsFor, resolveFacet } from "./facets.ts";

describe("Facets", () => {
  it.each(["events", "events.events.k8s.io"])("offers YAML and Related for %s", (type) => {
    expect(facetsFor({ type }).map((f) => f.id)).toEqual(["yaml", "related"]);
    expect(resolveFacet("events", { type })).toBe("yaml");
  });
  it.each(["pods", "unknown.example"])(
    "offers YAML, Events, and Related before discovery for %s",
    (type) => {
      expect(facetsFor({ type }).map((f) => f.id)).toEqual(["yaml", "events", "related"]);
      expect(resolveFacet("events", { type })).toBe("events");
      expect(resolveFacet(undefined, { type })).toBe("yaml");
    },
  );
});

it.each(["pods", "events", "events.events.k8s.io", "__proto__", "constructor"])(
  "offers Related for every Resource Type, including %s",
  (type) => {
    expect(facetsFor({ type }).find((facet) => facet.id === "related")?.label).toBe("Related");
    expect(resolveFacet("related", { type })).toBe("related");
  },
);
