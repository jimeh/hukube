/** Application update state. The Electron boundary owns networking and native UI. */
export type UpdateState =
  | { phase: "unavailable"; reason: string }
  | { phase: "idle" | "checking" | "current" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready" | "restarting"; version: string }
  | { phase: "error"; message: string };

export interface UpdatePort {
  check(): Promise<{ version: string } | undefined>;
  download(): Promise<void>;
  install(): void;
}
export interface UpdateFeedback {
  changed(state: UpdateState): void;
  current(): void;
  error(message: string): void;
  ready(version: string): void;
  restart(): void;
}

export class Updates {
  state: UpdateState;
  private busy = false;
  private manual = false;

  constructor(
    private readonly port: UpdatePort,
    private readonly feedback: UpdateFeedback,
    unavailable?: string,
  ) {
    this.state = unavailable ? { phase: "unavailable", reason: unavailable } : { phase: "idle" };
  }

  private set(state: UpdateState) {
    this.state = state;
    this.feedback.changed(state);
  }

  async check(manual = false) {
    if (this.state.phase === "unavailable") {
      if (manual) this.feedback.error(this.state.reason);
      return;
    }
    if (this.busy || this.state.phase === "restarting") return;
    if (this.state.phase === "ready") {
      if (manual) this.feedback.ready(this.state.version);
      return;
    }
    this.busy = true;
    this.manual = manual;
    this.set({ phase: "checking" });
    try {
      const update = await this.port.check();
      if (!update) {
        this.set({ phase: "current" });
        if (manual) this.feedback.current();
      } else {
        this.set({ phase: "downloading", version: update.version, percent: 0 });
        await this.port.download();
        // On macOS the boundary waits for Squirrel's signature verification too.
        this.set({ phase: "ready", version: update.version });
        this.feedback.ready(update.version);
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
      this.manual = false;
    }
  }

  progress(percent: number) {
    if (this.state.phase === "downloading")
      this.set({ ...this.state, percent: Math.max(0, Math.min(100, Math.round(percent))) });
  }

  failed(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.set({ phase: "error", message });
    if (this.manual) this.feedback.error(message);
  }

  restart() {
    if (this.state.phase !== "ready") return;
    this.feedback.restart();
  }

  /** Called only after every window has actually closed with its unload guards. */
  install() {
    if (this.state.phase !== "ready") return;
    this.set({ phase: "restarting", version: this.state.version });
    try {
      this.port.install();
    } catch (error) {
      this.failed(error);
    }
  }
}

export function updateMenu(state: UpdateState): { label: string; enabled: boolean } {
  switch (state.phase) {
    case "checking":
      return { label: "Checking for Updates…", enabled: false };
    case "downloading":
      return { label: `Downloading ${state.version} (${state.percent}%)…`, enabled: false };
    case "ready":
      return { label: `Restart to Update to ${state.version}…`, enabled: true };
    case "restarting":
      return { label: "Restarting to Update…", enabled: false };
    case "unavailable":
      return { label: "Updates Unavailable…", enabled: true };
    case "error":
      return { label: "Check for Updates Again…", enabled: true };
    default:
      return { label: "Check for Updates…", enabled: true };
  }
}

export function updateError(state: UpdateState, detail: string) {
  return state.phase === "unavailable"
    ? { message: "Updates unavailable", detail: state.reason }
    : {
        message: "Could not update hukube",
        detail: `${detail}\n\nYou can keep using hukube and try Check for Updates again. If installation keeps failing, download the latest release from github.com/jimeh/hukube/releases.`,
      };
}
