import { Alert, AlertDescription, AlertTitle } from "@hukube/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@hukube/ui/components/alert-dialog";
import { Button } from "@hukube/ui/components/button";
import { Checkbox } from "@hukube/ui/components/checkbox";
import { Input } from "@hukube/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@hukube/ui/components/native-select";
import { Separator } from "@hukube/ui/components/separator";
import { Spinner } from "@hukube/ui/components/spinner";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useOpenClusters } from "@/features/clusters/open-clusters.ts";
import { DefinitionManager } from "@/features/overview/definition-manager.tsx";

import {
  logPreferenceDefaults,
  logPreferenceRanges,
  parseDecimalDraft,
  usePreferences,
  type PreferenceChange,
  type PreferencePath,
  type PreferenceSaveState,
  type PreferenceScope,
} from "./preferences.ts";

export const settingsCategories = ["appearance", "logs", "overview"] as const;
export type SettingsCategory = (typeof settingsCategories)[number];

const categoryNames: Record<SettingsCategory, string> = {
  appearance: "Appearance",
  logs: "Log Streams",
  overview: "Overview definitions",
};

const connectionNames = {
  connecting: "Connecting to the Engine",
  reconnecting: "Connection to the Engine lost",
  outdated: "App and Engine versions do not match",
  closed: "Disconnected from the Engine",
} as const;

const pathNames: Record<PreferencePath, string> = {
  "appearance.theme": "Theme",
  "logStreams.maxLines": "Retained lines",
  "logStreams.maxCharacters": "Retained characters",
  "logStreams.maxStyledRanges": "Styled ranges",
  "logStreams.wrap": "Wrap",
  "logStreams.timestamps": "Timestamps",
};

export function SettingsPage({
  category,
  fromCluster,
}: {
  category: SettingsCategory;
  fromCluster?: string;
}) {
  const ids = useOpenClusters((state) => state.ids);
  const { snapshot, store } = usePreferences();
  const navigate = useNavigate();
  const [replaceOpen, setReplaceOpen] = useState(false);
  const returnsToCluster = !!fromCluster && ids.includes(fromCluster);
  const search = fromCluster ? { fromCluster } : {};

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-col gap-2">
          <Button
            className="w-fit"
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={
              returnsToCluster ? (
                <Link to="/c/$cluster" params={{ cluster: fromCluster }} />
              ) : (
                <Link to="/" />
              )
            }
          >
            {returnsToCluster ? `Back to ${fromCluster}` : "Back to clusters"}
          </Button>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            These preferences are shared by every window connected to this Engine.
          </p>
        </header>

        {snapshot.status === "loading" && (
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading app preferences
          </output>
        )}
        {snapshot.connection !== "open" && (
          <Alert>
            <AlertTitle>{connectionNames[snapshot.connection]}</AlertTitle>
            <AlertDescription>
              {snapshot.connection === "outdated"
                ? "Preferences are frozen until the app and Engine versions match."
                : snapshot.status === "ready"
                  ? "Last-known preferences remain active. Changes wait for an Engine connection and are shown as Saved only after read-back."
                  : "App preferences will load and changes can be saved after the Engine connects."}
            </AlertDescription>
          </Alert>
        )}
        {snapshot.status === "error" && (
          <Alert variant="destructive">
            <AlertTitle>Could not load app preferences</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>{snapshot.error}</span>
              <Button size="sm" variant="outline" onClick={store.retryLoad}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {snapshot.status === "malformed" && (
          <Alert variant="destructive">
            <AlertTitle>Stored app preferences cannot be read</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>{snapshot.error}</span>
              <span>
                Last-known values remain active. Replace the stored document only if discarding its
                unsupported data is acceptable.
              </span>
              <Button size="sm" variant="destructive" onClick={() => setReplaceOpen(true)}>
                Replace stored preferences
              </Button>
              <SaveStatus scope="recovery" save={snapshot.saves.recovery} />
            </AlertDescription>
          </Alert>
        )}
        {snapshot.status !== "malformed" && snapshot.saves.recovery.phase !== "idle" && (
          <SaveStatus scope="recovery" save={snapshot.saves.recovery} />
        )}

        <div className="flex flex-col gap-4 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
          <label className="flex flex-col gap-1 text-xs font-medium md:hidden">
            Category
            <NativeSelect
              className="w-full"
              aria-label="Category"
              value={category}
              onChange={(event) =>
                void navigate({
                  to: "/settings",
                  search: { ...search, category: event.target.value as SettingsCategory },
                })
              }
            >
              {settingsCategories.map((item) => (
                <NativeSelectOption key={item} value={item}>
                  {categoryNames[item]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>

          <nav aria-label="Settings categories" className="hidden md:block">
            <ul className="flex flex-col gap-1">
              {settingsCategories.map((item) => (
                <li key={item}>
                  <Link
                    to="/settings"
                    search={{ ...search, category: item }}
                    aria-current={item === category ? "page" : undefined}
                    className="flex min-h-8 items-center rounded-md px-3 py-1.5 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                  >
                    {categoryNames[item]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0">
            <div hidden={category !== "appearance"}>
              <AppearanceSettings />
            </div>
            <div hidden={category !== "logs"}>
              <LogStreamSettings />
            </div>
            <div hidden={category !== "overview"}>
              <OverviewSettings />
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={replaceOpen} onOpenChange={setReplaceOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Replace stored app preferences?</AlertDialogTitle>
          <AlertDialogDescription>
            This replaces the malformed or unsupported document with current defaults. Unknown data
            in that document will be discarded.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setReplaceOpen(false);
                void store.replaceStoredPreferences();
              }}
            >
              Replace stored preferences
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function AppearanceSettings() {
  const { snapshot, store } = usePreferences();
  const disabled = snapshot.status !== "ready";
  return (
    <SettingsSection
      id="settings-appearance"
      title="Appearance"
      description="Choose the color theme used by this Engine's app windows."
    >
      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-sm font-medium">Theme</legend>
        {(["light", "dark"] as const).map((theme) => (
          <label key={theme} className="flex min-h-8 items-center gap-2 rounded-md px-2 text-sm">
            <input
              type="radio"
              name="theme"
              value={theme}
              checked={snapshot.display.appearance.theme === theme}
              onChange={() =>
                void store.save("appearance", [{ path: "appearance.theme", value: theme }])
              }
              className="size-4 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
            {theme === "light" ? "Light" : "Dark"}
          </label>
        ))}
      </fieldset>
      {snapshot.fieldErrors["appearance.theme"] && (
        <p role="alert" className="text-xs text-destructive">
          {snapshot.fieldErrors["appearance.theme"]}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void store.save("appearance", [{ path: "appearance.theme", value: undefined }])
          }
        >
          Reset section
        </Button>
        <SaveStatus
          scope="appearance"
          save={snapshot.saves.appearance}
          onRetry={(overwrite) => void store.retry("appearance", overwrite)}
          onUseCurrent={() => store.acceptCurrent("appearance")}
        />
      </div>
    </SettingsSection>
  );
}

type BudgetName = "maxLines" | "maxCharacters" | "maxStyledRanges";
const budgetFields: readonly {
  name: BudgetName;
  path: PreferencePath;
  label: string;
  unit: string;
}[] = [
  {
    name: "maxLines",
    path: "logStreams.maxLines",
    label: "Retained lines",
    unit: "rows",
  },
  {
    name: "maxCharacters",
    path: "logStreams.maxCharacters",
    label: "Retained characters",
    unit: "UTF-16 characters plus one newline per row",
  },
  {
    name: "maxStyledRanges",
    path: "logStreams.maxStyledRanges",
    label: "Styled ranges",
    unit: "Monaco styled ranges, including ANSI styles, timestamps, origins, and notices/markers",
  },
];

function LogStreamSettings() {
  const { snapshot, store } = usePreferences();
  const prefix = useId();
  const confirmed = snapshot.effective.logStreams;
  const [drafts, setDrafts] = useState<Partial<Record<BudgetName, string>>>({});
  const [reduction, setReduction] = useState<
    | { kind: "save"; changes: readonly PreferenceChange[]; clearDrafts: boolean }
    | { kind: "retry"; paths: readonly PreferencePath[]; overwrite: boolean }
  >();
  const values = {
    maxLines: drafts.maxLines ?? String(confirmed.maxLines),
    maxCharacters: drafts.maxCharacters ?? String(confirmed.maxCharacters),
    maxStyledRanges: drafts.maxStyledRanges ?? String(confirmed.maxStyledRanges),
  };
  const validations = useMemo(
    () => ({
      maxLines: parseDecimalDraft(values.maxLines, logPreferenceRanges.maxLines),
      maxCharacters: parseDecimalDraft(values.maxCharacters, logPreferenceRanges.maxCharacters),
      maxStyledRanges: parseDecimalDraft(
        values.maxStyledRanges,
        logPreferenceRanges.maxStyledRanges,
      ),
    }),
    [values.maxLines, values.maxCharacters, values.maxStyledRanges],
  );
  const resetDrafts = () => {
    setDrafts({});
  };

  const reconcileConfirmedDrafts = (paths: readonly PreferencePath[]) => {
    setDrafts((current) => {
      const next = { ...current };
      const latest = store.getSnapshot().effective.logStreams;
      for (const path of paths) {
        const name = path.split(".")[1] as BudgetName;
        const draft = current[name];
        if (
          draft !== undefined &&
          parseDecimalDraft(draft, logPreferenceRanges[name]).value === latest[name]
        )
          delete next[name];
      }
      return next;
    });
  };

  const persist = (changes: readonly PreferenceChange[], clearDrafts = false) => {
    void store.save("retention", changes).then(() => {
      if (store.getSnapshot().saves.retention.phase !== "saved") return;
      if (clearDrafts) {
        resetDrafts();
        return;
      }
      reconcileConfirmedDrafts(changes.map(({ path }) => path));
    });
  };
  const saveChanges = (changes: readonly PreferenceChange[], clearDrafts = false) => {
    const isReduction = changes.some(({ path, value }) => {
      const name = path.split(".")[1] as BudgetName;
      const effectiveValue = typeof value === "number" ? value : logPreferenceDefaults[name];
      return effectiveValue < confirmed[name];
    });
    if (isReduction) setReduction({ kind: "save", changes, clearDrafts });
    else persist(changes, clearDrafts);
  };
  const retry = (paths: readonly PreferencePath[], overwrite: boolean) => {
    void store.retry("retention", overwrite).then(() => {
      if (store.getSnapshot().saves.retention.phase === "saved") reconcileConfirmedDrafts(paths);
    });
  };
  const retryChanges = (overwrite: boolean) => {
    const changes = snapshot.saves.retention.changes;
    const paths = changes?.map(({ path }) => path) ?? [];
    const isReduction = changes?.some(({ path, value }) => {
      const name = path.split(".")[1] as BudgetName;
      const intended = typeof value === "number" ? value : logPreferenceDefaults[name];
      return intended < confirmed[name];
    });
    if (isReduction) setReduction({ kind: "retry", paths, overwrite });
    else retry(paths, overwrite);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes = budgetFields.flatMap(({ name, path }) =>
      Object.hasOwn(drafts, name) && validations[name].value !== undefined
        ? [{ path, value: validations[name].value }]
        : [],
    );
    if (
      changes.length &&
      changes.every(({ path }) => !validations[path.split(".")[1] as BudgetName].error)
    )
      saveChanges(changes);
  };
  const disabled = snapshot.status !== "ready";
  const invalid = budgetFields.some(({ name }) => !!validations[name].error);
  const anyDirty = budgetFields.some(({ name }) => Object.hasOwn(drafts, name));

  return (
    <SettingsSection
      id="settings-log-streams"
      title="Log Streams"
      description="Defaults are shared by every mounted Log Stream in every window connected to this Engine."
    >
      <form className="flex flex-col gap-4 rounded-lg border p-4" onSubmit={submit}>
        <div>
          <h3 className="text-sm font-medium">Retention</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            All three logical budgets apply together. The character or styled-range cap may bind
            before the line cap, and raising only one cap may not retain more rows. These values do
            not measure JavaScript heap bytes; Monaco models, strings, arrays, objects, and renderer
            state add overhead.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {budgetFields.map(({ name, path, label, unit }) => {
            const id = `${prefix}-${name}`;
            const errorId = `${id}-error`;
            const helpId = `${id}-help`;
            const error = validations[name].error ?? snapshot.fieldErrors[path];
            const range = logPreferenceRanges[name];
            return (
              <label key={name} htmlFor={id} className="flex min-w-0 flex-col gap-1 text-xs">
                <span className="font-medium">{label}</span>
                <Input
                  id={id}
                  name={name}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={values[name]}
                  disabled={disabled}
                  aria-invalid={!!error}
                  aria-describedby={`${helpId}${error ? ` ${errorId}` : ""}`}
                  onChange={(event) => {
                    const draft = event.target.value;
                    setDrafts((current) => {
                      const next = { ...current };
                      const parsed = parseDecimalDraft(draft, range);
                      if (
                        !parsed.error &&
                        parsed.value === confirmed[name] &&
                        !snapshot.fieldErrors[path]
                      )
                        delete next[name];
                      else next[name] = draft;
                      return next;
                    });
                  }}
                />
                <span id={helpId} className="text-muted-foreground">
                  {range.minimum.toLocaleString()} to {range.maximum.toLocaleString()} {unit}
                </span>
                {error && (
                  <span id={errorId} role="alert" className="text-destructive">
                    {error}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={disabled || !anyDirty || invalid}>
            Apply
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              saveChanges(
                [
                  { path: "logStreams.maxLines", value: undefined },
                  { path: "logStreams.maxCharacters", value: undefined },
                  { path: "logStreams.maxStyledRanges", value: undefined },
                ],
                true,
              )
            }
          >
            Reset section
          </Button>
          {anyDirty &&
          (snapshot.saves.retention.phase === "idle" ||
            snapshot.saves.retention.phase === "saved") ? (
            !invalid && <output className="text-xs text-muted-foreground">Unsaved changes</output>
          ) : (
            <SaveStatus
              scope="retention"
              save={snapshot.saves.retention}
              onRetry={retryChanges}
              onUseCurrent={() => {
                store.acceptCurrent("retention");
                resetDrafts();
              }}
            />
          )}
        </div>
      </form>

      <Separator />

      <div className="flex flex-col gap-4 rounded-lg border p-4">
        <div>
          <h3 className="text-sm font-medium">Display</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These defaults update mounted viewers immediately and persist for other windows.
          </p>
        </div>
        <label htmlFor="settings-log-wrap" className="flex min-h-8 items-center gap-3 text-sm">
          <Checkbox
            id="settings-log-wrap"
            checked={snapshot.display.logStreams.wrap}
            disabled={disabled}
            onCheckedChange={(checked) =>
              void store.save("display", [{ path: "logStreams.wrap", value: checked }])
            }
          />
          Wrap long lines
        </label>
        <label
          htmlFor="settings-log-timestamps"
          className="flex min-h-8 items-center gap-3 text-sm"
        >
          <Checkbox
            id="settings-log-timestamps"
            checked={snapshot.display.logStreams.timestamps}
            disabled={disabled}
            onCheckedChange={(checked) =>
              void store.save("display", [{ path: "logStreams.timestamps", value: checked }])
            }
          />
          Show timestamps
        </label>
        {(snapshot.fieldErrors["logStreams.wrap"] ||
          snapshot.fieldErrors["logStreams.timestamps"]) && (
          <Alert variant="destructive">
            <AlertTitle>Stored display preferences are invalid</AlertTitle>
            <AlertDescription>
              {snapshot.fieldErrors["logStreams.wrap"] ??
                snapshot.fieldErrors["logStreams.timestamps"]}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void store.save("display", [
                { path: "logStreams.wrap", value: undefined },
                { path: "logStreams.timestamps", value: undefined },
              ])
            }
          >
            Reset section
          </Button>
          <SaveStatus
            scope="display"
            save={snapshot.saves.display}
            onRetry={(overwrite) => void store.retry("display", overwrite)}
            onUseCurrent={() => store.acceptCurrent("display")}
          />
        </div>
      </div>

      <AlertDialog open={!!reduction} onOpenChange={(open) => !open && setReduction(undefined)}>
        <AlertDialogContent>
          <AlertDialogTitle>Reduce retained Log Stream entries?</AlertDialogTitle>
          <AlertDialogDescription>
            Applying lower limits may discard the oldest retained entries from every mounted Log
            Stream. Discarded entries cannot be restored by raising the limits later.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const pending = reduction;
                setReduction(undefined);
                if (pending?.kind === "save") persist(pending.changes, pending.clearDrafts);
                else if (pending) retry(pending.paths, pending.overwrite);
              }}
            >
              Apply lower limits
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function OverviewSettings() {
  return (
    <SettingsSection
      id="settings-overview-definitions"
      title="Overview definitions"
      description="Engine-wide YAML layouts. Custom definitions override bundled matches. Removing a custom definition restores its bundled match."
    >
      <DefinitionManager />
    </SettingsSection>
  );
}

export function SaveStatus({
  scope,
  save,
  onRetry,
  onUseCurrent,
}: {
  scope: PreferenceScope;
  save: PreferenceSaveState;
  onRetry?: (overwriteCurrent: boolean) => void;
  onUseCurrent?: () => void;
}) {
  if (save.phase === "idle") return null;
  const fields = save.paths?.map((path) => pathNames[path]).join(", ");
  if (save.phase === "saving" || save.phase === "saved")
    return (
      <output aria-live="polite" className="text-xs text-muted-foreground">
        {fields ? `${fields}: ` : ""}
        {save.message ?? (save.phase === "saving" ? "Saving" : "Saved")}
      </output>
    );
  return (
    <Alert variant="destructive" className="min-w-0 flex-1">
      <AlertTitle>
        {fields ? `${fields}: ` : ""}
        {save.message ?? "Not saved"}
      </AlertTitle>
      {(onRetry || onUseCurrent) && (
        <AlertDescription className="mt-1 flex flex-wrap gap-2">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={() => onRetry(save.phase === "conflict")}>
              {save.phase === "conflict" ? "Retry with my value" : "Retry"}
            </Button>
          )}
          {onUseCurrent && (
            <Button size="sm" variant="ghost" onClick={onUseCurrent}>
              Use current value
            </Button>
          )}
        </AlertDescription>
      )}
      <span className="sr-only">{scope} preference save failed.</span>
    </Alert>
  );
}
