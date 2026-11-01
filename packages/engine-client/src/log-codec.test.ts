/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { LogCodec } from "./log-codec.ts";

import { frame, source, status } from "./log-test-fixtures.ts";

it("decodes the Go golden frame, every flag, absent time, and invalid UTF-8", () => {
  const codec = new LogCodec();
  codec.event({
    ...status,
    sources: [7, 9].map((id) => ({ ...source, id, container: String(id) })),
  });
  const golden = readFileSync(
    new URL("../../../engine/internal/protocol/testdata/log-frame.golden", import.meta.url),
  );
  const buffer = golden.buffer.slice(golden.byteOffset, golden.byteOffset + golden.byteLength);
  expect(codec.decode(buffer)).toEqual([
    { source: 0, time: 1767225600123, text: "hello" },
    { source: 0, time: 0, text: "�␀␛", cut: true },
    { source: 1, time: 0, text: "", gap: true },
    { source: 1, time: 0, text: "Error, exit code 1", exited: true },
  ]);
  codec.event(status);
  expect(codec.decode(frame(7, 1, 0n, new Uint8Array([0xff, 0x61])))[0]).toMatchObject({
    text: "�a",
    time: 0,
    cut: true,
  });
  expect(() => codec.decode(new ArrayBuffer(2))).toThrow("Unknown Log Stream channel");
});

it("keeps source numbers and newest nanosecond cursors across sockets and suppresses repeated exits", () => {
  const codec = new LogCodec();
  expect(codec.event(status).sources[0]!.id).toBe(0);
  codec.decode(frame());
  codec.decode(frame(7, 0, 1234567891n));
  codec.decode(frame(7, 0, 1234567800n));
  expect(codec.params({ cluster: "c", type: "pods", name: "web", uid: "uid" }).resume).toEqual([
    { podUid: "uid", container: "constructor", instance: "run1", time: "1234567891" },
  ]);
  expect(codec.decode(frame(7, 4))).toHaveLength(1);
  codec.beginSocket();
  expect(codec.event({ ...status, sources: [{ ...source, id: 99 }] }).sources[0]!.id).toBe(0);
  expect(codec.decode(frame(99, 4))).toEqual([]);
  codec.event({ ...status, sources: [{ ...source, id: 99, instance: "run2" }] });
  expect(codec.decode(frame(99, 4))).toHaveLength(1);
  codec.beginSocket({ previous: true });
  codec.event({ ...status, sources: [{ ...source, id: 99, instance: "run2" }] });
  expect(codec.decode(frame(99, 4))).toHaveLength(1);
});
it("stops resuming a container once a ready status no longer lists it", () => {
  const codec = new LogCodec();
  const params = { cluster: "c", type: "pods", name: "web", uid: "uid" };
  codec.event(status);
  codec.decode(frame());
  // A new socket's first status is not ready and lists nothing yet.
  codec.beginSocket();
  codec.event({ ...status, ready: false, sources: [] });
  expect(codec.params(params).resume).toHaveLength(1);
  codec.event({ ...status, sources: [], pods: 0, followed: 0, loaded: 0 });
  expect(codec.params(params).resume).toEqual([]);
});
it("keeps the cursor of a Pod whose containers a ready status does not list yet", () => {
  const codec = new LogCodec();
  const params = { cluster: "c", type: "deployments.apps", name: "web", uid: "uid" };
  const other = { ...source, id: 8, pod: "web-b", podUid: "uid2" };
  const both = { ...status, sources: [source, other], pods: 2, followed: 2, loaded: 2 };
  codec.event(both);
  codec.decode(frame(7));
  codec.decode(frame(8));
  // Two Pods are followed and one is listed: the other is late, not gone.
  codec.event({ ...both, sources: [source], loaded: 1 });
  expect(codec.params(params).resume).toHaveLength(2);
  codec.event({ ...both, sources: [source], pods: 1, followed: 1, loaded: 1 });
  expect(codec.params(params).resume).toHaveLength(1);
});
it("forgets a Pod that left a stream narrowed to a container another Pod lacks", () => {
  const codec = new LogCodec();
  const params = { cluster: "c", type: "deployments.apps", name: "web", uid: "uid" };
  // Two Pods are followed and loaded, and only one has the chosen container.
  const narrowed = { ...status, pods: 2, followed: 2, loaded: 2 };
  codec.event(narrowed);
  codec.decode(frame(7));
  const next = { ...source, id: 8, pod: "web-c", podUid: "uid3" };
  codec.event({ ...narrowed, sources: [next] });
  codec.decode(frame(8));
  expect(codec.params(params).resume).toEqual([expect.objectContaining({ podUid: "uid3" })]);
});

it("prunes per-socket Engine IDs on every ordered status while retaining stable state through partial status", () => {
  const codec = new LogCodec();
  const other = { ...source, id: 8, pod: "web-b", podUid: "uid2", container: "sidecar" };
  const complete = { ...status, sources: [source, other], pods: 2, followed: 2, loaded: 2 };
  codec.event(complete);
  codec.decode(frame(7));
  codec.decode(frame(8, 4));
  expect(codec.diagnostics()).toEqual({
    identities: 2,
    socketSources: 2,
    cursors: 1,
    exited: 1,
    nextStableId: 2,
  });

  codec.event({ ...complete, ready: false, sources: [source], loaded: 0 });
  expect(codec.diagnostics()).toMatchObject({
    identities: 2,
    socketSources: 1,
    cursors: 1,
    exited: 1,
  });
  expect(() => codec.decode(frame(8))).toThrow("Unknown log source");
  codec.beginSocket();
  codec.event({ ...complete, ready: false, sources: [], loaded: 0 });
  expect(codec.diagnostics()).toMatchObject({
    identities: 2,
    socketSources: 0,
    cursors: 1,
    exited: 1,
  });
});

it("prunes identities, cursors, and exited deduplication only after definitive absence and never reuses IDs", () => {
  const codec = new LogCodec();
  const params = { cluster: "c", type: "pods", name: "web", uid: "uid" };
  expect(codec.event(status).sources[0]!.id).toBe(0);
  codec.decode(frame());
  codec.decode(frame(7, 4));
  codec.beginSocket();
  codec.event({ ...status, ready: false, sources: [], loaded: 0 });
  expect(codec.params(params).resume).toHaveLength(1);
  expect(codec.diagnostics()).toMatchObject({ identities: 1, cursors: 1, exited: 1 });

  codec.event({ ...status, sources: [], pods: 0, followed: 0, loaded: 0 });
  expect(codec.params(params).resume).toEqual([]);
  expect(codec.diagnostics()).toMatchObject({
    identities: 0,
    socketSources: 0,
    cursors: 0,
    exited: 0,
    nextStableId: 1,
  });
  expect(codec.event({ ...status, sources: [{ ...source, id: 99 }] }).sources[0]!.id).toBe(1);
  expect(codec.diagnostics().nextStableId).toBe(2);
});

it("keeps diagnostics bounded across repeated definitive source churn", () => {
  const codec = new LogCodec();
  for (let generation = 0; generation < 20; generation++) {
    const next = {
      ...source,
      id: generation + 10,
      pod: `web-${generation}`,
      podUid: `uid-${generation}`,
      instance: `run-${generation}`,
    };
    codec.beginSocket();
    codec.event({ ...status, sources: [next] });
    codec.decode(frame(next.id));
    expect(codec.diagnostics()).toMatchObject({
      identities: 1,
      socketSources: 1,
      cursors: 1,
      exited: 0,
    });
  }
  expect(codec.diagnostics().nextStableId).toBe(20);
});
