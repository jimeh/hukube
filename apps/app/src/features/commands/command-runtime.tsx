import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useConnectionState } from "@hukube/engine-client/react";
import { useModalCount } from "@hukube/ui/hooks/use-modal-inert";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@hukube/ui/components/command";
import { Button } from "@hukube/ui/components/button";
import { useHost } from "@/lib/host.tsx";
import { commandPlatform } from "@/lib/platform.ts";
import { usePreferences } from "../settings/store.ts";
import { rememberSettingsOrigin } from "../settings/settings-page.tsx";
import { useSettingsOpenWork } from "../settings/open-work.ts";
import { WorkspaceContext } from "../workspace/workspace-context.tsx";
import { ResourceSearch } from "../go-to-resource/go-to-resource.tsx";
import { commands } from "./runtime.ts";
import { useKeybindings } from "./store.ts";
import { catalog, definition, validateArguments, type ArgumentIssue } from "./catalog.ts";
import { ArgumentFields, focusInvalidArgument } from "./argument-fields.tsx";
export function CommandRuntime() {
  const { snapshot } = useKeybindings();
  const preferences = usePreferences();
  const connection = useConnectionState(),
    host = useHost(),
    location = useLocation(),
    navigate = useNavigate(),
    modalCount = useModalCount();
  const view = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [search, setSearch] = useState("");
  useLayoutEffect(() => {
    commands.configure({
      route: location.pathname,
      platform: commandPlatform,
      host: host.kind,
      connection,
      modalCount,
      map: snapshot.active,
      preferencesReady: () => {
        const s = preferences.store.getSnapshot();
        return s.loaded && !s.error;
      },
      preference: (field, value) => preferences.store.change(field, value),
      settings: (section, origin) => {
        rememberSettingsOrigin(origin.route, origin.element, true);
        void navigate({ to: "/settings/$section", params: { section } });
      },
    });
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => commands.key(e);
    const cancel = () => commands.chords.cancel();
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("keypress", key, true);
    window.addEventListener("blur", commands.blur);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("focusin", cancel, true);
    // Recorder filters before its document listener sees an unsafe event.
    const recorderFilter = (e: KeyboardEvent) => {
      if (
        commands.getSnapshot().recording &&
        (e.isComposing ||
          e.keyCode === 229 ||
          ["Dead", "Process"].includes(e.key) ||
          e.getModifierState("AltGraph") ||
          e.repeat)
      )
        e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", recorderFilter, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("keypress", key, true);
      window.removeEventListener("blur", commands.blur);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("focusin", cancel, true);
      window.removeEventListener("keydown", recorderFilter, true);
    };
  }, []);
  useEffect(
    () => useSettingsOpenWork.getState().setKeybindings(!!snapshot.draft || snapshot.pending),
    [snapshot.draft, snapshot.pending],
  );
  const [lastMode, setLastMode] = useState(view.palette?.mode);
  if (lastMode !== view.palette?.mode) {
    setLastMode(view.palette?.mode);
    setSearch("");
  }
  const palette = view.palette;
  const inputView = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || !palette || !commands.ownsPaletteInput(palette)) return;
      // A view's ref attaches inside the portal, including when it opens before
      // the previous exit finishes. Ordinary updates retain this callback identity.
      element
        .querySelector<HTMLElement>("[data-slot=command-input],form input,form select")
        ?.focus();
      return () => {
        // Release a disappearing control while it is still connected. Otherwise
        // the dialog schedules a popup restore that can outlive a rapid reopen.
        if (element.contains(document.activeElement))
          element.closest<HTMLElement>("[role=dialog]")?.focus({ preventScroll: true });
      };
    },
    [palette],
  );
  return (
    <>
      {view.hint && (
        <output className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded border bg-popover p-3 text-sm shadow">
          {view.hint}
        </output>
      )}
      {view.error && !palette && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-50 max-w-sm rounded border bg-popover p-3 text-sm"
        >
          {view.error}
        </div>
      )}
      <CommandDialog
        open={!!palette}
        onOpenChange={(open) => {
          if (!open) commands.closePalette();
        }}
        onOpenChangeComplete={(open) => {
          if (!open) commands.paletteClosed();
        }}
        title={palette?.mode === "resources" ? "Go to Resource" : "Command palette"}
        description="Actions use the target captured when this palette opened"
        finalFocus={false}
        initialFocus={false}
        className="top-[8vh]! max-h-[84vh] overflow-y-auto sm:max-w-2xl!"
      >
        {palette && (
          <div
            ref={inputView}
            onKeyDownCapture={(e) => {
              if (e.key === "Escape" && palette.prompt) {
                e.preventDefault();
                e.stopPropagation();
                commands.backToSearch();
              }
            }}
          >
            <div className="flex flex-wrap gap-2 border-b p-2">
              <Button
                variant={palette.mode === "commands" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={palette.mode === "commands"}
                onClick={() => {
                  if (palette.mode !== "commands") commands.openPalette("commands", palette.origin);
                }}
              >
                Commands
              </Button>
              <Button
                variant={palette.mode === "resources" ? "secondary" : "ghost"}
                size="sm"
                disabled={!palette.origin.workspace}
                aria-pressed={palette.mode === "resources"}
                onClick={() => {
                  if (palette.mode !== "resources")
                    commands.openPalette("resources", palette.origin);
                }}
              >
                Go to Resource
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => commands.closePalette()}
              >
                Close
              </Button>
            </div>
            <p className="break-words px-3 py-2 text-xs text-muted-foreground">
              Captured target:{" "}
              {palette.origin.panel?.api.title ??
                palette.origin.workspace?.value.cluster ??
                "Window"}
            </p>
            {view.error && (
              <p role="alert" className="px-3 text-sm text-destructive">
                {view.error}
              </p>
            )}
            {palette.prompt ? (
              <Prompt key={palette.prompt.id} prompt={palette.prompt} origin={palette.origin} />
            ) : palette.mode === "resources" && palette.origin.workspace ? (
              <WorkspaceContext value={palette.origin.workspace.value}>
                <ResourceSearch origin={palette.origin} />
              </WorkspaceContext>
            ) : (
              <Command
                shouldFilter={false}
                loop
                onKeyDownCapture={(e) => {
                  // cmdk owns Search/list navigation. Nested native controls own
                  // their activation defaults, including Enter on Arguments.
                  if (
                    e.key === "Enter" &&
                    e.target instanceof HTMLElement &&
                    e.target.closest("button,a[href]")
                  )
                    e.stopPropagation();
                }}
              >
                <CommandInput
                  aria-label="Search commands"
                  placeholder="Search commands…"
                  value={search}
                  onValueChange={setSearch}
                />
                <CommandList>
                  <CommandEmpty>No commands match.</CommandEmpty>
                  {catalog
                    .filter((c) =>
                      `${c.id} ${c.title} ${c.category} ${c.description}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((c) => {
                      const reason = commands.reason(c.id, palette.origin);
                      return (
                        <div key={c.id} className="flex min-w-0 items-center">
                          <CommandItem
                            value={c.id}
                            disabled={!!reason}
                            className="min-w-0 flex-1 data-[disabled=true]:opacity-100"
                            onSelect={() => commands.invoke(c.id, {}, palette.origin)}
                          >
                            <div className="min-w-0">
                              <p>{c.title}</p>
                              <p className="break-words text-xs text-muted-foreground">
                                {reason ?? c.description}
                              </p>
                              <p className="text-xs text-muted-foreground">{c.id}</p>
                            </div>
                            <span className="ml-auto shrink-0 text-xs">
                              {commands.label(c.id, palette.origin)}
                            </span>
                          </CommandItem>
                          {!!c.fields.length && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Edit arguments for ${c.title}`}
                              onClick={() => commands.editArguments(c.id, palette.origin)}
                            >
                              Arguments
                            </Button>
                          )}
                        </div>
                      );
                    })}
                </CommandList>
              </Command>
            )}
          </div>
        )}
      </CommandDialog>
    </>
  );
}
function Prompt({
  prompt,
  origin,
}: {
  prompt: NonNullable<ReturnType<typeof commands.getSnapshot>["palette"]>["prompt"] & {};
  origin: Parameters<typeof commands.invoke>[2];
}) {
  const [args, setArgs] = useState(prompt.args);
  const [issues, setIssues] = useState<ArgumentIssue[]>([]);
  const form = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={form}
      className="flex flex-col gap-4 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const validation = validateArguments(prompt.id, args);
        setIssues(validation.issues);
        if (validation.issues.length) {
          focusInvalidArgument(form.current, validation.issues);
          return;
        }
        commands.invoke(prompt.id, args, origin, "pointer");
      }}
    >
      <h3 className="font-medium">{definition(prompt.id).title}</h3>
      {issues
        .filter((issue) => !issue.field)
        .map((issue) => (
          <p key={issue.message} role="alert">
            {issue.message}
          </p>
        ))}
      <ArgumentFields
        issues={issues}
        cluster={origin.workspace?.value.cluster}
        id={prompt.id}
        onSubmit={() => form.current?.requestSubmit()}
        value={args}
        onChange={setArgs}
        types={[...(origin.workspace?.value.types.keys() ?? [])]}
      />
      <div className="flex gap-2">
        <Button type="submit">Run command</Button>
        <Button type="button" variant="outline" onClick={() => commands.backToSearch()}>
          Back
        </Button>
      </div>
    </form>
  );
}
