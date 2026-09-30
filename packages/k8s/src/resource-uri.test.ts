import { describe, expect, it } from "vitest";

import { formatResourceUri, parseResourceUri, type ResourceAddress } from "./resource-uri.ts";

describe("Resource URIs", () => {
  it.each<[string, ResourceAddress]>([
    [
      "namespaced core type",
      { cluster: "kind-dev", type: "pods", namespace: "default", name: "web-1" },
    ],
    [
      "cluster-scoped type",
      {
        cluster: "prod",
        type: "clusterroles.rbac.authorization.k8s.io",
        namespace: "",
        name: "system:basic-user",
      },
    ],
    [
      "cluster IDs with URI-significant characters",
      {
        cluster: "arn:aws:eks:eu-west-1:123:cluster/prod#1",
        type: "deployments.apps",
        namespace: "ns",
        name: "api",
        facet: "yaml",
      },
    ],
  ])("round-trips a %s", (_, address) => {
    expect(parseResourceUri(formatResourceUri(address))).toEqual(address);
  });

  it("uses a stable, versioned format", () => {
    expect(
      formatResourceUri({ cluster: "a/b", type: "pods", namespace: "", name: "x", facet: "yaml" }),
    ).toBe("hukube://resource/v1/a%2Fb/pods/_/x#yaml");
  });

  it.each([
    ["another scheme", "https://resource/v1/c/pods/ns/name"],
    ["a future version", "hukube://resource/v2/c/pods/ns/name"],
    ["missing segments", "hukube://resource/v1/c/pods/name"],
    ["an empty segment", "hukube://resource/v1/c//ns/name"],
    ["an unknown facet", "hukube://resource/v1/c/pods/ns/name#nope"],
    ["broken escapes", "hukube://resource/v1/%E0%A4%A/pods/ns/name"],
  ])("rejects %s", (_, uri) => {
    expect(parseResourceUri(uri)).toBeUndefined();
  });
});
