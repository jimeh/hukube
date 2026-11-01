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

it("updates all three budgets in place, reports precise loss, and never restores discarded rows", () => {
  const doc = new LogDocument("pods", { lines: 10, characters: 100, decorations: 10 });
  doc.status(status);
  doc.append(
    ["one", "two", "three"].map((text) => ({
      source: 7,
      time: 0,
      text,
      spans: [[0, 1, 1, -1, 0]],
    })),
  );
  const rewrites = doc.rewrites;
  expect(doc.updateBudgets({ lines: 2, characters: 100, decorations: 10 })).toBe(1);
  expect(doc.rows.map((row) => row.text)).toEqual(["two", "three"]);
  expect(doc.rewrites).toBe(rewrites);
  expect(doc.updateBudgets({ lines: 10, characters: 100, decorations: 10 })).toBe(0);
  expect(doc.rows.map((row) => row.text)).toEqual(["two", "three"]);
  expect(doc.updateBudgets({ lines: 10, characters: 100, decorations: 1 })).toBe(1);
  expect(doc.rows.map((row) => row.text)).toEqual(["three"]);
  expect(doc.updateBudgets({ lines: 10, characters: 5, decorations: 10 })).toBe(1);
  expect(doc.rows).toEqual([]);
  expect(doc.updateBudgets({ lines: 10, characters: 5, decorations: 10 })).toBe(0);
});

it("drops a row that exceeds a character or styled-range budget by itself", () => {
  const characters = new LogDocument("pods", { lines: 10, characters: 4, decorations: 10 });
  characters.status(status);
  characters.append([{ source: 7, time: 0, text: "four" }]);
  expect(characters.rows).toEqual([]);

  const decorations = new LogDocument("pods", {
    lines: 10,
    characters: 100,
    decorations: 1,
  });
  decorations.status(status);
  decorations.append([
    {
      source: 7,
      time: 0,
      text: "styled",
      spans: [
        [0, 1, 1, -1, 0],
        [1, 2, 2, -1, 0],
      ],
    },
  ]);
  expect(decorations.rows).toEqual([]);
});

it("reports loss caused by timestamp and origin rebuilds through the same signal", () => {
  const timestamped = new LogDocument("pods", {
    lines: 10,
    characters: 24,
    decorations: 10,
  });
  timestamped.status(status);
  timestamped.append([
    { source: 7, time: new Date(2026, 9, 13, 1, 2, 3, 4).getTime(), text: "a" },
    { source: 7, time: new Date(2026, 9, 13, 1, 2, 3, 5).getTime(), text: "b" },
  ]);
  expect(timestamped.timestamps(true)).toBe(1);
  expect(timestamped.rows).toHaveLength(1);

  const origin = new LogDocument("deployments.apps", {
    lines: 10,
    characters: 11,
    decorations: 10,
  });
  origin.status(status);
  origin.append([{ source: 7, time: 0, text: "first" }]);
  expect(
    origin.status({
      ...status,
      sources: [source, { ...source, id: 8, pod: "other-x", podUid: "uid2" }],
      pods: 2,
      followed: 2,
      loaded: 2,
    }),
  ).toBe(1);
  expect(origin.rows).toEqual([]);
});

it("keeps current and row-referenced sources, then prunes sources and colors at their liveness boundary", () => {
  const first = { ...source, pod: "app-old-aaa", podUid: "old" };
  const second = { ...source, id: 8, pod: "app-new-bbb", podUid: "new" };
  const doc = new LogDocument("deployments.apps", {
    lines: 10,
    characters: 1_000,
    decorations: 100,
  });
  doc.status({ ...status, sources: [first] });
  doc.append([{ source: first.id, time: 0, text: "old" }]);
  doc.status({ ...status, sources: [second] });
  doc.append([{ source: second.id, time: 0, text: "new" }]);
  expect(doc.diagnostics()).toMatchObject({
    entries: 2,
    sources: 2,
    currentSources: 1,
    referencedSources: 2,
    colors: 2,
  });

  doc.status({ ...status, ready: false, sources: [], loaded: 0 });
  expect(doc.diagnostics().currentSources).toBe(1);
  const before = doc.rows.map((row) => row.text);
  const rewrites = doc.rewrites;
  expect(doc.updateBudgets({ lines: 1, characters: 1_000, decorations: 100 })).toBe(1);
  expect(doc.diagnostics()).toMatchObject({ sources: 1, referencedSources: 1, colors: 1 });
  expect(doc.rows[0]!.text).toBe(before[1]);
  expect(doc.rows[0]!.text).toContain("new-bbb");
  expect(doc.rewrites).toBe(rewrites);

  doc.status({ ...status, sources: [], pods: 0, followed: 0, loaded: 0 });
  expect(doc.diagnostics().sources).toBe(1);
  doc.clear();
  expect(doc.diagnostics()).toMatchObject({
    entries: 0,
    sources: 0,
    currentSources: 0,
    referencedSources: 0,
    colors: 0,
  });
});

it("only shortens the initialized common Pod prefix and never rewrites merely because sources prune", () => {
  const first = { ...source, pod: "web-old-aaa", podUid: "old" };
  const second = { ...source, id: 8, pod: "web-new-bbb", podUid: "new" };
  const third = { ...source, id: 9, pod: "api-ccc", podUid: "third" };
  const doc = new LogDocument("deployments.apps", {
    lines: 10,
    characters: 1_000,
    decorations: 100,
  });
  doc.status({ ...status, sources: [first, second], pods: 2, followed: 2, loaded: 2 });
  doc.append([
    { source: first.id, time: 0, text: "one" },
    { source: second.id, time: 0, text: "two" },
  ]);
  const secondText = doc.rows[1]!.text;
  doc.status({ ...status, sources: [second] });
  const afterStatus = doc.rewrites;
  doc.updateBudgets({ lines: 1, characters: 1_000, decorations: 100 });
  expect(doc.rows[0]!.text).toBe(secondText);
  expect(doc.rewrites).toBe(afterStatus);
  doc.status({ ...status, sources: [second, third], pods: 2, followed: 2, loaded: 2 });
  expect(doc.rows[0]!.text).not.toBe(secondText);
  expect(doc.rows[0]!.text).toContain("web-new-bbb");
});

it("initializes the common Pod prefix from the first definitive live set", () => {
  const stale = { ...source, pod: "api-old-aaa", podUid: "stale" };
  const first = { ...source, id: 8, pod: "web-new-aaa", podUid: "first" };
  const second = { ...source, id: 9, pod: "web-new-bbb", podUid: "second" };
  const doc = new LogDocument("deployments.apps");
  doc.status({ ...status, ready: false, sources: [stale], loaded: 0 });
  doc.status({ ...status, sources: [first] });
  doc.append([{ source: first.id, time: 0, text: "line" }]);
  doc.status({ ...status, sources: [first, second], pods: 2, followed: 2, loaded: 2 });
  expect(doc.rows[0]!.text).toBe("aaa line");
});
