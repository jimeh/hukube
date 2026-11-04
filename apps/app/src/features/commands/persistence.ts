import {
  AppKeybindingsKey,
  type EngineClient,
  type Setting,
  type Subscription,
} from "@hukube/engine-client";
import {
  compileKeymap,
  emptyDocument,
  type KeybindingDocument,
  type Keymap,
  type Platform,
} from "./keyboard.ts";
export interface KeyboardSnapshot {
  loaded: boolean;
  fresh: boolean;
  revision: string;
  raw: unknown;
  document: KeybindingDocument;
  active: Keymap;
  draft?: KeybindingDocument;
  draftRevision?: string;
  status: string;
  error?: string;
  readOnly: boolean;
  conflict: boolean;
  pending: boolean;
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Compare JSON values independently of property insertion order. */
export function equalDocument(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = Object.keys(a),
    y = Object.keys(b);
  return (
    x.length === y.length &&
    x.every(
      (k) =>
        Object.hasOwn(b, k) &&
        equalDocument((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}
export function createKeyboardStore(client: EngineClient, platform: Platform) {
  let state: KeyboardSnapshot = {
    loaded: false,
    fresh: false,
    revision: "",
    raw: null,
    document: emptyDocument,
    active: compileKeymap(emptyDocument, platform),
    status: "Loading shortcuts. Defaults are active.",
    readOnly: false,
    conflict: false,
    pending: false,
  };
  const listeners = new Set<() => void>();
  let watch: Subscription<{ key: string }> | undefined,
    epoch = 0,
    disposed = false;
  let intent: { value: KeybindingDocument; generation: number; settled: boolean } | undefined;
  let generation = 0;
  const show = (patch: Partial<KeyboardSnapshot>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const receive = (setting: Setting) => {
    const raw = setting.value,
      doc = (raw ?? emptyDocument) as KeybindingDocument;
    const revision = setting.revision ?? "";
    if (intent && !intent.settled) {
      show({ fresh: false });
      return;
    }
    let active = state.active,
      error: string | undefined;
    const readOnly = !!raw && typeof raw === "object" && "version" in raw && raw.version !== 1;
    try {
      active = compileKeymap(doc, platform);
    } catch (e) {
      error = message(e);
    }
    const confirmed = intent && equalDocument(doc, intent.value);
    const conflict =
      !!state.draft && revision !== state.draftRevision && !equalDocument(doc, state.draft);
    const unconfirmed = !!intent && !confirmed;
    if (conflict && !confirmed) active = state.active;
    show({
      loaded: true,
      fresh: true,
      revision,
      raw,
      document: doc,
      readOnly,
      error: error ?? (unconfirmed ? state.error : undefined),
      active,
      pending: false,
      conflict: confirmed ? false : conflict,
      ...(confirmed && intent?.generation === generation
        ? { draft: undefined, draftRevision: undefined }
        : {}),
      status: error
        ? "Invalid keyboard data. Last good shortcuts remain active."
        : confirmed
          ? "Saved shortcuts"
          : conflict
            ? `Conflict with Engine revision ${revision}. Your draft is preserved.`
            : unconfirmed
              ? "Not saved. The Engine does not contain your draft. Review before retrying."
              : "Shortcuts loaded",
    });
    intent = undefined;
  };
  const refresh = () => {
    watch?.close();
    const captured = ++epoch;
    show({ fresh: false });
    if (disposed || client.getState() !== "open") return;
    watch = client.subscribe(
      "settings.watch",
      { key: AppKeybindingsKey },
      {
        data: (value) => {
          if (captured === epoch) receive(value);
        },
        error: (e) => {
          if (captured === epoch)
            show({ error: e.message, status: "Could not load shortcuts", fresh: false });
        },
      },
    );
  };
  const off = client.onStateChange(() => {
    if (client.getState() !== "open") {
      epoch++;
      watch?.close();
      show({
        fresh: false,
        status: intent
          ? "Checking save after reconnect…"
          : "Reconnecting. Last good shortcuts remain active.",
      });
    } else refresh();
  });
  refresh();
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    retry: refresh,
    edit(value: KeybindingDocument) {
      if (state.readOnly || state.pending) return;
      generation++;
      show({
        draft: value,
        draftRevision: state.draftRevision ?? state.revision,
        status: "Unsaved shortcuts",
        error: undefined,
      });
    },
    discard() {
      generation++;
      show({
        draft: undefined,
        draftRevision: undefined,
        conflict: false,
        status: state.pending ? "Checking sent save…" : "Changes cancelled",
      });
      if (!state.pending) refresh();
    },
    async save(reviewedConflict = false) {
      if (
        !state.draft ||
        state.pending ||
        !state.loaded ||
        !state.fresh ||
        state.readOnly ||
        client.getState() !== "open"
      )
        return;
      try {
        compileKeymap(state.draft, platform);
      } catch (e) {
        show({ error: message(e), status: "Not saved" });
        return;
      }
      if (state.conflict && !reviewedConflict) return;
      const value = state.draft,
        ifRevision = reviewedConflict ? state.revision : state.draftRevision!;
      const sending = { value, generation, settled: false };
      intent = sending;
      show({ pending: true, status: "Saving shortcuts…", error: undefined });
      try {
        await client.request("settings.put", { key: AppKeybindingsKey, value, ifRevision });
      } catch (e) {
        show({ error: message(e), status: "Save not confirmed. Checking Engine…" });
      } finally {
        if (intent === sending) {
          sending.settled = true;
          refresh();
        }
      }
    },
    dispose() {
      disposed = true;
      epoch++;
      watch?.close();
      off();
      listeners.clear();
    },
  };
}
export type KeyboardStore = ReturnType<typeof createKeyboardStore>;
