import { expect, it } from "vitest";
import { LogDocument, commonPodPrefix, formatLogTime, logOrigin } from "./log-document.ts";
import { source, status } from "../../../../../packages/engine-client/src/log-test-fixtures.ts";

it("formats timestamps, Pod and workload origins, cut lines, and record markers as text", () => {
  const date = new Date(2026, 9, 13, 1, 2, 3, 4);
  expect(formatLogTime(date.getTime(), date)).toBe("01:02:03.004");
  expect(formatLogTime(new Date(2026, 9, 12, 1, 2, 3, 4).getTime(), date)).toBe(
    "10-12 01:02:03.004",
  );
  expect(formatLogTime(0)).toBe("");
  expect(logOrigin({ ...source, pod: "web-a-b" }, "deployments.apps", 4, true)).toBe(
    "a-b/constructor",
  );
  expect(logOrigin({ ...source, pod: "db-0" }, "statefulsets.apps", 3, false)).toBe("0");
  expect(logOrigin(source, "pods", 0, true)).toBe("constructor");
  // One ReplicaSet's Pods differ in their last part, two ReplicaSets' in their hash too.
  expect(commonPodPrefix(["web-6ddb-p656b", "web-6ddb-p6aaa"])).toBe("web-6ddb-".length);
  expect(commonPodPrefix(["web-6ddb-p656b", "web-7c5d-fv79n"])).toBe("web-".length);
  expect(commonPodPrefix(["db-0", "db-1"])).toBe("db-".length);
  expect(commonPodPrefix(["web-6ddb-p656b"])).toBe("web-6ddb-".length);
  expect(commonPodPrefix(["solo"])).toBe(0);
  expect(commonPodPrefix(["web", "web-2"])).toBe(0);
  expect(commonPodPrefix([])).toBe(0);
  const doc = new LogDocument("pods");
  doc.status(status);
  doc.append([
    {
      source: 7,
      time: date.getTime(),
      text: '<img onerror="bad">',
      cut: true,
      spans: [[0, 4, 1, -1, 1]],
    },
    { source: 7, time: 0, text: "", gap: true },
    { source: 7, time: 0, text: "Error, exit code 1", exited: true },
  ]);
  expect(doc.rows.map((row) => row.text)).toEqual([
    '<img onerror="bad"> … cut at 64 KiB',
    "··· some lines may be missing ···",
    "··· the container exited: Error, exit code 1 ···",
  ]);
  doc.timestamps(true);
  expect(doc.rows[0]!.text).toContain("01:02:03.004");
  doc.status({
    ...status,
    sources: [source, { ...source, id: 8, pod: "web-b", podUid: "uid2", container: "__proto__" }],
  });
  expect(doc.rows[1]!.text).toBe("··· constructor: some lines may be missing ···");
  expect(doc.rows[0]!.spans.map((span) => span.className)).toContain("log-fg-6");
});
it("retains the newest rows within line, character, and decoration budgets including display prefixes", () => {
  for (const [budgets, expected] of [
    [{ lines: 2, characters: 100, decorations: 100 }, ["two", "three"]],
    [{ lines: 100, characters: 10, decorations: 100 }, ["two", "three"]],
    [{ lines: 100, characters: 100, decorations: 2 }, ["two", "three"]],
  ] as const) {
    const doc = new LogDocument("pods", budgets);
    doc.status(status);
    doc.append(
      ["one", "two", "three"].map((text) => ({
        source: 7,
        time: Date.now(),
        text,
        spans: [[0, 1, 1, -1, 0]],
      })),
    );
    expect(doc.rows.map((row) => row.text)).toEqual(expected);
  }
  const doc = new LogDocument("pods", { lines: 100, characters: 25, decorations: 100 });
  doc.status(status);
  doc.append(["one", "two"].map((text) => ({ source: 7, time: Date.now(), text })));
  doc.timestamps(true);
  expect(doc.rows).toHaveLength(1);
  expect(doc.rows[0]!.text).toContain("two");
});
it("colors origins by container on a Pod's tab and by Pod on a workload's", () => {
  const sources = [
    source,
    { ...source, id: 8, container: "sidecar" },
    { ...source, id: 9, pod: "web-b", podUid: "uid2" },
  ];
  const lines = sources.map(({ id }) => ({ source: id, time: 0, text: "x" }));
  const colors = (type: string) => {
    const doc = new LogDocument(type);
    doc.status({ ...status, sources });
    doc.append(lines);
    return doc.rows.map((row) => row.spans[0]!.className);
  };
  const [app, sidecar, otherPod] = colors("pods");
  expect(sidecar).not.toBe(app);
  expect(otherPod).toBe(app);
  const [first, sameWorkloadPod, second] = colors("deployments.apps");
  expect(sameWorkloadPod).toBe(first);
  expect(second).not.toBe(first);
});
it("trims each budget immediately without rewriting survivors and never restores removed rows", () => {
  for (const budgets of [
    { lines: 2, characters: 1000, decorations: 1000 },
    { lines: 100, characters: 12, decorations: 1000 },
    { lines: 100, characters: 1000, decorations: 2 },
  ]) {
    const doc = new LogDocument("pods");
    doc.status(status);
    doc.append(
      ["one", "two", "three"].map((text) => ({
        source: 7,
        time: 1,
        text,
        spans: [[0, 1, 1, -1, 0]],
      })),
    );
    const survivor = doc.rows[2];
    const rewrites = doc.rewrites;
    let changes = 0;
    doc.subscribe(() => changes++);
    doc.updateBudgets(budgets);
    expect(doc.rows.map((row) => row.text)).toEqual(["two", "three"]);
    expect(doc.rows[1]).toBe(survivor);
    expect(doc.rewrites).toBe(rewrites);
    expect(changes).toBe(1);
    expect(doc.evictedLines).toBe(1);
    doc.updateBudgets({ lines: 100, characters: 1000, decorations: 1000 });
    expect(doc.rows).toHaveLength(2);
    doc.updateBudgets({ lines: 1, characters: 1, decorations: 1 });
    expect(doc.rows).toEqual([]);
    expect(doc.evictedLines).toBe(3);
  }
});
it("collects retired descriptors and colors through repeated rollouts while preserving old-row formatting", () => {
  const doc = new LogDocument("deployments.apps");
  const first = { ...source, pod: "web-first", podUid: "old", id: 1 };
  doc.status({
    ...status,
    sources: [first, { ...first, id: 2, pod: "web-other", podUid: "other" }],
  });
  doc.append([{ source: 1, time: 0, text: "old retained" }]);
  const oldText = doc.rows[0]!.text,
    oldColor = doc.rows[0]!.spans[0]!.className;
  for (let i = 3; i < 200; i++) {
    doc.status({
      ...status,
      sources: [{ ...first, id: i, pod: `web-next-${i}`, podUid: String(i) }],
    });
    expect(doc.metadataSnapshot()).toMatchObject({ sources: 2, colors: 2, retained: 1 });
    doc.timestamps(true);
    doc.timestamps(false);
    // A shorter common prefix may legitimately reveal more of all names, but old source identity/color survives.
    expect(doc.rows[0]!.text).toContain("first old retained");
    expect(doc.rows[0]!.spans[0]!.className).toBe(oldColor);
  }
  expect(oldText).toBe("first old retained");
  doc.clear();
  expect(doc.metadataSnapshot()).toEqual({ sources: 1, colors: 1, retained: 0 });
  doc.end();
  expect(doc.metadataSnapshot()).toEqual({ sources: 0, colors: 0, retained: 0 });
});
