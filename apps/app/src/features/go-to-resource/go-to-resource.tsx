import type { ResourceType, Row } from "@hukube/engine-client";
import { useSubscription } from "@hukube/engine-client/react";
import { Badge } from "@hukube/ui/components/badge";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@hukube/ui/components/command";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { useNamespaces } from "@/features/namespaces/use-namespaces.ts";
import { useWorkspace } from "@/features/workspace/workspace-context.tsx";

import {
  isPaletteShortcut,
  matchingTypes,
  parsePaletteInput,
  resourceItems,
  scopeQuery,
} from "./palette-input.ts";

const resourceLimit = 50;
const typeLimit = 8;
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * The Go to Resource palette of one Workspace. It finds Resource Types and
 * Resources by name, optionally scoped by type and Namespace prefixes. Only
 * the active Workspace responds to the shortcut, and the palette closes when
 * its Workspace is hidden, because the dialog renders outside it.
 */
export function GoToResource({ active }: { active: boolean }) {
  const { cluster, types, openList, openResource } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState("");

  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) setOpen(false);
  }
  const shown = open && active;

  const onShortcut = useEffectEvent(() => {
    if (!open) setInput("");
    setOpen(!open);
  });
  useEffect(() => {
    if (!active) return;
    // Capture phase, so the shortcut wins over editors such as Monaco that
    // use Ctrl+K themselves.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e, isMac)) return;
      e.preventDefault();
      e.stopPropagation();
      onShortcut();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active]);

  const typeList = useMemo(() => [...types.values()], [types]);
  const namespaceList = useNamespaces(cluster, shown);
  // A forbidden or failed Namespace type lists none, so it is not complete.
  const namespacesListed = types.get("namespaces")?.state === "ready";
  const namespaces = useMemo(
    () =>
      namespaceList && {
        names: new Set(namespaceList.names),
        complete: namespaceList.complete && namespacesListed,
      },
    [namespaceList, namespacesListed],
  );
  const parsed = parsePaletteInput(input, typeList, namespaces);
  const where = parsed.kind === "ok" ? scopeQuery(parsed.scope) : undefined;
  const params =
    parsed.kind === "ok" && parsed.text.trim()
      ? { text: parsed.text, ...(where ? { where } : {}) }
      : undefined;
  const { data, error } = useSubscription(
    "resources.find",
    shown && params ? { cluster, ...params, limit: resourceLimit } : undefined,
  );
  const items = params ? resourceItems(data, params) : [];
  const typeMatches =
    parsed.kind === "ok" && !parsed.scope.types && !parsed.scope.namespace
      ? matchingTypes(typeList, parsed.text, typeLimit)
      : [];

  // Results arrive after the input changes, so keep the selection on an
  // enabled item: the user's choice while it remains, else the first one.
  const enabledValues = [
    ...typeMatches.map((t) => typeValue(t.key)),
    ...items.filter((i) => !i.disabled).map((i) => i.value),
  ];
  const selection = enabledValues.includes(selected) ? selected : (enabledValues[0] ?? "");

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  const chooseType = (t: ResourceType) => choose(() => openList(t.key));
  const chooseRow = (r: Row) =>
    choose(() => openResource({ type: r.type, namespace: r.namespace ?? "", name: r.name }));

  return (
    <CommandDialog
      open={shown}
      onOpenChange={setOpen}
      title="Go to Resource"
      description="Find a Resource or Resource Type by name"
    >
      <Command shouldFilter={false} loop value={selection} onValueChange={setSelected}>
        <CommandInput
          aria-label="Go to Resource"
          placeholder="name, type/name, or namespace/type/name"
          value={input}
          onValueChange={setInput}
        />
        {parsed.kind === "ok" && (parsed.scope.types || parsed.scope.namespace) && (
          <div className="flex gap-1 px-3 pt-2" aria-label="Scope">
            {parsed.scope.types && (
              <Badge variant="secondary">
                {kindsOf(parsed.scope.types.keys, types) || parsed.scope.types.segment}
              </Badge>
            )}
            {parsed.scope.namespace && (
              <Badge variant="outline" className="font-mono">
                {parsed.scope.namespace}
              </Badge>
            )}
          </div>
        )}
        <CommandList>
          {parsed.kind === "error" && (
            <p className="px-3 py-2 text-destructive">{parsed.message}</p>
          )}
          {error && <p className="px-3 py-2 text-destructive">{error.message}</p>}
          {parsed.kind === "ok" && parsed.text.trim() && data && (
            <CommandEmpty>Nothing matches.</CommandEmpty>
          )}
          {typeMatches.length > 0 && (
            <CommandGroup heading="Resource types">
              {typeMatches.map((t) => (
                <CommandItem key={t.key} value={typeValue(t.key)} onSelect={() => chooseType(t)}>
                  <span>{t.kind}</span>
                  <span className="ml-auto font-mono text-muted-foreground">{t.key}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {items.length > 0 && (
            <CommandGroup heading="Resources">
              {items.map(({ row, value, disabled }) => (
                <CommandItem
                  key={value}
                  value={value}
                  disabled={disabled}
                  onSelect={() => chooseRow(row)}
                >
                  <span className="shrink-0 text-muted-foreground">
                    {types.get(row.type)?.kind ?? row.type}
                  </span>
                  <span className="truncate font-mono">{row.name}</span>
                  {row.namespace && (
                    <span className="ml-auto truncate font-mono text-muted-foreground">
                      {row.namespace}
                    </span>
                  )}
                </CommandItem>
              ))}
              {data && data.total > items.length && (
                <p className="px-2.5 py-1.5 text-muted-foreground">
                  {data.total - items.length} more; type more to narrow them down.
                </p>
              )}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

const typeValue = (key: string) => `type:${key}`;

function kindsOf(keys: string[], types: ReadonlyMap<string, ResourceType>): string {
  return [...new Set(keys.map((k) => types.get(k)?.kind ?? k))].join(", ");
}
