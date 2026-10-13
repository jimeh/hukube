import { expect, it } from "vitest";
import { followManifest, isDirty, sessionNotice, startSession } from "./session.ts";
const live = {
  kind: "ConfigMap",
  metadata: { name: "web", uid: "u", resourceVersion: "1" },
  data: { greeting: "hello" },
};
it("follows editable live changes only while there are no unsaved edits", () => {
  const clean = startSession(live);
  const changed = { ...live, data: { greeting: "cluster" } };
  expect(followManifest(clean, changed, false)?.text).toContain("cluster");
  const dirty = { ...clean, text: clean.text + "# mine\n" };
  expect(isDirty(dirty)).toBe(true);
  expect(followManifest(dirty, changed, false)).toBe(dirty);
  expect(sessionNotice(dirty, changed, false, "ConfigMap web", "ConfigMap")).toContain(
    "changed on the Cluster",
  );
  expect(
    sessionNotice(
      dirty,
      { ...live, metadata: { ...live.metadata, resourceVersion: "2" }, status: {} },
      false,
      "ConfigMap web",
      "ConfigMap",
    ),
  ).toBeUndefined();
});
it("keeps deleted and replaced edits, but leaves clean Edit mode after deletion", () => {
  const clean = startSession(live);
  const dirty = { ...clean, text: clean.text + "# mine\n" };
  expect(followManifest(clean, undefined, true)).toBeUndefined();
  expect(followManifest(dirty, undefined, true)).toBe(dirty);
  expect(sessionNotice(dirty, undefined, true, "ConfigMap web", "ConfigMap")).toContain(
    "cannot be applied",
  );
  expect(
    sessionNotice(
      dirty,
      { ...live, metadata: { ...live.metadata, uid: "new" } },
      false,
      "ConfigMap web",
      "ConfigMap",
    ),
  ).toContain("replaced by a new ConfigMap");
});
