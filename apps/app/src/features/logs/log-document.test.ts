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

it("generates notices for first loss, settings eviction and first loss after Clear, keeping cumulative counts and sequences", () => {
  const doc = new LogDocument("pods", { lines: 3, characters: 100, decorations: 100 });
  const append = (texts: string[]) =>
    doc.append(texts.map((text) => ({ source: 7, time: 1, text })));
  expect(doc.lossGeneration).toBe(0);
  append(["one", "two", "three", "four"]);
  expect(doc.lossGeneration).toBe(1);
  append(["five", "six"]);
  expect(doc.evictedLines).toBe(3);
  expect(doc.lossGeneration).toBe(1);
  doc.updateBudgets({ ...doc.budgets, lines: 4 });
  doc.updateBudgets({ ...doc.budgets, lines: 3 });
  expect(doc.lossGeneration).toBe(1);
  doc.updateBudgets({ ...doc.budgets, lines: 2 });
  expect(doc.evictedLines).toBe(4);
  expect(doc.lossGeneration).toBe(2);
  doc.timestamps(true);
  // Formatted prefixes now exceed the character budget only after it is reduced.
  doc.updateBudgets({ ...doc.budgets, characters: 1 });
  expect(doc.evictedLines).toBe(6);
  expect(doc.lossGeneration).toBe(3);
  doc.clear();
  expect(doc.evictedLines).toBe(0);
  expect(doc.lossGeneration).toBe(3);
  append(["seven"]);
  expect(doc.rows).toEqual([]);
  expect(doc.lossGeneration).toBe(4);
  expect(doc.evictedLines).toBe(1);
  doc.updateBudgets({ ...doc.budgets, characters: 100 });
  append(["eight"]);
  expect(doc.rows[0]!.sequence).toBe(7);
  expect(doc.lossGeneration).toBe(4);
});

it("starts a new loss generation when confirmed timestamp formatting evicts more content", () => {
  const doc = new LogDocument("pods", { lines: 2, characters: 30, decorations: 100 });
  doc.append(["one", "two", "three"].map((text) => ({ source: 7, time: 1, text })));
  expect(doc.lossGeneration).toBe(1);
  doc.timestamps(true);
  expect(doc.evictedLines).toBe(2);
  expect(doc.lossGeneration).toBe(2);
  doc.timestamps(true);
  doc.timestamps(false);
  expect(doc.lossGeneration).toBe(2);
});

it.each(["characters", "decorations"] as const)(
  "applies formatting and %s capacity together in both directions, notifying once and preserving sequences/references",
  (budget) => {
    const doc = new LogDocument("pods", { lines: 10, characters: 1000, decorations: 100 });
    doc.status(status);
    doc.append(
      ["one", "two", "six"].map((text) => ({
        source: 7,
        time: 1,
        text,
        spans: [[0, 1, 1, -1, 0]],
      })),
    );
    doc.end();
    const ids = doc.rows.map((row) => row.sequence);
    const plain = doc.rows.map((row) => row.text);
    const tight = budget === "characters" ? 12 : 3;
    let notifications = 0;
    doc.subscribe(() => notifications++);
    // Enlarging capacity must happen before timestamps can add text/styles.
    doc.applyPreferences({
      lines: 3,
      characters: budget === "characters" ? tight : 1000,
      decorations: budget === "decorations" ? tight : 100,
      timestamps: false,
    });
    doc.applyPreferences({ lines: 3, characters: 1000, decorations: 100, timestamps: true });
    expect(doc.rows.map((row) => row.sequence)).toEqual(ids);
    expect(doc.rows.every((row) => row.spans.length === 2)).toBe(true);
    expect(doc.rows.every((row) => row.spans[1]!.className === "log-fg-1")).toBe(true);
    const changes = notifications;
    const rewrites = doc.rewrites;
    // Reducing capacity must happen after removing timestamp text/styles.
    const final = {
      lines: 3,
      characters: budget === "characters" ? tight : 1000,
      decorations: budget === "decorations" ? tight : 100,
      timestamps: false,
    };
    doc.applyPreferences(final);
    expect(doc.rows.map((row) => row.text)).toEqual(plain);
    expect(doc.rows.map((row) => row.sequence)).toEqual(ids);
    expect(doc.evictedLines).toBe(0);
    expect(doc.lossGeneration).toBe(0);
    expect(doc.retainedSources()).toEqual([7]);
    expect(doc.metadataSnapshot()).toEqual({ sources: 1, colors: 1, retained: 1 });
    expect(notifications).toBe(changes + 1);
    expect(doc.rewrites).toBe(rewrites + 1);
    doc.applyPreferences(final);
    expect(notifications).toBe(changes + 1);
    expect(doc.rewrites).toBe(rewrites + 1);
    doc.applyPreferences({ ...final, characters: 1 });
    expect(doc.evictedLines).toBe(3);
    expect(doc.lossGeneration).toBe(1);
    expect(doc.metadataSnapshot()).toEqual({ sources: 0, colors: 0, retained: 0 });
  },
);

it("resets the actual default budgets and timestamps without losing any of 50000 rows that fit the final snapshot", () => {
  const doc = new LogDocument("pods", { lines: 100000, characters: 64000000, decorations: 400000 });
  doc.timestamps(true);
  doc.append(Array.from({ length: 50000 }, () => ({ source: 7, time: 1, text: "x".repeat(630) })));
  expect(doc.rows).toHaveLength(50000);
  const rewrites = doc.rewrites;
  doc.applyPreferences({
    lines: 50000,
    characters: 32000000,
    decorations: 200000,
    timestamps: false,
  });
  expect(doc.rows).toHaveLength(50000);
  expect(doc.rows[0]!.sequence).toBe(0);
  expect(doc.rows.at(-1)!.sequence).toBe(49999);
  expect(doc.rows.reduce((sum, row) => sum + row.text.length + 1, 0)).toBe(31550000);
  expect(doc.rows.every((row) => row.text === "x".repeat(630))).toBe(true);
  expect(doc.evictedLines).toBe(0);
  expect(doc.rewrites).toBe(rewrites + 1);
});

it("validates every preference before mutating formatting, budgets, rows or notifications", () => {
  const doc = new LogDocument("pods");
  doc.append([{ source: 7, time: 1, text: "one" }]);
  const rows = doc.rows,
    revision = doc.revision,
    rewrites = doc.rewrites;
  const settings = { ...doc.budgets, timestamps: true };
  for (const invalid of [
    { lines: 0 },
    { characters: 64000001 },
    { decorations: 1.5 },
    { timestamps: "yes" },
  ]) {
    expect(() => doc.applyPreferences({ ...settings, ...invalid } as typeof settings)).toThrow(
      /Invalid/,
    );
    expect(doc.rows).toBe(rows);
    expect(doc.rows[0]!.text).toBe("one");
    expect(doc.revision).toBe(revision);
    expect(doc.rewrites).toBe(rewrites);
    expect(doc.budgets).toEqual({ lines: 50000, characters: 32000000, decorations: 200000 });
  }
});

it("projects literal payload text with include AND exclude, Unicode case and literal whitespace", () => {
  const doc = new LogDocument("pods");
  doc.append(
    ["Error Café", "error debug", " ERROR ", "   ", "[.*]"].map((text) => ({
      source: 7,
      time: 1,
      text,
    })),
  );
  const originals = [...doc.rows];
  const show = (include = "", exclude = "", matchCase = false) => {
    doc.filter({ include, exclude, matchCase });
    return doc.visibleRows.map((row) => row.text);
  };
  expect(show("error", "debug")).toEqual(["Error Café", " ERROR "]);
  expect(doc.retainedLines).toBe(5);
  expect(doc.matchingLines).toBe(2);
  expect(doc.projectedRows).toBe(2);
  expect(show("CAFÉ")).toEqual(["Error Café"]);
  expect(show("error", "", true)).toEqual(["error debug"]);
  expect(show(" ")).toEqual(["Error Café", "error debug", " ERROR ", "   "]);
  expect(show("[.*]")).toEqual(["[.*]"]);
  expect(show("missing")).toEqual([]);
  expect(doc.matchingLines).toBe(0);
  expect(show()).toEqual(originals.map((row) => row.text));
  expect(doc.visibleRows.every((row, i) => row === originals[i])).toBe(true);
  expect(doc.rows).toEqual(originals);
  expect(doc.nextSequence).toBe(5);
  const revision = doc.filterRevision;
  show();
  expect(doc.filterRevision).toBe(revision);
});

it("never matches generated origin, time or cut suffix and always retains ordered notices and hidden cut counts", () => {
  const doc = new LogDocument("pods");
  doc.status({ ...status, sources: [source, { ...source, id: 8, container: "other" }] });
  doc.timestamps(true);
  doc.append([
    { source: 7, time: 1, text: "red payload", cut: true, spans: [[0, 3, 1, -1, 0]] },
    { source: 7, time: 1, text: "", gap: true },
    { source: 7, time: 1, text: "Error", exited: true },
    { source: 8, time: 1, text: "keep" },
  ]);
  doc.marker("overflow notice");
  for (const include of ["constructor", ".001", "64 KiB", "log-fg-1", "not retained suffix"]) {
    doc.filter({ include, exclude: "notice", matchCase: false });
    expect(doc.visibleRows.map((row) => row.sequence)).toEqual([1, 2, 4]);
    expect(doc.retainedLines).toBe(2);
    expect(doc.retainedCutLines).toBe(1);
    expect(doc.matchingLines).toBe(0);
  }
  doc.filter({ include: "payload", exclude: "", matchCase: false });
  expect(doc.visibleRows.map((row) => row.sequence)).toEqual([0, 1, 2, 4]);
  expect(doc.visibleRows[0]!.spans.some((span) => span.className === "log-fg-1")).toBe(true);
  expect(doc.matchingLines).toBe(1);
  doc.filter({ include: "", exclude: "", matchCase: false });
  expect(doc.projectedRows).toBe(5);
  expect(doc.matchingLines).toBe(2);
});

it.each(["lines", "characters", "decorations"] as const)(
  "evicts hidden original rows under the %s budget and prunes only after their last retained reference",
  (budget) => {
    const doc = new LogDocument("pods");
    doc.status(status);
    doc.append(
      ["one", "two", "six"].map((text) => ({
        source: 7,
        time: 0,
        text,
        spans: [[0, 1, 1, -1, 0]],
      })),
    );
    doc.filter({ include: "one", exclude: "", matchCase: false });
    doc.status({ ...status, sources: [{ ...source, id: 8, container: "new" }] });
    doc.end();
    expect(doc.retainedSources()).toEqual([7]);
    expect(doc.sources.has(7)).toBe(true);
    // Origin prefixes and decorations count even when every payload is hidden.
    doc.updateBudgets({
      lines: budget === "lines" ? 2 : 100,
      characters: budget === "characters" ? 8 : 1000,
      decorations: budget === "decorations" ? 2 : 100,
    });
    expect(doc.rows.map((row) => row.sequence)).toEqual([1, 2]);
    expect(doc.visibleRows).toEqual([]);
    expect(doc.retainedLines).toBe(2);
    expect(doc.evictedLines).toBe(1);
    expect(doc.retainedSources()).toEqual([7]);
    doc.filter({ include: "", exclude: "", matchCase: false });
    expect(doc.visibleRows.map((row) => row.text)).toEqual(["two", "six"]);
    doc.clear();
    expect(doc.retainedSources()).toEqual([]);
    expect(doc.metadataSnapshot()).toEqual({ sources: 0, colors: 0, retained: 0 });
    expect(doc.retainedLines).toBe(0);
    expect(doc.retainedCutLines).toBe(0);
    doc.append([{ source: 8, time: 0, text: "new" }]);
    expect(doc.rows[0]!.sequence).toBe(3);
  },
);

it("projects new batches and status/origin/timestamp rewrites without altering the predicate or retained identities", () => {
  const doc = new LogDocument("deployments.apps", undefined, {
    include: "keep",
    exclude: "",
    matchCase: false,
  });
  doc.status({ ...status, sources: [{ ...source, pod: "web-aaa" }] });
  doc.append([
    { source: 7, time: 1, text: "keep first" },
    { source: 7, time: 1, text: "hidden", cut: true },
  ]);
  expect(doc.visibleRows.map((row) => row.sequence)).toEqual([0]);
  doc.status({
    ...status,
    sources: [source, { ...source, id: 8, pod: "other-bbb", podUid: "new", container: "sidecar" }],
  });
  doc.timestamps(true);
  expect(doc.visibleRows[0]!.text).toContain(".001 web-a/constructor keep first");
  doc.append([{ source: 8, time: 1, text: "keep next" }]);
  expect(doc.visibleRows.map((row) => row.sequence)).toEqual([0, 2]);
  expect(doc.retainedLines).toBe(3);
  expect(doc.matchingLines).toBe(2);
  expect(doc.retainedCutLines).toBe(1);
  const revision = doc.filterRevision;
  doc.timestamps(false);
  expect(doc.filterRevision).toBe(revision);
  expect(doc.visibleRows.map((row) => row.sequence)).toEqual([0, 2]);
  doc.updateBudgets({ ...doc.budgets, lines: 1 });
  expect(doc.retainedCutLines).toBe(0);
  expect(doc.retainedSources().toSorted((a, b) => a - b)).toEqual([7, 8]);
  doc.end();
  expect(doc.retainedSources()).toEqual([8]);
});
