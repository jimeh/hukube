import { formatResourceUri } from "@hukube/k8s";
import { describe, expect, it } from "vitest";

import { newResourceUri, resourceEventsParams } from "./facet-rules.ts";

const address = { cluster: "c", type: "configmaps", namespace: "ns", name: "settings" };
const manifest = { metadata: { uid: "new" } };

describe("Events subscription params", () => {
  it("waits until the Manifest answers", () => {
    expect(resourceEventsParams(address, { stale: false }, undefined)).toBeUndefined();
  });
  it("uses the UID of the last Manifest and keeps it after deletion", () => {
    for (const data of [{ object: manifest }, { deleted: true }]) {
      expect(resourceEventsParams(address, { stale: false, data }, manifest)).toEqual({
        ...address,
        uid: "new",
      });
    }
    expect(
      resourceEventsParams(
        address,
        { stale: false, data: { object: { metadata: { uid: "recreated" } } } },
        { metadata: { uid: "recreated" } },
      )?.uid,
    ).toBe("recreated");
  });
  it("adds the static Pod hash as another UID", () => {
    const pod = {
      metadata: { uid: "mirror-uid", annotations: { "kubernetes.io/config.mirror": "hash" } },
    };
    expect(
      resourceEventsParams(
        { ...address, type: "pods" },
        { stale: false, data: { object: pod } },
        pod,
      ),
    ).toEqual({ ...address, type: "pods", uid: "mirror-uid", otherUids: ["hash"] });
  });
  it.each([
    ["Pod without the annotation", "pods", { annotations: {} }],
    [
      "non-Pod with the annotation",
      "configmaps",
      { annotations: { "kubernetes.io/config.mirror": "hash" } },
    ],
    ["empty annotation", "pods", { annotations: { "kubernetes.io/config.mirror": "" } }],
    ["non-string annotation", "pods", { annotations: { "kubernetes.io/config.mirror": 123 } }],
    ["null annotations", "pods", { annotations: null }],
    ["non-object annotations", "pods", { annotations: "hash" }],
    ["null metadata", "pods", null],
    ["non-object metadata", "pods", "hash"],
  ] as const)("omits otherUids for %s", (_name, type, metadata) => {
    const object = { metadata };
    expect(
      resourceEventsParams({ ...address, type }, { stale: false, data: { object } }, object),
    ).toEqual({ ...address, type });
  });
  it("has no UID when never found or the Manifest fails", () => {
    expect(
      resourceEventsParams(address, { stale: false, data: { deleted: true } }, undefined),
    ).toEqual(address);
    expect(
      resourceEventsParams(
        address,
        { stale: false, error: { code: "internal", message: "failed" } },
        undefined,
      ),
    ).toEqual(address);
    expect(
      resourceEventsParams(
        address,
        { stale: false, data: { object: {} } },
        { metadata: { uid: 123 } },
      ),
    ).toEqual(address);
  });
});

describe("New Resource tab Facets", () => {
  const uri = formatResourceUri(address);
  const active = formatResourceUri({ ...address, name: "other", facet: "events" });
  it("inherits the Pane's active Resource tab's Facet", () => {
    expect(newResourceUri(uri, active)).toBe(`${uri}#events`);
  });
  it("respects an explicit Facet and keeps a new tab's default URI", () => {
    expect(newResourceUri(`${uri}#yaml`, active)).toBe(`${uri}#yaml`);
    expect(newResourceUri(uri, undefined)).toBe(uri);
    expect(newResourceUri(uri, "list:pods")).toBe(uri);
  });
  it("falls back when the inherited Facet does not apply", () => {
    const eventUri = formatResourceUri({ ...address, type: "events" });
    expect(newResourceUri(eventUri, active)).toBe(`${eventUri}#yaml`);
    expect(newResourceUri(uri, `${eventUri}#events`)).toBe(`${uri}#yaml`);
  });
});
