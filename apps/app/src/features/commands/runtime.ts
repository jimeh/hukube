import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { WorkspaceValue } from "../workspace/workspace-context.tsx";
import { parseResourceUri } from "@hukube/k8s";
import { guardPanel } from "../edit/unsaved-edits.ts";
import { closeSessionTab } from "../exec/window-tabs.ts";
import { useExecSessions, type ExecTerminal } from "../exec/sessions.ts";
import { isReservedKey } from "../exec/keys.ts";
import { pinPanel } from "../workspace/dock.ts";
import { argumentsFor, catalog, definition, type CommandArgs, type CommandId } from "./catalog.ts";
import {
  Chords,
  eligibleRules,
  strokesOverlap,
  sameStrokes,
  possibleNativePaste,
  definiteNativePaste,
  nativePasteGesture,
  matchesStroke,
  unsafeKey,
  type Keymap,
  type CompiledRule,
  type Platform,
  displayKeys,
} from "./keyboard.ts";
import type { Context } from "./conditions.ts";
export interface Surface {
  element: HTMLElement;
  read(): {
    kind: "editor" | "log" | "terminal" | "resource";
    find?: () => void;
    review?: () => void;
    reviewReason?: string;
    dirty?: boolean;
    uid?: string;
    focus?: () => void;
  };
}
interface WorkspaceOwner {
  token: object;
  api: DockviewApi;
  value: WorkspaceValue;
}
export interface Origin {
  openPane?: string;
  route: string;
  workspace?: WorkspaceOwner;
  panel?: IDockviewPanel;
  group?: object;
  params?: string;
  surface?: Surface;
  resource?: Surface;
  resourceUid?: string;
  uid?: string;
  element?: HTMLElement;
  session?: ExecTerminal;
}
interface Configuration {
  route: string;
  platform: Platform;
  host: "web" | "desktop";
  connection: string;
  modalCount: number;
  map: Keymap;
  preferencesReady(): boolean;
  preference(field: "theme" | "wrap" | "timestamps", value: string | boolean): void;
  settings(section: string, origin: Origin): void;
}
interface View {
  palette?: {
    mode: "commands" | "resources";
    origin: Origin;
    prompt?: { id: CommandId; args: Record<string, unknown> };
  };
  hint: string;
  error: string;
  recording: boolean;
}
const paletteCommand = (id: CommandId) => id === "app.commandPalette" || id === "app.goToResource";
export const terminalVerdicts = new WeakMap<KeyboardEvent, "handled" | "paste">();
export class CommandRuntime {
  private workspaces = new Map<string, WorkspaceOwner>();
  private surfaces = new Map<HTMLElement, Surface>();
  private listeners = new Set<() => void>();
  private config?: Configuration;
  private view: View = { hint: "", error: "", recording: false };
  // Compare published palette output, never callback identity or copied owner state.
  private availabilityObservation: unknown[] = [];
  private paletteObservation?: { content: string; types?: WorkspaceValue["types"] };
  private held = new Map<string, { native?: EventTarget | null; key: string }>();
  private paletteInput?: View["palette"];
  private returnFocus?: { origin: Origin; target: Origin; closed: boolean };
  readonly chords = new Chords<Origin>((hint) => this.show({ hint }));
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.view;
  private show(patch: Partial<View>) {
    if ("palette" in patch) this.paletteInput = patch.palette;
    if (patch.palette) this.returnFocus = undefined;
    this.view = { ...this.view, ...patch };
    this.paletteObservation = this.observePalette();
    this.availabilityObservation = this.observeAvailability();
    for (const fn of this.listeners) fn();
  }
  private observePalette() {
    const origin = this.view.palette?.origin;
    if (!origin) return;
    return {
      content: JSON.stringify([
        origin.panel?.api.title ?? origin.workspace?.value.cluster ?? "Window",
        catalog.map(({ id }) => [this.reason(id, origin), this.label(id, origin)]),
      ]),
      types: origin.workspace?.value.types,
    };
  }
  /** Compare capabilities and captured identities, never fresh owner values or callbacks.
   * Closed-palette consumers (notably Exec hints) also need the parent's layout
   * updates after their own render. This projection only controls publication;
   * invocation still reads the live owners and validates its exact capture.
   */
  private observeAvailability(): unknown[] {
    const values: unknown[] = [!!this.config?.preferencesReady(), !!navigator.clipboard?.readText];
    for (const [cluster, owner] of this.workspaces) {
      values.push(cluster, owner.token, owner.api, owner.value.active);
      for (const panel of new Set([owner.api.activePanel, ...(owner.api.panels ?? [])])) {
        if (!panel) continue;
        const sessionId = (panel.params as { sessionId?: string })?.sessionId;
        const terminal = sessionId
          ? useExecSessions.getState().entries.get(sessionId)?.terminal
          : undefined;
        values.push(
          panel,
          panel.group,
          JSON.stringify(panel.params),
          panel.api?.component,
          terminal,
          terminal?.inputHeld,
          terminal?.hasSelection(),
        );
      }
    }
    for (const surface of this.surfaces.values()) {
      const state = surface.read();
      values.push(
        surface,
        surface.element.isConnected,
        state.kind,
        !!state.find,
        !!state.review,
        state.reviewReason,
        !!state.dirty,
        state.uid,
      );
    }
    return values;
  }
  configure(config: Configuration) {
    if (
      this.config?.map !== config.map ||
      config.modalCount > (this.view.palette ? 1 : 0) ||
      this.config?.route !== config.route
    )
      this.chords.cancel();
    if (
      this.config?.route !== config.route ||
      config.modalCount > (this.config?.modalCount ?? 0) ||
      config.connection === "outdated"
    )
      this.returnFocus = undefined;
    if (
      this.config?.route !== config.route ||
      config.modalCount > (this.view.palette ? 1 : 0) ||
      config.connection === "outdated"
    )
      this.paletteInput = undefined;
    const contextChanged =
      !this.config ||
      this.config.map !== config.map ||
      this.config.route !== config.route ||
      this.config.platform !== config.platform ||
      this.config.host !== config.host ||
      this.config.connection !== config.connection ||
      this.config.modalCount !== config.modalCount;
    this.config = config;
    if (contextChanged) this.show({});
    this.refreshAvailability();
  }
  registerWorkspace(cluster: string, owner: WorkspaceOwner) {
    this.workspaces.set(cluster, owner);
    this.refreshAvailability();
    return () => {
      if (this.workspaces.get(cluster) === owner) {
        this.workspaces.delete(cluster);
        this.refreshAvailability();
      }
      this.chords.cancel();
    };
  }
  ownsPaletteInput(palette: NonNullable<View["palette"]>) {
    return (
      this.paletteInput === palette &&
      this.view.palette === palette &&
      !this.view.recording &&
      this.valid(palette.origin, "workspace") &&
      this.config?.connection !== "outdated" &&
      (this.config?.modalCount ?? 0) <= 1
    );
  }
  refreshAvailability() {
    // Visible navigation input follows placement, not Resource/edit authorization.
    if (this.paletteInput && !this.valid(this.paletteInput.origin, "workspace"))
      this.paletteInput = undefined;
    if (this.returnFocus && !this.valid(this.returnFocus.target)) this.returnFocus = undefined;
    if (this.chords.pending && !this.valid(this.chords.pending.origin)) this.chords.cancel();
    if (
      this.config?.connection === "outdated" ||
      (this.view.palette?.mode === "resources" &&
        !this.valid(this.view.palette.origin, "workspace"))
    ) {
      this.closePalette();
      return;
    }
    const next = this.observePalette();
    const availability = this.observeAvailability();
    if (
      availability.length !== this.availabilityObservation.length ||
      availability.some((value, i) => value !== this.availabilityObservation[i]) ||
      (next &&
        (next.content !== this.paletteObservation?.content ||
          next.types !== this.paletteObservation?.types))
    )
      this.show({});
  }
  registerSurface(surface: Surface) {
    this.surfaces.set(surface.element, surface);
    this.refreshAvailability();
    return () => {
      if (this.surfaces.get(surface.element) === surface) {
        this.surfaces.delete(surface.element);
        const origin = this.chords.pending?.origin;
        if (origin?.surface === surface || origin?.resource === surface) this.chords.cancel();
        this.refreshAvailability();
      }
    };
  }
  capture(cluster?: string, panelId?: string, element?: HTMLElement): Origin {
    const route = this.config?.route ?? "/";
    const workspace = cluster
      ? this.workspaces.get(cluster)
      : [...this.workspaces.values()].find((w) => w.value.active && route.startsWith("/c/"));
    element ??=
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const targetPanelId =
      panelId ?? element?.closest<HTMLElement>("[data-command-panel]")?.dataset["commandPanel"];
    const panel = targetPanelId
      ? workspace?.api.getPanel(targetPanelId)
      : workspace?.api.activePanel;
    const candidates = [...this.surfaces.values()]
      .filter((s) =>
        panel
          ? s.element.closest<HTMLElement>("[data-command-panel]")?.dataset["commandPanel"] ===
            panel.id
          : s.element.contains(element ?? null),
      )
      .filter((s) => s.element.getClientRects().length);
    const resource = candidates.find((s) => s.read().kind === "resource");
    const owned = candidates.filter((s) => s.read().kind !== "resource");
    const surface =
      owned
        .filter((s) => s.element.contains(element ?? null))
        .toSorted((a, b) =>
          a.element.contains(b.element) ? 1 : b.element.contains(a.element) ? -1 : 0,
        )[0] ??
      owned[0] ??
      resource;
    const sessionId = element?.closest<HTMLElement>("[data-exec-session]")?.dataset["execSession"];
    const session = sessionId
      ? useExecSessions.getState().entries.get(sessionId)?.terminal
      : undefined;
    return {
      route,
      workspace,
      panel,
      group: panel?.group,
      resource,
      resourceUid: resource?.read().uid,
      params: panel ? JSON.stringify(panel.params) : undefined,
      surface,
      uid: surface?.read().uid,
      element,
      session,
    };
  }
  valid(origin: Origin, target: "captured" | "workspace" = "captured"): boolean {
    if (origin.route !== this.config?.route) return false;
    const w = origin.workspace;
    if (w && (!w.value.active || this.workspaces.get(w.value.cluster)?.token !== w.token))
      return false;
    if (
      origin.panel &&
      (w?.api.getPanel(origin.panel.id) !== origin.panel ||
        origin.group !== origin.panel.group ||
        origin.params !== JSON.stringify(origin.panel.params))
    )
      return false;
    if (origin.openPane !== undefined && origin.openPane !== origin.panel?.id) return false;
    // Workspace navigation retains exact placement, but does not operate on the
    // source Resource, editor or session. Hydration/remounting is incidental.
    if (target === "workspace") return true;
    if (
      origin.resource &&
      (this.surfaces.get(origin.resource.element) !== origin.resource ||
        origin.resourceUid !== origin.resource.read().uid)
    )
      return false;
    if (
      origin.surface &&
      (this.surfaces.get(origin.surface.element) !== origin.surface ||
        origin.uid !== origin.surface.read().uid)
    )
      return false;
    if (
      origin.session &&
      origin.session !==
        useExecSessions
          .getState()
          .entries.get((origin.panel?.params as { sessionId?: string })?.sessionId ?? "")?.terminal
    )
      return false;
    return true;
  }
  context(origin = this.capture()): Context {
    const cfg = this.config,
      e = origin.element,
      surface = origin.surface?.read(),
      terminal = origin.session;
    const text = !!e?.closest("input,textarea,select,[contenteditable=true]");
    // Find widgets retain Monaco's own native Find action.
    const findWidget = !!e?.closest(".find-widget");
    const focused =
      surface?.kind === "terminal" && terminal?.element.contains(e ?? null)
        ? "terminal"
        : findWidget
          ? "input"
          : origin.surface?.element.contains(e ?? null) &&
              (surface?.kind === "editor" || surface?.kind === "log")
            ? surface.kind
            : text
              ? "input"
              : "other";
    const uri = (origin.panel?.params as { uri?: string })?.uri;
    return {
      platform: cfg?.platform ?? "linux",
      host: cfg?.host ?? "web",
      route: cfg?.route.startsWith("/settings")
        ? "settings"
        : cfg?.route.startsWith("/c/")
          ? "workspace"
          : "clusters",
      workspace: !!origin.workspace,
      focus: focused,
      tabKind: (origin.panel?.api.component ?? "none") as Context["tabKind"],
      facet: uri ? (parseResourceUri(uri)?.facet ?? "none") : "none",
      terminalLive: focused === "terminal" && !!terminal && !terminal.inputHeld,
      terminalSelection: !!terminal?.hasSelection(),
      manifestDirty: !!surface?.dirty,
      engineConnected: cfg?.connection === "open",
      modalOpen: (cfg?.modalCount ?? 0) > (this.view.palette ? 1 : 0),
      paletteOpen: !!this.view.palette,
      recording: this.view.recording,
    };
  }
  private refuseRecording() {
    if (!this.view.recording) return false;
    this.show({
      error: "Stop or cancel shortcut recording before opening Commands or Go to Resource.",
    });
    return true;
  }
  reason(id: CommandId, origin: Origin, nativePaste = false): string | undefined {
    if (paletteCommand(id) && this.view.recording)
      return "Stop or cancel shortcut recording before opening Commands or Go to Resource.";
    if (this.config?.connection === "outdated") return "The app is out of date.";
    const def = definition(id);
    if (
      !this.valid(
        origin,
        def.target === "workspace" || paletteCommand(id) ? "workspace" : "captured",
      )
    )
      return "The captured target changed or is no longer available.";
    const surface = origin.surface?.read();
    if (def.target === "workspace" && !origin.workspace) return "Open a Cluster Workspace first.";
    if (def.target === "tab" && !origin.panel) return "No captured Tab.";
    if (id === "tab.pin" && !(origin.panel?.params as { preview?: boolean })?.preview)
      return "The Tab is already pinned.";
    if (id === "manifest.review")
      return surface?.review ? surface.reviewReason : "No captured Manifest edit.";
    if (id === "editor.find" && !surface?.find) return "No captured searchable editor or terminal.";
    if (def.target === "terminal" && !origin.session) return "Focus an Exec terminal first.";
    if (id === "terminal.copy" && !origin.session?.hasSelection())
      return "No terminal text selected.";
    if (
      id === "terminal.paste" &&
      !nativePaste &&
      (!navigator.clipboard?.readText || origin.session?.inputHeld)
    )
      return "Clipboard reading is unavailable here. Use the browser paste shortcut in a live terminal.";
    if (
      (id.startsWith("logs.") || id === "appearance.setTheme") &&
      !this.config?.preferencesReady()
    )
      return "App preferences are not available.";
    if (
      (id === "app.goToResource" || id === "app.commandPalette") &&
      (this.config?.modalCount ?? 0) > (this.view.palette ? 1 : 0)
    )
      return "Close the current dialog first.";
  }
  dispatch<K extends CommandId>(id: K, args: CommandArgs<K>, origin = this.capture()) {
    return this.invoke(id, args, origin, "pointer");
  }
  invoke(
    id: CommandId,
    raw: unknown,
    origin: Origin,
    source: "pointer" | "keyboard" | "palette" = "palette",
    gesture?: KeyboardEvent,
  ) {
    try {
      const args = argumentsFor(id, raw, source !== "pointer");
      const nativePaste =
        source === "keyboard" &&
        id === "terminal.paste" &&
        !!gesture &&
        nativePasteGesture(gesture, this.config!.platform);
      const reason = this.reason(id, origin, nativePaste);
      if (reason) throw Error(reason);
      try {
        argumentsFor(id, args);
      } catch (e) {
        if (source === "pointer") throw e;
        if (this.refuseRecording()) return false;
        this.show({ palette: { mode: "commands", origin, prompt: { id, args } } });
        return true;
      }
      this.execute(id, args, origin, nativePaste);
      return true;
    } catch (e) {
      this.show({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
  private execute(
    id: CommandId,
    args: Record<string, unknown>,
    origin: Origin,
    nativePaste: boolean,
  ) {
    const cfg = this.config!,
      workspace = origin.workspace,
      surface = origin.surface?.read(),
      terminal = origin.session;
    switch (id) {
      case "app.commandPalette":
        this.openPalette("commands", origin);
        return;
      case "app.goToResource":
        this.openPalette("resources", origin);
        return;
      case "app.openSettings":
        this.closePalette(false);
        cfg.settings(typeof args.section === "string" ? args.section : "appearance", origin);
        return;
      case "resource.openType":
      case "resource.open": {
        const beside = args.beside ? origin.panel?.id : undefined;
        if (args.beside && !beside) throw Error("Open beside requires a captured Tab.");
        if (id === "resource.openType") {
          if (!workspace!.value.types.has(String(args.type)))
            throw Error("Resource Type is not available in the captured Workspace.");
          workspace!.value.openList(String(args.type), {
            preview: !!args.preview,
            beside,
            pane: origin.openPane,
          });
        } else {
          const address = parseResourceUri(String(args.uri));
          if (!address || address.cluster !== workspace!.value.cluster)
            throw Error("Resource URI must belong to the captured Workspace.");
          workspace!.value.openResource(address, {
            preview: !!args.preview,
            beside,
            pane: origin.openPane,
          });
        }
        break;
      }
      case "tab.close": {
        this.closePalette(false);
        guardPanel(origin.panel!.id, () => {
          if (!this.valid(origin)) {
            this.show({ error: "The captured Tab changed before the close was confirmed." });
            return;
          }
          if (origin.panel!.id.startsWith("exec:"))
            closeSessionTab(workspace!.value.cluster, origin.panel!.id.slice(5));
          origin.panel!.api.close();
        });
        return;
      }
      case "tab.pin":
        pinPanel(origin.panel!.api, origin.panel!.params);
        break;
      case "editor.find":
        this.closePalette(false);
        surface!.find!();
        return;
      case "manifest.review":
        this.closePalette(false);
        // Overview and YAML prepare their own field/editor return policy.
        surface?.focus?.();
        surface!.review!();
        return;
      case "appearance.setTheme":
        cfg.preference("theme", String(args.theme));
        break;
      case "logs.setWrap":
        cfg.preference("wrap", !!args.enabled);
        break;
      case "logs.setTimestamps":
        cfg.preference("timestamps", !!args.enabled);
        break;
      case "terminal.copy":
        terminal!.copy();
        break;
      case "terminal.selectAll":
        terminal!.selectAll();
        break;
      case "terminal.clear":
        terminal!.clear();
        break;
      case "terminal.paste":
        if (!nativePaste)
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (this.valid(origin) && !terminal!.inputHeld) terminal!.paste(text);
            })
            .catch((e) => this.show({ error: String(e) }));
        break;
    }
    this.closePalette();
  }
  openPalette(mode: "commands" | "resources", origin = this.capture()) {
    if (this.refuseRecording()) return;
    if (this.reason(mode === "commands" ? "app.commandPalette" : "app.goToResource", origin))
      return;
    this.chords.cancel();
    if (this.view.palette?.mode === mode) {
      this.closePalette();
      return;
    }
    this.show({ palette: { mode, origin: this.view.palette?.origin ?? origin }, error: "" });
  }
  editArguments(id: CommandId, origin: Origin, args: Record<string, unknown> = {}) {
    if (this.refuseRecording()) return;
    this.show({ palette: { mode: "commands", origin, prompt: { id, args } } });
  }
  backToSearch() {
    if (this.view.palette) this.show({ palette: { ...this.view.palette, prompt: undefined } });
  }
  closePalette(restore = true) {
    if (!restore) this.returnFocus = undefined;
    const origin = this.view.palette?.origin;
    if (!origin) return;
    this.returnFocus = restore
      ? { origin, target: this.valid(origin) ? origin : this.capture(), closed: false }
      : undefined;
    this.show({ palette: undefined });
  }
  // Base UI retains its focus scope through the exit animation. finalFocus=false
  // disables auto-return, but not its restoration of focus inside the closing popup.
  paletteClosed() {
    if (this.view.palette || !this.returnFocus) return;
    this.returnFocus.closed = true;
    this.restorePaletteFocus();
  }
  private restorePaletteFocus() {
    const pending = this.returnFocus;
    if (!pending?.closed || this.held.size) return;
    // The completion callback precedes the unmount commit. Cross that commit and
    // its focus cleanup once; key release and every invalidation still gate the job.
    requestAnimationFrame(() => {
      if (this.returnFocus !== pending || this.held.size) return;
      this.returnFocus = undefined;
      if (this.view.palette || (this.config?.modalCount ?? 0) > 0 || !this.valid(pending.target))
        return;
      const { origin, target } = pending;
      if (
        this.valid(origin) &&
        origin.element?.isConnected &&
        origin.element.getClientRects().length &&
        !origin.element.closest("[inert]")
      )
        origin.element.focus();
      else {
        const focus = target.surface?.read().focus;
        if (focus) focus();
        else
          document
            .querySelector<HTMLElement>('nav[aria-label=Clusters] [aria-label="Command palette"]')
            ?.focus({ preventScroll: true });
      }
    });
  }

  setRecording(recording: boolean) {
    this.chords.cancel();
    this.paletteInput = undefined;
    this.returnFocus = undefined;
    this.show({ recording });
  }
  label(id: CommandId, origin = this.capture()) {
    return this.labelFor(id, this.context(origin), origin);
  }
  private ruleAvailable(rule: CompiledRule, origin: Origin, event?: KeyboardEvent) {
    const native =
      rule.command === "terminal.paste" &&
      (event
        ? nativePasteGesture(event, this.config!.platform)
        : possibleNativePaste(rule.keys.at(-1)!, this.config!.platform));
    return !this.reason(rule.command, origin, native);
  }
  private ruleAvailability(rule: CompiledRule, origin: Origin) {
    if (!this.reason(rule.command, origin)) return "definite";
    if (!this.ruleAvailable(rule, origin)) return "unavailable";
    return definiteNativePaste(rule.keys.at(-1)!, this.config!.platform) ? "definite" : "partial";
  }
  resolveRule(rule: CompiledRule, map: Keymap, origin: Origin, context = this.context(origin)) {
    const candidates = eligibleRules(
      map.rules,
      () => context,
      (r) =>
        r.keys.length === rule.keys.length &&
        r.keys.every((key, i) => strokesOverlap(rule.keys[i]!, key, context.platform)),
      (r) => this.ruleAvailable(r, origin),
    );
    if (!candidates.includes(rule)) return {};
    const later = candidates.slice(candidates.indexOf(rule) + 1);
    const conflict = later.at(-1);
    if (!conflict)
      return this.ruleAvailability(rule, origin) === "partial"
        ? { partial: true }
        : { winner: rule };
    // Only identical normalized sequences establish dominance over the entire
    // represented event class. Partial overlap depends on the actual layout.
    return sameStrokes(rule.keys, conflict.keys, context.platform) &&
      this.ruleAvailability(conflict, origin) === "definite"
      ? { winner: conflict }
      : { conflict };
  }
  winnerFor(rule: CompiledRule, map: Keymap, origin: Origin, context = this.context(origin)) {
    return this.resolveRule(rule, map, origin, context).winner;
  }
  labelFor(id: CommandId, c: Context, origin = this.capture()) {
    return this.config?.map.rules
      .findLast((r) => r.command === id && this.winnerFor(r, this.config!.map, origin, c) === r)
      ?.keys.map((k) => displayKeys([k], c.platform))
      .join(" ");
  }
  key = (event: KeyboardEvent) => {
    const physical = event.code || event.key;
    const held = this.held.get(physical);
    if (held) {
      // Keep the native default only for the original still-visible control.
      // A search selection, prompt submission or close may already have removed it.
      const nativeDefault =
        held.native &&
        event.target === held.native &&
        this.view.palette &&
        held.native instanceof HTMLElement &&
        held.native.isConnected &&
        ((event.type === "keypress" && held.key === "Enter") ||
          (event.type === "keyup" && held.key === " "));
      if (nativeDefault && event.type === "keypress") held.native = undefined;
      if (nativeDefault && event.type !== "keyup") return;
      terminalVerdicts.set(event, "handled");
      if (!nativeDefault) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (event.type === "keyup") {
        this.held.delete(physical);
        if (!this.held.size) this.restorePaletteFocus();
      }
      return;
    }
    if (
      event.type !== "keydown" ||
      this.view.recording ||
      unsafeKey(event) ||
      event.repeat ||
      !this.config
    )
      return;
    if (isReservedKey(this.config.platform === "mac", event)) {
      this.chords.cancel();
      return;
    }
    if (this.view.palette && ["Enter", "Escape", " "].includes(event.key)) {
      const native = event.target instanceof HTMLElement && event.target.closest("button,a[href]");
      if (event.key === " " && !native) return;
      this.held.set(physical, { key: event.key, native: native || undefined });
      return;
    }
    const origin = this.capture(),
      context = this.context(origin);
    const matchContext = (r: CompiledRule, target: Origin) =>
      this.view.palette && r.scope === "terminal" && paletteCommand(r.command)
        ? this.context(target)
        : context;
    if (context.modalOpen) {
      this.chords.cancel();
      return;
    }
    if (
      this.chords.pending &&
      (!this.valid(this.chords.pending.origin) ||
        origin.panel !== this.chords.pending.origin.panel ||
        origin.workspace?.token !== this.chords.pending.origin.workspace?.token)
    )
      this.chords.cancel();
    if (this.chords.pending && event.key === "Escape") {
      this.consume(event);
      this.chords.cancel();
      return;
    }
    // Modifier transitions are not a second stroke. Validate the origin and modal
    // above first, and leave the existing deadline untouched.
    if (this.chords.pending && ["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    const pending = this.chords.pending;
    if (pending) {
      this.chords.cancel();
      const winner = eligibleRules(
        pending.rules,
        (r) => matchContext(r, pending.origin),
        (r) => matchesStroke(event, r.keys[1]!, context.platform),
        (r) =>
          !this.reason(
            r.command,
            pending.origin,
            r.command === "terminal.paste" && nativePasteGesture(event, context.platform),
          ),
      ).at(-1);
      if (winner) {
        this.consume(
          event,
          winner.command === "terminal.paste" && nativePasteGesture(event, context.platform),
        );
        this.invoke(winner.command, winner.args, pending.origin, "keyboard", event);
        return;
      }
    }
    const ruleOrigin = (command: CommandId) =>
      (command === "app.commandPalette" || command === "app.goToResource") && this.view.palette
        ? this.view.palette.origin
        : origin;
    const eligible = eligibleRules(
      this.config.map.rules,
      (r) => matchContext(r, ruleOrigin(r.command)),
      (r) => matchesStroke(event, r.keys[0]!, context.platform),
      // A prefix cannot know its completion's key/code. Keep possible
      // candidates, then check the actual second event before choosing a winner.
      (r) => this.ruleAvailable(r, ruleOrigin(r.command), r.keys.length === 1 ? event : undefined),
    );
    if (!eligible.length) return;
    const winner = eligible.at(-1)!,
      target = ruleOrigin(winner.command);
    this.consume(
      event,
      winner.keys.length === 1 &&
        winner.command === "terminal.paste" &&
        nativePasteGesture(event, context.platform),
    );
    if (winner.keys.length === 2) this.chords.start(eligible, target);
    else this.invoke(winner.command, winner.args, target, "keyboard", event);
  };
  private consume(e: KeyboardEvent, paste = false) {
    this.held.set(e.code || e.key, { key: e.key });
    terminalVerdicts.set(e, paste ? "paste" : "handled");
    if (!paste) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  blur = () => {
    this.held.clear();
    this.paletteInput = undefined;
    this.returnFocus = undefined;
    this.chords.cancel();
  };
}
export const commands = new CommandRuntime();
