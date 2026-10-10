import type { Column, Row } from "@hukube/engine-client";
import { describe, expect, it } from "vitest";

import { cellText, gridLayout, growWidths, listColumns } from "./columns.ts";

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

  it("hides the columns kubectl only shows with -o wide, keeping cell positions", () => {
    expect(listColumns(columns, []).map((c) => [c.name, c.index])).toEqual([
      ["Ready", 0],
      ["Data", 2],
      ["Size", 3],
    ]);
  });

  it("treats a column as numeric when it is declared so or only holds numbers", () => {
    const rows = [row("a", ["1/1", "n1", 3, null]), row("b", ["0/1", "n2", 0, null]), row("c")];
    expect(listColumns(columns, rows).map((c) => [c.name, c.numeric])).toEqual([
      ["Ready", false],
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
    expect(growWidths({}, columns, rows)).toEqual({ Status: 17, Message: 48 });
  });

  it("makes room for the header when cells are short or missing", () => {
    expect(growWidths({}, columns, [row("a", ["Ok", null]), row("b")])).toEqual({
      Status: 9,
      Message: 10,
    });
  });

  it("never shrinks, and returns the same widths when nothing grew", () => {
    const wide = growWidths({}, columns, [row("a", ["ContainerCreating", "pulling image"])]);
    expect(growWidths(wide, columns, [row("b", ["Running", "ok"])])).toBe(wide);
    expect(growWidths(wide, columns, [row("c", ["Running", "back-off restarting"])])).toEqual({
      Status: 17,
      Message: 19,
    });
  });
});

describe("gridLayout", () => {
  const columns = listColumns([{ name: "Status", type: "string", priority: 0 }], []);

  it("puts the columns between the Namespace and the age", () => {
    expect(gridLayout(true, columns, { Status: 17 })).toEqual({
      template: "minmax(12rem, 2fr) minmax(8rem, 1fr) 17ch 5rem",
      minWidth: "calc(12rem + 8rem + 17ch + 5rem + 3.75rem)",
    });
  });

  it("leaves out the Namespace, and sizes a column without cells by its header", () => {
    expect(gridLayout(false, columns, {})).toEqual({
      template: "minmax(12rem, 2fr) 9ch 5rem",
      minWidth: "calc(12rem + 9ch + 5rem + 3rem)",
    });
  });
});
