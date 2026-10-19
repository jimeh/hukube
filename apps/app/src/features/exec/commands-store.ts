import type { EngineClient } from "@hukube/engine-client";
import { imageKey } from "./command.ts";

export interface ExecCommands {
  /** Most recently used first. Names from a Cluster are values, never object keys. */
  images: { image: string; command: string }[];
  recent: string[];
}
const empty = (): ExecCommands => ({ images: [], recent: [] });
function isCommand(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function read(value: unknown): ExecCommands {
  if (!value || typeof value !== "object") return empty();
  const data = value as Record<string, unknown>;
  const result = empty();
  if (Array.isArray(data["images"]))
    for (const item of data["images"]) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.image === "string" &&
        isCommand(item.command) &&
        !result.images.some((entry) => entry.image === item.image)
      )
        result.images.push({ image: item.image, command: item.command });
      if (result.images.length === 100) break;
    }
  if (Array.isArray(data["recent"]))
    for (const command of data["recent"]) {
      if (isCommand(command) && !result.recent.includes(command)) result.recent.push(command);
      if (result.recent.length === 10) break;
    }
  return result;
}

/** Apply one run to a known setting, keeping both lists most recent first. */
function recordRun(
  current: ExecCommands,
  image: string,
  command: string,
  remember: boolean,
): ExecCommands {
  const repository = imageKey(image);
  const saved = current.images.find((entry) => entry.image === repository);
  const touch = !!saved && saved.command === command;
  let images = current.images;
  if ((remember && repository) || touch) {
    images = images.filter((entry) => entry.image !== repository);
    if (command.trim()) images = [{ image: repository, command }, ...images].slice(0, 100);
  }
  const recent = command.trim()
    ? [command, ...current.recent.filter((entry) => entry !== command)].slice(0, 10)
    : current.recent;
  return images === current.images && recent === current.recent ? current : { images, recent };
}

/** Shared by a window's consumers, with one watch and one write in flight. */
export function createCommandsStore(client: Pick<EngineClient, "subscribe" | "request">) {
  const key = "exec/commands";
  let snapshot: ExecCommands | undefined;
  let readState: "pending" | "ready" | "failed" = "pending";
  let unread: { image: string; command: string; remember: boolean; resolve: () => void }[] = [];
  const listeners = new Set<() => void>();
  let watch: { close: () => void } | undefined;
  let writing = false;
  let waiting: ExecCommands | undefined;
  let settled = Promise.resolve();
  const show = (value: ExecCommands | undefined) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  const openWatch = () => {
    if (readState === "failed") readState = "pending";
    const opened = client.subscribe(
      "settings.watch",
      { key },
      {
        data: ({ value }) => {
          if (watch !== opened || writing) return;
          readState = "ready";
          const stored = read(value);
          const queued = unread;
          unread = [];
          const next = queued.reduce(
            (current, run) => recordRun(current, run.image, run.command, run.remember),
            stored,
          );
          if (next === stored) {
            show(stored);
            for (const run of queued) run.resolve();
          } else {
            void put(next).then(() => {
              for (const run of queued) run.resolve();
            });
          }
        },
        error: (error) => {
          if (watch !== opened) return;
          console.warn("Could not read Exec Session commands", error);
          readState = "failed";
          waiting = undefined;
          const queued = unread;
          unread = [];
          show(undefined);
          for (const run of queued) run.resolve();
        },
      },
    );
    watch = opened;
  };
  const write = async (value: ExecCommands): Promise<void> => {
    writing = true;
    try {
      await client.request("settings.put", { key, value });
    } catch (error) {
      console.warn("Could not save Exec Session commands", error);
    }
    const next = waiting;
    waiting = undefined;
    if (next) return write(next);
    writing = false;
    // A fresh watch starts after the writes the Engine has answered. An old
    // echo has no revision, so it cannot safely replace the local value.
    if (watch) {
      watch.close();
      openWatch();
    }
  };
  const put = (value: ExecCommands): Promise<void> => {
    show(value);
    if (writing) waiting = value;
    else settled = write(value);
    return settled;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!watch) openWatch();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          watch?.close();
          watch = undefined;
        }
      };
    },
    commandFor: (image: string) =>
      snapshot?.images.find((entry) => entry.image === imageKey(image))?.command,
    /** Record a run, optionally replacing (or forgetting) the image's command. */
    run: (image: string, command: string, remember = false): Promise<void> => {
      if (readState === "failed") {
        console.warn("Could not save Exec Session commands because the setting could not be read.");
        return Promise.resolve();
      }
      if (snapshot === undefined) {
        // Preserve the intent until it can be applied to the Engine's value.
        return new Promise((resolve) => unread.push({ image, command, remember, resolve }));
      }
      const next = recordRun(snapshot, image, command, remember);
      return next === snapshot ? settled : put(next);
    },
  };
}
