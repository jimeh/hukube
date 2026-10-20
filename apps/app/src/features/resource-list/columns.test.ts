import type { Column, Row } from "@hukube/engine-client";
import { describe, expect, it } from "vitest";

import { resolveColumnLayout } from "./column-layout.ts";

import { cellText, gridLayout, growWidths, listColumns, type ColumnWidths } from "./columns.ts";

const none: ColumnWidths = new Map();
const widthsOf = (widths: ColumnWidths) => Object.fromEntries(widths);

const row = (name: string, cells?: unknown[]): Row => ({
  uid: name,
  type: "pods",
  name,
  createdAt: "",
  ...(cells ? { cells } : {}),
});

describe("listColumns", () => {
  const columns: Column[] = [
    { name: "Ready", type: "string", priority: 0 },
    { name: "Node", type: "string", priority: 1 },
    { name: "Data", type: "string", priority: 0 },
    { name: "Size", type: "integer", priority: 0 },
  ];

  it("includes wide columns, keeping cell positions", () => {
    expect(listColumns(columns, []).map((c) => [c.name, c.index])).toEqual([
      ["Ready", 0],
      ["Node", 1],
      ["Data", 2],
      ["Size", 3],
    ]);
  });

  it("treats a column as numeric when it is declared so or only holds numbers", () => {
    const rows = [row("a", ["1/1", "n1", 3, null]), row("b", ["0/1", "n2", 0, null]), row("c")];
    expect(listColumns(columns, rows).map((c) => [c.name, c.numeric])).toEqual([
      ["Ready", false],
      ["Node", false],
      ["Data", true],
      ["Size", true],
    ]);
  });

  it("shows no columns before the Engine has sent any", () => {
    expect(listColumns(undefined, [row("a")])).toEqual([]);
  });
});

describe("cellText", () => {
  it.each([
    ["Running", "Running"],
    [3, "3"],
    [true, "true"],
    [null, "<none>"],
    [undefined, "<none>"],
    [{ a: 1 }, '{"a":1}'],
  ])("shows %j as %s", (value, want) => {
    expect(cellText(value)).toBe(want);
  });
});

describe("growWidths", () => {
  const columns = listColumns(
    [
      { name: "Status", type: "string", priority: 0 },
      { name: "Message", type: "string", priority: 0 },
    ],
    [],
  );

  it("fits the header and the widest cell, up to a limit", () => {
    const rows = [row("a", ["ContainerCreating", "x".repeat(200)]), row("b", ["Running", "ok"])];
    expect(widthsOf(growWidths(none, columns, rows))).toEqual({
      "cell:Status": 17,
      "cell:Message": 48,
    });
  });

  it("makes room for the header when cells are short or missing", () => {
    expect(widthsOf(growWidths(none, columns, [row("a", ["Ok", null]), row("b")]))).toEqual({
      "cell:Status": 9,
      "cell:Message": 10,
    });
  });

  it("never shrinks, and returns the same widths when nothing grew", () => {
    const wide = growWidths(none, columns, [row("a", ["ContainerCreating", "pulling image"])]);
    expect(growWidths(wide, columns, [row("b", ["Running", "ok"])])).toBe(wide);
    expect(
      widthsOf(growWidths(wide, columns, [row("c", ["Running", "back-off restarting"])])),
    ).toEqual({ "cell:Status": 17, "cell:Message": 19 });
  });

  // A list sets the grown widths while it renders, so widths that never
  // settle make it render without end.
  it.each(["constructor", "toString", "__proto__"])(
    "settles for a column a Cluster named %s",
    (name) => {
      const named = listColumns([{ name, type: "string", priority: 0 }], []);
      const first = growWidths(none, named, [row("a", ["Running"])]);
      expect(first.get(`cell:${name}`)).toBe(name.length + 3);
      expect(growWidths(first, named, [row("a", ["Running"])])).toBe(first);
      expect(gridLayout(named, first, undefined).template).toBe(
        `${name.length + 3}ch minmax(2rem, 1fr)`,
      );
    },
  );
});

describe("gridLayout", () => {
  const served = [{ name: "Status", type: "string", priority: 0 }];
  // The action sits at the right end of the header, so its track takes the
  // spare width whenever no column does.
  it("keeps the action cell at the right end before any column has loaded", () => {
    expect(gridLayout([], none, undefined)).toEqual({
      template: "minmax(2rem, 1fr)",
      minWidth: "calc(2rem + 1.5rem)",
    });
  });
  it("keeps the action cell at the right end when every column has a fixed width", () => {
    const age = { id: "age", source: "age" as const, name: "Age", numeric: false };
    expect(gridLayout([...listColumns(served, []), age], none, undefined).template).toBe(
      "9ch 5rem minmax(2rem, 1fr)",
    );
  });
  it("sizes the resolved order with Name taking spare width", () => {
    const layout = resolveColumnLayout({
      type: "pods",
      namespaced: true,
      allNamespaces: true,
      columns: served,
      rows: [],
      stored: null,
    });
    expect(gridLayout(layout.shown, new Map([["cell:Status", 17]]), layout.spare)).toEqual({
      template: "minmax(12rem, 2fr) minmax(8rem, 1fr) 17ch 5rem 2rem",
      minWidth: "calc(12rem + 8rem + 17ch + 5rem + 2rem + 4.5rem)",
    });
  });
  it("leaves out Namespace when narrowed, sizing a column without cells by its header", () => {
    const layout = resolveColumnLayout({
      type: "pods",
      namespaced: true,
      allNamespaces: false,
      columns: served,
      rows: [],
      stored: null,
    });
    expect(gridLayout(layout.shown, none, layout.spare)).toEqual({
      template: "minmax(12rem, 2fr) 9ch 5rem 2rem",
      minWidth: "calc(12rem + 9ch + 5rem + 2rem + 3.75rem)",
    });
  });
  it("gives Message the spare width and sizes a shown Name by content", () => {
    const columns = listColumns([{ name: "Message", type: "string", priority: 0 }], []);
    const name = { id: "name", source: "name" as const, name: "Name", numeric: false };
    const widths = growWidths(none, [name, ...columns], [row("a-long-resource-name", ["hello"])]);
    expect(gridLayout([name, ...columns], widths, "cell:Message").template).toBe(
      "20ch minmax(12rem, 2fr) 2rem",
    );
    expect(gridLayout([name], widths, "name").template).toBe("minmax(12rem, 2fr) 2rem");
  });
  it("keeps Name and a served cell called Name at different widths", () => {
    const layout = resolveColumnLayout({
      type: "widgets",
      namespaced: false,
      allNamespaces: true,
      columns: [{ name: "Name", type: "string", priority: 0 }],
      rows: [row("long-resource-name", ["a"])],
      stored: null,
    });
    const widths = growWidths(none, layout.shown, [row("long-resource-name", ["a"])]);
    expect(widths.get("name")).toBe(18);
    expect(widths.get("cell:Name")).toBe(7);
    expect(gridLayout(layout.shown, widths, layout.spare).template).toBe(
      "minmax(12rem, 2fr) 7ch 5rem 2rem",
    );
  });
});
