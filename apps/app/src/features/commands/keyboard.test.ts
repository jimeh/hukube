import { PUNCTUATION_CODE_MAP, matchesKeyboardEvent, parseHotkey } from "@tanstack/hotkeys";
import { expect, it } from "vitest";
import { compileCondition, type Context } from "./conditions.ts";
import { argumentsFor } from "./catalog.ts";
import {
  Chords,
  strokesOverlap,
  compileKeymap,
  defaultRules,
  emptyDocument,
  type Rule,
} from "./keyboard.ts";
const context: Context = {
  platform: "linux",
  host: "web",
  route: "workspace",
  workspace: true,
  focus: "other",
  tabKind: "list",
  facet: "none",
  terminalLive: false,
  terminalSelection: false,
  manifestDirty: false,
  engineConnected: true,
  modalOpen: false,
  paletteOpen: false,
  recording: false,
};
const rule = (patch: Partial<Rule> = {}): Rule => ({
  id: "user.1",
  command: "app.openSettings",
  keys: ["Mod+,"],
  scope: "app",
  enabled: true,
  when: "",
  ...patch,
});
it("bounds and typechecks grammar without JS evaluation", () => {
  expect(compileCondition("workspace && platform != 'mac'").test(context)).toBe(true);
  for (const text of [
    "unknown",
    "platform",
    "platform == true",
    "workspace()",
    "x.y",
    "1+1",
    "workspace === true",
    "!".repeat(40) + "workspace",
    "(".repeat(40) + "true" + ")".repeat(40),
    " ".repeat(1025),
  ])
    expect(() => compileCondition(text)).toThrow(/./);
});
it("validates arguments, optional defaults and missing prompted fields", () => {
  expect(argumentsFor("app.openSettings", undefined)).toEqual({});
  expect(() => argumentsFor("appearance.setTheme", {})).toThrow(/./);
  expect(argumentsFor("appearance.setTheme", {}, true)).toEqual({});
  expect(() => argumentsFor("appearance.setTheme", { theme: "blue" }, true)).toThrow(/./);
  expect(() => argumentsFor("tab.close", { rpc: "x" })).toThrow(/./);
});
it("uses exact default disables and ordered rules, retaining future rules inert", () => {
  const map = compileKeymap(
    {
      ...emptyDocument,
      disabledDefaults: ["default.resource.app"],
      rules: [rule(), rule({ id: "user.2" }), rule({ id: "future", command: "future.command" })],
    },
    "linux",
  );
  expect(map.rules.some((r) => r.id === "default.resource.app")).toBe(false);
  expect(map.rules.some((r) => r.id === "default.resource.terminal.other")).toBe(true);
  expect(map.rules.at(-1)?.id).toBe("user.2");
  expect(map.diagnostics.join()).toContain("overrides");
  expect(map.diagnostics.join()).toContain("inactive");
});
it("rejects ambiguous prefixes and reserved keys, proving typed disjoint contexts", () => {
  expect(() =>
    compileKeymap({ ...emptyDocument, rules: [rule({ keys: ["Mod+K", "X"] })] }, "linux"),
  ).toThrow("prefix");
  for (const keys of [["Mod+J"], ["G", "Mod+J"], ["Mod+[KeyJ]"], ["G", "Mod+[KeyJ]"]])
    expect(() => compileKeymap({ ...emptyDocument, rules: [rule({ keys })] }, "linux")).toThrow(
      "reserved",
    );
  expect(() =>
    compileKeymap(
      {
        ...emptyDocument,
        rules: [rule({ keys: ["Mod+K", "X"], when: "terminalLive", scope: "terminal" })],
      },
      "linux",
    ),
  ).not.toThrow(/./);
  expect(defaultRules).toHaveLength(17);
});
it("cancels sequence with an injected clock and never replays", () => {
  let callback: (() => void) | undefined;
  let hint = "";
  let cleared = 0;
  const c = new Chords<string>((v) => (hint = v), {
    set: (fn) => {
      callback = fn;
      return 1;
    },
    clear: () => cleared++,
  });
  const r = compileKeymap(
    { ...emptyDocument, rules: [rule({ keys: ["G", "H"] })] },
    "linux",
  ).rules.at(-1)!;
  c.start([r], "original");
  expect(c.pending?.origin).toBe("original");
  expect(hint).toContain("Escape");
  callback?.();
  expect(c.pending).toBeUndefined();
  expect(hint).toBe("");
  expect(cleared).toBeGreaterThan(0);
});

it("rejects layout-dependent physical/logical prefix overlaps conservatively", () => {
  expect(() =>
    compileKeymap({ ...emptyDocument, rules: [rule({ keys: ["Mod+[KeyK]", "X"] })] }, "linux"),
  ).toThrow("prefix");
});

it.each(["!", "?"])("rejects a shifted %s single/chord prefix overlap", (glyph) => {
  const code = glyph === "!" ? "Digit1" : "Slash";
  expect(() =>
    compileKeymap(
      {
        ...emptyDocument,
        disabledDefaults: defaultRules.map((r) => r.id),
        rules: [
          rule({ id: "glyph", keys: [glyph] }),
          rule({ id: "physical", keys: [`Shift+[${code}]`, "H"] }),
        ],
      },
      "linux",
    ),
  ).toThrow("prefix");
});

const fallbackCases = [
  ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (key) => [key, `Key${key}`]),
  ...Array.from("0123456789", (key) => [key, `Digit${key}`]),
  ...Array.from("0123456789", (key) => [key, `Numpad${key}`]),
  ...Object.entries(PUNCTUATION_CODE_MAP).map(([code, key]) => [key, code]),
  ["+", "NumpadAdd"],
  ["-", "NumpadSubtract"],
  ["*", "NumpadMultiply"],
  ["/", "NumpadDivide"],
  [".", "NumpadDecimal"],
  ["Enter", "NumpadEnter"],
  ["Space", "Space"],
];
it.each(fallbackCases)(
  "includes installed fallback %s/%s in overlap and prefix analysis",
  (logical, code) => {
    for (const platform of ["mac", "linux", "windows"] as const) {
      const a = "Alt+?",
        b = `Alt+${logical}`;
      // A direct logical match and a different positional fallback on the SAME event.
      const event = {
        key: "?",
        code,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
        metaKey: false,
        getModifierState: () => false,
      } as unknown as KeyboardEvent;
      expect(matchesKeyboardEvent(event, a, platform)).toBe(true);
      expect(matchesKeyboardEvent(event, parseHotkey(b, platform), platform)).toBe(true);
      expect(strokesOverlap(a, b, platform)).toBe(true);
      for (const [single, prefix] of [
        [a, b],
        [b, a],
      ]) {
        const rules = [
          rule({ id: "single", keys: [single!] }),
          rule({ id: "chord", keys: [prefix!, "F12"] }),
        ];
        const document = {
          ...emptyDocument,
          disabledDefaults: defaultRules.map((r) => r.id),
          rules,
        };
        expect(() => compileKeymap(document, platform)).toThrow("prefix");
        expect(() =>
          compileKeymap(
            { ...document, rules: [rules[0]!, { ...rules[1]!, enabled: false }] },
            platform,
          ),
        ).not.toThrow();
        expect(() =>
          compileKeymap(
            {
              ...document,
              rules: [rules[0]!, { ...rules[1]!, when: "terminalLive", scope: "terminal" }],
            },
            platform,
          ),
        ).not.toThrow();
      }
      for (const keys of [
        [[a], [b]],
        [
          [a, "F12"],
          [b, "F12"],
        ],
        [
          ["F12", a],
          ["F12", b],
        ],
      ]) {
        const map = compileKeymap(
          {
            ...emptyDocument,
            disabledDefaults: defaultRules.map((r) => r.id),
            rules: keys.map((sequence, i) => rule({ id: String(i), keys: sequence })),
          },
          platform,
        );
        expect(map.diagnostics.join()).toMatch(/overlap|overrides/);
      }
    }
  },
);
it("rejects the actual plus/NumpadMultiply single-prefix witness with implicit Shift controls", () => {
  const event = {
    key: "+",
    code: "NumpadMultiply",
    ctrlKey: true,
    getModifierState: () => false,
  } as unknown as KeyboardEvent;
  expect(matchesKeyboardEvent(event, "Control++", "linux")).toBe(true);
  expect(matchesKeyboardEvent(event, "Control+*", "linux")).toBe(true);
  expect(() =>
    compileKeymap(
      {
        ...emptyDocument,
        disabledDefaults: defaultRules.map((r) => r.id),
        rules: [
          rule({ id: "plus", keys: ["Control++"] }),
          rule({ id: "multiply", keys: ["Control+*", "F12"] }),
        ],
      },
      "linux",
    ),
  ).toThrow("prefix");
  expect(strokesOverlap("Control++", "Control+Shift+[NumpadMultiply]", "linux")).toBe(true);
  expect(strokesOverlap("Control++", "Alt+*", "linux")).toBe(false);
});
