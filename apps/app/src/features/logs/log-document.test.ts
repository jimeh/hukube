import { expect, it } from "vitest";
import { LogDocument, formatLogTime, logOrigin } from "./log-document.ts";
import { source, status } from "../../../../../packages/engine-client/src/log-test-fixtures.ts";

it("formats timestamps, Pod and workload origins, cut lines, and record markers as text", () => {
  const date = new Date(2026, 9, 13, 1, 2, 3, 4);
  expect(formatLogTime(date.getTime(), date)).toBe("01:02:03.004");
  expect(formatLogTime(new Date(2026, 9, 12, 1, 2, 3, 4).getTime(), date)).toBe(
    "10-12 01:02:03.004",
  );
  expect(formatLogTime(0)).toBe("");
  expect(logOrigin({ ...source, pod: "web-a-b" }, "deployments.apps", "web", true)).toBe(
    "a-b/constructor",
  );
  expect(logOrigin({ ...source, pod: "db-0" }, "statefulsets.apps", "db", false)).toBe("0");
  expect(logOrigin(source, "pods", "web-a", true)).toBe("constructor");
  const doc = new LogDocument("pods", "web-a");
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
    const doc = new LogDocument("pods", "web", budgets);
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
  const doc = new LogDocument("pods", "web", { lines: 100, characters: 25, decorations: 100 });
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
    const doc = new LogDocument(type, "web");
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
