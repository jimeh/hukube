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
  private paletteObservation?: { content: string; types?: WorkspaceValue["types"] };
  private held = new Set<string>();
  private returnFocus?: { origin: Origin; target: Origin; closed: boolean };
  readonly chords = new Chords<Origin>((hint) => this.show({ hint }));
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.view;
  private show(patch: Partial<View>) {
    if (patch.palette) this.returnFocus = undefined;
    this.view = { ...this.view, ...patch };
    this.paletteObservation = this.observePalette();
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
    const mapChanged = this.config?.map !== config.map;
    this.config = config;
    if (mapChanged) this.show({});
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
  refreshAvailability() {
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
    if (
      next &&
      (next.content !== this.paletteObservation?.content ||
        next.types !== this.paletteObservation?.types)
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
  reason(id: CommandId, origin: Origin, source = "palette"): string | undefined {
    if (this.config?.connection === "outdated") return "The app is out of date.";
    const def = definition(id);
    if (!this.valid(origin, def.target === "workspace" ? "workspace" : "captured"))
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
      source !== "keyboard" &&
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
  ) {
    try {
      const args = argumentsFor(id, raw, source !== "pointer");
      const reason = this.reason(id, origin, source);
      if (reason) throw Error(reason);
      try {
        argumentsFor(id, args);
      } catch (e) {
        if (source === "pointer") throw e;
        this.show({ palette: { mode: "commands", origin, prompt: { id, args } } });
        return true;
      }
      this.execute(id, args, origin, source);
      return true;
    } catch (e) {
      this.show({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
  private execute(id: CommandId, args: Record<string, unknown>, origin: Origin, source: string) {
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
        if (source !== "keyboard")
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
    this.show({ recording });
  }
  label(id: CommandId, origin = this.capture()) {
    return this.labelFor(id, this.context(origin));
  }
  labelFor(id: CommandId, c: Context) {
    return this.config?.map.rules
      .findLast((r) => r.command === id && r.condition.test(c))
      ?.keys.map((k) => displayKeys([k], c.platform))
      .join(" ");
  }
  key = (event: KeyboardEvent) => {
    const physical = event.code || event.key;
    if (this.held.has(physical)) {
      terminalVerdicts.set(event, "handled");
      event.preventDefault();
      event.stopImmediatePropagation();
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
    if (this.view.palette && ["Enter", "Escape"].includes(event.key)) {
      this.held.add(physical);
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
      const winner = pending.rules.findLast(
        (r) =>
          r.condition.test(matchContext(r, pending.origin)) &&
          matchesStroke(event, r.keys[1]!, context.platform) &&
          !this.reason(r.command, pending.origin, "keyboard"),
      );
      if (winner) {
        this.consume(event, winner.command === "terminal.paste");
        this.invoke(winner.command, winner.args, pending.origin, "keyboard");
        return;
      }
    }
    const ruleOrigin = (command: CommandId) =>
      (command === "app.commandPalette" || command === "app.goToResource") && this.view.palette
        ? this.view.palette.origin
        : origin;
    const eligible = this.config.map.rules.filter((r) => {
      const target = ruleOrigin(r.command),
        c = matchContext(r, target);
      return (
        r.condition.test(c) &&
        (!c.terminalLive || r.scope === "terminal") &&
        (r.scope !== "terminal" ||
          (c.focus === "terminal" && (r.id.startsWith("default.") || c.terminalLive))) &&
        matchesStroke(event, r.keys[0]!, c.platform) &&
        !this.reason(r.command, target, "keyboard")
      );
    });
    if (!eligible.length) return;
    const winner = eligible.at(-1)!,
      target = ruleOrigin(winner.command);
    this.consume(event, winner.command === "terminal.paste");
    if (winner.keys.length === 2) this.chords.start(eligible, target);
    else this.invoke(winner.command, winner.args, target, "keyboard");
  };
  private consume(e: KeyboardEvent, paste = false) {
    this.held.add(e.code || e.key);
    terminalVerdicts.set(e, paste ? "paste" : "handled");
    if (!paste) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  blur = () => {
    this.held.clear();
    this.returnFocus = undefined;
    this.chords.cancel();
  };
}
export const commands = new CommandRuntime();
