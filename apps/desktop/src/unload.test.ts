import { expect, it } from "vitest";
import { unloadPrompt } from "./unload.ts";

it("asks for edits on every unload, and for sessions only when the Engine will stop", () => {
  for (const mac of [true, false])
    for (const quitting of [true, false])
      for (const last of [true, false]) {
        expect(unloadPrompt({ edits: 0, sessions: 0 }, quitting, last, mac)).toBeUndefined();
        const both = unloadPrompt({ edits: 1, sessions: 2 }, quitting, last, mac)!;
        expect(both.message).toBe(
          quitting || (!mac && last)
            ? "Discard edits and end Exec Sessions?"
            : "Discard unsaved edits?",
        );
        expect(unloadPrompt({ edits: 1, sessions: 0 }, quitting, last, mac)).toMatchObject({
          message: "Discard unsaved edits?",
          buttons: ["Cancel", "Discard"],
        });
        for (const sessions of [1, 2]) {
          const prompt = unloadPrompt({ edits: 0, sessions }, quitting, last, mac);
          const expected =
            quitting || (!mac && last)
              ? {
                  message: "Quit and end the Exec Sessions?",
                  detail: `Quitting stops the Engine, which ends ${sessions} Exec Session${sessions === 1 ? "" : "s"} in this window. A command still running in a container may keep running.`,
                  buttons: ["Cancel", "Quit"],
                }
              : undefined;
          expect(prompt).toEqual(expected);
        }
      }
});
