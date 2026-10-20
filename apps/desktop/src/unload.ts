export interface OpenWork {
  edits: number;
  sessions: number;
}

/** Whether unloading this window discards work or stops the Engine. */
export function unloadPrompt(
  work: OpenWork,
  quitting: boolean,
  closingLastWindow: boolean,
  mac: boolean,
) {
  const stopsEngine = quitting || (!mac && closingLastWindow);
  if (work.edits && work.sessions && stopsEngine)
    return {
      buttons: ["Cancel", "Discard and end"],
      message: "Discard edits and end Exec Sessions?",
      detail:
        "This window has edits that have not been applied, and Exec Sessions that quitting ends. A command still running in a container may keep running.",
    };
  if (work.edits)
    return {
      buttons: ["Cancel", "Discard"],
      message: "Discard unsaved edits?",
      detail: "This window has edits that have not been applied.",
    };
  if (work.sessions && stopsEngine)
    return {
      buttons: ["Cancel", "Quit"],
      message: "Quit and end the Exec Sessions?",
      detail: `Quitting stops the Engine, which ends ${work.sessions} Exec Session${work.sessions === 1 ? "" : "s"} in this window. A command still running in a container may keep running.`,
    };
  return undefined;
}
