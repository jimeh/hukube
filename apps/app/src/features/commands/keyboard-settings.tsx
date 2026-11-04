import { useLayoutEffect, useRef, useMemo, useState, useId } from "react";
import { HotkeyRecorder } from "@tanstack/hotkeys";
import { Button } from "@hukube/ui/components/button";
import { Input } from "@hukube/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@hukube/ui/components/native-select";
import { commandPlatform } from "@/lib/platform.ts";
import {
  catalog,
  definition,
  isCommand,
  validateArguments,
  type ArgumentIssue,
} from "./catalog.ts";
import { ArgumentFields, focusInvalidArgument } from "./argument-fields.tsx";
import { commands } from "./runtime.ts";
import { compileKeymap, defaultRules, displayKeys, emptyDocument, type Rule } from "./keyboard.ts";
import { vocabulary } from "./conditions.ts";
import { useKeybindings } from "./store.ts";
export function KeyboardSettings({ visible = true }: { visible?: boolean }) {
  const { store, snapshot } = useKeybindings();
  const [search, setSearch] = useState(""),
    [editing, setEditing] = useState<Rule>();
  const keymapDocument = snapshot.draft ?? snapshot.document;
  const usable =
    keymapDocument?.version === 1 &&
    Array.isArray(keymapDocument.rules) &&
    keymapDocument.rules.length <= 256 &&
    new Set(keymapDocument.rules.map((r) => r?.id)).size === keymapDocument.rules.length &&
    Array.isArray(keymapDocument.disabledDefaults) &&
    keymapDocument.disabledDefaults.length <= 256 &&
    keymapDocument.rules.every(
      (r) =>
        r &&
        typeof r.id === "string" &&
        typeof r.command === "string" &&
        Array.isArray(r.keys) &&
        r.keys.length >= 1 &&
        r.keys.length <= 2 &&
        typeof r.when === "string" &&
        typeof r.enabled === "boolean" &&
        ["app", "terminal"].includes(r.scope) &&
        (r.args === undefined ||
          (!!r.args && typeof r.args === "object" && !Array.isArray(r.args))) &&
        r.keys.every((k) => typeof k === "string"),
    );
  const candidate = usable ? keymapDocument : emptyDocument;
  const compilation = useMemo(() => {
    try {
      return { map: compileKeymap(candidate, commandPlatform), error: "" };
    } catch (e) {
      return { error: String(e) };
    }
  }, [candidate]);
  const change = (next: typeof keymapDocument) => store.edit(next);
  const update = (rule: Rule) =>
    change({ ...candidate, rules: candidate.rules.map((r) => (r.id === rule.id ? rule : r)) });
  const begin = (rule: Rule) => {
    store.edit(candidate);
    setEditing({ ...rule, args: { ...rule.args }, keys: [...rule.keys] });
  };
  const move = (id: string, delta: number) => {
    const rules = [...candidate.rules],
      i = rules.findIndex((r) => r.id === id),
      j = i + delta;
    if (j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j]!, rules[i]!];
    change({ ...candidate, rules });
  };
  const matching = (r: Rule) =>
    `${r.id} ${r.command} ${isCommand(r.command) ? definition(r.command).title : ""} ${JSON.stringify(r.args)} ${r.when} ${r.keys.join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase());
  const [, refreshContext] = useState(0);
  useLayoutEffect(() => {
    if (!visible) return;
    const refresh = () => refreshContext((value) => value + 1);
    document.addEventListener("focusin", refresh);
    document.addEventListener("focusout", refresh);
    return () => {
      document.removeEventListener("focusin", refresh);
      document.removeEventListener("focusout", refresh);
    };
  }, [visible]);
  const origin = commands.capture();
  const context = commands.context(origin);
  const winner = (id: string) => {
    const current = compilation.map?.rules.find((r) => r.id === id);
    if (!current) return "Disabled or inactive";
    if (!current.condition.test(context)) return "Condition does not match this context";
    const effective = commands.winnerFor(current, compilation.map!, origin, context);
    if (!effective) return "Unavailable in this context";
    return effective.id === id ? "Effective in this context" : `Shadowed here by ${effective.id}`;
  };
  const locked = snapshot.readOnly || snapshot.pending || !snapshot.loaded;
  return (
    <div className="relative flex min-w-0 flex-col gap-4 text-sm">
      <p>
        Shortcuts are shared by every window connected to this Engine. Defaults remain active while
        loading. Changes take effect only after confirmed save.
      </p>
      <output>{snapshot.status}</output>
      {snapshot.error && (
        <p role="alert" className="break-words text-destructive">
          {snapshot.error}
        </p>
      )}
      {(!usable || snapshot.readOnly || snapshot.error) && (
        <details>
          <summary className="cursor-pointer py-2">Recovery data</summary>
          <p>
            Copy this data before recovering. Unknown commands and future fields are preserved and
            inactive. Future versions are read-only.
          </p>
          <textarea
            aria-label="Keyboard recovery data"
            className="mt-2 h-40 w-full rounded border p-2 font-mono text-xs"
            readOnly
            value={JSON.stringify(snapshot.raw, null, 2)}
          />
          <Button variant="outline" onClick={store.retry}>
            Reload Engine data
          </Button>
        </details>
      )}
      <label htmlFor="shortcut-search" className="flex flex-col gap-1">
        Search commands and bindings
        <Input
          id="shortcut-search"
          name="shortcut-search"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {editing && (
        <RuleEditor
          key={editing.id}
          initial={editing}
          visible={visible}
          disabled={locked}
          onCancel={() => setEditing(undefined)}
          onSave={(rule) => {
            const rules = candidate.rules.some((r) => r.id === rule.id)
              ? candidate.rules.map((r) => (r.id === rule.id ? rule : r))
              : [...candidate.rules, rule];
            change({ ...candidate, rules });
            setEditing(undefined);
          }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            locked ||
            !!editing ||
            !snapshot.draft ||
            !!compilation.error ||
            snapshot.conflict ||
            !snapshot.fresh
          }
          onClick={() => void store.save()}
        >
          Save shortcuts
        </Button>
        <Button
          variant="outline"
          disabled={!snapshot.draft && !editing}
          onClick={() => {
            setEditing(undefined);
            store.discard();
          }}
        >
          Cancel changes
        </Button>
        <Button
          variant="outline"
          disabled={locked}
          onClick={() => {
            setEditing(undefined);
            change({ ...candidate, rules: [], disabledDefaults: [] });
          }}
        >
          Reset keyboard shortcuts
        </Button>
      </div>
      {snapshot.conflict && (
        <div role="alert" className="rounded border p-3">
          <p>
            Engine revision: {snapshot.revision}. Review your draft and the Engine document before
            replacing it.
          </p>
          <details>
            <summary className="cursor-pointer py-2">Review Engine shortcuts</summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
              {JSON.stringify(snapshot.raw, null, 2)}
            </pre>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={locked || !!editing || !!compilation.error}
              onClick={() => void store.save(true)}
            >
              Save reviewed draft over this revision
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(undefined);
                store.discard();
                store.retry();
              }}
            >
              Discard draft and reload
            </Button>
          </div>
        </div>
      )}
      {compilation.error && (
        <p role="alert" className="break-words text-destructive">
          {compilation.error}
        </p>
      )}
      {!!compilation.map?.diagnostics.length && (
        <div aria-label="Binding conflicts" className="rounded border p-3">
          <p>Effective precedence: the last eligible matching rule wins.</p>
          {compilation.map.diagnostics.map((text) => (
            <p key={text} className="break-words text-xs">
              {text}
            </p>
          ))}
        </div>
      )}
      <details>
        <summary className="cursor-pointer py-2">Conditions and keyboard help</summary>
        <p>
          Use !, &amp;&amp;, ||, parentheses, == and !=. Example: workspace &amp;&amp; focus ==
          'editor'. Conditions choose bindings; they grant no permissions.
        </p>
        <dl className="mt-2 space-y-1">
          {Object.entries(vocabulary).map(([key, values]) => (
            <div key={key}>
              <dt className="font-mono">{key}</dt>
              <dd className="break-words text-muted-foreground">{values.join(", ")}</dd>
            </div>
          ))}
        </dl>
      </details>
      <h3 className="font-medium">Commands</h3>
      {catalog
        .filter((c) =>
          `${c.title} ${c.id} ${c.description}`.toLowerCase().includes(search.toLowerCase()),
        )
        .map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2 border-b pb-3">
            <div className="min-w-0 flex-1">
              <p>{c.title}</p>
              <p className="break-words font-mono text-xs text-muted-foreground">{c.id}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || !!editing}
              onClick={() =>
                begin({
                  id: crypto.randomUUID(),
                  command: c.id,
                  args: {},
                  keys: [],
                  scope: "app",
                  when: "",
                  enabled: true,
                })
              }
            >
              Add binding<span className="sr-only"> for {c.title}</span>
            </Button>
          </div>
        ))}
      <h3 className="font-medium">Default bindings ({commandPlatform})</h3>
      {defaultRules.filter(matching).map((r) => {
        const disabled = candidate.disabledDefaults.includes(r.id);
        return (
          <div key={r.id} className="flex flex-col gap-2 rounded border p-3">
            <RuleSummary rule={r} enabled={!disabled} />
            <p className="text-xs">{winner(r.id)}</p>
            <Button
              size="sm"
              className="self-start"
              variant="outline"
              disabled={locked}
              onClick={() =>
                change({
                  ...candidate,
                  disabledDefaults: disabled
                    ? candidate.disabledDefaults.filter((id) => id !== r.id)
                    : [...candidate.disabledDefaults, r.id],
                })
              }
            >
              {disabled ? "Reset default" : "Disable default"}
              <span className="sr-only"> {r.id}</span>
            </Button>
          </div>
        );
      })}
      <h3 className="font-medium">User bindings (ordered)</h3>
      {!candidate.rules.length && (
        <p className="text-muted-foreground">No user bindings. Add one from a command above.</p>
      )}
      {candidate.rules.filter(matching).map((r) => (
        <div key={r.id} className="flex flex-col gap-2 rounded border p-3">
          <RuleSummary rule={r} enabled={r.enabled} />
          <p className="text-xs">{winner(r.id)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={locked || !!editing}
              onClick={() => begin(r)}
            >
              Edit / record<span className="sr-only"> {r.id}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => update({ ...r, enabled: !r.enabled })}
            >
              {r.enabled ? "Disable" : "Enable"}
              <span className="sr-only"> {r.id}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() =>
                change({ ...candidate, rules: candidate.rules.filter((x) => x.id !== r.id) })
              }
            >
              Remove<span className="sr-only"> {r.id}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || candidate.rules[0]?.id === r.id}
              aria-label={`Move up ${r.id}`}
              onClick={() => move(r.id, -1)}
            >
              Move up
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || candidate.rules.at(-1)?.id === r.id}
              aria-label={`Move down ${r.id}`}
              onClick={() => move(r.id, 1)}
            >
              Move down
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
function RuleSummary({ rule: r, enabled }: { rule: Rule; enabled: boolean }) {
  return (
    <div className="min-w-0 break-words">
      <p>
        {isCommand(r.command) ? definition(r.command).title : r.command}:{" "}
        <kbd>{displayKeys(r.keys, commandPlatform)}</kbd>
      </p>
      <p className="font-mono text-xs">{r.id}</p>
      <p className="text-xs text-muted-foreground">
        {enabled ? "Enabled" : "Disabled"} · {r.scope} scope · when: {r.when || "always"} · args:{" "}
        {JSON.stringify(r.args ?? {})}
      </p>
    </div>
  );
}
function RuleEditor({
  initial,
  onSave,
  onCancel,
  disabled,
  visible,
}: {
  visible: boolean;
  initial: Rule;
  onSave: (rule: Rule) => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const jsonId = useId();
  const [issues, setIssues] = useState<ArgumentIssue[]>([]);
  const jsonError = issues.find((issue) => !issue.field);
  useLayoutEffect(() => {
    form.current?.querySelector("select")?.focus({ preventScroll: true });
    const section = form.current?.closest("section");
    if (section && form.current)
      section.scrollTop +=
        form.current.getBoundingClientRect().top - section.getBoundingClientRect().top;
  }, []);
  const [rule, setRule] = useState(initial),
    [keys, setKeys] = useState(initial.keys.join(" ")),
    [error, setError] = useState(""),
    [recording, setRecording] = useState(false),
    [steps, setSteps] = useState("");
  const [argsText, setArgsText] = useState(JSON.stringify(initial.args ?? {}, null, 2));
  const updateArgs = (value: Record<string, unknown>) => {
    setRule((r) => ({ ...r, args: value }));
    setArgsText(JSON.stringify(value, null, 2));
  };
  if (!visible && recording) setRecording(false);
  useLayoutEffect(() => {
    if (!visible || !recording) return;
    commands.setRecording(true);
    const recorder = new HotkeyRecorder({
      platform: commandPlatform,
      recordBy: "key",
      maxSteps: 2,
      ignoreInputs: false,
      onRecord: (hotkey) => {
        setKeys(typeof hotkey === "string" ? hotkey : hotkey.join(" "));
        setRecording(false);
      },
      onCancel: () => setRecording(false),
      onReject: (r) => setError(r.message),
    });
    const subscription = recorder.store.subscribe(() =>
      setSteps(recorder.store.state.steps.join(" ")),
    );
    recorder.start();
    return () => {
      recorder.destroy();
      subscription.unsubscribe();
      commands.setRecording(false);
    };
  }, [recording, visible]);
  return (
    <form
      ref={form}
      aria-label="Edit keyboard rule"
      className="flex min-w-0 flex-col gap-3 rounded border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        let args: unknown;
        let diagnostics: ArgumentIssue[];
        try {
          args = JSON.parse(argsText);
          diagnostics = isCommand(rule.command)
            ? validateArguments(rule.command, args, true).issues
            : !args || typeof args !== "object" || Array.isArray(args)
              ? [{ message: "Arguments: Enter a JSON object." }]
              : [];
        } catch {
          diagnostics = [{ message: "Arguments: Enter valid JSON for a named argument object." }];
        }
        setIssues(diagnostics);
        setError("");
        if (diagnostics.length) {
          focusInvalidArgument(form.current, diagnostics);
          return;
        }
        try {
          const next = {
            ...rule,
            keys: keys.trim().split(/\s+/),
            args: args as Record<string, unknown>,
          };
          compileKeymap(
            { ...emptyDocument, disabledDefaults: defaultRules.map((r) => r.id), rules: [next] },
            commandPlatform,
          );
          onSave(next);
        } catch (failure) {
          setError(String(failure));
        }
      }}
    >
      <p className="break-words text-xs">Rule ID: {rule.id}</p>
      <label className="flex flex-col gap-1">
        Command
        <NativeSelect
          value={rule.command}
          disabled={recording}
          onChange={(e) => {
            setRule({ ...rule, command: e.target.value, args: {} });
            setArgsText("{}");
            setIssues([]);
          }}
        >
          {!isCommand(rule.command) && (
            <NativeSelectOption value={rule.command}>{rule.command} (unknown)</NativeSelectOption>
          )}
          {catalog.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.title} ({c.id})
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label htmlFor="strokes" className="flex flex-col gap-1">
        One or two strokes (space separated)
        <Input
          id="strokes"
          name="strokes"
          autoComplete="off"
          spellCheck={false}
          disabled={recording}
          value={keys}
          onChange={(e) => setKeys(e.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Example syntax: Mod+K. Recording uses logical keys. Backspace/Delete edit steps, Enter
        accepts one stroke, a second stroke completes a chord, Escape cancels. Host or OS shortcuts
        may never reach the recorder.
      </p>
      <div className="flex gap-2">
        {recording ? (
          <Button type="button" variant="outline" onClick={() => setRecording(false)}>
            Stop / cancel recording
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSteps("");
              setRecording(true);
            }}
          >
            Record shortcut
          </Button>
        )}
      </div>
      {recording && (
        <output>
          Recording: {steps || "Press the first stroke"}. Enter accepts; Escape cancels.
        </output>
      )}
      {isCommand(rule.command) && (
        <ArgumentFields
          id={rule.command}
          value={rule.args ?? {}}
          onChange={updateArgs}
          issues={issues}
        />
      )}
      <label htmlFor={jsonId} className="flex flex-col gap-1">
        Named arguments (JSON object)
        <textarea
          className="min-h-20 w-full rounded border p-2 font-mono text-xs"
          name="arguments"
          id={jsonId}
          aria-invalid={jsonError ? true : undefined}
          aria-describedby={jsonError ? `${jsonId}-error` : undefined}
          spellCheck={false}
          value={argsText}
          onChange={(e) => {
            setArgsText(e.target.value);
            try {
              setRule({ ...rule, args: JSON.parse(e.target.value) as Record<string, unknown> });
            } catch {
              /* Preserve incomplete JSON text. */
            }
          }}
        />
      </label>
      {jsonError && (
        <p id={`${jsonId}-error`} role="alert" className="text-destructive">
          {jsonError.message}
        </p>
      )}
      <label htmlFor="when" className="flex flex-col gap-1">
        Condition (when)
        <Input
          id="when"
          name="when"
          autoComplete="off"
          spellCheck={false}
          value={rule.when}
          onChange={(e) => setRule({ ...rule, when: e.target.value })}
        />
      </label>
      <label htmlFor="rule-scope" className="flex flex-col gap-1">
        Scope
        <NativeSelect
          id="rule-scope"
          value={rule.scope}
          onChange={(e) => setRule({ ...rule, scope: e.target.value as Rule["scope"] })}
        >
          <NativeSelectOption value="app">App</NativeSelectOption>
          <NativeSelectOption value="terminal">
            Terminal (takes keys from the process)
          </NativeSelectOption>
        </NativeSelect>
      </label>
      <p className="text-xs text-muted-foreground">
        App bindings cannot take live Exec input. Terminal scope applies only to a focused live
        terminal and deliberately takes the chosen keys from its process.
      </p>
      <label className="flex min-h-6 items-center gap-2">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => setRule({ ...rule, enabled: e.target.checked })}
        />
        Enabled
      </label>
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={disabled || recording}>
          Save rule
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel rule
        </Button>
      </div>
    </form>
  );
}
