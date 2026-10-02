import type { FindResult, ResourceType } from "@hukube/engine-client";
import { describe, expect, it } from "vitest";

import {
  isPaletteShortcut,
  matchingTypes,
  parsePaletteInput,
  resourceItems,
  sameJson,
  scopeQuery,
} from "./palette-input.ts";

function type(key: string, kind: string, shortNames: string[] = []): ResourceType {
  const [resource = "", ...group] = key.split(".");
  return {
    key,
    group: group.join("."),
    version: "v1",
    resource,
    kind,
    namespaced: true,
    verbs: [],
    shortNames,
    state: "ready",
    count: 1,
  };
}

const types = [
  type("pods", "Pod", ["po"]),
  type("deployments.apps", "Deployment", ["deploy"]),
  type("events", "Event", ["ev"]),
  type("events.events.k8s.io", "Event", ["ev"]),
  type("monitors.example.com", "Monitor"),
];
const namespaces = { names: new Set(["default", "kube-system", "monitor"]), complete: true };

describe("parsePaletteInput", () => {
  it.each([
    ["no prefix", "core", {}, "core"],
    ["a resource name", "pods/core", { types: { segment: "pods", keys: ["pods"] } }, "core"],
    ["a kind, ignoring case", "Pod/core", { types: { segment: "pod", keys: ["pods"] } }, "core"],
    [
      "a short name",
      "deploy/api",
      { types: { segment: "deploy", keys: ["deployments.apps"] } },
      "api",
    ],
    [
      "a type key",
      "deployments.apps/api",
      { types: { segment: "deployments.apps", keys: ["deployments.apps"] } },
      "api",
    ],
    [
      "a name several types share",
      "ev/x",
      { types: { segment: "ev", keys: ["events", "events.events.k8s.io"] } },
      "x",
    ],
    ["a namespace", "kube-system/core", { namespace: "kube-system" }, "core"],
    [
      "a namespace then a type",
      "kube-system/po/core",
      { namespace: "kube-system", types: { segment: "po", keys: ["pods"] } },
      "core",
    ],
    [
      "a type then a namespace",
      "po/kube-system/core",
      { namespace: "kube-system", types: { segment: "po", keys: ["pods"] } },
      "core",
    ],
    [
      "a segment naming both a type and a namespace, as the type",
      "monitor/x",
      { types: { segment: "monitor", keys: ["monitors.example.com"] } },
      "x",
    ],
    ["an empty name", "po/", { types: { segment: "po", keys: ["pods"] } }, ""],
  ])("resolves %s", (_, input, scope, text) => {
    expect(parsePaletteInput(input, types, namespaces)).toEqual({ kind: "ok", scope, text });
  });

  it.each([
    ["two types", "po/deploy/x", "Use only one resource type prefix."],
    ["two namespaces", "default/kube-system/x", "Use only one namespace prefix."],
    ["an unknown segment", "nope/x", "No resource type or namespace named “nope”."],
    ["an empty segment", "/x", "A prefix before “/” is empty."],
    ["three segments", "a/b/c/x", "Use at most a type and a namespace before the name."],
  ])("rejects %s", (_, input, message) => {
    expect(parsePaletteInput(input, types, namespaces)).toEqual({ kind: "error", message });
  });

  it("reads an unknown segment as a Namespace when the known ones are incomplete", () => {
    const partial = { ...namespaces, complete: false };
    expect(parsePaletteInput("zz-team/po/api", types, partial)).toEqual({
      kind: "ok",
      scope: { namespace: "zz-team", types: { segment: "po", keys: ["pods"] } },
      text: "api",
    });
  });

  it("waits for Namespaces before reading an unknown segment as one", () => {
    expect(parsePaletteInput("kube-system/x", types, undefined)).toEqual({ kind: "pending" });
    expect(parsePaletteInput("po/x", types, undefined)).toEqual({
      kind: "ok",
      scope: { types: { segment: "po", keys: ["pods"] } },
      text: "x",
    });
  });
});

describe("scopeQuery", () => {
  it("narrows by type and namespace", () => {
    expect(scopeQuery({})).toBeUndefined();
    expect(scopeQuery({ namespace: "default" })).toEqual({
      op: "in",
      field: "namespace",
      values: ["default"],
    });
    expect(scopeQuery({ namespace: "default", types: { segment: "po", keys: ["pods"] } })).toEqual({
      op: "and",
      args: [
        { op: "in", field: "type", values: ["pods"] },
        { op: "in", field: "namespace", values: ["default"] },
      ],
    });
  });
});

describe("resourceItems", () => {
  const where = { op: "in" as const, field: "type" as const, values: ["pods"] };
  // The Engine echoes params in its own key order.
  const result: FindResult = {
    text: "web",
    where: { values: ["pods"], field: "type", op: "in" },
    total: 1,
    rows: [{ uid: "1", type: "pods", namespace: "default", name: "web", createdAt: "" }],
  };

  it("enables rows that answer the current params", () => {
    expect(resourceItems(result, { text: "web", where })).toEqual([
      { row: result.rows[0], value: "resource:pods/1", disabled: false },
    ]);
  });

  it("tells apart one Resource served under two types", () => {
    const row = { uid: "1", namespace: "default", name: "e", createdAt: "" };
    const events: FindResult = {
      text: "e",
      total: 2,
      rows: [
        { ...row, type: "events" },
        { ...row, type: "events.events.k8s.io" },
      ],
    };
    const values = resourceItems(events, { text: "e" }).map((i) => i.value);
    expect(new Set(values).size).toBe(2);
  });

  it.each([
    ["the text changed", { text: "webx", where }],
    ["the scope changed", { text: "web", where: { ...where, values: ["services"] } }],
    ["the scope was removed", { text: "web" }],
    ["there are no params", undefined],
  ])("disables rows when %s", (_, params) => {
    expect(resourceItems(result, params).map((i) => i.disabled)).toEqual([true]);
  });
});

describe("sameJson", () => {
  it("ignores key order and undefined keys", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(
      true,
    );
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: [] }, { a: {} })).toBe(false);
    expect(sameJson(undefined, {})).toBe(false);
  });
});

describe("matchingTypes", () => {
  it("ranks exact names, then prefixes, then substrings", () => {
    const candidates = [
      type("sidepods.example.com", "SidePod"),
      type("poddisruptionbudgets.policy", "PodDisruptionBudget", ["pdb"]),
      type("pods", "Pod", ["po"]),
      type("services", "Service", ["svc"]),
    ];
    expect(matchingTypes(candidates, "Pod", 8).map((t) => t.key)).toEqual([
      "pods",
      "poddisruptionbudgets.policy",
      "sidepods.example.com",
    ]);
    expect(matchingTypes(candidates, "pod", 2)).toHaveLength(2);
    expect(matchingTypes(candidates, " ", 8)).toEqual([]);
  });
});

const keyEvent = (k: string, code: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isPaletteShortcut", () => {
  it.each([
    ["Ctrl+K elsewhere", keyEvent("k", "KeyK", { ctrlKey: true }), false, true],
    ["Cmd+K on macOS", keyEvent("k", "KeyK", { metaKey: true }), true, true],
    ["Ctrl+K on macOS", keyEvent("k", "KeyK", { ctrlKey: true }), true, false],
    ["Cmd+K elsewhere", keyEvent("k", "KeyK", { metaKey: true }), false, false],
    ["Ctrl+Shift+K", keyEvent("K", "KeyK", { ctrlKey: true, shiftKey: true }), false, false],
    ["Ctrl+K on a Cyrillic layout", keyEvent("л", "KeyK", { ctrlKey: true }), false, true],
    [
      "Ctrl+K on Dvorak, where K is elsewhere",
      keyEvent("k", "KeyV", { ctrlKey: true }),
      false,
      true,
    ],
    ["Ctrl+T on Dvorak, at K's position", keyEvent("t", "KeyK", { ctrlKey: true }), false, false],
  ])("%s", (_, event, mac, want) => {
    expect(isPaletteShortcut(event, mac)).toBe(want);
  });
});
