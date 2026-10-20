import { formatResourceUri, parseResourceUri } from "@hukube/k8s";
import { newResourceUri } from "./facet-rules.ts";
import { ownsPods } from "./logs-rule.ts";
import { describe, expect, it } from "vitest";

import { facetsFor, resolveFacet } from "./facets.ts";

describe("Facets", () => {
  it.each(["events", "events.events.k8s.io"])("offers YAML and Related for %s", (type) => {
    expect(facetsFor({ type }).map((f) => f.id)).toEqual(["yaml", "related"]);
    expect(resolveFacet("events", { type })).toBe("yaml");
  });
  it.each(["unknown.example"])(
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

it("offers Logs for fixed workload types and discovered Pod ownership, with URI inheritance", () => {
  for (const type of [
    "pods",
    "deployments.apps",
    "replicasets.apps",
    "statefulsets.apps",
    "daemonsets.apps",
    "jobs.batch",
    "cronjobs.batch",
    "replicationcontrollers",
  ])
    expect(facetsFor({ type }).map((facet) => facet.id)).toEqual([
      "yaml",
      "logs",
      "events",
      "related",
    ]);
  expect(resolveFacet("logs", { type: "constructor" })).toBe("yaml");
  expect(resolveFacet("logs", { type: "constructor", logs: true })).toBe("logs");
  const address = {
    cluster: "c",
    type: "pods",
    namespace: "ns",
    name: "constructor",
    facet: "logs" as const,
  };
  expect(parseResourceUri(formatResourceUri(address))).toEqual(address);
  expect(
    newResourceUri(formatResourceUri({ ...address, facet: undefined }), formatResourceUri(address)),
  ).toBe(formatResourceUri(address));
  expect(
    ownsPods({
      found: true,
      total: 1,
      sections: [
        {
          relationship: "owns",
          direction: "out",
          rows: [{ type: "pods", kind: "Pod", status: "found", depth: 1 }],
          total: 1,
        },
      ],
      types: [],
    }),
  ).toBe(true);
  expect(
    ownsPods({
      found: true,
      total: 1,
      sections: [{ relationship: "owns", direction: "out", rows: [], total: 10, truncated: true }],
      types: [],
    }),
  ).toBe(true);
  expect(
    ownsPods({
      found: true,
      total: 1,
      sections: [
        {
          relationship: "owns",
          direction: "in",
          rows: [{ type: "pods", kind: "Pod", status: "found", depth: 1 }],
          total: 1,
        },
      ],
      types: [],
    }),
  ).toBe(false);
});
