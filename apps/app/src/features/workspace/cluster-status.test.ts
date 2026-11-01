import type { ClusterStatus } from "@hukube/engine-client";
import { expect, it } from "vitest";

import { clusterStatusPresentation } from "./cluster-status.ts";

it("distinguishes discovery permission failures from unavailable Clusters", () => {
  const forbidden: ClusterStatus = {
    phase: "failed",
    message: "discovery: unknown",
    error: { code: "forbidden", reason: "Forbidden", message: "unknown" },
  };
  expect(clusterStatusPresentation(forbidden)).toEqual({
    title: "Not permitted",
    description: "Your Kubernetes credentials cannot discover Resource Types for this Cluster.",
    detail: "Kubernetes reported Forbidden.",
    statusText: "Not permitted to access the Cluster: Forbidden",
  });

  const unavailable: ClusterStatus = {
    phase: "failed",
    message: "server version: dial tcp 127.0.0.1:7443: connect: connection refused",
    error: { code: "unavailable", message: "connection refused" },
  };
  expect(clusterStatusPresentation(unavailable)).toEqual({
    title: "Cluster unavailable",
    description:
      "hukube could not discover Resource Types because it could not reach this Cluster.",
    detail:
      "Technical detail: server version: dial tcp 127.0.0.1:7443: connect: connection refused",
    statusText:
      "Cluster unavailable: server version: dial tcp 127.0.0.1:7443: connect: connection refused",
  });
});

it("reserves the healthy empty presentation for a ready Cluster", () => {
  expect(clusterStatusPresentation(undefined)?.title).toBe("Connecting to Cluster");
  expect(clusterStatusPresentation({ phase: "connecting" })?.title).toBe("Connecting to Cluster");
  expect(clusterStatusPresentation({ phase: "ready", serverVersion: "v1.31.0" })).toBeUndefined();
});
