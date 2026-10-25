import type { Column } from "@hukube/engine-client";
import { describe, expect, it } from "vitest";

import {
  columnId,
  defaultColumnLayout,
  moveColumn,
  moveColumnTo,
  readColumnLayout,
  resolveColumnLayout,
  showColumn,
  shownSort,
  type StoredColumnLayout,
} from "./column-layout.ts";

const cells = (names: string[], priority = 0): Column[] =>
  names.map((name) => ({ name, type: "string", priority }));
const stored = (ids: string[], hidden: string[] = []): StoredColumnLayout => ({
  version: 1,
  columns: ids.map((id) => ({
    ...(id.startsWith("cell:")
      ? { source: "cell" as const, name: id.slice(5) }
      : { source: id as "name" | "namespace" | "age" }),
    ...(hidden.includes(id) ? { hidden: true } : {}),
  })),
});
const resolve = (
  value: StoredColumnLayout | null = null,
  columns = cells(["A", "B"]),
  one = false,
) =>
  resolveColumnLayout({
    type: "widgets",
    namespaced: true,
    oneNamespace: one,
    columns,
    rows: [],
    stored: value,
  });
const ids = (value: StoredColumnLayout) => value.columns.map(columnId);
const shown = (value: ReturnType<typeof resolve>) => value.shown.map((c) => c.id);

describe("readColumnLayout", () => {
  // A stored setting outlives the build that wrote it, and any client may
  // write one, so a value of the wrong shape reads as no stored layout.
  it.each([
    null,
    "columns",
    7,
    true,
    [],
    [{ source: "name" }],
    {},
    { version: 1 },
    { version: 2, columns: [] },
    { version: "1", columns: [] },
    { version: 1, columns: {} },
    { version: 1, columns: "name" },
  ])("ignores an unreadable value %j", (value) => {
    expect(readColumnLayout(value)).toBeNull();
  });
  it("discards malformed and repeated entries without dropping valid ones", () => {
    expect(
      readColumnLayout({
        version: 1,
        columns: [
          null,
          1,
          "Name",
          ["name"],
          {},
          { source: ["name"] },
          { source: "cell" },
          { source: "cell", name: 4 },
          { source: "name", name: "Name" },
          { source: "age", hidden: "yes" },
          { source: "other" },
          { source: "name" },
          { source: "name", hidden: true },
          { source: "cell", name: "Name" },
          { source: "cell", name: "Name", hidden: true },
          { source: "age", hidden: false },
        ],
      }),
    ).toEqual({
      version: 1,
      columns: [
        { source: "name" },
        { source: "cell", name: "Name" },
        { source: "age", hidden: false },
      ],
    });
  });
});

describe("resolveColumnLayout", () => {
  it("uses the general default, with wide columns hidden", () => {
    const layout = resolve(null, [...cells(["A", "B"]), ...cells(["Wide"], 1)]);
    expect(shown(layout)).toEqual(["name", "namespace", "cell:A", "cell:B", "age"]);
    expect(layout.stored.columns.at(-1)).toEqual({ source: "cell", name: "Wide", hidden: true });
    expect(layout.spare).toBe("name");
  });
  it("uses a stored order and visibility", () => {
    expect(
      shown(resolve(stored(["cell:B", "age", "name", "namespace", "cell:A"], ["cell:A"]))),
    ).toEqual(["cell:B", "age", "name", "namespace"]);
  });
  it.each([
    [
      ["namespace", "cell:A", "cell:B", "age"],
      ["name", "namespace", "cell:A", "cell:B", "age"],
    ],
    [
      ["name", "namespace", "cell:B", "age"],
      ["name", "namespace", "cell:A", "cell:B", "age"],
    ],
    [
      ["name", "namespace", "cell:A", "cell:B"],
      ["name", "namespace", "cell:A", "cell:B", "age"],
    ],
  ])("inserts an unknown column at its default position in %j", (before, after) => {
    expect(ids(resolve(stored(before)).stored)).toEqual(after);
  });
  it("inserts after the nearest default predecessor even in a moved layout", () => {
    expect(ids(resolve(stored(["age", "cell:A", "name", "namespace"])).stored)).toEqual([
      "age",
      "cell:A",
      "cell:B",
      "name",
      "namespace",
    ]);
  });
  it("keeps an unserved entry through hiding and moving", () => {
    const layout = resolve(
      stored(["name", "cell:Elsewhere", "namespace", "cell:A", "cell:B", "age"]),
    );
    expect(shown(layout)).not.toContain("cell:Elsewhere");
    expect(ids(showColumn(layout, "cell:A", false)!)).toContain("cell:Elsewhere");
    expect(ids(moveColumn(layout, "name", 1)!)).toContain("cell:Elsewhere");
  });
  it("hides Namespace while one Namespace is chosen and shows it for several", () => {
    const one = resolve(stored(["name", "namespace", "age"]), [], true);
    expect(shown(one)).toEqual(["name", "age"]);
    expect(one.available.map((c) => c.id)).toContain("namespace");
    expect(shown(resolve(stored(["name", "namespace", "age"]), [], false))).toEqual([
      "name",
      "namespace",
      "age",
    ]);
  });
  it("shows Namespace only for namespaced types not narrowed to one Namespace", () => {
    expect(shown(resolve(null, cells(["A"]), true))).not.toContain("namespace");
    const layout = resolveColumnLayout({
      type: "nodes",
      namespaced: false,
      oneNamespace: false,
      columns: [],
      rows: [],
      stored: null,
    });
    expect(layout.available.map((c) => c.id)).toEqual(["name", "age"]);
  });
  it("shows Name when every available entry is hidden, and prevents hiding it", () => {
    const layout = resolve(
      stored(
        ["name", "namespace", "age", "cell:A", "cell:B"],
        ["name", "namespace", "age", "cell:A", "cell:B"],
      ),
    );
    expect(shown(layout)).toEqual(["name"]);
    expect(showColumn(layout, "name", false)).toBeUndefined();
    expect(layout.stored.columns.find((c) => c.source === "name")?.hidden).toBeUndefined();
  });
  it("uses the first served duplicate's priority", () => {
    const layout = resolve(null, [...cells(["A"], 1), ...cells(["A"])]);
    expect(shown(layout)).not.toContain("cell:A");
    expect(layout.available.find((c) => c.id === "cell:A")?.index).toBe(0);
  });
  it("handles hostile names, a cell called Name, and duplicate served names", () => {
    const layout = resolve(
      null,
      cells(["constructor", "__proto__", "toString", "Name", "constructor"]),
    );
    expect(shown(layout)).toEqual([
      "name",
      "namespace",
      "cell:constructor",
      "cell:__proto__",
      "cell:toString",
      "cell:Name",
      "age",
    ]);
    expect(layout.shown.find((c) => c.id === "cell:constructor")?.index).toBe(0);
    expect(ids(layout.stored).filter((id) => id === "cell:constructor")).toHaveLength(1);
  });
});

describe("tuned defaults", () => {
  const pod = [
    ...cells(["Ready", "Status", "Restarts"]),
    ...cells(["IP", "Node", "Nominated Node", "Readiness Gates"], 1),
  ];
  const event = [
    ...cells(["Last Seen", "Type", "Reason", "Object", "Message"]),
    ...cells(["First Seen", "Count"], 1),
  ];
  it("shows Node after the ordinary Pod columns", () => {
    expect(
      shown(
        resolveColumnLayout({
          type: "pods",
          namespaced: true,
          oneNamespace: false,
          columns: pod,
          rows: [],
          stored: null,
        }),
      ),
    ).toEqual([
      "name",
      "namespace",
      "cell:Ready",
      "cell:Status",
      "cell:Restarts",
      "cell:Node",
      "age",
    ]);
    expect(ids(defaultColumnLayout("pods", true, pod))).toContain("cell:IP");
  });
  it.each(["events", "events.events.k8s.io"])(
    "shows the tuned %s columns with Message taking spare width",
    (type) => {
      const layout = resolveColumnLayout({
        type,
        namespaced: true,
        oneNamespace: false,
        columns: event,
        rows: [],
        stored: null,
      });
      expect(shown(layout)).toEqual([
        "namespace",
        "cell:Last Seen",
        "cell:Type",
        "cell:Reason",
        "cell:Object",
        "cell:Message",
      ]);
      expect(layout.spare).toBe("cell:Message");
      expect(layout.stored.columns.find((c) => c.source === "name")?.hidden).toBe(true);
      expect(layout.stored.columns.find((c) => c.source === "age")?.hidden).toBe(true);
    },
  );
  it.each([undefined, cells(["Type", "Reason"])])(
    "falls back while a tuned Event column is unserved: %j",
    (columns) => {
      const layout = resolveColumnLayout({
        type: "events",
        namespaced: true,
        oneNamespace: false,
        columns,
        rows: [],
        stored: null,
      });
      expect(shown(layout)).toContain("name");
      expect(shown(layout)).toContain("age");
    },
  );
  it("falls back to Name for spare width when Message is hidden or unserved", () => {
    for (const columns of [event, []]) {
      const layout = resolveColumnLayout({
        type: "events",
        namespaced: true,
        oneNamespace: false,
        columns,
        rows: [],
        stored: stored(["name", "cell:Message"], ["cell:Message"]),
      });
      expect(layout.spare).toBe("name");
    }
    expect(
      resolveColumnLayout({
        type: "events",
        namespaced: true,
        oneNamespace: false,
        columns: event,
        rows: [],
        stored: stored(["name", "cell:Message"], ["name", "cell:Message"]),
      }).spare,
    ).toBeUndefined();
  });
});

describe("column edits", () => {
  const layout = resolve(
    stored(["name", "cell:Missing", "cell:A", "namespace", "cell:B", "age"], ["cell:A"]),
  );
  it("moves across hidden and unserved entries to the nearest shown column", () => {
    expect(ids(moveColumn(layout, "name", 1)!)).toEqual([
      "cell:Missing",
      "cell:A",
      "namespace",
      "name",
      "cell:B",
      "age",
    ]);
    expect(ids(moveColumn(layout, "cell:B", -1)!)).toEqual([
      "name",
      "cell:Missing",
      "cell:A",
      "cell:B",
      "namespace",
      "age",
    ]);
  });
  it("does not move past either end", () => {
    expect(moveColumn(layout, "name", -1)).toBeUndefined();
    expect(moveColumn(layout, "age", 1)).toBeUndefined();
  });
  it("does not edit an unchanged position, invalid position, or unshown column", () => {
    expect(moveColumnTo(layout, "name", 0)).toBeUndefined();
    expect(moveColumnTo(layout, "name", -1)).toBeUndefined();
    expect(moveColumnTo(layout, "name", layout.shown.length)).toBeUndefined();
    expect(moveColumn(layout, "cell:A", 1)).toBeUndefined();
    expect(moveColumnTo(layout, "cell:Missing", 0)).toBeUndefined();
  });
  it("does not edit unchanged visibility or an unknown column", () => {
    expect(showColumn(layout, "name", true)).toBeUndefined();
    expect(showColumn(layout, "cell:A", false)).toBeUndefined();
    expect(showColumn(layout, "cell:Unknown", true)).toBeUndefined();
  });
  it("skips Namespace when a single Namespace is selected", () => {
    const narrowed = resolve(layout.stored, cells(["A", "B"]), true);
    expect(shown(resolve(moveColumn(narrowed, "name", 1), cells(["A", "B"]), true))).toEqual([
      "cell:B",
      "name",
      "age",
    ]);
  });
  it("moves to a drag position and can show a hidden wide column", () => {
    expect(shown(resolve(moveColumnTo(layout, "age", 0)))).toEqual([
      "age",
      "name",
      "namespace",
      "cell:B",
    ]);
    expect(shown(resolve(showColumn(layout, "cell:A", true)))).toContain("cell:A");
  });
});

describe("shownSort", () => {
  it("uses name ascending when a sorted column is hidden, unserved, or Namespace is narrowed", () => {
    const layout = resolve(
      stored(["name", "namespace", "age", "cell:A", "cell:B"], ["cell:A"]),
      cells(["A", "B"]),
      true,
    );
    for (const sort of [
      { field: "column" as const, column: "A", desc: true },
      { field: "column" as const, column: "Missing" },
      { field: "namespace" as const, desc: true },
    ]) {
      expect(shownSort(sort, layout.shown)).toEqual({ field: "name" });
    }
    expect(shownSort({ field: "column", column: "B", desc: true }, layout.shown)).toEqual({
      field: "column",
      column: "B",
      desc: true,
    });
  });
  it("restores the requested sort when its column shows again", () => {
    const sort = { field: "column" as const, column: "A", desc: true };
    expect(shownSort(sort, resolve().shown)).toEqual(sort);
  });
});
