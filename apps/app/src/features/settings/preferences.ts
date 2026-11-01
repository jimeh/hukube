import {
  EngineRequestError,
  type ConnectionState,
  type EngineClient,
  type Setting,
} from "@hukube/engine-client";
import { useEngine } from "@hukube/engine-client/react";
import { useSyncExternalStore } from "react";
import { z } from "zod";

import { readCachedTheme, setTheme, type Theme } from "@/lib/theme.ts";

export const preferenceKey = "app/preferences";

export const logPreferenceDefaults = {
  maxLines: 50_000,
  maxCharacters: 32_000_000,
  maxStyledRanges: 200_000,
  wrap: true,
  timestamps: false,
} as const;

export const logPreferenceRanges = {
  maxLines: { minimum: 1, maximum: 100_000 },
  maxCharacters: { minimum: 2, maximum: 32_000_000 },
  maxStyledRanges: { minimum: 1, maximum: 200_000 },
} as const;

export interface AppPreferencesV1 {
  version: 1;
  appearance?: { theme?: Theme; [key: string]: unknown };
  logStreams?: {
    maxLines?: number;
    maxCharacters?: number;
    maxStyledRanges?: number;
    wrap?: boolean;
    timestamps?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface EffectivePreferences {
  appearance: { theme: Theme };
  logStreams: {
    maxLines: number;
    maxCharacters: number;
    maxStyledRanges: number;
    wrap: boolean;
    timestamps: boolean;
  };
}

export type PreferencePath =
  | "appearance.theme"
  | "logStreams.maxLines"
  | "logStreams.maxCharacters"
  | "logStreams.maxStyledRanges"
  | "logStreams.wrap"
  | "logStreams.timestamps";
export type PreferenceValue = Theme | number | boolean;
export type PreferenceScope = "appearance" | "retention" | "display" | "recovery";
export type PreferenceSection = "appearance" | "logStreams";
export type PreferenceChange = { path: PreferencePath; value: PreferenceValue | undefined };

export interface PreferenceSaveState {
  phase: "idle" | "saving" | "saved" | "error" | "conflict";
  message?: string;
  paths?: readonly PreferencePath[];
  changes?: readonly PreferenceChange[];
}

interface SaveStateInternal extends PreferenceSaveState {
  id?: number;
  observed?: ReadonlyMap<PreferencePath, unknown>;
  migration?: boolean;
  blockedSection?: PreferenceSection;
}

export interface PreferenceSnapshot {
  status: "loading" | "ready" | "error" | "malformed";
  connection: ConnectionState;
  effective: EffectivePreferences;
  /** Immediate local theme/wrap/timestamp choices layered over confirmed Engine values. */
  display: EffectivePreferences;
  fieldErrors: Readonly<Partial<Record<PreferencePath, string>>>;
  sectionErrors: Readonly<Partial<Record<PreferenceSection, string>>>;
  revision?: string;
  error?: string;
  saves: Readonly<Record<PreferenceScope, PreferenceSaveState>>;
  repairs: Readonly<Record<PreferenceSection, PreferenceSaveState>>;
}

interface DecodedPreferences {
  raw: AppPreferencesV1 | null;
  effective: EffectivePreferences;
  fieldErrors: Partial<Record<PreferencePath, string>>;
  sectionErrors: Partial<Record<PreferenceSection, string>>;
}

interface ThemeAdapter {
  readCachedTheme(): Theme | undefined;
  setTheme(theme: Theme): void;
}

interface Operation {
  id: number;
  scope: PreferenceScope;
  changes: readonly PreferenceChange[];
  observed: ReadonlyMap<PreferencePath, unknown>;
  migration?: boolean;
}

const envelopeSchema = z.object({ version: z.literal(1) }).passthrough();
const themeSchema = z.enum(["light", "dark"]);
const booleanSchema = z.boolean();
const numericSchemas = {
  maxLines: z
    .number()
    .int()
    .min(logPreferenceRanges.maxLines.minimum)
    .max(logPreferenceRanges.maxLines.maximum),
  maxCharacters: z
    .number()
    .int()
    .min(logPreferenceRanges.maxCharacters.minimum)
    .max(logPreferenceRanges.maxCharacters.maximum),
  maxStyledRanges: z
    .number()
    .int()
    .min(logPreferenceRanges.maxStyledRanges.minimum)
    .max(logPreferenceRanges.maxStyledRanges.maximum),
} as const;

const defaultEffective = (): EffectivePreferences => ({
  appearance: { theme: "dark" },
  logStreams: { ...logPreferenceDefaults },
});

const emptySave = (): SaveStateInternal => ({ phase: "idle" });
const emptySaves = (): Record<PreferenceScope, SaveStateInternal> => ({
  appearance: emptySave(),
  retention: emptySave(),
  display: emptySave(),
  recovery: emptySave(),
});
const emptyRepairs = (): Record<PreferenceSection, SaveStateInternal> => ({
  appearance: emptySave(),
  logStreams: emptySave(),
});

const invalidSection = Symbol("invalid preference section");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafError(label: string, issue: string): string {
  return `Stored ${label} is invalid: ${issue}`;
}

function decodeField<T>(
  value: unknown,
  schema: z.ZodType<T>,
  label: string,
  path: PreferencePath,
  errors: Partial<Record<PreferencePath, string>>,
): T | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  errors[path] = leafError(label, parsed.error.issues[0]?.message ?? "invalid value");
  return undefined;
}

export function decodePreferences(
  setting: Pick<Setting, "value" | "revision">,
): DecodedPreferences {
  if (setting.revision === "" && setting.value === null)
    return { raw: null, effective: defaultEffective(), fieldErrors: {}, sectionErrors: {} };
  const envelope = envelopeSchema.safeParse(setting.value);
  if (!envelope.success)
    throw new Error(
      "Stored app preferences are malformed or use an unsupported version. They have not been overwritten.",
    );
  const raw = envelope.data as AppPreferencesV1;
  const effective = defaultEffective();
  const fieldErrors: Partial<Record<PreferencePath, string>> = {};
  const sectionErrors: Partial<Record<PreferenceSection, string>> = {};

  if (raw.appearance !== undefined) {
    if (!isRecord(raw.appearance)) {
      sectionErrors.appearance = fieldErrors["appearance.theme"] =
        "Stored Appearance preferences are invalid: expected an object.";
    } else if (raw.appearance["theme"] !== undefined) {
      const theme = decodeField(
        raw.appearance["theme"],
        themeSchema,
        "theme",
        "appearance.theme",
        fieldErrors,
      );
      if (theme !== undefined) effective.appearance.theme = theme;
    }
  }

  if (raw.logStreams !== undefined) {
    if (!isRecord(raw.logStreams)) {
      sectionErrors.logStreams = "Stored Log Stream preferences are invalid: expected an object.";
      for (const path of [
        "logStreams.maxLines",
        "logStreams.maxCharacters",
        "logStreams.maxStyledRanges",
        "logStreams.wrap",
        "logStreams.timestamps",
      ] as const)
        fieldErrors[path] = sectionErrors.logStreams;
    } else {
      const log = raw.logStreams;
      for (const name of ["maxLines", "maxCharacters", "maxStyledRanges"] as const) {
        if (log[name] === undefined) continue;
        const value = decodeField(
          log[name],
          numericSchemas[name],
          name === "maxLines"
            ? "retained lines"
            : name === "maxCharacters"
              ? "retained characters"
              : "styled ranges",
          `logStreams.${name}`,
          fieldErrors,
        );
        if (value !== undefined) effective.logStreams[name] = value;
      }
      for (const name of ["wrap", "timestamps"] as const) {
        if (log[name] === undefined) continue;
        const value = decodeField(
          log[name],
          booleanSchema,
          name,
          `logStreams.${name}`,
          fieldErrors,
        );
        if (value !== undefined) effective.logStreams[name] = value;
      }
    }
  }
  return { raw, effective, fieldErrors, sectionErrors };
}

export function parseDecimalDraft(
  draft: string,
  range: { minimum: number; maximum: number },
): { value?: number; error?: string } {
  if (!/^(0|[1-9][0-9]*)$/.test(draft))
    return { error: "Enter a base-10 whole number without signs, separators, or spaces." };
  const value = Number(draft);
  if (!Number.isSafeInteger(value)) return { error: "Enter a whole number within the safe range." };
  if (value < range.minimum || value > range.maximum)
    return {
      error: `Enter a value from ${range.minimum.toLocaleString()} to ${range.maximum.toLocaleString()}.`,
    };
  return { value };
}

function rawPath(raw: AppPreferencesV1 | null, path: PreferencePath): unknown {
  if (!raw) return undefined;
  const [section, field] = path.split(".") as ["appearance" | "logStreams", string];
  const value = raw[section];
  return isRecord(value) ? value[field] : value === undefined ? undefined : invalidSection;
}

function sectionFor(path: PreferencePath): PreferenceSection {
  return path.startsWith("appearance.") ? "appearance" : "logStreams";
}

function sectionValue(raw: AppPreferencesV1 | null, section: PreferenceSection) {
  if (!raw || !Object.hasOwn(raw, section)) return { present: false as const, value: undefined };
  return { present: true as const, value: (raw as Record<string, unknown>)[section] };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => deepEqual(value, b[index]))
    );
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a).toSorted();
  const bKeys = Object.keys(b).toSorted();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]))
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

function pathsMatch(
  raw: AppPreferencesV1 | null,
  values: ReadonlyMap<PreferencePath, unknown>,
): boolean {
  for (const [path, value] of values) if (!sameValue(rawPath(raw, path), value)) return false;
  return true;
}

function intended(changes: readonly PreferenceChange[]): ReadonlyMap<PreferencePath, unknown> {
  return new Map(changes.map(({ path, value }) => [path, value]));
}

function patchPreferences(
  raw: AppPreferencesV1 | null,
  changes: readonly PreferenceChange[],
): AppPreferencesV1 {
  const next: AppPreferencesV1 = { ...(raw ?? { version: 1 }), version: 1 };
  for (const { path, value } of changes) {
    const [section, field] = path.split(".") as ["appearance" | "logStreams", string];
    const previous = next[section];
    const nested: Record<string, unknown> = isRecord(previous) ? { ...previous } : {};
    if (value === undefined) delete nested[field];
    else nested[field] = value;
    if (Object.keys(nested).length) next[section] = nested;
    else delete next[section];
  }
  return next;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof EngineRequestError
    ? error.code
    : isRecord(error) && typeof error["code"] === "string"
      ? error["code"]
      : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyEffective(value: EffectivePreferences): EffectivePreferences {
  return {
    appearance: { ...value.appearance },
    logStreams: { ...value.logStreams },
  };
}

export function createPreferenceStore(
  client: Pick<EngineClient, "subscribe" | "request" | "getState" | "onStateChange">,
  theme: ThemeAdapter = { readCachedTheme, setTheme },
) {
  let raw: AppPreferencesV1 | null = null;
  let effective = defaultEffective();
  let fieldErrors: Partial<Record<PreferencePath, string>> = {};
  let sectionErrors: Partial<Record<PreferenceSection, string>> = {};
  let loadStatus: PreferenceSnapshot["status"] = "loading";
  let revision: string | undefined;
  let loadError: string | undefined;
  let malformedValue: unknown;
  let fresh = false;
  let hasValidSnapshot = false;
  let serial = 0;
  let firstValidSnapshot = true;
  let operationId = 0;
  let generation = 0;
  let started = false;
  let watch: { close(): void } | undefined;
  let stopState: (() => void) | undefined;
  let queue = Promise.resolve();
  const pendingOperations = new Map<number, Operation>();
  const retiredOperations = new Set<number>();
  const listeners = new Set<() => void>();
  const waiters: { resolve(): void; reject(error: unknown): void }[] = [];
  const saves = emptySaves();
  const repairs = emptyRepairs();

  let current: PreferenceSnapshot = {
    status: "loading",
    connection: client.getState(),
    effective,
    display: effective,
    fieldErrors,
    sectionErrors,
    saves,
    repairs,
  };

  const activeValue = (path: PreferencePath): unknown => {
    if (sectionErrors[sectionFor(path)]) return rawPath(raw, path);
    const active = Object.values(saves)
      .filter(
        (save) => ["saving", "error", "conflict"].includes(save.phase) && !save.blockedSection,
      )
      .toSorted((a, b) => (b.id ?? 0) - (a.id ?? 0))
      .find((save) => save.changes?.some((change) => change.path === path));
    const change = active?.changes?.find((candidate) => candidate.path === path);
    return change ? change.value : rawPath(raw, path);
  };

  const displayPreferences = (): EffectivePreferences => {
    const display = copyEffective(effective);
    const themeValue = activeValue("appearance.theme");
    const wrap = activeValue("logStreams.wrap");
    const timestamps = activeValue("logStreams.timestamps");
    display.appearance.theme =
      themeValue === "light" || themeValue === "dark" ? themeValue : "dark";
    if (typeof wrap === "boolean") display.logStreams.wrap = wrap;
    if (typeof timestamps === "boolean") display.logStreams.timestamps = timestamps;
    return display;
  };

  const publish = () => {
    const display = displayPreferences();
    current = {
      status: loadStatus,
      connection: client.getState(),
      effective,
      display,
      fieldErrors,
      sectionErrors,
      ...(revision !== undefined ? { revision } : {}),
      ...(loadError ? { error: loadError } : {}),
      saves: { ...saves },
      repairs: { ...repairs },
    };
    if (hasValidSnapshot) theme.setTheme(display.appearance.theme);
    for (const listener of listeners) listener();
  };

  const settleWaiters = (error?: unknown) => {
    for (const waiter of waiters.splice(0)) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  };

  const queueOperation = (operation: Operation): Promise<void> => {
    pendingOperations.set(operation.id, operation);
    const result = queue
      .then(() => execute(operation))
      .finally(() => {
        pendingOperations.delete(operation.id);
        retiredOperations.delete(operation.id);
      });
    queue = result.catch(() => {});
    return result;
  };

  const retirePendingOperations = (section: PreferenceSection) => {
    for (const operation of pendingOperations.values())
      if (operation.changes.some((change) => sectionFor(change.path) === section))
        retiredOperations.add(operation.id);
  };

  const retireBlockedSaves = (section: PreferenceSection) => {
    retirePendingOperations(section);
    for (const scope of ["appearance", "retention", "display"] as const) {
      const save = saves[scope];
      if (save.blockedSection !== section) continue;
      saves[scope] = emptySave();
    }
  };

  const makeOperation = (
    scope: PreferenceScope,
    changes: readonly PreferenceChange[],
    observed?: ReadonlyMap<PreferencePath, unknown>,
    migration = false,
  ): Operation => {
    const operation: Operation = {
      id: ++operationId,
      scope,
      changes: changes.map((change) => ({ ...change })),
      observed: observed ?? new Map(changes.map(({ path }) => [path, activeValue(path)] as const)),
      migration,
    };
    saves[scope] = {
      phase: "saving",
      message: "Saving",
      paths: changes.map((change) => change.path),
      id: operation.id,
      changes: operation.changes,
      observed: operation.observed,
      migration,
    };
    return operation;
  };

  const retireMigration = (operation: Operation): boolean => {
    if (
      !operation.migration ||
      (revision === "" && raw === null) ||
      pathsMatch(raw, intended(operation.changes))
    )
      return false;
    retiredOperations.add(operation.id);
    if (saves[operation.scope].id === operation.id) saves[operation.scope] = emptySave();
    return true;
  };

  const retireMigrations = () => {
    for (const operation of pendingOperations.values()) retireMigration(operation);
  };

  const applySetting = (setting: Setting) => {
    serial++;
    revision = setting.revision;
    fresh = true;
    loadError = undefined;
    let migration: Operation | undefined;
    if (setting.revision !== "" || setting.value !== null) {
      for (const scope of ["appearance", "retention", "display"] as const) {
        const save = saves[scope];
        if (save.migration && save.phase === "error") saves[scope] = emptySave();
      }
    }
    try {
      const decoded = decodePreferences(setting);
      raw = decoded.raw;
      effective = decoded.effective;
      fieldErrors = decoded.fieldErrors;
      sectionErrors = decoded.sectionErrors;
      loadStatus = "ready";
      hasValidSnapshot = true;
      malformedValue = undefined;

      for (const section of ["appearance", "logStreams"] as const) {
        const repair = repairs[section];
        if (repair.phase === "saving" && !sectionValue(raw, section).present) {
          repairs[section] = {
            ...repair,
            phase: "saved",
            message: `${section === "appearance" ? "Appearance" : "Log Streams"} section repaired`,
          };
          retireBlockedSaves(section);
        } else if (repair.phase === "saved" && sectionErrors[section])
          repairs[section] = emptySave();
      }

      for (const scope of ["appearance", "retention", "display"] as const) {
        const save = saves[scope];
        const blocked = save.changes?.find((change) => sectionErrors[sectionFor(change.path)]);
        if (blocked)
          saves[scope] = {
            ...save,
            phase: "error",
            message: `Not saved: Repair ${sectionFor(blocked.path) === "appearance" ? "Appearance" : "Log Streams"} section first`,
            blockedSection: sectionFor(blocked.path),
          };
        else if (save.blockedSection) {
          retirePendingOperations(save.blockedSection);
          if (save.migration) saves[scope] = emptySave();
          else if (save.changes && pathsMatch(raw, intended(save.changes)))
            saves[scope] = {
              ...save,
              phase: "saved",
              message: "Saved",
              blockedSection: undefined,
            };
          else
            saves[scope] = {
              ...save,
              phase: "conflict",
              message: "Not saved: changed in another window",
            };
        } else if (save.changes && pathsMatch(raw, intended(save.changes)))
          saves[scope] = { ...save, phase: "saved", message: "Saved" };
        else if (save.phase === "saved" && save.changes && !pathsMatch(raw, intended(save.changes)))
          saves[scope] = emptySave();
      }

      if (firstValidSnapshot) {
        firstValidSnapshot = false;
        const cached = theme.readCachedTheme();
        if (setting.revision === "" && decoded.raw === null && cached) {
          migration = makeOperation(
            "appearance",
            [{ path: "appearance.theme", value: cached }],
            new Map([["appearance.theme", undefined]]),
            true,
          );
        }
      }
    } catch (error) {
      loadStatus = "malformed";
      loadError = messageOf(error);
      malformedValue = setting.value;
      fieldErrors = {};
      sectionErrors = {};
    }
    retireMigrations();
    publish();
    settleWaiters();
    if (migration) void queueOperation(migration);
  };

  const failWatch = (error: unknown) => {
    fresh = false;
    loadStatus = "error";
    loadError = messageOf(error);
    publish();
    settleWaiters(error);
  };

  const openWatch = () => {
    watch?.close();
    const opened = ++generation;
    fresh = false;
    watch = client.subscribe(
      "settings.watch",
      { key: preferenceKey },
      {
        data: (setting) => {
          if (opened === generation) applySetting(setting);
        },
        error: (error) => {
          if (opened === generation) failWatch(error.message);
        },
      },
    );
  };

  const start = () => {
    if (started) return;
    started = true;
    openWatch();
    let previous = client.getState();
    stopState = client.onStateChange(() => {
      const next = client.getState();
      if (next === "open" && previous !== "open") openWatch();
      previous = next;
      publish();
    });
  };

  const refresh = (): Promise<void> =>
    new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      openWatch();
    });

  const ensureFresh = async (): Promise<void> => {
    if (!started) start();
    if (!fresh) await refresh();
    if (loadStatus !== "ready")
      throw new Error(
        loadStatus === "malformed"
          ? "Replace the malformed stored preferences before saving."
          : "Load app preferences successfully before saving.",
      );
  };

  const refreshAfterReconnect = async (): Promise<void> => {
    if (client.getState() === "open") {
      await refresh();
      return;
    }
    await new Promise<void>((resolve) => {
      const stop = client.onStateChange(() => {
        if (client.getState() === "open") {
          stop();
          resolve();
        }
      });
    });
    await refresh();
  };

  const updateSave = (
    operation: Operation,
    phase: PreferenceSaveState["phase"],
    message: string,
  ) => {
    if (saves[operation.scope].id !== operation.id) return;
    const blocked = operation.changes.find((change) => sectionErrors[sectionFor(change.path)]);
    if (phase === "saved" && blocked) {
      phase = "error";
      message = `Not saved: Repair ${sectionFor(blocked.path) === "appearance" ? "Appearance" : "Log Streams"} section first`;
    }
    saves[operation.scope] = {
      phase,
      message,
      paths: operation.changes.map((change) => change.path),
      ...(phase === "saved" || phase === "error" || phase === "conflict"
        ? {
            id: operation.id,
            changes: operation.changes,
            observed: operation.observed,
            migration: operation.migration,
            ...(blocked ? { blockedSection: sectionFor(blocked.path) } : {}),
          }
        : {}),
    };
    publish();
  };

  const conflict = (operation: Operation) => {
    if (operation.migration) {
      if (saves[operation.scope].id === operation.id) saves[operation.scope] = emptySave();
      publish();
      return;
    }
    updateSave(operation, "conflict", "Not saved: changed in another window");
  };

  const blockOperation = (operation: Operation): boolean => {
    const blocked = operation.changes.find((change) => sectionErrors[sectionFor(change.path)]);
    if (!blocked) return false;
    updateSave(
      operation,
      "error",
      `Not saved: Repair ${sectionFor(blocked.path) === "appearance" ? "Appearance" : "Log Streams"} section first`,
    );
    return true;
  };

  async function execute(operation: Operation): Promise<void> {
    let writes = 0;
    try {
      while (writes < 4) {
        if (retiredOperations.has(operation.id)) return;
        await ensureFresh();
        if (retiredOperations.has(operation.id)) return;
        if (retireMigration(operation)) {
          publish();
          return;
        }
        if (blockOperation(operation)) return;
        if (pathsMatch(raw, intended(operation.changes))) {
          updateSave(operation, "saved", "Saved");
          return;
        }
        if (!pathsMatch(raw, operation.observed)) {
          conflict(operation);
          return;
        }

        const value = patchPreferences(raw, operation.changes);
        const ifRevision = revision!;
        const before = serial;
        writes++;
        try {
          await client.request("settings.put", { key: preferenceKey, value, ifRevision });
        } catch (error) {
          if (retiredOperations.has(operation.id)) return;
          const code = errorCode(error);
          if (code === "not_connected") {
            if (saves[operation.scope].id === operation.id) {
              saves[operation.scope] = {
                ...saves[operation.scope],
                message: "Saving when the Engine reconnects",
              };
              publish();
            }
            await refreshAfterReconnect();
          } else if (code === "conflict" || code === "disconnected") {
            await refreshAfterReconnect();
          } else {
            throw error;
          }
          if (retiredOperations.has(operation.id)) return;
          if (loadStatus !== "ready")
            throw new Error(loadError ?? "Could not reload preferences.", { cause: error });
          if (blockOperation(operation)) return;
          if (pathsMatch(raw, intended(operation.changes))) {
            updateSave(operation, "saved", "Saved");
            return;
          }
          if (!pathsMatch(raw, operation.observed)) {
            conflict(operation);
            return;
          }
          continue;
        }

        if (retiredOperations.has(operation.id)) return;
        if (serial === before) await refresh();
        if (retiredOperations.has(operation.id)) return;
        if (loadStatus !== "ready")
          throw new Error(loadError ?? "Could not read back preferences.");
        if (blockOperation(operation)) return;
        if (pathsMatch(raw, intended(operation.changes))) {
          updateSave(operation, "saved", "Saved");
          return;
        }
        conflict(operation);
        return;
      }
      throw new Error("Preferences kept changing in other windows. Try again.");
    } catch (error) {
      if (retiredOperations.has(operation.id)) return;
      if (blockOperation(operation)) return;
      if (loadStatus === "ready" && pathsMatch(raw, intended(operation.changes)))
        updateSave(operation, "saved", "Saved");
      else updateSave(operation, "error", `Not saved: ${messageOf(error)}`);
    }
  }

  const save = (
    scope: Exclude<PreferenceScope, "recovery">,
    changes: readonly PreferenceChange[],
  ): Promise<void> => {
    start();
    const previous = saves[scope];
    let nextChanges = changes;
    let observed: ReadonlyMap<PreferencePath, unknown> | undefined;
    if (
      previous.changes &&
      previous.observed &&
      ["saving", "error", "conflict"].includes(previous.phase)
    ) {
      const prior = new Map(previous.changes.map((change) => [change.path, change]));
      const merged = new Map(prior);
      for (const change of changes) merged.set(change.path, change);
      nextChanges = [...merged.values()];
      observed = new Map(
        nextChanges.map(({ path }) => [
          path,
          prior.has(path)
            ? previous.phase === "saving"
              ? prior.get(path)!.value
              : previous.observed!.get(path)
            : activeValue(path),
        ]),
      );
    }
    const operation = makeOperation(scope, nextChanges, observed);
    if (blockOperation(operation)) return Promise.resolve();
    publish();
    return queueOperation(operation);
  };

  const retry = (scope: Exclude<PreferenceScope, "recovery">, useCurrent = false) => {
    const previous = saves[scope];
    if (!previous.changes || !previous.observed) return Promise.resolve();
    const observed = useCurrent
      ? new Map(previous.changes.map(({ path }) => [path, rawPath(raw, path)] as const))
      : previous.observed;
    const operation = makeOperation(scope, previous.changes, observed, previous.migration);
    if (blockOperation(operation)) return Promise.resolve();
    publish();
    return queueOperation(operation);
  };

  const acceptCurrent = (scope: Exclude<PreferenceScope, "recovery">) => {
    saves[scope] = emptySave();
    publish();
  };

  const repairSection = (section: PreferenceSection): Promise<void> => {
    start();
    const label = section === "appearance" ? "Appearance" : "Log Streams";
    const initial = sectionValue(raw, section);
    const id = ++operationId;
    repairs[section] = { phase: "saving", message: `Repairing ${label} section`, id };
    const update = (phase: "saving" | "saved" | "error" | "conflict", message: string) => {
      if (repairs[section].id !== id) return;
      repairs[section] = { phase, message, id };
      publish();
    };
    if (loadStatus !== "ready" || !initial.present || isRecord(initial.value)) {
      update("error", `Not repaired: ${label} section is not a present malformed value`);
      return Promise.resolve();
    }
    const observed = initial.value;
    publish();

    const evaluate = (): "absent" | "same" | "changed" | "malformed" => {
      if (loadStatus === "malformed") return "malformed";
      if (loadStatus !== "ready") return "changed";
      const currentSection = sectionValue(raw, section);
      if (!currentSection.present) return "absent";
      return !isRecord(currentSection.value) && deepEqual(currentSection.value, observed)
        ? "same"
        : "changed";
    };
    const run = async () => {
      try {
        for (let writes = 0; writes < 4; writes++) {
          await ensureFresh();
          const beforeWrite = evaluate();
          if (beforeWrite === "absent") {
            update("saved", `${label} section repaired`);
            return;
          }
          if (beforeWrite === "malformed")
            throw new Error("Repair the whole stored document before repairing a section.");
          if (beforeWrite === "changed") {
            update("conflict", "Not repaired: section changed in another window");
            return;
          }

          const value: AppPreferencesV1 = { ...raw!, version: 1 };
          delete (value as Record<string, unknown>)[section];
          const ifRevision = revision!;
          const before = serial;
          try {
            await client.request("settings.put", { key: preferenceKey, value, ifRevision });
          } catch (error) {
            const code = errorCode(error);
            if (!["not_connected", "conflict", "disconnected"].includes(code ?? "")) throw error;
            if (code === "not_connected")
              update("saving", `Repairing ${label} section when the Engine reconnects`);
            await refreshAfterReconnect();
            const afterFailure = evaluate();
            if (afterFailure === "absent") {
              update("saved", `${label} section repaired`);
              return;
            }
            if (afterFailure === "malformed")
              throw new Error("Repair the whole stored document before repairing a section.", {
                cause: error,
              });
            if (afterFailure === "changed") {
              update("conflict", "Not repaired: section changed in another window");
              return;
            }
            continue;
          }

          if (serial === before) await refresh();
          const afterWrite = evaluate();
          if (afterWrite === "absent") {
            update("saved", `${label} section repaired`);
            return;
          }
          if (afterWrite === "malformed")
            throw new Error("Repair the whole stored document before repairing a section.");
          if (afterWrite === "changed") {
            update("conflict", "Not repaired: section changed in another window");
            return;
          }
          throw new Error(`${label} section repair was not confirmed by the Engine.`);
        }
        throw new Error(`${label} section kept changing. Try again.`);
      } catch (error) {
        if (evaluate() === "absent") update("saved", `${label} section repaired`);
        else update("error", `Not repaired: ${messageOf(error)}`);
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };

  const preferencesReplaced = () =>
    loadStatus === "ready" && raw !== null && raw.version === 1 && Object.keys(raw).length === 1;

  const replaceStoredPreferences = (): Promise<void> => {
    start();
    const id = ++operationId;
    saves.recovery = { phase: "saving", message: "Replacing stored preferences", id };
    publish();
    const updateRecovery = (phase: "saving" | "saved" | "error", message: string) => {
      if (saves.recovery.id !== id) return;
      saves.recovery = { phase, message, id };
      publish();
    };
    const run = async () => {
      try {
        for (let writes = 0; writes < 4; writes++) {
          if (!fresh) await refresh();
          if (preferencesReplaced()) {
            updateRecovery("saved", "Stored preferences replaced");
            return;
          }
          if (loadStatus !== "malformed" || revision === undefined || malformedValue === undefined)
            throw new Error("Stored preferences changed in another window.");
          const observedRevision = revision;
          const before = serial;
          try {
            await client.request("settings.put", {
              key: preferenceKey,
              value: { version: 1 },
              ifRevision: observedRevision,
            });
          } catch (error) {
            const code = errorCode(error);
            if (!["not_connected", "conflict", "disconnected"].includes(code ?? "")) throw error;
            if (code === "not_connected")
              updateRecovery("saving", "Replacing when the Engine reconnects");
            await refreshAfterReconnect();
            if (preferencesReplaced()) {
              updateRecovery("saved", "Stored preferences replaced");
              return;
            }
            if (loadStatus !== "malformed" || revision !== observedRevision)
              throw new Error("Stored preferences changed in another window.", { cause: error });
            continue;
          }
          if (serial === before) await refresh();
          if (preferencesReplaced()) {
            updateRecovery("saved", "Stored preferences replaced");
            return;
          }
          throw new Error(
            loadStatus === "malformed"
              ? "Replacement was not confirmed by the Engine."
              : "Stored preferences changed in another window.",
          );
        }
        throw new Error("Stored preferences kept changing. Try again.");
      } catch (error) {
        if (preferencesReplaced()) updateRecovery("saved", "Stored preferences replaced");
        else updateRecovery("error", `Not saved: ${messageOf(error)}`);
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };

  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          watch?.close();
          watch = undefined;
          generation++;
          stopState?.();
          stopState = undefined;
          started = false;
          fresh = false;
          settleWaiters(new Error("Preference controller closed."));
        }
      };
    },
    save,
    retry,
    acceptCurrent,
    retryLoad: openWatch,
    repairSection,
    replaceStoredPreferences,
  };
}

const stores = new WeakMap<EngineClient, ReturnType<typeof createPreferenceStore>>();

export function getPreferenceStore(engine: EngineClient) {
  let store = stores.get(engine);
  if (!store) {
    store = createPreferenceStore(engine);
    stores.set(engine, store);
  }
  return store;
}

export function usePreferences() {
  const store = getPreferenceStore(useEngine());
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot) };
}

/** Keeps Engine-shared preferences active while the Settings page is closed. */
export function PreferencesController() {
  usePreferences();
  return null;
}
