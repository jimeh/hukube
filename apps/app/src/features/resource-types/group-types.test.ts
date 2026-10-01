import type { ResourceType } from "@hukube/engine-client";
import { describe, expect, it } from "vitest";

import { groupTypes } from "./group-types.ts";

function type(key: string, kind: string, count: number, shortNames?: string[]): ResourceType {
  const dot = key.indexOf(".");
  const group = dot === -1 ? "" : key.slice(dot + 1);
  return {
    key,
    group,
    version: "v1",
    resource: dot === -1 ? key : key.slice(0, dot),
    kind,
    namespaced: true,
    verbs: ["list", "watch"],
    state: "ready",
    count,
    ...(shortNames ? { shortNames } : {}),
  };
}

const types = [
  type("certificates.cert-manager.io", "Certificate", 2),
  type("ingresses.networking.k8s.io", "Ingress", 1),
  type("pods", "Pod", 5, ["po"]),
  type("deployments.apps", "Deployment", 3, ["deploy"]),
  type("configmaps", "ConfigMap", 4, ["cm"]),
  type("replicationcontrollers", "ReplicationController", 0, ["rc"]),
];

const summary = (opts: Parameters<typeof groupTypes>[1]) =>
  groupTypes(types, opts).map((g) => `${g.label}: ${g.types.map((t) => t.kind).join(", ")}`);

describe("groupTypes", () => {
  it("orders core, then built-in groups, then other groups, hiding empty types", () => {
    expect(summary({ filter: "", showEmpty: false })).toEqual([
      "core: ConfigMap, Pod",
      "apps: Deployment",
      "networking.k8s.io: Ingress",
      "cert-manager.io: Certificate",
    ]);
  });

  it("shows empty types when asked", () => {
    expect(summary({ filter: "", showEmpty: true })[0]).toBe(
      "core: ConfigMap, Pod, ReplicationController",
    );
  });

  it("filters by kind, type key, or exact short name, including empty types", () => {
    expect(summary({ filter: "cert", showEmpty: false })).toEqual(["cert-manager.io: Certificate"]);
    expect(summary({ filter: "rc", showEmpty: false })).toEqual(["core: ReplicationController"]);
    expect(summary({ filter: ".apps", showEmpty: false })).toEqual(["apps: Deployment"]);
  });
});
