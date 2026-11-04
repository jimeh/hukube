import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stringify, parse } from "yaml";
import {
  assemble,
  candidate,
  draft,
  identity,
  packages,
  targets,
  packageVersion,
} from "./inventory.ts";
import { readFile } from "node:fs/promises";
const sha = "a".repeat(40);
it("refuses wrong versions, commits, published releases, and mismatched retry assets", () => {
  expect(() => identity("v0.1.0", sha, "0.1.0")).not.toThrow(/./);
  for (const args of [
    ["v0.2.0", sha, "0.1.0"],
    ["v0.1.0", "main", "0.1.0"],
  ])
    expect(() => identity(args[0]!, args[1]!, args[2]!)).toThrow(/./);
  expect(() =>
    draft({ draft: false, tag_name: "v0.1.0", target_commitish: sha }, "v0.1.0", sha),
  ).toThrow(/./);
  expect(() =>
    draft({ draft: true, tag_name: "v0.1.0", target_commitish: "main" }, "v0.1.0", sha),
  ).toThrow(/./);
  expect(() => candidate({ name: "a", digest: "sha256:abc" }, "a", "abc")).not.toThrow(/./);
  expect(() => candidate({ name: "a", digest: "sha256:old" }, "a", "new")).toThrow(/./);
});
it("assembles both Mac architectures and refuses incomplete inventories, forged metadata and missing checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hukube-release-"));
  try {
    const names = packages("0.1.0");
    for (const name of names) await writeFile(join(directory, name), name);
    for (const name of names.filter((n) => n.includes("-mac-")))
      await writeFile(join(directory, `${name}.blockmap`), "blockmap");
    for (const target of targets) {
      await writeFile(
        join(directory, `${target}.json`),
        JSON.stringify({
          version: "0.1.0",
          sha,
          target,
          verified: true,
          signed: target.startsWith("mac"),
          sandbox: target === "linux-x64",
          hashes: Object.fromEntries(
            names
              .filter((n) => n.includes(target))
              .map((n) => [n, createHash("sha512").update(n).digest("base64")]),
          ),
        }),
      );
      const files = names
        .filter((n) => n.includes(target))
        .map((url) => ({
          url,
          size: Buffer.byteLength(url),
          sha512: createHash("sha512").update(url).digest("base64"),
        }));
      await writeFile(
        join(directory, `${target}.yml`),
        stringify({ version: "0.1.0", files, path: files[0]!.url, sha512: files[0]!.sha512 }),
      );
    }
    await writeFile(join(directory, names[0]!), "corrupted");
    await expect(assemble(directory, "0.1.0", sha)).rejects.toThrow("verification digest differs");
    await writeFile(join(directory, names[0]!), names[0]!);
    const assets = await assemble(directory, "0.1.0", sha);
    expect(assets).toContain("SHA256SUMS");
    const manifest = parse(await readFile(join(directory, "latest-mac.yml"), "utf8"));
    expect(manifest.files.map((file: { url: string }) => file.url).toSorted()).toEqual(
      names.filter((n) => n.includes("mac")).toSorted(),
    );
    // Assembly inputs are immutable. A new invocation starts with a fresh directory.
    await rm(join(directory, "latest-mac.yml"));
    await rm(join(directory, "latest-linux.yml"));
    await rm(join(directory, "SHA256SUMS"));
    await rm(join(directory, "mac-x64.json"));
    await expect(assemble(directory, "0.1.0", sha)).rejects.toThrow(/./);
    await rm(join(directory, names[0]!));
    await expect(assemble(directory, "0.1.0", sha)).rejects.toThrow("Missing candidate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses version paths before packaging can remove an output directory", () => {
  expect(packageVersion("0.1.0-snapshot")).toBe("0.1.0-snapshot");
  for (const value of ["../../other", "0.1.0/../../other", "main", "0.1.0\n"])
    expect(() => packageVersion(value)).toThrow("semantic version");
});
