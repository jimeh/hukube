import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("launches the AppImage with only caller arguments and honors the updater's install-only exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hukube-launcher-"));
  const received = join(directory, "arguments");
  try {
    await writeFile(
      join(directory, "hukube"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS_FILE"\n',
    );
    await chmod(join(directory, "hukube"), 0o755);
    const launcher = fileURLToPath(new URL("../../build/AppRun", import.meta.url));
    const env = {
      ...process.env,
      APPDIR: directory,
      TEST_ARGS_FILE: received,
      APPIMAGE_EXIT_AFTER_INSTALL: "",
    };
    execFileSync(launcher, ["one", "two words"], { env });
    expect(await readFile(received, "utf8")).toBe("one\ntwo words\n");
    await rm(received);
    execFileSync(launcher, [], { env: { ...env, APPIMAGE_EXIT_AFTER_INSTALL: "true" } });
    await expect(readFile(received)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
