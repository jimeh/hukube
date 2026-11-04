import {
  normalizeHotkey,
  parseHotkey,
  matchesKeyboardEvent,
  formatForDisplay,
  validateHotkey,
  PUNCTUATION_CODE_MAP,
} from "@tanstack/hotkeys";
import { compileCondition, disjoint, type Context, type Condition } from "./conditions.ts";
import { argumentsFor, isCommand, type CommandId } from "./catalog.ts";
export type Platform = Context["platform"];
export interface Rule {
  id: string;
  command: string;
  args?: Record<string, unknown>;
  keys: string[];
  when: string;
  enabled: boolean;
  scope: "app" | "terminal";
  [key: string]: unknown;
}
export interface KeybindingDocument {
  version: 1;
  rules: Rule[];
  disabledDefaults: string[];
  [key: string]: unknown;
}
export const emptyDocument: KeybindingDocument = { version: 1, rules: [], disabledDefaults: [] };
export interface CompiledRule extends Rule {
  command: CommandId;
  condition: Condition;
}
export interface Keymap {
  rules: CompiledRule[];
  diagnostics: string[];
}
export const unsafeKey = (e: KeyboardEvent) =>
  e.isComposing ||
  e.keyCode === 229 ||
  ["Dead", "Process", "Unidentified"].includes(e.key) ||
  e.getModifierState("AltGraph");
export function normalizeStroke(key: string, platform: Platform) {
  if (key.length > 100 || !validateHotkey(key).valid) throw Error(`Invalid stroke: ${key}`);
  const normalized = normalizeHotkey(key, platform),
    parsed = parseHotkey(normalized, platform);
  if (
    (parsed.key === "J" || parsed.code === "KeyJ") &&
    (platform === "mac" ? parsed.meta : parsed.ctrl)
  )
    throw Error("Mod+J is reserved, including in chords");
  return normalized;
}
export function displayKeys(keys: string[], platform: Platform): string {
  try {
    return formatForDisplay(keys, { platform });
  } catch {
    return keys.join(" ");
  }
}
const rule = (
  id: string,
  command: CommandId,
  key: string,
  when: string,
  scope: Rule["scope"] = "app",
): Rule => ({ id: `default.${id}`, command, keys: [key], when, scope, enabled: true });
export const defaultRules: Rule[] = [
  rule("resource.app", "app.goToResource", "Mod+K", "!terminalLive"),
  rule("resource.terminal.mac", "app.goToResource", "Meta+K", "platform == 'mac'", "terminal"),
  rule(
    "resource.terminal.other",
    "app.goToResource",
    "Control+Shift+K",
    "platform != 'mac'",
    "terminal",
  ),
  rule("palette.app", "app.commandPalette", "Mod+Shift+P", "!terminalLive"),
  rule("palette.terminal", "app.commandPalette", "Mod+Shift+P", "terminalLive", "terminal"),
  rule("find.editor", "editor.find", "Mod+F", "focus == 'editor'"),
  rule("find.log", "editor.find", "Mod+F", "focus == 'log'"),
  rule("find.terminal.mac", "editor.find", "Meta+F", "platform == 'mac'", "terminal"),
  rule("find.terminal.other", "editor.find", "Control+Shift+F", "platform != 'mac'", "terminal"),
  rule("manifest.review", "manifest.review", "Mod+S", "focus == 'editor' && manifestDirty"),
  rule(
    "copy.terminal.mac",
    "terminal.copy",
    "Meta+C",
    "platform == 'mac' && terminalSelection",
    "terminal",
  ),
  rule(
    "copy.terminal.other",
    "terminal.copy",
    "Control+C",
    "platform != 'mac' && terminalSelection",
    "terminal",
  ),
  rule("copy.terminal.shift", "terminal.copy", "Control+Shift+C", "platform != 'mac'", "terminal"),
  rule("paste.terminal.mac", "terminal.paste", "Meta+V", "platform == 'mac'", "terminal"),
  rule("paste.terminal.other", "terminal.paste", "Control+V", "platform != 'mac'", "terminal"),
  rule(
    "paste.terminal.shift",
    "terminal.paste",
    "Control+Shift+V",
    "platform != 'mac'",
    "terminal",
  ),
  rule("selectAll.terminal.mac", "terminal.selectAll", "Meta+A", "platform == 'mac'", "terminal"),
];
const fields = new Set(["id", "command", "args", "keys", "when", "enabled", "scope"]);
export function compileKeymap(document: KeybindingDocument, platform: Platform): Keymap {
  if (document.version !== 1)
    throw Error("Unsupported keyboard document version. Recovery data is read-only.");
  if (
    !Array.isArray(document.rules) ||
    document.rules.length > 256 ||
    !Array.isArray(document.disabledDefaults) ||
    document.disabledDefaults.length > 256 ||
    new TextEncoder().encode(JSON.stringify(document)).length > 65536
  )
    throw Error("Invalid or oversized keyboard document");
  if (
    new Set(document.disabledDefaults).size !== document.disabledDefaults.length ||
    document.disabledDefaults.some((id) => typeof id !== "string" || id.length > 128)
  )
    throw Error("Invalid disabled default IDs");
  const ids = new Set<string>(),
    diagnostics: string[] = [],
    rules: CompiledRule[] = [];
  for (const raw of [
    ...defaultRules.filter((r) => !document.disabledDefaults.includes(r.id)),
    ...document.rules,
  ]) {
    if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 128 || ids.has(raw.id))
      throw Error("Rule IDs must be unique stable strings");
    ids.add(raw.id);
    if (!isCommand(raw.command) || Object.keys(raw).some((k) => !fields.has(k))) {
      diagnostics.push(
        `${raw.id}: unknown command or future semantic fields; preserved and inactive`,
      );
      continue;
    }
    if (
      !Array.isArray(raw.keys) ||
      raw.keys.length < 1 ||
      raw.keys.length > 2 ||
      raw.keys.some((k) => typeof k !== "string") ||
      typeof raw.enabled !== "boolean" ||
      typeof raw.when !== "string" ||
      !["app", "terminal"].includes(raw.scope)
    )
      throw Error(`${raw.id}: invalid rule shape`);
    const args = argumentsFor(raw.command, raw.args, true),
      keys = raw.keys.map((k) => normalizeStroke(k, platform)),
      condition = compileCondition(raw.when);
    // Scope constraints participate in prefix disjointness, including held/ended terminal defaults.
    const scopeCondition = compileCondition(
      raw.scope === "app"
        ? "!terminalLive"
        : raw.id.startsWith("default.")
          ? "focus == 'terminal'"
          : "focus == 'terminal' && terminalLive",
    );
    const scoped: Condition = {
      test: (c) => condition.test(c) && scopeCondition.test(c),
      keys: new Set([...condition.keys, ...scopeCondition.keys]),
    };
    if (raw.enabled) rules.push({ ...raw, command: raw.command, args, keys, condition: scoped });
  }
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!,
        b = rules[j]!;
      if (!strokesOverlap(a.keys[0]!, b.keys[0]!, platform) || disjoint(a.condition, b.condition))
        continue;
      if (a.keys.length !== b.keys.length)
        throw Error(`${a.id} and ${b.id}: single stroke conflicts with chord prefix`);
      if (
        a.keys.length === b.keys.length &&
        a.keys.every((key, step) => strokesOverlap(key, b.keys[step]!, platform))
      )
        diagnostics.push(
          sameStrokes(a.keys, b.keys, platform)
            ? `${b.id} overrides ${a.id} where their conditions overlap (last eligible rule wins)`
            : `${b.id} may overlap ${a.id} (last eligible matching rule wins)`,
        );
    }
  return { rules, diagnostics };
}
export const matchesStroke = (e: KeyboardEvent, key: string, platform: Platform) =>
  !unsafeKey(e) && matchesKeyboardEvent(e, parseHotkey(key, platform), platform);
/** One ordered eligibility boundary for dispatch and shortcut presentation. */
export function eligibleRules(
  rules: CompiledRule[],
  context: (rule: CompiledRule) => Context,
  matches: (rule: CompiledRule) => boolean,
  available: (rule: CompiledRule) => boolean,
) {
  return rules.filter((candidate) => {
    const c = context(candidate);
    return (
      !c.modalOpen &&
      !c.recording &&
      candidate.condition.test(c) &&
      matches(candidate) &&
      available(candidate)
    );
  });
}
/** Possible intersection, not a layout mapping or authority to dispatch an event.
 * Direct key identities, physical codes and the library's compatibility fallback
 * are independent. Probe both Shift states because printable glyphs allow an
 * implicit Shift. An unknown layout can pair either logical key with either code.
 */
export function strokesOverlap(left: string, right: string, platform: Platform) {
  const a = parseHotkey(left, platform),
    b = parseHotkey(right, platform);
  if (a.ctrl !== b.ctrl || a.meta !== b.meta || a.alt !== b.alt) return false;
  if (normalizeHotkey(left, platform) === normalizeHotkey(right, platform)) return true;
  // Remaining installed codeToLogicalKey branches beyond letters/digits and
  // public punctuation. Keep these as witnesses, not a layout conversion.
  const codes = new Set([
    a.code,
    b.code,
    "",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
    "NumpadEnter",
    "Space",
  ]);
  for (const p of [a, b]) {
    if (!p.key) continue;
    if (/^[A-Z]$/.test(p.key)) codes.add(`Key${p.key}`);
    if (/^[0-9]$/.test(p.key)) {
      codes.add(`Digit${p.key}`);
      codes.add(`Numpad${p.key}`);
    }
    for (const [code, key] of Object.entries(PUNCTUATION_CODE_MAP))
      if (key === p.key) codes.add(code);
  }
  // Non-Latin text permits the installed code fallback; it is not a mapping
  // from the user's layout. Actual dispatch always matches the incoming event.
  for (const key of new Set([a.key, b.key, "м"])) {
    if (!key) continue;
    for (const code of codes)
      for (const shiftKey of [false, true]) {
        const event = {
          key,
          code: code ?? "",
          shiftKey,
          ctrlKey: a.ctrl,
          metaKey: a.meta,
          altKey: a.alt,
          isComposing: false,
          keyCode: 0,
          location: 0,
          getModifierState: () => false,
        } as unknown as KeyboardEvent;
        if (matchesStroke(event, left, platform) && matchesStroke(event, right, platform))
          return true;
      }
  }
  return false;
}
export const sameStrokes = (left: string[], right: string[], platform: Platform) =>
  left.length === right.length &&
  left.every((key, i) => normalizeHotkey(key, platform) === normalizeHotkey(right[i]!, platform));
const nativePasteKeys = (platform: Platform) =>
  platform === "mac" ? ["Meta+V"] : ["Control+V", "Control+Shift+V"];
/** Future prefix/presentation possibility only; never grants completed permission. */
export const possibleNativePaste = (stroke: string, platform: Platform) =>
  nativePasteKeys(platform).some((key) => strokesOverlap(stroke, key, platform));
/** Identical logical native strokes cover the whole matched completion class. */
export const definiteNativePaste = (stroke: string, platform: Platform) =>
  nativePasteKeys(platform).some((key) => sameStrokes([stroke], [key], platform));
export function nativePasteGesture(e: KeyboardEvent, platform: Platform) {
  return nativePasteKeys(platform).some((key) => matchesStroke(e, key, platform));
}
export interface Clock {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}
const clock: Clock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};
/** Owns only sequence progress; callers own origin validation and event consumption. */
export class Chords<T> {
  pending?: { rules: CompiledRule[]; origin: T };
  private timer: unknown;
  constructor(
    private changed: (hint: string) => void,
    private time: Clock = clock,
  ) {}
  cancel() {
    if (!this.pending) return;
    this.time.clear(this.timer);
    this.pending = undefined;
    this.changed("");
  }
  start(rules: CompiledRule[], origin: T) {
    this.cancel();
    this.pending = { rules, origin };
    this.changed(`${rules[0]!.keys[0]} … (Escape to cancel)`);
    this.timer = this.time.set(() => this.cancel(), 1000);
  }
}
