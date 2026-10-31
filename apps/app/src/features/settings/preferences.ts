import { z } from "zod";
import {
  AppPreferencesKey,
  PreferenceDefaultTheme,
  PreferenceDefaultWrap,
  PreferenceDefaultTimestamps,
  PreferenceMaxLines,
  PreferenceMaxCharacters,
  PreferenceMaxDecorations,
  PreferenceDefaultLines,
  PreferenceDefaultCharacters,
  PreferenceDefaultDecorations,
  type EngineClient,
  type Setting,
  type Subscription,
} from "@hukube/engine-client";

const appearance = z.object({ theme: z.enum(["light", "dark"]).optional() }).passthrough();
const logs = z
  .object({
    maxLines: z.number().int().min(1).max(PreferenceMaxLines).optional(),
    maxCharacters: z.number().int().min(1).max(PreferenceMaxCharacters).optional(),
    maxDecorations: z.number().int().min(1).max(PreferenceMaxDecorations).optional(),
    wrap: z.boolean().optional(),
    timestamps: z.boolean().optional(),
  })
  .passthrough();
export const preferenceSchema = z
  .object({ version: z.literal(1), appearance: appearance.optional(), logStreams: logs.optional() })
  .passthrough();
function decodePreferences(value: unknown): Preferences {
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "number" &&
    value.version !== 1
  )
    throw new Error(
      "This Hukube version cannot read these app preferences. Update Hukube, then retry. Your saved preferences have not been changed.",
    );
  const result = preferenceSchema.safeParse(value);
  if (!result.success) {
    const labels: Record<string, string> = {
      version: "preference version",
      appearance: "Appearance",
      "appearance.theme": "Theme",
      logStreams: "Log Streams",
      "logStreams.maxLines": "Maximum retained lines",
      "logStreams.maxCharacters": "Maximum retained characters",
      "logStreams.maxDecorations": "Maximum styled ranges",
      "logStreams.wrap": "Wrap",
      "logStreams.timestamps": "Timestamps",
    };
    const field = labels[result.error.issues[0]?.path.join(".") ?? ""];
    throw new Error(
      `The saved app preferences contain an invalid value${field ? ` for ${field}` : ""}. Correct the stored app preferences, then retry. Your saved preferences have not been changed.`,
    );
  }
  return result.data;
}
export type Preferences = z.infer<typeof preferenceSchema>;
export const defaults = {
  theme: PreferenceDefaultTheme as "light" | "dark",
  maxLines: PreferenceDefaultLines,
  maxCharacters: PreferenceDefaultCharacters,
  maxDecorations: PreferenceDefaultDecorations,
  wrap: PreferenceDefaultWrap as boolean,
  timestamps: PreferenceDefaultTimestamps as boolean,
};
export type Values = typeof defaults;
export type Field = keyof Values;
export const fields = Object.keys(defaults) as Field[];
export const logFields = fields.filter((field) => field !== "theme");
export const maximums = {
  maxLines: PreferenceMaxLines,
  maxCharacters: PreferenceMaxCharacters,
  maxDecorations: PreferenceMaxDecorations,
};
export type NumericField = keyof typeof maximums;
export function numericValue(field: NumericField, text: string): number {
  const value = Number(text.trim());
  if (
    !/^\d+$/.test(text.trim()) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximums[field]
  )
    throw new Error(`Enter a whole number from 1 to ${maximums[field].toLocaleString()}.`);
  return value;
}
function rawValue(raw: Preferences, field: Field): unknown {
  return field === "theme" ? raw.appearance?.theme : raw.logStreams?.[field];
}
function resolved(raw: Preferences): Values {
  return Object.fromEntries(
    fields.map((field) => [field, rawValue(raw, field) ?? defaults[field]]),
  ) as Values;
}
function compose(raw: Preferences, changes: Partial<Values>): Preferences {
  const next = { ...raw, appearance: { ...raw.appearance }, logStreams: { ...raw.logStreams } };
  for (const field of fields)
    if (Object.hasOwn(changes, field)) {
      if (field === "theme") next.appearance.theme = changes.theme!;
      else Object.assign(next.logStreams, { [field]: changes[field] });
    }
  return preferenceSchema.parse(next);
}
export interface Draft {
  value: string | boolean;
  observed: unknown;
  generation: number;
  status: "Not saved" | "Saving" | "Saved";
  error?: string;
  conflict?: boolean;
  reset?: "appearance" | "logStreams";
}
interface IntentFields {
  changes: Partial<Values>;
  observed: Partial<Record<Field, unknown>>;
  generations: Partial<Record<Field, number>>;
}
interface Intent extends IntentFields {
  attempts: number;
  /** Evidence of the last sent attempt, independent of its remaining retry ownership. */
  sent?: IntentFields;
}
export interface PreferenceSnapshot {
  connected: boolean;
  loaded: boolean;
  fresh: boolean;
  raw: Preferences;
  revision: string;
  values: Values;
  drafts: Partial<Record<Field, Draft>>;
  error?: string;
  defaults: boolean;
}
function intendedValue(field: Field, draft: Draft): Values[Field] {
  return field in maximums
    ? numericValue(field as NumericField, String(draft.value))
    : (draft.value as Values[Field]);
}
function draftMatches(field: Field, draft: Draft, actual: unknown): boolean {
  try {
    return actual === intendedValue(field, draft);
  } catch {
    return false;
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const code = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";

/** One store per Engine client. Raw field observations, drafts and committed intents have separate lifetimes. */
export function createPreferenceStore(
  client: EngineClient,
  legacyTheme?: "light" | "dark",
  retireLegacy: () => void = () => {},
) {
  let current: PreferenceSnapshot = {
    connected: client.getState() === "open",
    loaded: false,
    fresh: false,
    raw: { version: 1 },
    revision: "",
    values: defaults,
    drafts: {},
    defaults: true,
  };
  const listeners = new Set<() => void>();
  let watch: Subscription<{ key: string }> | undefined;
  let epoch = 0,
    generation = 0,
    disposed = false,
    running = false;
  let migration = legacyTheme;
  let migrationGeneration: number | undefined;
  const queue: Intent[] = [];
  let active: Intent | undefined;
  const waiters: {
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  const show = (patch: Partial<PreferenceSnapshot>) => {
    current = { ...current, ...patch };
    for (const listener of listeners) listener();
  };
  const update = (intent: IntentFields, patch: Partial<Draft>) => {
    const drafts = { ...current.drafts };
    for (const field of fields)
      if (drafts[field] && drafts[field].generation === intent.generations[field])
        drafts[field] = { ...drafts[field], ...patch };
    show({ drafts });
  };
  const failRead = (error: unknown) => {
    show({ fresh: false, error: `Cannot load app preferences: ${message(error)}` });
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(current.error));
    }
  };
  const matches = (intent: Intent) =>
    Object.entries(intent.changes).every(
      ([field, value]) => rawValue(current.raw, field as Field) === value,
    );
  const conflict = (intent: Intent) =>
    Object.keys(intent.changes).some(
      (field) =>
        rawValue(current.raw, field as Field) !== intent.observed[field as Field] &&
        rawValue(current.raw, field as Field) !== intent.changes[field as Field],
    );
  const settle = (intent: IntentFields) => {
    update(intent, { status: "Saved", error: undefined, conflict: false });
    // Local successors were observed while this write was pending, not against a remote edit.
    for (const queued of queue)
      for (const field of fields)
        if (
          Object.hasOwn(intent.changes, field) &&
          queued.observed[field] === intent.observed[field]
        )
          queued.observed[field] = rawValue(current.raw, field);
    const drafts = { ...current.drafts };
    for (const field of fields)
      if (
        Object.hasOwn(intent.changes, field) &&
        drafts[field] &&
        drafts[field].generation !== intent.generations[field] &&
        drafts[field].observed === intent.observed[field]
      )
        drafts[field] = {
          ...drafts[field],
          observed: rawValue(current.raw, field),
          conflict: false,
        };
    show({ drafts });
  };
  // A newer committed field owns all future retries. Keep sent evidence for readback.
  const abandon = (touched: Field[]) => {
    for (const intent of [...queue, ...(active ? [active] : [])])
      for (const field of touched) {
        delete intent.changes[field];
        delete intent.observed[field];
        delete intent.generations[field];
      }
    for (let i = queue.length - 1; i >= 0; i--)
      if (!Object.keys(queue[i]!.changes).length && !queue[i]!.sent) queue.splice(i, 1);
  };
  const reconcileSent = (intent: Intent) => {
    if (!intent.sent) return;
    const confirmed: IntentFields = { changes: {}, observed: {}, generations: {} };
    for (const field of fields)
      if (
        Object.hasOwn(intent.sent.changes, field) &&
        rawValue(current.raw, field) === intent.sent.changes[field]
      ) {
        Object.assign(confirmed.changes, { [field]: intent.sent.changes[field] });
        confirmed.observed[field] = intent.sent.observed[field];
        confirmed.generations[field] = intent.sent.generations[field];
      }
    settle(confirmed);
    intent.sent = undefined;
  };
  const open = () => {
    if (disposed) return;
    watch?.close();
    const mine = ++epoch;
    show({ fresh: false });
    watch = client.subscribe(
      "settings.watch",
      { key: AppPreferencesKey },
      {
        data: (setting: Setting) => {
          if (mine !== epoch || disposed || client.getState() !== "open") return;
          try {
            const raw =
              setting.value === null ? { version: 1 as const } : decodePreferences(setting.value);
            if (typeof setting.revision !== "string")
              throw new Error("Missing preference revision");
            const drafts = { ...current.drafts };
            if (
              raw.appearance?.theme !== undefined &&
              migration &&
              raw.appearance.theme !== migration &&
              drafts.theme?.generation === migrationGeneration
            )
              delete drafts.theme;
            for (const field of fields) {
              const draft = drafts[field];
              if (!draft || draft.status === "Saved") continue;
              const actual = rawValue(raw, field);
              drafts[field] = {
                ...draft,
                conflict: actual !== draft.observed && !draftMatches(field, draft, actual),
              };
            }
            show({
              loaded: true,
              fresh: true,
              raw,
              revision: setting.revision,
              values: resolved(raw),
              error: undefined,
              defaults: setting.value === null,
              drafts,
            });
            if (raw.appearance?.theme !== undefined) {
              migration = undefined;
              retireLegacy();
            }
            for (const waiter of waiters.splice(0)) {
              clearTimeout(waiter.timer);
              waiter.resolve();
            }
            if (!running) void pump();
            if (migration && !current.drafts.theme && !active && !queue.length) {
              edit("theme", migration);
              migrationGeneration = current.drafts.theme!.generation;
              commit(["theme"]);
            }
          } catch (error) {
            failRead(error);
          }
        },
        error: (error) => {
          if (mine === epoch) failRead(error.message);
        },
      },
    );
  };
  const fresh = () =>
    new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error("Not saved, outcome not confirmed. Retry when the Engine is available."),
          );
        }, 10_000),
      };
      waiters.push(waiter);
      open();
    });
  async function pump() {
    if (running || disposed || !current.fresh || client.getState() !== "open") return;
    running = true;
    try {
      while (queue.length && current.fresh) {
        if (disposed) break;
        const intent = queue.shift()!;
        active = intent;
        reconcileSent(intent);
        if (matches(intent)) {
          settle(intent);
          active = undefined;
          continue;
        }
        try {
          for (;;) {
            // Discard/supersession may run while the preceding put or readback awaits.
            if (matches(intent)) {
              settle(intent);
              break;
            }
            if (conflict(intent)) {
              update(intent, {
                status: "Not saved",
                conflict: true,
                error: "This preference changed in another window. Review the Engine value.",
              });
              break;
            }
            if (++intent.attempts > 4)
              throw new Error("Preferences kept changing. Review and retry.");
            update(intent, { status: "Saving", error: undefined, conflict: false });
            const value = compose(current.raw, intent.changes);
            intent.sent = {
              changes: { ...intent.changes },
              observed: { ...intent.observed },
              generations: { ...intent.generations },
            };
            // The timer changes presentation only. A sent put is never cancelled or duplicated while unresolved.
            const deadline = setTimeout(
              () =>
                update(intent, {
                  status: "Not saved",
                  error: "Not saved, outcome not confirmed. Waiting for the sent write.",
                }),
              10_000,
            );
            let failure: unknown;
            try {
              await client.request("settings.put", {
                key: AppPreferencesKey,
                value,
                ifRevision: current.revision,
              });
            } catch (error) {
              failure = error;
            } finally {
              clearTimeout(deadline);
            }
            if (
              failure &&
              !["conflict", "disconnected", "unavailable", "unknown"].includes(code(failure))
            )
              throw failure;
            await fresh();
            reconcileSent(intent);
            if (matches(intent)) {
              settle(intent);
              break;
            }
            if (!failure) {
              update(intent, {
                status: "Not saved",
                conflict: true,
                error: "The saved value was superseded. Review the Engine value.",
              });
              break;
            }
          }
        } catch (error) {
          update(intent, { status: "Not saved", error: message(error) });
          // Only committed intents can resume after connection recovery.
          if (code(error) === "not_connected") show({ fresh: false });
          if (!current.fresh && (Object.keys(intent.changes).length || intent.sent)) {
            intent.attempts = 0;
            queue.unshift(intent);
          }
        }
        active = undefined;
      }
    } finally {
      running = false;
    }
  }
  function edit(field: Field, value: string | boolean) {
    const old = current.drafts[field];
    const draft: Draft = {
      value,
      observed: old && old.status !== "Saved" ? old.observed : rawValue(current.raw, field),
      generation: ++generation,
      status: "Not saved",
    };
    if (field in maximums)
      try {
        numericValue(field as NumericField, String(value));
      } catch (error) {
        draft.error = message(error);
      }
    show({ drafts: { ...current.drafts, [field]: draft } });
  }
  function commit(touched: Field[], keepMine = false) {
    if (!current.loaded || current.error) return;
    const intent: Intent = { changes: {}, observed: {}, generations: {}, attempts: 0 };
    for (const field of touched) {
      const draft = current.drafts[field];
      if (!draft || draft.status === "Saved") continue;
      if (draft.conflict && !keepMine) return;
      let value: Values[Field];
      try {
        value = intendedValue(field, draft);
        compose(current.raw, { [field]: value });
      } catch (error) {
        show({ drafts: { ...current.drafts, [field]: { ...draft, error: message(error) } } });
        return;
      }
      Object.assign(intent.changes, { [field]: value });
      intent.observed[field] = keepMine ? rawValue(current.raw, field) : draft.observed;
      intent.generations[field] = draft.generation;
    }
    if (!Object.keys(intent.changes).length) return;
    abandon(Object.keys(intent.changes) as Field[]);
    queue.push(intent);
    void pump();
  }
  const stopState = client.onStateChange(() => {
    show({ connected: client.getState() === "open" });
    if (client.getState() === "open") open();
    else {
      epoch++;
      watch?.close();
      watch = undefined;
      show({ fresh: false });
    }
  });
  open();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit,
    commit,
    change: (field: Field, value: string | boolean) => {
      edit(field, value);
      commit([field]);
    },
    reset: (section: "appearance" | "logStreams") => {
      if (!current.loaded || current.error) return;
      const touched = section === "appearance" ? ["theme" as const] : logFields;
      for (const field of touched) {
        edit(
          field,
          typeof defaults[field] === "number" ? String(defaults[field]) : defaults[field],
        );
        show({
          drafts: { ...current.drafts, [field]: { ...current.drafts[field]!, reset: section } },
        });
      }
      commit(touched, true);
    },
    discard: (touched: Field[]) => {
      abandon(touched);
      const drafts = { ...current.drafts };
      for (const field of touched) delete drafts[field];
      show({ drafts });
    },
    retry: () => {
      open();
    },
    dispose: () => {
      disposed = true;
      epoch++;
      watch?.close();
      stopState();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Preference store closed"));
      }
      listeners.clear();
    },
  };
}
export type PreferenceStore = ReturnType<typeof createPreferenceStore>;
