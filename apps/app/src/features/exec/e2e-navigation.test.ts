// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { openGoToResource } from "../../../../../e2e/tests/exec.ts";
import { terminalTakesKey } from "./keys.ts";

afterEach(() => document.body.replaceChildren());
it.each(["macOS", "Windows", "Linux"])(
  "opens Go to Resource after a restored terminal takes focus on %s",
  async (platform) => {
    const terminal = document.createElement("textarea");
    document.body.append(terminal);
    terminal.focus();
    expect(document.activeElement).toBe(terminal);
    let action = "";
    const mac = platform === "macOS";
    const page = {
      evaluate: async (fn: () => void) => fn(),
      keyboard: {
        press: async (key: string) => {
          expect(key).toBe("ControlOrMeta+K");
          action =
            document.activeElement === terminal
              ? terminalTakesKey(mac, { key: "k", code: "KeyK", metaKey: mac, ctrlKey: !mac }, true)
                ? "terminal"
                : "goToResource"
              : "goToResource";
        },
      },
    };
    await openGoToResource(page as never);
    expect(action).toBe("goToResource");
  },
);
