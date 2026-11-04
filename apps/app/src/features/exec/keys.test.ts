import { expect, it } from "vitest";
import { terminalTakesKey } from "./keys.ts";
it("terminal-first bytes, held terminals, reserved Mod+J and single arbiter verdict", () => {
  for (const mac of [true, false]) {
    const e = { key: "k", code: "KeyK", metaKey: mac, ctrlKey: !mac };
    expect(terminalTakesKey(mac, e, true)).toBe(!mac);
    expect(terminalTakesKey(mac, e, true, "handled")).toBe(false);
    expect(terminalTakesKey(mac, e, true, "paste")).toBe(false);
    expect(terminalTakesKey(mac, { ...e, key: "j", code: "KeyJ" }, true)).toBe(false);
    expect(terminalTakesKey(mac, { ...e, metaKey: false, ctrlKey: false }, false)).toBe(false);
    expect(terminalTakesKey(mac, { ...e, metaKey: false, ctrlKey: false }, true)).toBe(true);
  }
});
