import { expect, it, vi } from "vitest";
import type { EngineClient, Setting } from "@hukube/engine-client";
import { createKeyboardStore } from "./persistence.ts";
import { emptyDocument, type KeybindingDocument } from "./keyboard.ts";
function harness() {
  let value: unknown = null,
    revision = "",
    state = "open",
    hold = false;
  let settle: (() => void) | undefined;
  const stateListeners = new Set<() => void>(),
    watches = new Set<{ data(s: Setting): void }>();
  const puts: { value: unknown; ifRevision: string }[] = [];
  const emit = () => {
    for (const l of watches) l.data({ key: "app/keybindings", value, revision });
  };
  const client = {
    getState: () => state,
    onStateChange: (fn: () => void) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    subscribe: (_m: string, _p: unknown, l: { data(s: Setting): void }) => {
      watches.add(l);
      queueMicrotask(() => {
        if (watches.has(l) && !hold) l.data({ key: "app/keybindings", value, revision });
      });
      return { close: () => watches.delete(l), update() {} };
    },
    request: async (_m: string, p: { value: unknown; ifRevision: string }) => {
      puts.push(p);
      if (p.ifRevision !== revision) throw Error("conflict");
      value = p.value;
      revision += "x";
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return {};
    },
  } as unknown as EngineClient;
  return {
    client,
    store: createKeyboardStore(client, "linux"),
    puts,
    emit,
    hold: (v: boolean) => (hold = v),
    remote: (next: unknown) => {
      value = next;
      revision += "r";
      emit();
    },
    settle: () => settle?.(),
    connection: (v: string) => {
      state = v;
      for (const f of stateListeners) f();
    },
  };
}
const document: KeybindingDocument = {
  ...emptyDocument,
  disabledDefaults: ["default.palette.app"],
  future: { keep: true },
};
it("activates atomically only after settlement and fresh matching readback", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
  h.store.edit(document);
  h.hold(true);
  const save = h.store.save();
  expect(h.puts[0]?.ifRevision).toBe("");
  h.emit();
  expect(h.store.getSnapshot().active.rules.some((r) => r.id === "default.palette.app")).toBe(true);
  h.settle();
  await save;
  expect(h.store.getSnapshot().pending).toBe(true);
  h.emit();
  expect(h.store.getSnapshot().draft).toBeUndefined();
  expect(h.store.getSnapshot().active.rules.some((r) => r.id === "default.palette.app")).toBe(
    false,
  );
  h.store.dispose();
});
it("preserves stable draft IDs and unknown fields through remote conflict and reviewed retry", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
  h.store.edit(document);
  h.remote({ ...emptyDocument, remote: true });
  expect(h.store.getSnapshot().conflict).toBe(true);
  await h.store.save();
  expect(h.puts).toHaveLength(0);
  const save = h.store.save(true);
  expect(h.puts[0]?.ifRevision).toBe("r");
  h.settle();
  await save;
  await vi.waitFor(() => expect(h.store.getSnapshot().draft).toBeUndefined());
  expect(h.store.getSnapshot().document.future).toEqual({ keep: true });
  h.store.dispose();
});
it("retains last good map for malformed rules and future versions without overwriting", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
  const active = h.store.getSnapshot().active;
  h.remote({ ...emptyDocument, rules: [{ id: "broken", command: "app.openSettings" }] });
  expect(h.store.getSnapshot().active).toBe(active);
  expect(h.store.getSnapshot().error).toBeTruthy();
  h.remote({ version: 2, rules: [], disabledDefaults: [], future: "recover" });
  expect(h.store.getSnapshot().readOnly).toBe(true);
  h.store.edit(document);
  await h.store.save();
  expect(h.puts).toHaveLength(0);
  h.store.dispose();
});
it("does not retry sent writes after discard or overwrite unseen remote edits", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
  h.store.edit(document);
  const save = h.store.save();
  h.connection("reconnecting");
  h.store.discard();
  h.remote({ ...emptyDocument, remote: true });
  h.settle();
  await save;
  h.connection("open");
  await vi.waitFor(() => expect(h.store.getSnapshot().fresh).toBe(true));
  expect(h.store.getSnapshot().draft).toBeUndefined();
  expect(h.puts).toHaveLength(1);
  h.store.dispose();
});

it("activates remote confirmed maps in a second window but keeps its conflicting draft and last map", async () => {
  const h = harness(),
    other = createKeyboardStore(h.client, "linux");
  await vi.waitFor(() => expect(other.getSnapshot().loaded).toBe(true));
  const old = other.getSnapshot().active;
  other.edit({ ...emptyDocument, local: true });
  h.store.edit(document);
  const save = h.store.save();
  h.emit();
  expect(other.getSnapshot().conflict).toBe(true);
  expect(other.getSnapshot().active).toBe(old);
  h.settle();
  await save;
  other.discard();
  await vi.waitFor(() =>
    expect(other.getSnapshot().active.rules.some((r) => r.id === "default.palette.app")).toBe(
      false,
    ),
  );
  other.dispose();
  h.store.dispose();
});
