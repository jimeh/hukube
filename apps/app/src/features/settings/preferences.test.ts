// @vitest-environment jsdom

import { EngineRequestError, type EngineClient, type SettingPut } from "@hukube/engine-client";
import { expect, it } from "vitest";

import {
  createPreferenceStore,
  decodePreferences,
  logPreferenceDefaults,
  logPreferenceRanges,
  parseDecimalDraft,
  preferenceKey,
  type AppPreferencesV1,
} from "./preferences.ts";

type Watch = {
  closed: boolean;
  listener: {
    data(setting: { key: string; value: unknown; revision: string }): void;
    error?(error: { code: string; message: string }): void;
  };
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(assertion: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await Promise.resolve();
    }
  }
  throw last;
}

class SettingsServer {
  value: unknown;
  revision: string;
  revisionNumber: number;
  holdReads = false;
  broadcastOnCommit = false;
  readonly puts: SettingPut[] = [];
  readonly watches = new Set<Watch>();
  readonly behaviors: ((params: SettingPut, control: ClientControl) => Promise<void>)[] = [];

  constructor(value: unknown = null) {
    this.value = value;
    this.revisionNumber = value === null ? 0 : 1;
    this.revision = value === null ? "" : "r1";
  }

  setting() {
    return { key: preferenceKey, value: this.value, revision: this.revision };
  }

  subscribe(listener: Watch["listener"]) {
    const watch = { closed: false, listener };
    this.watches.add(watch);
    queueMicrotask(() => {
      if (!this.holdReads && !watch.closed) listener.data(this.setting());
    });
    return {
      close: () => {
        watch.closed = true;
      },
      update: () => {},
    };
  }

  broadcast() {
    for (const watch of this.watches) if (!watch.closed) watch.listener.data(this.setting());
  }

  commit(value: unknown) {
    this.value = value;
    this.revision = `r${++this.revisionNumber}`;
    if (this.broadcastOnCommit) this.broadcast();
  }

  compare(params: SettingPut) {
    if (params.ifRevision !== this.revision)
      throw new EngineRequestError({ code: "conflict", message: "changed" });
  }

  async put(params: SettingPut, control: ClientControl) {
    this.puts.push(params);
    const behavior = this.behaviors.shift();
    if (behavior) return behavior(params, control);
    if (control.state !== "open")
      throw new EngineRequestError({ code: "not_connected", message: "offline" });
    this.compare(params);
    this.commit(params.value);
  }
}

interface ClientControl {
  state: "open" | "reconnecting";
  setState(state: "open" | "reconnecting"): void;
}

function clientFor(server: SettingsServer) {
  const stateListeners = new Set<() => void>();
  const control: ClientControl = {
    state: "open",
    setState(state) {
      control.state = state;
      for (const listener of stateListeners) listener();
    },
  };
  const client = {
    subscribe: (_method: string, _params: unknown, listener: Watch["listener"]) =>
      server.subscribe(listener),
    request: (_method: string, params: SettingPut) => server.put(params, control),
    getState: () => control.state,
    onStateChange: (listener: () => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  } as unknown as EngineClient;
  return { client, control };
}

function storeFor(server: SettingsServer, cached?: "light" | "dark") {
  const { client, control } = clientFor(server);
  let cache = cached;
  const applied: ("light" | "dark")[] = [];
  const store = createPreferenceStore(client, {
    readCachedTheme: () => cache,
    setTheme: (theme) => {
      cache = theme;
      applied.push(theme);
    },
  });
  const stop = store.subscribe(() => {});
  return {
    store,
    stop,
    control,
    applied,
    cache: () => cache,
    setCache: (next: "light" | "dark") => {
      cache = next;
    },
  };
}

async function ready(store: ReturnType<typeof createPreferenceStore>) {
  await until(() => expect(store.getSnapshot().status).toBe("ready"));
}

it("decodes defaults and recovers invalid known fields without discarding valid or unknown data", async () => {
  const server = new SettingsServer({
    version: 1,
    future: { enabled: true },
    logStreams: { maxLines: "many", wrap: false, futureBudget: 7 },
  });
  const h = storeFor(server);
  await ready(h.store);
  const snapshot = h.store.getSnapshot();
  expect(snapshot.effective.logStreams).toEqual({ ...logPreferenceDefaults, wrap: false });
  expect(snapshot.fieldErrors["logStreams.maxLines"]).toMatch(/retained lines.*invalid/i);
  await h.store.save("retention", [{ path: "logStreams.maxCharacters", value: 1_000 }]);
  expect(server.value).toEqual({
    version: 1,
    future: { enabled: true },
    logStreams: {
      maxLines: "many",
      maxCharacters: 1_000,
      wrap: false,
      futureBudget: 7,
    },
  });
  expect(h.store.getSnapshot().saves.retention.phase).toBe("saved");
  h.stop();
});

it("blocks every ordinary operation for present non-object known sections", async () => {
  for (const malformed of ["dark", 7, false, null, ["future"]]) {
    const server = new SettingsServer({
      version: 1,
      appearance: malformed,
      logStreams: malformed,
    });
    const h = storeFor(server);
    await ready(h.store);
    expect(h.store.getSnapshot().sectionErrors).toMatchObject({
      appearance: expect.stringMatching(/expected an object/),
      logStreams: expect.stringMatching(/expected an object/),
    });

    await h.store.save("appearance", [{ path: "appearance.theme", value: "dark" }]);
    await h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
    await h.store.save("retention", [{ path: "logStreams.maxLines", value: undefined }]);
    await h.store.retry("appearance", true);
    await h.store.retry("display", true);
    await h.store.retry("retention", true);

    expect(server.puts).toHaveLength(0);
    expect(h.store.getSnapshot().display).toEqual({
      appearance: { theme: "dark" },
      logStreams: logPreferenceDefaults,
    });
    for (const scope of ["appearance", "display", "retention"] as const) {
      expect(h.store.getSnapshot().saves[scope].phase).toBe("error");
      expect(h.store.getSnapshot().saves[scope].message).toMatch(/Repair .* section/);
    }
    h.stop();
  }
});

it("repairs one malformed section after confirmation while preserving all unrelated fields", async () => {
  const server = new SettingsServer({
    version: 1,
    appearance: "broken",
    logStreams: { wrap: false, futureBudget: 7 },
    future: { enabled: true },
  });
  const h = storeFor(server);
  await ready(h.store);
  await h.store.save("display", [{ path: "logStreams.timestamps", value: true }]);
  expect(server.value).toEqual({
    version: 1,
    appearance: "broken",
    logStreams: { wrap: false, timestamps: true, futureBudget: 7 },
    future: { enabled: true },
  });
  await h.store.repairSection("appearance");
  expect(server.value).toEqual({
    version: 1,
    logStreams: { wrap: false, timestamps: true, futureBudget: 7 },
    future: { enabled: true },
  });
  expect(h.store.getSnapshot().repairs.appearance).toMatchObject({
    phase: "saved",
    message: "Appearance section repaired",
  });
  expect(h.store.getSnapshot().sectionErrors.appearance).toBeUndefined();
  h.stop();
});

it("rebases an equal malformed repair and conflicts when the section changed or became valid", async () => {
  const rebasedServer = new SettingsServer({ version: 1, appearance: "broken", first: true });
  const rebased = storeFor(rebasedServer);
  await ready(rebased.store);
  rebasedServer.behaviors.push(async (params) => {
    rebasedServer.compare(params);
    rebasedServer.commit({ version: 1, appearance: "broken", first: true, remote: 2 });
    throw new EngineRequestError({ code: "conflict", message: "changed" });
  });
  await rebased.store.repairSection("appearance");
  expect(rebasedServer.value).toEqual({ version: 1, first: true, remote: 2 });
  expect(rebasedServer.puts).toHaveLength(2);
  expect(rebased.store.getSnapshot().repairs.appearance.phase).toBe("saved");
  rebased.stop();

  for (const replacement of ["different", { theme: "light" }]) {
    const server = new SettingsServer({ version: 1, appearance: "broken", future: true });
    const h = storeFor(server);
    await ready(h.store);
    server.behaviors.push(async (params) => {
      server.compare(params);
      server.commit({ version: 1, appearance: replacement, future: true });
      throw new EngineRequestError({ code: "conflict", message: "changed" });
    });
    await h.store.repairSection("appearance");
    expect(server.puts).toHaveLength(1);
    expect(h.store.getSnapshot().repairs.appearance).toMatchObject({
      phase: "conflict",
      message: "Not repaired: section changed in another window",
    });
    expect((server.value as Record<string, unknown>)["appearance"]).toEqual(replacement);
    h.stop();
  }
});

it("confirms an unknown repair outcome and hands a malformed envelope to whole-document recovery", async () => {
  const disconnected = new SettingsServer({ version: 1, logStreams: [] });
  const first = storeFor(disconnected);
  await ready(first.store);
  disconnected.behaviors.push(async (params) => {
    disconnected.compare(params);
    disconnected.commit(params.value);
    throw new EngineRequestError({ code: "disconnected", message: "lost response" });
  });
  await first.store.repairSection("logStreams");
  expect(first.store.getSnapshot().repairs.logStreams.phase).toBe("saved");
  expect(disconnected.value).toEqual({ version: 1 });
  first.stop();

  const malformed = new SettingsServer({ version: 1, logStreams: [] });
  const second = storeFor(malformed);
  await ready(second.store);
  malformed.behaviors.push(async (params) => {
    malformed.compare(params);
    malformed.commit({ version: 2, logStreams: [] });
    throw new EngineRequestError({ code: "conflict", message: "changed" });
  });
  await second.store.repairSection("logStreams");
  expect(second.store.getSnapshot()).toMatchObject({
    status: "malformed",
    repairs: {
      logStreams: {
        phase: "error",
        message: expect.stringMatching(/whole stored document/),
      },
    },
  });
  expect(malformed.puts).toHaveLength(1);
  second.stop();
});

it("retires a blocked in-flight save after section repair without replaying it", async () => {
  const server = new SettingsServer({ version: 1 });
  const h = storeFor(server);
  await ready(h.store);
  const gate = deferred();
  server.behaviors.push(async () => {
    await gate.promise;
    throw new EngineRequestError({ code: "conflict", message: "changed" });
  });
  const first = h.store.save("appearance", [{ path: "appearance.theme", value: "light" }]);
  await until(() => expect(server.puts).toHaveLength(1));
  const queued = h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  server.commit({ version: 1, logStreams: "broken", remote: true });
  server.broadcast();
  expect(h.store.getSnapshot().display.logStreams.wrap).toBe(true);

  const repair = h.store.repairSection("logStreams");
  server.commit({ version: 1, remote: true });
  server.broadcast();
  expect(h.store.getSnapshot().repairs.logStreams.phase).toBe("saved");
  expect(h.store.getSnapshot().saves.display.phase).toBe("idle");
  expect(h.store.getSnapshot().display.logStreams.wrap).toBe(true);

  gate.resolve();
  await Promise.all([first, queued, repair]);
  expect(server.puts).toHaveLength(2);
  expect(server.value).toEqual({
    version: 1,
    appearance: { theme: "light" },
    remote: true,
  });
  expect(h.store.getSnapshot().saves.appearance.phase).toBe("saved");
  expect(h.store.getSnapshot().saves.display.phase).toBe("idle");
  expect(h.store.getSnapshot().display.logStreams.wrap).toBe(true);

  await h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(server.puts).toHaveLength(3);
  expect(server.value).toEqual({
    version: 1,
    appearance: { theme: "light" },
    logStreams: { wrap: false },
    remote: true,
  });
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");
  expect(h.store.getSnapshot().display.logStreams.wrap).toBe(false);
  h.stop();
});

it("shows confirmed data when another window repairs a section with blocked intent", async () => {
  const server = new SettingsServer({ version: 1, logStreams: "broken" });
  server.broadcastOnCommit = true;
  const first = storeFor(server);
  const second = storeFor(server);
  await Promise.all([ready(first.store), ready(second.store)]);

  await first.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(first.store.getSnapshot().saves.display.phase).toBe("error");
  expect(first.store.getSnapshot().display.logStreams.wrap).toBe(true);

  await second.store.repairSection("logStreams");
  expect(server.puts).toHaveLength(1);
  expect(server.value).toEqual({ version: 1 });
  expect(first.store.getSnapshot().sectionErrors.logStreams).toBeUndefined();
  expect(first.store.getSnapshot().saves.display).toMatchObject({
    phase: "conflict",
    message: "Not saved: changed in another window",
  });
  expect(first.store.getSnapshot().display.logStreams.wrap).toBe(true);

  first.stop();
  second.stop();
});

it("reconciles blocked intent against different or equal readable remote data", async () => {
  for (const replacement of [true, false]) {
    const server = new SettingsServer({ version: 1, logStreams: "broken" });
    const h = storeFor(server);
    await ready(h.store);
    await h.store.save("display", [{ path: "logStreams.wrap", value: false }]);

    server.commit({ version: 1, logStreams: { wrap: replacement }, remote: true });
    server.broadcast();

    expect(server.puts).toHaveLength(0);
    expect(h.store.getSnapshot().sectionErrors.logStreams).toBeUndefined();
    expect(h.store.getSnapshot().saves.display).toMatchObject(
      replacement
        ? { phase: "conflict", message: "Not saved: changed in another window" }
        : { phase: "saved", message: "Saved" },
    );
    expect(h.store.getSnapshot().display.logStreams.wrap).toBe(replacement);
    expect(server.value).toEqual({
      version: 1,
      logStreams: { wrap: replacement },
      remote: true,
    });
    h.stop();
  }
});

it("rejects malformed envelopes until an explicit CAS replacement", async () => {
  const server = new SettingsServer({ version: 2, appearance: { theme: "light" } });
  const h = storeFor(server);
  await until(() => expect(h.store.getSnapshot().status).toBe("malformed"));
  await h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(server.puts).toHaveLength(0);
  expect(h.store.getSnapshot().saves.display.message).toMatch(/Replace the malformed/);
  await h.store.replaceStoredPreferences();
  expect(server.puts[0]).toMatchObject({
    key: preferenceKey,
    value: { version: 1 },
    ifRevision: "r1",
  });
  expect(h.store.getSnapshot().status).toBe("ready");
  expect(h.store.getSnapshot().saves.recovery.phase).toBe("saved");
  h.stop();
});

it("reconciles an unknown replacement outcome and reports a superseding recovery", async () => {
  const disconnected = new SettingsServer({ version: 2 });
  const first = storeFor(disconnected);
  await until(() => expect(first.store.getSnapshot().status).toBe("malformed"));
  disconnected.behaviors.push(async (params) => {
    disconnected.compare(params);
    disconnected.commit(params.value);
    throw new EngineRequestError({ code: "disconnected", message: "lost response" });
  });
  await first.store.replaceStoredPreferences();
  expect(first.store.getSnapshot()).toMatchObject({
    status: "ready",
    saves: { recovery: { phase: "saved", message: "Stored preferences replaced" } },
  });
  first.stop();

  const superseded = new SettingsServer({ version: 2 });
  const second = storeFor(superseded);
  await until(() => expect(second.store.getSnapshot().status).toBe("malformed"));
  superseded.behaviors.push(async (params) => {
    superseded.compare(params);
    superseded.commit({ version: 1, future: "other window" });
    throw new EngineRequestError({ code: "conflict", message: "changed" });
  });
  await second.store.replaceStoredPreferences();
  expect(second.store.getSnapshot()).toMatchObject({
    status: "ready",
    effective: { appearance: { theme: "dark" } },
    saves: {
      recovery: {
        phase: "error",
        message: "Not saved: Stored preferences changed in another window.",
      },
    },
  });
  expect(superseded.value).toEqual({ version: 1, future: "other window" });
  second.stop();
});

it("accepts only bounded ASCII whole-number drafts", () => {
  expect(parseDecimalDraft("1", logPreferenceRanges.maxLines)).toEqual({ value: 1 });
  expect(parseDecimalDraft("100000", logPreferenceRanges.maxLines)).toEqual({ value: 100_000 });
  for (const draft of ["", "+1", "-1", "1.0", "1e2", "1,000", " 1", "01"])
    expect(parseDecimalDraft(draft, logPreferenceRanges.maxLines).error).toBeDefined();
  expect(parseDecimalDraft("0", logPreferenceRanges.maxLines).error).toMatch(/1 to 100,000/);
  expect(parseDecimalDraft("100001", logPreferenceRanges.maxLines).error).toMatch(/1 to 100,000/);
  expect(
    parseDecimalDraft(String(Number.MAX_SAFE_INTEGER + 1), logPreferenceRanges.maxLines).error,
  ).toBeDefined();
  expect(parseDecimalDraft("2", logPreferenceRanges.maxCharacters)).toEqual({ value: 2 });
  expect(parseDecimalDraft("1", logPreferenceRanges.maxCharacters).error).toMatch(
    /2 to 32,000,000/,
  );
  expect(parseDecimalDraft("1", logPreferenceRanges.maxStyledRanges)).toEqual({ value: 1 });
  expect(parseDecimalDraft("200001", logPreferenceRanges.maxStyledRanges).error).toMatch(
    /1 to 200,000/,
  );
});

it("uses an explicit empty revision and remains Saving until watched read-back", async () => {
  const server = new SettingsServer();
  const h = storeFor(server);
  await ready(h.store);
  server.holdReads = true;
  const saving = h.store.save("appearance", [{ path: "appearance.theme", value: "light" }]);
  await until(() => expect(server.puts).toHaveLength(1));
  expect(server.puts[0]!.ifRevision).toBe("");
  expect(h.store.getSnapshot().saves.appearance.phase).toBe("saving");
  server.broadcast();
  await saving;
  expect(h.store.getSnapshot().saves.appearance.phase).toBe("saved");
  h.stop();
});

it("confirms a watched intended value before the settings.put result arrives", async () => {
  const server = new SettingsServer({ version: 1 });
  const h = storeFor(server);
  await ready(h.store);
  const result = deferred();
  server.behaviors.push(async (params) => {
    server.compare(params);
    server.commit(params.value);
    server.broadcast();
    await result.promise;
    throw new EngineRequestError({ code: "unavailable", message: "late result error" });
  });
  const saving = h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  await until(() => expect(h.store.getSnapshot().saves.display.phase).toBe("saved"));
  expect(server.puts).toHaveLength(1);
  result.resolve();
  await saving;
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");
  h.stop();
});

it("rebases independent client edits and reports a same-field conflict without overwriting", async () => {
  const server = new SettingsServer({ version: 1 });
  const first = storeFor(server);
  const second = storeFor(server);
  await Promise.all([ready(first.store), ready(second.store)]);
  await Promise.all([
    first.store.save("appearance", [{ path: "appearance.theme", value: "light" }]),
    second.store.save("display", [{ path: "logStreams.wrap", value: false }]),
  ]);
  expect(server.value).toEqual({
    version: 1,
    appearance: { theme: "light" },
    logStreams: { wrap: false },
  });
  expect(server.puts).toHaveLength(3);

  server.broadcast();
  await Promise.resolve();
  await Promise.all([
    first.store.save("display", [{ path: "logStreams.timestamps", value: true }]),
    second.store.save("display", [{ path: "logStreams.timestamps", value: false }]),
  ]);
  expect((server.value as AppPreferencesV1).logStreams?.timestamps).toBe(true);
  expect(second.store.getSnapshot().saves.display).toMatchObject({
    phase: "conflict",
    message: "Not saved: changed in another window",
  });
  expect(second.store.getSnapshot().display.logStreams.timestamps).toBe(false);
  second.store.acceptCurrent("display");
  expect(second.store.getSnapshot().display.logStreams.timestamps).toBe(true);
  first.stop();
  second.stop();
});

it("bounds repeated unrelated CAS rebases to four writes", async () => {
  const server = new SettingsServer({ version: 1 });
  const h = storeFor(server);
  await ready(h.store);
  for (let attempt = 1; attempt <= 4; attempt++)
    server.behaviors.push(async (params) => {
      server.compare(params);
      server.commit({ ...(server.value as AppPreferencesV1), churn: attempt });
      throw new EngineRequestError({ code: "conflict", message: "changed" });
    });
  await h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(server.puts).toHaveLength(4);
  expect(h.store.getSnapshot().saves.display).toMatchObject({
    phase: "error",
    message: "Not saved: Preferences kept changing in other windows. Try again.",
  });
  expect((server.value as AppPreferencesV1).logStreams?.wrap).toBeUndefined();
  h.stop();
});

it("accepts an equal-value conflict but rejects a successful write superseded before its result", async () => {
  const equalServer = new SettingsServer({ version: 1 });
  const equal = storeFor(equalServer);
  await ready(equal.store);
  equalServer.behaviors.push(async (params) => {
    equalServer.compare(params);
    equalServer.commit(params.value);
    throw new EngineRequestError({ code: "conflict", message: "raced" });
  });
  await equal.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(equal.store.getSnapshot().saves.display.phase).toBe("saved");
  equal.stop();

  const supersededServer = new SettingsServer({ version: 1 });
  const superseded = storeFor(supersededServer);
  await ready(superseded.store);
  supersededServer.behaviors.push(async (params) => {
    supersededServer.compare(params);
    supersededServer.commit(params.value);
    supersededServer.commit({ version: 1, logStreams: { wrap: true } });
    supersededServer.broadcast();
  });
  await superseded.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(superseded.store.getSnapshot().saves.display.phase).toBe("conflict");
  expect(superseded.store.getSnapshot().display.logStreams.wrap).toBe(false);
  superseded.stop();
});

it("serializes rapid toggles and applies the last intent", async () => {
  const server = new SettingsServer({ version: 1 });
  const h = storeFor(server);
  await ready(h.store);
  const gate = deferred();
  server.behaviors.push(async (params) => {
    await gate.promise;
    server.compare(params);
    server.commit(params.value);
  });
  const first = h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  await until(() => expect(server.puts).toHaveLength(1));
  const second = h.store.save("display", [{ path: "logStreams.wrap", value: true }]);
  gate.resolve();
  await Promise.all([first, second]);
  expect(server.puts).toHaveLength(2);
  expect((server.value as AppPreferencesV1).logStreams?.wrap).toBe(true);
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");
  h.stop();
});

it("keeps rapid different-field intent together and does not hide an earlier failure", async () => {
  const server = new SettingsServer({ version: 1 });
  const h = storeFor(server);
  await ready(h.store);
  const gate = deferred();
  server.behaviors.push(async () => {
    await gate.promise;
    throw new EngineRequestError({ code: "unavailable", message: "disk full" });
  });
  const wrap = h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  await until(() => expect(server.puts).toHaveLength(1));
  const timestamps = h.store.save("display", [{ path: "logStreams.timestamps", value: true }]);
  expect(h.store.getSnapshot().display.logStreams).toMatchObject({
    wrap: false,
    timestamps: true,
  });
  gate.resolve();
  await Promise.all([wrap, timestamps]);
  expect(h.store.getSnapshot().saves.display).toMatchObject({
    phase: "conflict",
    paths: ["logStreams.wrap", "logStreams.timestamps"],
  });
  expect(h.store.getSnapshot().display.logStreams).toMatchObject({
    wrap: false,
    timestamps: true,
  });
  await h.store.retry("display", true);
  expect(server.value).toEqual({ version: 1, logStreams: { wrap: false, timestamps: true } });
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");
  h.stop();
});

it("retains failed intent, retries it, and confirms a disconnected write from read-back", async () => {
  const server = new SettingsServer({ version: 1 });
  const h = storeFor(server);
  await ready(h.store);
  server.behaviors.push(async () => {
    throw new EngineRequestError({ code: "unavailable", message: "disk full" });
  });
  await h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(h.store.getSnapshot().saves.display).toMatchObject({
    phase: "error",
    message: "Not saved: disk full",
  });
  expect(h.store.getSnapshot().display.logStreams.wrap).toBe(false);
  server.commit({ version: 1, appearance: { theme: "dark" }, logStreams: { timestamps: true } });
  server.broadcast();
  expect(h.store.getSnapshot().saves.display).toMatchObject({
    phase: "error",
    message: "Not saved: disk full",
  });
  expect(h.store.getSnapshot().display.logStreams).toMatchObject({
    wrap: false,
    timestamps: true,
  });
  expect(server.puts).toHaveLength(1);
  await h.store.retry("display");
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");

  server.behaviors.push(async (params) => {
    server.compare(params);
    server.commit(params.value);
    throw new EngineRequestError({ code: "disconnected", message: "lost response" });
  });
  await h.store.save("display", [{ path: "logStreams.timestamps", value: true }]);
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");
  h.stop();
});

it("waits through not-connected state and rebases after reconnect", async () => {
  const server = new SettingsServer({ version: 1 });
  const h = storeFor(server);
  await ready(h.store);
  server.behaviors.push(async (_params, control) => {
    control.setState("reconnecting");
    throw new EngineRequestError({ code: "not_connected", message: "offline" });
  });
  const saving = h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  await until(() =>
    expect(h.store.getSnapshot().saves.display.message).toBe("Saving when the Engine reconnects"),
  );
  h.control.setState("open");
  await saving;
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");
  expect((server.value as AppPreferencesV1).logStreams?.wrap).toBe(false);
  h.stop();
});

it("migrates a valid legacy theme only for a wholly absent document and Engine state wins later", async () => {
  const absent = new SettingsServer();
  const migrated = storeFor(absent, "light");
  await until(() => expect(migrated.store.getSnapshot().saves.appearance.phase).toBe("saved"));
  expect(absent.puts).toHaveLength(1);
  expect(absent.puts[0]).toMatchObject({
    ifRevision: "",
    value: { version: 1, appearance: { theme: "light" } },
  });
  expect(migrated.cache()).toBe("light");
  migrated.stop();

  const existing = new SettingsServer({ version: 1 });
  const stale = storeFor(existing, "light");
  await ready(stale.store);
  expect(existing.puts).toHaveLength(0);
  expect(stale.store.getSnapshot().effective.appearance.theme).toBe("dark");
  expect(stale.cache()).toBe("dark");
  stale.setCache("light");
  stale.control.setState("reconnecting");
  stale.control.setState("open");
  await until(() => expect(stale.cache()).toBe("dark"));
  stale.stop();

  const engineDark = decodePreferences({
    revision: "r1",
    value: { version: 1, appearance: { theme: "dark" } },
  });
  expect(engineDark.effective.appearance.theme).toBe("dark");
});

it.each([
  ["theme-less", { version: 1, logStreams: { wrap: false } }],
  ["different-theme", { version: 1, appearance: { theme: "dark" } }],
] as const)(
  "retires a terminally failed legacy migration after a fresh %s document",
  async (_kind, remote) => {
    const server = new SettingsServer();
    server.behaviors.push(async () => {
      throw new EngineRequestError({ code: "unavailable", message: "disk full" });
    });
    const h = storeFor(server, "light");
    await until(() =>
      expect(h.store.getSnapshot().saves.appearance).toMatchObject({
        phase: "error",
        message: "Not saved: disk full",
      }),
    );
    // The operation leaves pendingOperations in the queue promise's finally handler.
    await Promise.resolve();
    expect(server.puts).toHaveLength(1);

    server.commit(remote);
    server.broadcast();

    expect(server.puts).toHaveLength(1);
    expect(h.store.getSnapshot()).toMatchObject({
      effective: { appearance: { theme: "dark" } },
      display: { appearance: { theme: "dark" } },
      saves: { appearance: { phase: "idle" } },
    });
    expect(h.cache()).toBe("dark");
    h.stop();
  },
);

it("retires legacy theme migration when watch delivery creates a theme-less document", async () => {
  const server = new SettingsServer();
  server.broadcastOnCommit = true;
  const gate = deferred();
  server.behaviors.push(async (params) => {
    await gate.promise;
    server.compare(params);
    server.commit(params.value);
  });
  const migrating = storeFor(server, "light");
  await until(() => expect(server.puts).toHaveLength(1));

  const concurrent = storeFor(server);
  await ready(concurrent.store);
  await concurrent.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(server.value).toEqual({ version: 1, logStreams: { wrap: false } });
  gate.resolve();
  await until(() =>
    expect(migrating.store.getSnapshot().saves.appearance.phase).not.toBe("saving"),
  );

  expect(server.puts).toHaveLength(2);
  expect(server.value).toEqual({ version: 1, logStreams: { wrap: false } });
  expect(migrating.store.getSnapshot()).toMatchObject({
    effective: { appearance: { theme: "dark" } },
    saves: { appearance: { phase: "idle" } },
  });
  expect(migrating.cache()).toBe("dark");
  expect(concurrent.store.getSnapshot().saves.display.phase).toBe("saved");
  migrating.stop();
  concurrent.stop();
});

it("retires legacy theme migration after an empty-revision conflict creates a theme-less document", async () => {
  const server = new SettingsServer();
  server.behaviors.push(async (params) => {
    server.compare(params);
    server.commit({
      version: 1,
      logStreams: { timestamps: true },
      future: { owner: "other window" },
    });
    throw new EngineRequestError({ code: "conflict", message: "changed" });
  });
  const h = storeFor(server, "light");
  await until(() => expect(server.puts.length).toBeGreaterThanOrEqual(1));
  await until(() => expect(h.store.getSnapshot().saves.appearance.phase).not.toBe("saving"));

  expect(server.puts).toHaveLength(1);
  expect(server.value).toEqual({
    version: 1,
    logStreams: { timestamps: true },
    future: { owner: "other window" },
  });
  expect(h.store.getSnapshot()).toMatchObject({
    effective: { appearance: { theme: "dark" } },
    saves: { appearance: { phase: "idle" } },
  });
  expect(h.cache()).toBe("dark");
  h.stop();
});

it("retires legacy migration when a malformed Appearance document is created and repairs independently", async () => {
  const server = new SettingsServer();
  const gate = deferred();
  server.behaviors.push(async () => {
    await gate.promise;
    throw new EngineRequestError({ code: "conflict", message: "changed" });
  });
  const h = storeFor(server, "light");
  await until(() => expect(server.puts).toHaveLength(1));

  server.commit({ version: 1, appearance: "broken", remote: true });
  server.broadcast();
  expect(h.store.getSnapshot().saves.appearance.phase).toBe("idle");
  expect(h.store.getSnapshot().display.appearance.theme).toBe("dark");
  expect(h.cache()).toBe("dark");

  const repair = h.store.repairSection("appearance");
  server.commit({ version: 1, remote: true });
  server.broadcast();
  gate.resolve();
  await repair;

  expect(server.puts).toHaveLength(1);
  expect(server.value).toEqual({ version: 1, remote: true });
  expect(h.store.getSnapshot().repairs.appearance.phase).toBe("saved");
  expect(h.store.getSnapshot().saves.appearance.phase).toBe("idle");
  expect(h.store.getSnapshot().display.appearance.theme).toBe("dark");
  expect(h.cache()).toBe("dark");
  h.stop();
});

it("keeps the legacy theme cache intact through connection changes before the first valid snapshot", async () => {
  const server = new SettingsServer();
  server.holdReads = true;
  const h = storeFor(server, "light");
  h.control.setState("reconnecting");
  h.control.setState("open");
  expect(h.cache()).toBe("light");
  server.holdReads = false;
  server.broadcast();
  await until(() => expect(h.store.getSnapshot().saves.appearance.phase).toBe("saved"));
  expect(server.puts).toHaveLength(1);
  expect(server.puts[0]!.value).toEqual({ version: 1, appearance: { theme: "light" } });
  h.stop();
});

it("two migration windows converge to one winner without reusing a stale cache after reset", async () => {
  const server = new SettingsServer();
  const light = storeFor(server, "light");
  const dark = storeFor(server, "dark");
  await Promise.all([ready(light.store), ready(dark.store)]);
  await until(() => expect(server.puts.length).toBeGreaterThanOrEqual(1));
  server.broadcast();
  await until(() => {
    expect(light.store.getSnapshot().effective.appearance.theme).toBe(
      dark.store.getSnapshot().effective.appearance.theme,
    );
  });

  const winner = light.store.getSnapshot().effective.appearance.theme;
  await light.store.save("appearance", [{ path: "appearance.theme", value: undefined }]);
  expect((server.value as AppPreferencesV1).appearance).toBeUndefined();
  light.stop();
  dark.stop();

  const reload = storeFor(server, winner === "light" ? "dark" : "light");
  await ready(reload.store);
  expect(server.puts.at(-1)?.value).toEqual({ version: 1 });
  expect(reload.store.getSnapshot().effective.appearance.theme).toBe("dark");
  reload.stop();
});

it("reports watch errors while retaining the last-known-good values", async () => {
  const server = new SettingsServer({ version: 1, logStreams: { wrap: false } });
  const h = storeFor(server);
  await ready(h.store);
  const currentWatch = [...server.watches].findLast((watch) => !watch.closed)!;
  currentWatch.listener.error?.({ code: "unavailable", message: "read failed" });
  expect(h.store.getSnapshot()).toMatchObject({
    status: "error",
    error: "read failed",
    effective: { logStreams: { wrap: false } },
  });
  h.stop();
});

it("does not issue a write for an already-confirmed value", async () => {
  const server = new SettingsServer({ version: 1, logStreams: { wrap: false } });
  const h = storeFor(server);
  await ready(h.store);
  await h.store.save("display", [{ path: "logStreams.wrap", value: false }]);
  expect(server.puts).toHaveLength(0);
  expect(h.store.getSnapshot().saves.display.phase).toBe("saved");
  h.stop();
});

it("keeps unknown top-level fields when decoding a valid loose envelope", () => {
  const decoded = decodePreferences({ revision: "r1", value: { version: 1, future: 42 } });
  expect(decoded.raw).toEqual({ version: 1, future: 42 });
  expect(decoded.fieldErrors).toEqual({});
});

it("applies theme changes through the adapter", async () => {
  const server = new SettingsServer({ version: 1, appearance: { theme: "light" } });
  const h = storeFor(server, "dark");
  await ready(h.store);
  expect(h.applied.at(-1)).toBe("light");
  await h.store.save("appearance", [{ path: "appearance.theme", value: "dark" }]);
  expect(h.applied.at(-1)).toBe("dark");
  h.stop();
});
