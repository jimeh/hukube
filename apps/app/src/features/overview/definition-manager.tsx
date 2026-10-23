import { useState } from "react";
import { create } from "zustand";
import { Button } from "@hukube/ui/components/button";
import { Input } from "@hukube/ui/components/input";
import { Textarea } from "@hukube/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@hukube/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@hukube/ui/components/dropdown-menu";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import example from "../../../../../docs/overview/widget.yaml?raw";
import { bundledSources } from "./bundled.ts";
import { parseDefinition, sourceLimit } from "./definition.ts";
import { useRegistry } from "./registry.ts";

export const useDefinitionManager = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);
function download(name: string, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "application/yaml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
export function OverviewSettings() {
  const { open, setOpen } = useDefinitionManager();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label="Settings" />}>
          <HugeiconsIcon icon={Settings01Icon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setOpen(true)}>Overview definitions</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && <DefinitionManager />}
    </>
  );
}
function DefinitionManager() {
  const { snapshot, store } = useRegistry();
  const setOpen = useDefinitionManager((s) => s.setOpen);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<{
    key: string;
    source: string;
    observed: unknown;
    remove?: boolean;
  }>();
  const entries = snapshot.registry?.entries;
  const ready = snapshot.status === "ready" && !!entries;
  const changeText = (source: string) => {
    setText(source);
    setIntent(undefined);
    setError(undefined);
    setMessage(undefined);
  };
  const validate = () => {
    try {
      const d = parseDefinition(text);
      setIntent({ key: d.resourceType, source: text, observed: entries?.[d.resourceType] });
      setError(undefined);
    } catch (failure) {
      setError(String(failure));
    }
  };
  const save = async () => {
    if (!intent || !ready) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      if (intent.remove) await store.remove(intent.key, intent.observed);
      else await store.install(intent.source, intent.observed);
      setMessage(`${intent.key} ${intent.remove ? "removed" : "saved"}.`);
      setIntent(undefined);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Overview definitions</DialogTitle>
          <DialogDescription>
            Engine-wide YAML layouts. Custom definitions override bundled matches. Removing a custom
            definition restores its bundled match.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto">
          {snapshot.status === "loading" && <output>Loading saved definitions…</output>}
          {snapshot.error && (
            <div role="alert">
              <p>{snapshot.error}</p>
              <Button size="sm" variant="outline" onClick={store.retry}>
                Retry loading definitions
              </Button>
            </div>
          )}
          <div className="max-h-56 shrink-0 overflow-auto rounded border">
            <table className="w-full table-fixed text-left text-xs">
              <thead>
                <tr>
                  <th className="w-1/2 p-2">Resource Type</th>
                  <th className="w-16 p-2">Source</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...new Set([...Object.keys(bundledSources), ...Object.keys(entries ?? {})])]
                  .toSorted()
                  .map((key) => {
                    const custom = !!entries && Object.hasOwn(entries, key);
                    const source = custom ? entries[key] : bundledSources[key];
                    return (
                      <tr key={key} className="border-t">
                        <td className="break-all p-2 font-mono">
                          {key}
                          {snapshot.errors.get(key) && (
                            <p className="font-sans text-destructive">{snapshot.errors.get(key)}</p>
                          )}
                        </td>
                        <td className="p-2">{custom ? "Custom" : "Built-in"}</td>
                        <td className="p-2">
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Inspect ${key}`}
                              onClick={() =>
                                changeText(
                                  typeof source === "string"
                                    ? source
                                    : JSON.stringify(source, null, 2),
                                )
                              }
                            >
                              Inspect
                            </Button>
                            {typeof source === "string" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Export ${key}`}
                                onClick={() => download(`${key}.yaml`, source)}
                              >
                                Export
                              </Button>
                            )}
                            {custom && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || !ready}
                                aria-label={`Remove ${key}`}
                                onClick={() => {
                                  setIntent({ key, source: "", observed: source, remove: true });
                                  setError(undefined);
                                }}
                              >
                                Remove
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="overview-import-file"
              className="flex min-w-0 flex-1 flex-col gap-1 text-xs"
            >
              Import local YAML
              <Input
                id="overview-import-file"
                type="file"
                accept=".yaml,.yml,application/yaml,text/yaml"
                aria-label="Import definition file"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > sourceLimit) {
                    setError("Definition exceeds 64 KiB.");
                    return;
                  }
                  void file
                    .text()
                    .then(changeText)
                    .catch((failure: unknown) => setError(String(failure)));
                  event.target.value = "";
                }}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => download("widget-overview.yaml", example)}
            >
              Download Widget example
            </Button>
          </div>
          <label htmlFor="overview-import-text" className="flex flex-col gap-1 text-xs">
            Definition YAML
            <Textarea
              id="overview-import-text"
              className="min-h-48 font-mono text-xs"
              aria-label="Definition YAML"
              value={text}
              disabled={busy}
              onChange={(e) => changeText(e.target.value)}
              spellCheck={false}
            />
          </label>
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
              {error}
            </p>
          )}
          {message && <output className="text-xs text-success">{message}</output>}
          {intent && (
            <div className="flex flex-col gap-2 rounded border border-warning/40 bg-warning/10 p-3 text-xs">
              <p>
                {intent.remove
                  ? `Remove the custom definition for ${intent.key}?`
                  : intent.observed !== undefined
                    ? `Replace the saved custom definition for ${intent.key}?`
                    : `Install a custom definition for ${intent.key}?`}
              </p>
              {intent.observed !== undefined && (
                <details>
                  <summary>Current saved definition</summary>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
                    {typeof intent.observed === "string"
                      ? intent.observed
                      : JSON.stringify(intent.observed, null, 2)}
                  </pre>
                </details>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!ready || busy} onClick={() => void save()}>
                  {busy
                    ? "Saving…"
                    : intent.remove
                      ? "Confirm removal"
                      : intent.observed !== undefined
                        ? "Replace definition"
                        : "Install definition"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setIntent({ ...intent, observed: entries?.[intent.key] });
                    setError(undefined);
                  }}
                >
                  Review current definition
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setIntent(undefined)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button disabled={busy || !ready || !text} onClick={validate}>
              Validate import
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
