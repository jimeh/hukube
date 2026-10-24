import { describe, expect, it } from "vitest";

import {
  allNamespacesItem,
  emptyListNotice,
  keepOrder,
  missingNamespaces,
  namespaceLabel,
  nextSelection,
  pickerRows,
  readNamespaces,
} from "./namespace-selection.ts";

describe("readNamespaces", () => {
  // Restored Tab params outlive the build that wrote them, so they are
  // untrusted, and a layout from before this param has none.
  it.each([undefined, null, "shop", 7, {}, { shop: true }])("reads %j as no selection", (value) => {
    expect(readNamespaces(value)).toEqual([]);
  });

  it("keeps unique, non-empty strings, sorted", () => {
    expect(readNamespaces(["shop", "", 3, null, "payments", "shop", { name: "x" }])).toEqual([
      "payments",
      "shop",
    ]);
  });
});

describe("nextSelection", () => {
  it("selects just the name checked while on All namespaces", () => {
    expect(nextSelection([], [allNamespacesItem, "shop"])).toEqual(["shop"]);
  });

  it("returns to All namespaces when it is checked", () => {
    expect(nextSelection(["payments", "shop"], ["payments", "shop", allNamespacesItem])).toEqual(
      [],
    );
  });

  it("stays on All namespaces when it is pressed while already on it", () => {
    expect(nextSelection([], [])).toEqual([]);
  });

  it("adds and removes names, sorted", () => {
    expect(nextSelection(["shop"], ["shop", "payments"])).toEqual(["payments", "shop"]);
    expect(nextSelection(["payments", "shop"], ["payments"])).toEqual(["payments"]);
    expect(nextSelection(["shop"], [])).toEqual([]);
  });
});

describe("pickerRows", () => {
  const names = ["alpha", "beta", "gamma", "shop"];

  it("lists All namespaces, the chosen, then the rest by name", () => {
    expect(pickerRows({ names, pinned: ["shop", "beta"], chosen: [], filtering: false })).toEqual([
      allNamespacesItem,
      "beta",
      "shop",
      "alpha",
      "gamma",
    ]);
  });

  it("keeps the order taken at open after a check and an uncheck", () => {
    // `shop` was chosen when the popup opened; `alpha` was checked and `shop`
    // unchecked since, and neither moves.
    expect(pickerRows({ names, pinned: ["shop"], chosen: ["alpha"], filtering: false })).toEqual([
      allNamespacesItem,
      "shop",
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("lists a chosen Namespace that is not among the names", () => {
    expect(
      pickerRows({ names: ["alpha"], pinned: [], chosen: ["alpha", "gone"], filtering: false }),
    ).toEqual([allNamespacesItem, "gone", "alpha"]);
    expect(pickerRows({ names: [], pinned: ["shop"], chosen: ["shop"], filtering: false })).toEqual(
      [allNamespacesItem, "shop"],
    );
  });

  it("leaves out All namespaces while filtering", () => {
    expect(pickerRows({ names, pinned: ["shop"], chosen: ["shop"], filtering: true })).toEqual([
      "shop",
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describe("keepOrder", () => {
  it("keeps the listed rows in place, a deleted one included, and adds arrivals after them", () => {
    const listed = [allNamespacesItem, "shop", "alpha", "gamma"];
    // `beta` and `delta` arrived and `alpha` was deleted since the popup opened.
    const next = pickerRows({
      names: ["beta", "delta", "gamma", "shop"],
      pinned: ["shop"],
      chosen: ["shop"],
      filtering: false,
    });
    expect(keepOrder(listed, next)).toEqual([
      allNamespacesItem,
      "shop",
      "alpha",
      "gamma",
      "beta",
      "delta",
    ]);
  });
});

describe("missingNamespaces", () => {
  const chosen = ["gone", "shop"];

  it("marks a chosen Namespace absent from a complete, ready list", () => {
    expect(missingNamespaces(chosen, ["alpha", "shop"], true)).toEqual(new Set(["gone"]));
  });

  it("marks nothing while the list is loading, incomplete, or not permitted", () => {
    expect(missingNamespaces(chosen, ["alpha", "shop"], false)).toEqual(new Set());
    expect(missingNamespaces(chosen, undefined, true)).toEqual(new Set());
  });
});

describe("namespaceLabel", () => {
  const many = Array.from({ length: 40 }, (_, i) => `ns-${String(i).padStart(2, "0")}`);

  it.each([
    [0, [], { name: undefined, more: undefined, moreText: undefined, text: "All namespaces" }],
    [1, ["shop"], { name: "shop", more: undefined, moreText: undefined, text: "shop" }],
    [
      3,
      ["payments", "shop", "web"],
      { name: "payments", more: "+2", moreText: "and 2 more", text: "payments and 2 more" },
    ],
    [40, many, { name: "ns-00", more: "+39", moreText: "and 39 more", text: "ns-00 and 39 more" }],
  ])("reads %i chosen Namespaces", (_count, selection, want) => {
    expect(namespaceLabel(selection)).toEqual(want);
  });

  it("formats counts for the locale", () => {
    const thousands = Array.from({ length: 1235 }, (_, i) => `ns-${i}`);
    expect(namespaceLabel(thousands, "en-US")).toMatchObject({
      more: "+1,234",
      moreText: "and 1,234 more",
    });
  });
});

describe("emptyListNotice", () => {
  const kind = "Service";

  it("says the one chosen Namespace is not found, whatever the other filters", () => {
    const want = {
      title: "gone not found",
      description:
        "The cluster has no namespace with this name. Choose another namespace, or show all namespaces.",
    };
    const missing = new Set(["gone"]);
    expect(emptyListNotice({ kind, chosen: ["gone"], missing, filtered: false })).toEqual(want);
    expect(emptyListNotice({ kind, chosen: ["gone"], missing, filtered: true })).toEqual(want);
  });

  it("says when none of several chosen Namespaces is found", () => {
    const chosen = ["gone-a", "gone-b", "gone-c"];
    expect(
      emptyListNotice({ kind, chosen, missing: new Set(chosen), filtered: true, locale: "en-US" }),
    ).toEqual({
      title: "3 chosen namespaces not found",
      description: "The cluster has none of them. Choose other namespaces, or show all namespaces.",
    });
  });

  it("names the selection or the filters when only some chosen Namespaces are missing", () => {
    const missing = new Set(["gone"]);
    const chosen = ["gone", "shop"];
    expect(emptyListNotice({ kind, chosen, missing, filtered: false, locale: "en-US" })).toEqual({
      title: "No Service resources in 2 namespaces",
      description: "This list updates live.",
    });
    expect(emptyListNotice({ kind, chosen, missing, filtered: true })).toEqual({
      title: "No matches",
      description: "Nothing matches the current filters.",
    });
  });

  it("names the selection while the Namespace list is unknown", () => {
    // `missingNamespaces` marks none until the list is complete and ready.
    expect(
      emptyListNotice({ kind, chosen: ["gone"], missing: new Set(), filtered: false }),
    ).toEqual({ title: "No Service resources in gone", description: "This list updates live." });
    expect(emptyListNotice({ kind, chosen: [], missing: new Set(), filtered: false })).toEqual({
      title: "No Service resources",
      description: "The cluster has none right now. This list updates live.",
    });
  });
});
