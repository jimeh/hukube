import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";

export function packageVersion(value: string): string {
  if (value.trim() !== value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value))
    throw new Error("Package version must be a semantic version without path separators.");
  return value;
}
export function identity(tag: string, sha: string, version: string) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${version}` || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Release tag, full commit SHA, and app version must agree.");
}
export function draft(
  release: { draft: boolean; tag_name: string; target_commitish: string },
  tag: string,
  sha: string,
) {
  if (!release.draft || release.tag_name !== tag || release.target_commitish !== sha)
    throw new Error("Refusing a published release or mismatched draft identity.");
}
export function candidate(
  existing: { name: string; digest?: string },
  name: string,
  digest: string,
) {
  if (existing.name !== name || existing.digest !== `sha256:${digest}`)
    throw new Error(`Refusing to replace mismatched candidate asset: ${name}`);
}
export const targets = ["mac-arm64", "mac-x64", "linux-x64"] as const;
export function packages(version: string) {
  return [
    `hukube-${version}-mac-arm64.dmg`,
    `hukube-${version}-mac-arm64.zip`,
    `hukube-${version}-mac-x64.dmg`,
    `hukube-${version}-mac-x64.zip`,
    `hukube-${version}-linux-x64.AppImage`,
  ];
}
interface Manifest {
  version: string;
  files: { url: string; sha512: string; size: number }[];
  path: string;
  sha512: string;
  releaseDate?: string;
}
export async function verifyManifest(
  directory: string,
  manifest: Manifest,
  version: string,
  expected: string[],
) {
  if (
    manifest.version !== version ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== expected.length ||
    new Set(manifest.files.map((f) => f.url)).size !== expected.length
  )
    throw new Error("Update manifest has an incorrect version or file inventory.");
  for (const file of manifest.files) {
    if (!expected.includes(file.url)) throw new Error(`Unexpected update reference: ${file.url}`);
    const bytes = await readFile(join(directory, file.url));
    if (
      file.size !== bytes.length ||
      file.sha512 !== createHash("sha512").update(bytes).digest("base64")
    )
      throw new Error(`Update metadata does not match ${file.url}`);
  }
  const legacy = manifest.files.find((file) => file.url === manifest.path);
  if (!legacy || manifest.sha512 !== legacy.sha512)
    throw new Error("Legacy update path and digest disagree with files.");
}

/** Merge per-architecture Mac metadata, then verify every byte before upload. */
export async function assemble(directory: string, version: string, sha: string) {
  const expected = packages(version);
  const names = await readdir(directory);
  const allowed = new Set([
    ...expected,
    ...expected.map((n) => `${n}.blockmap`),
    ...targets.flatMap((t) => [`${t}.yml`, `${t}.json`]),
  ]);
  for (const name of names)
    if (!allowed.has(name)) throw new Error(`Unexpected candidate: ${name}`);
  for (const name of [
    ...expected,
    ...expected.filter((n) => n.includes("-mac-")).map((n) => `${n}.blockmap`),
  ])
    if (!names.includes(name) || !(await stat(join(directory, name))).size)
      throw new Error(`Missing candidate: ${name}`);
  for (const target of targets) {
    const report = JSON.parse(await readFile(join(directory, `${target}.json`), "utf8")) as Record<
      string,
      unknown
    >;
    if (
      report["version"] !== version ||
      report["sha"] !== sha ||
      report["target"] !== target ||
      report["verified"] !== true ||
      (target.startsWith("mac") && report["signed"] !== true)
    )
      throw new Error(`Missing platform verification: ${target}`);
    const hashes = report["hashes"] as Record<string, string> | undefined;
    for (const name of expected.filter((n) => n.includes(target)))
      if (
        hashes?.[name] !==
        createHash("sha512")
          .update(await readFile(join(directory, name)))
          .digest("base64")
      )
        throw new Error(`Platform verification digest differs: ${name}`);
  }
  const manifest = async (target: string) =>
    parse(await readFile(join(directory, `${target}.yml`), "utf8")) as Manifest;
  const arm = await manifest("mac-arm64");
  const intel = await manifest("mac-x64");
  const linux = await manifest("linux-x64");
  await verifyManifest(
    directory,
    arm,
    version,
    expected.filter((n) => n.includes("mac-arm64")),
  );
  await verifyManifest(
    directory,
    intel,
    version,
    expected.filter((n) => n.includes("mac-x64")),
  );
  await verifyManifest(
    directory,
    linux,
    version,
    expected.filter((n) => n.endsWith("AppImage")),
  );
  const mac = { ...intel, files: [...intel.files, ...arm.files] };
  await verifyManifest(
    directory,
    mac,
    version,
    expected.filter((n) => n.includes("-mac-")),
  );
  await writeFile(join(directory, "latest-mac.yml"), stringify(mac));
  await writeFile(join(directory, "latest-linux.yml"), stringify(linux));
  const assets = [
    ...expected,
    ...names.filter((n) => n.endsWith(".blockmap")),
    "latest-mac.yml",
    "latest-linux.yml",
    ...targets.map((t) => `${t}.json`),
  ];
  const checksums = [];
  for (const name of assets.toSorted())
    checksums.push(
      `${createHash("sha256")
        .update(await readFile(join(directory, name)))
        .digest("hex")}  ${name}`,
    );
  await writeFile(join(directory, "SHA256SUMS"), checksums.join("\n") + "\n");
  return [...assets, "SHA256SUMS"];
}
