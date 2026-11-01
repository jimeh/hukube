import { expect, it, vi } from "vitest";
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

it("forks bounded candidates and atomically replaces rows, status, formatting, and loss state", () => {
  const budgets = { lines: 3, characters: 1_000, decorations: 100 };
  const doc = new LogDocument("pods", budgets);
  doc.status(status);
  doc.timestamps(true);
  doc.append([
    { source: source.id, time: 1_767_225_600_000, text: "one" },
    { source: source.id, time: 1_767_225_601_000, text: "two" },
    { source: source.id, time: 1_767_225_602_000, text: "three" },
  ]);
  doc.updateBudgets({ ...budgets, lines: 2 });
  expect(doc.retentionLoss).toBe(true);

  const fork = doc.fork();
  const empty = doc.emptyFork();
  expect(fork.rows.map(({ text }) => text)).toEqual(doc.rows.map(({ text }) => text));
  expect(fork.retentionLoss).toBe(true);
  expect(empty.rows).toEqual([]);
  expect(empty.retentionLoss).toBe(false);
  const replacementStatus = {
    ...status,
    sources: [{ ...source, instance: "run-2", error: "partial" }],
  };
  empty.status(replacementStatus);
  empty.append([{ source: source.id, time: 1_767_225_603_000, text: "replacement" }]);
  expect(empty.rows[0]!.text).toMatch(/replacement$/);

  const changed = vi.fn<() => void>();
  const unsubscribe = doc.subscribe(changed);
  const revision = doc.revision;
  const rewrites = doc.rewrites;
  doc.replaceFrom(empty);
  expect(changed).toHaveBeenCalledOnce();
  expect(doc.revision).toBe(revision + 1);
  expect(doc.rewrites).toBe(rewrites + 1);
  expect(doc.rows.map(({ text }) => text)).toEqual([expect.stringMatching(/replacement$/)]);
  expect(doc.displayedStatus).toBe(replacementStatus);
  expect(doc.retentionLoss).toBe(false);
  expect(empty.diagnostics()).toMatchObject({
    entries: 0,
    sources: 0,
    currentSources: 0,
    referencedSources: 0,
    colors: 0,
  });

  fork.release();
  expect(fork.diagnostics()).toMatchObject({
    entries: 0,
    sources: 0,
    currentSources: 0,
    referencedSources: 0,
    colors: 0,
  });
  unsubscribe();
});

it("selectively reconciles changed epochs without restoring unchanged rows or erasing their loss", () => {
  const first = { ...source, id: 0, instance: "a-1", container: "main" };
  const second = {
    ...source,
    id: 1,
    pod: "web-b",
    podUid: "uid-b",
    instance: "b-1",
    container: "sidecar",
  };
  const committedStatus = {
    ...status,
    sources: [first, second],
    pods: 2,
    followed: 2,
    loaded: 2,
  };
  const doc = new LogDocument("deployments.apps", {
    lines: 10,
    characters: 10_000,
    decorations: 1_000,
  });
  doc.status(committedStatus);
  doc.append([
    { source: 0, time: 1, text: "a-evicted" },
    { source: 0, time: 2, text: "a-retained" },
    { source: 1, time: 3, text: "b-old" },
  ]);
  doc.lossMarker([
    { source: 0, instance: "a-1", records: 2 },
    { source: 1, instance: "b-1", records: 3 },
  ]);
  doc.updateBudgets({ lines: 3, characters: 10_000, decorations: 1_000 });
  expect(doc.rows.map(({ text }) => text).join("|")).not.toContain("a-evicted");
  doc.updateBudgets({ lines: 20, characters: 10_000, decorations: 1_000 });

  const changed = { ...second, instance: "b-2" };
  const added = {
    ...source,
    id: 2,
    pod: "web-c",
    podUid: "uid-c",
    instance: "c-1",
    container: "worker",
  };
  const nextStatus = {
    ...status,
    sources: [first, changed, added],
    pods: 3,
    followed: 3,
    loaded: 3,
  };
  const staged = doc.emptyFork();
  staged.status(nextStatus);
  staged.append([
    { source: 1, time: 4, text: "b-new" },
    { source: 2, time: 5, text: "c-new" },
  ]);
  staged.lossMarker([
    { source: 1, instance: "b-2", records: 4 },
    { source: 2, instance: "c-1", records: 1 },
  ]);

  const beforeRevision = doc.revision;
  const beforeRewrites = doc.rewrites;
  doc.reconcile(staged, new Set([1]), nextStatus);

  expect(doc.revision).toBe(beforeRevision + 1);
  expect(doc.rewrites).toBe(beforeRewrites + 1);
  expect(doc.rows.map(({ text }) => text)).toEqual([
    expect.stringContaining("a-retained"),
    "··· 2 lines dropped: they arrived faster than they could be shown ···",
    expect.stringContaining("b-new"),
    expect.stringContaining("c-new"),
    "··· 5 lines dropped: they arrived faster than they could be shown ···",
  ]);
  expect(doc.rows.map(({ sequence }) => sequence)).toEqual([1, 3, 4, 5, 6]);
  expect(doc.rows.map(({ text }) => text).join("|")).not.toMatch(/a-evicted|b-old/);
  expect(doc.retentionLoss).toBe(true);
});

it("drops a superseded staged epoch and carries staged retention loss into reconciliation", () => {
  const doc = new LogDocument("pods", { lines: 10, characters: 1_000, decorations: 100 });
  const first = { ...source, id: 0, instance: "i1", previous: true };
  doc.status({ ...status, sources: [first] });
  doc.append([{ source: 0, time: 1, text: "i1" }]);

  const staged = doc.emptyFork();
  const second = { ...first, instance: "i2" };
  staged.status({ ...status, ready: false, sources: [second] });
  staged.append([
    { source: 0, time: 2, text: "i2-old" },
    { source: 0, time: 3, text: "i2-last" },
  ]);
  staged.updateBudgets({ lines: 1, characters: 1_000, decorations: 100 });
  expect(staged.retentionLoss).toBe(true);
  staged.discardSources(new Set([0]));
  const third = { ...first, instance: "i3" };
  const nextStatus = { ...status, sources: [third] };
  staged.status(nextStatus);
  staged.append([{ source: 0, time: 4, text: "i3" }]);

  doc.reconcile(staged, new Set([0]), nextStatus);
  expect(doc.rows.map(({ text }) => text)).toEqual(["i3"]);
  expect(doc.retentionLoss).toBe(true);
});
