import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Button } from "@hukube/ui/components/button";
import { Input } from "@hukube/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@hukube/ui/components/native-select";
import { Checkbox } from "@hukube/ui/components/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@hukube/ui/components/alert-dialog";
import { DefinitionManager } from "../overview/definition-manager.tsx";
import { useOpenClusters } from "../clusters/open-clusters.ts";
import {
  defaults,
  logFields,
  maximums,
  fieldStatus,
  sectionStatus,
  type Field,
  type NumericField,
} from "./preferences.ts";
import { KeyboardSettings } from "../commands/keyboard-settings.tsx";
import { usePreferences } from "./store.ts";

const sections = {
  "keyboard-shortcuts": "Keyboard shortcuts",
  appearance: "Appearance",
  "log-streams": "Log Streams",
  "overview-definitions": "Overview definitions",
};
type Section = keyof typeof sections;
let origin: HTMLElement | undefined;
let explicitOrigin = false;
let returnLocation = "/";
try {
  const saved = sessionStorage.getItem("hukube.settings-return");
  if (saved?.startsWith("/c/")) returnLocation = saved;
} catch {
  /* Window-local history is optional. */
}
export function rememberSettingsOrigin(location: string, target?: HTMLElement, explicit = false) {
  if (location.startsWith("/settings")) return;
  if (!explicit && explicitOrigin) {
    explicitOrigin = false;
    return;
  }
  explicitOrigin = explicit;
  returnLocation = location;
  origin = target;
  try {
    sessionStorage.setItem("hukube.settings-return", location);
  } catch {
    /* Navigation still works. */
  }
}
export function SettingsPage({ visible }: { visible: boolean }) {
  const location = useLocation();
  const clusterIds = useOpenClusters((state) => state.ids);
  const navigate = useNavigate();
  const section = location.pathname.split("/")[2] || "appearance";
  const valid = Object.hasOwn(sections, section);
  const [visited, setVisited] = useState<string[]>([section]);
  if (visible && !visited.includes(section)) setVisited([...visited, section]);
  const page = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const sectionElements = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const element = sectionElements.current.get(section);
    if (visible && element) element.scrollTop = scrollPositions.current.get(section) ?? 0;
  }, [visible, section]);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousVisible = useRef(false);
  const sidebar = useRef<HTMLElement>(null);
  const selector = useRef<HTMLSelectElement>(null);
  const { snapshot, store } = usePreferences();
  useEffect(() => {
    if (visible && !previousVisible.current) heading.current?.focus({ preventScroll: true });
    if (!visible && page.current?.contains(document.activeElement))
      document
        .querySelector<HTMLElement>(
          "nav[aria-label=Clusters] [data-active=true] a, nav[aria-label=Clusters] a",
        )
        ?.focus();
    previousVisible.current = visible;
  }, [visible]);
  useEffect(() => {
    const media = matchMedia("(min-width: 768px)");
    const swap = () => {
      if (media.matches && document.activeElement === selector.current)
        sidebar.current?.querySelector<HTMLElement>("[aria-current=page]")?.focus();
      else if (!media.matches && sidebar.current?.contains(document.activeElement))
        selector.current?.focus();
    };
    media.addEventListener("change", swap);
    return () => media.removeEventListener("change", swap);
  }, []);
  const back = () => {
    const cluster = returnLocation.startsWith("/c/")
      ? decodeURIComponent(returnLocation.split("/")[2]!)
      : undefined;
    const destination = cluster && clusterIds.includes(cluster) ? returnLocation : "/";
    void navigate({ to: destination }).then(() =>
      requestAnimationFrame(() => {
        if (origin?.isConnected && origin.getClientRects().length) origin.focus();
        else {
          const target = document.querySelector<HTMLElement>(
            "nav[aria-label=Clusters] [data-active=true] a, main h1, main button",
          );
          if (target) {
            if (target.tagName === "H1") target.tabIndex = -1;
            target.focus();
          }
        }
      }),
    );
  };
  const returnCluster = returnLocation.startsWith("/c/")
    ? decodeURIComponent(returnLocation.split("/")[2]!)
    : undefined;
  return (
    <div ref={page} hidden={!visible} className="h-full overflow-hidden" aria-label="App Settings">
      <div className="mx-auto flex h-full max-w-5xl min-w-0 flex-col gap-5 p-4 sm:p-8">
        <div>
          <Button variant="ghost" onClick={back}>
            Back to{" "}
            {returnCluster && clusterIds.includes(returnCluster) ? returnCluster : "clusters"}
          </Button>
          <h1 ref={heading} tabIndex={-1} className="mt-3 text-xl font-semibold outline-none">
            Settings
          </h1>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 md:flex-row">
          <nav
            ref={sidebar}
            aria-label="Settings categories"
            className="hidden w-48 shrink-0 flex-col gap-1 md:flex"
          >
            {Object.entries(sections).map(([key, label]) => (
              <Link
                key={key}
                to="/settings/$section"
                params={{ section: key }}
                aria-current={section === key ? "page" : undefined}
                className="rounded p-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-col gap-2 md:hidden">
            <label htmlFor="settings-category">Settings category</label>
            <NativeSelect
              id="settings-category"
              ref={selector}
              value={valid ? section : ""}
              onChange={(event) =>
                void navigate({ to: "/settings/$section", params: { section: event.target.value } })
              }
            >
              {!valid && (
                <NativeSelectOption value="" disabled>
                  Unknown category
                </NativeSelectOption>
              )}
              {Object.entries(sections).map(([key, label]) => (
                <NativeSelectOption key={key} value={key}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <output className="sr-only">
              {visible ? (sections[section as Section] ?? "Unknown Settings category") : ""}
            </output>
            {!valid && (
              <div>
                <h2>Unknown Settings category</h2>
                <Link to="/settings/$section" params={{ section: "appearance" }}>
                  Open Appearance
                </Link>
              </div>
            )}
            {visited
              .filter((key) => Object.hasOwn(sections, key))
              .map((key) => (
                <section
                  key={key}
                  hidden={section !== key}
                  className="h-full overflow-auto pr-1"
                  ref={(element) => {
                    if (element) sectionElements.current.set(key, element);
                    else sectionElements.current.delete(key);
                  }}
                  onScroll={(event) => {
                    if (visible && section === key)
                      scrollPositions.current.set(key, event.currentTarget.scrollTop);
                  }}
                  aria-label={sections[key as Section]}
                >
                  <h2 className="mb-4 text-lg font-medium">{sections[key as Section]}</h2>
                  {key === "overview-definitions" ? (
                    <DefinitionManager />
                  ) : key === "keyboard-shortcuts" ? (
                    <KeyboardSettings
                      visible={
                        visible && section === key && location.pathname.startsWith("/settings/")
                      }
                    />
                  ) : (
                    <>
                      <p className="mb-4 text-sm text-muted-foreground">
                        Shared by every window and both Hosts connected to this Engine.
                      </p>
                      {!snapshot.loaded && !snapshot.error && (
                        <output>Loading app preferences…</output>
                      )}
                      {snapshot.error && (
                        <div role="alert" className="mb-4 break-words">
                          <p>{snapshot.error}</p>
                          <Button variant="outline" onClick={store.retry}>
                            Retry loading preferences
                          </Button>
                        </div>
                      )}
                      {snapshot.loaded && !snapshot.connected && !snapshot.error && (
                        <output>
                          Reconnecting. Changes are not saved until preferences can be read again.
                        </output>
                      )}
                      {key === "appearance" ? (
                        <PreferenceField field="theme" />
                      ) : (
                        <div className="flex flex-col gap-5">
                          <p className="text-sm text-muted-foreground">
                            Limits apply to each Log Stream, including hidden ones. Reducing a limit
                            removes oldest whole lines immediately after confirmation. Increasing it
                            never restores removed content.
                          </p>
                          <PreferenceField field="wrap" />
                          <PreferenceField field="timestamps" />
                          <PreferenceField field="maxLines" />
                          <PreferenceField field="maxCharacters" />
                          <details>
                            <summary className="cursor-pointer py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring">
                              Advanced
                            </summary>
                            <div className="mt-3">
                              <PreferenceField field="maxDecorations" />
                            </div>
                          </details>
                        </div>
                      )}
                      <PreferenceSectionStatus
                        fields={key === "appearance" ? ["theme"] : logFields}
                      />
                      <ResetSection section={key === "appearance" ? "appearance" : "logStreams"} />
                    </>
                  )}
                </section>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
const labels: Record<Field, string> = {
  theme: "Theme",
  wrap: "Wrap lines",
  timestamps: "Show timestamps",
  maxLines: "Maximum retained lines",
  maxCharacters: "Maximum retained characters",
  maxDecorations: "Maximum styled ranges",
};
export function PreferenceField({ field }: { field: Field }) {
  const { store, snapshot } = usePreferences();
  const draft = snapshot.drafts[field];
  const value = draft && draft.status !== "Saved" ? draft.value : snapshot.values[field];
  const disabled = !snapshot.loaded || !!snapshot.error;
  const id = `preference-${field}`;
  const numeric = field in maximums;
  const help =
    field === "maxCharacters"
      ? "Rendered UTF-16 code units, including timestamp/origin prefixes and one newline per row. Some Unicode characters count as two units. This is not a heap size."
      : field === "maxDecorations"
        ? "Counts ANSI colors/styles and timestamp/origin/marker styling. Reaching this limit removes oldest whole lines."
        : field === "maxLines"
          ? "Oldest whole lines are removed when any retention limit is reached."
          : "";
  return (
    <div
      className="flex min-w-0 flex-col gap-2 text-sm"
      onBlur={(event) => {
        if (numeric && !event.currentTarget.contains(event.relatedTarget)) store.commit([field]);
      }}
    >
      {numeric ? (
        <>
          <label htmlFor={id}>{labels[field]}</label>
          <Input
            id={id}
            name={field}
            inputMode="numeric"
            autoComplete="off"
            className="max-w-xs"
            value={String(value)}
            disabled={disabled}
            aria-invalid={!!draft?.error}
            aria-describedby={`${help ? `${id}-help ` : ""}${id}-status`}
            onChange={(event) => store.edit(field, event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                store.commit([field]);
              }
            }}
          />
        </>
      ) : field === "theme" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={id}>Theme</label>
          <NativeSelect
            id={id}
            name="theme"
            value={String(value)}
            disabled={disabled}
            onChange={(event) => store.change(field, event.target.value)}
          >
            <NativeSelectOption value="light">Light</NativeSelectOption>
            <NativeSelectOption value="dark">Dark</NativeSelectOption>
          </NativeSelect>
        </div>
      ) : (
        <label className="flex min-h-6 items-center gap-2" htmlFor={id}>
          <Checkbox
            id={id}
            name={field}
            checked={!!value}
            disabled={disabled}
            onCheckedChange={(checked) => store.change(field, checked)}
          />
          {labels[field]}
        </label>
      )}
      {help && (
        <p id={`${id}-help`} className="max-w-prose text-muted-foreground">
          {help} Range: 1 to {maximums[field as NumericField]?.toLocaleString()}.
        </p>
      )}
      <div id={`${id}-status`} aria-live="polite" className="break-words text-xs">
        {draft ? (
          <>
            <p>
              {fieldStatus(snapshot, field)}
              {draft.error ? `: ${draft.error}` : ""}
            </p>
            {draft.conflict && <p>Engine value: {String(snapshot.values[field])}</p>}
            {draft.status === "Not saved" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {draft.reset ? (
                  <span>
                    Review and confirm Reset{" "}
                    {draft.reset === "appearance" ? "Appearance" : "Log Streams"} below to retry
                    this section.
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => store.commit([field], !!draft.conflict)}
                  >
                    {draft.conflict ? "Keep my value" : "Retry save"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    store.discard([field]);
                    document.getElementById(id)?.focus();
                  }}
                >
                  Use Engine value
                </Button>
              </div>
            )}
          </>
        ) : (
          fieldStatus(snapshot, field)
        )}
      </div>
    </div>
  );
}
export function PreferenceSectionStatus({ fields }: { fields: Field[] }) {
  const { snapshot } = usePreferences();
  return <output className="mt-5 block text-sm">{sectionStatus(snapshot, fields)}</output>;
}
export function ResetSection({ section }: { section: "appearance" | "logStreams" }) {
  const { store, snapshot } = usePreferences();
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = section === "appearance" ? "Appearance" : "Log Streams";
  return (
    <>
      <Button
        ref={trigger}
        variant="outline"
        className="mt-4"
        disabled={!snapshot.loaded || !!snapshot.error}
        onClick={() => setOpen(true)}
      >
        Reset {label}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) trigger.current?.focus();
        }}
      >
        <AlertDialogContent initialFocus={cancel}>
          <AlertDialogTitle>Reset {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {section === "appearance"
              ? "Use the dark theme."
              : `Use ${defaults.maxLines.toLocaleString()} lines, ${defaults.maxCharacters.toLocaleString()} characters, ${defaults.maxDecorations.toLocaleString()} styled ranges, wrap on and timestamps off. Reductions can remove retained lines.`}{" "}
            This replaces this section's drafts.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button ref={cancel} variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                store.reset(section);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              Reset {label}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
