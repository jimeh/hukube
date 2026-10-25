import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assemble, candidate, draft, identity } from "../src/release/inventory.ts";
const root = resolve(import.meta.dirname, "../../..");
const repo = "jimeh/hukube";
const gh = (...args: string[]) => execFileSync("gh", args, { cwd: root, encoding: "utf8" }).trim();
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const version = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"))
  .version as string;
const tag = process.env["RELEASE_TAG"] ?? "";
const sha = process.env["RELEASE_SHA"] ?? "";
const directory = resolve(process.argv[3] ?? ".data/release-candidates");
interface Asset {
  id: number;
  name: string;
  digest?: string;
  size: number;
}
async function guard() {
  identity(tag, sha, version);
  const rootVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  if (
    rootVersion !== version ||
    git("rev-parse", "HEAD") !== sha ||
    git("rev-parse", `${tag}^{commit}`) !== sha
  )
    throw new Error("Package versions, checkout and explicit tag must match.");
  git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  const releases = JSON.parse(
    gh("api", "--paginate", "--slurp", `repos/${repo}/releases`),
  ).flat() as {
    id: number;
    draft: boolean;
    tag_name: string;
    target_commitish: string;
    assets: Asset[];
  }[];
  const matches = releases.filter((r) => r.tag_name === tag);
  if (matches.length !== 1) throw new Error("Expected exactly one existing release candidate.");
  const release = matches[0]!;
  draft(release, tag, sha);
  return release;
}
switch (process.argv[2]) {
  case "guard":
    console.log(JSON.stringify(await guard()));
    break;
  case "assemble": {
    identity(tag, sha, version);
    const assets = await assemble(directory, version, sha);
    await writeFile(join(directory, "assets.json"), JSON.stringify(assets));
    break;
  }
  case "publish": {
    if (process.env["GITHUB_ACTIONS"] !== "true" || process.env["GITHUB_REPOSITORY"] !== repo)
      throw new Error("Publication runs only in this repository's release workflow.");
    let release = await guard();
    const assets = JSON.parse(await readFile(join(directory, "assets.json"), "utf8")) as string[];
    const sums = (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n");
    const verified = new Map(sums.map((line) => [line.slice(66), line.slice(0, 64)]));
    if (!assets.includes("SHA256SUMS") || assets.length !== verified.size + 1)
      throw new Error("Incomplete asset index.");
    for (const name of assets) {
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Invalid asset name.");
      const bytes = await readFile(join(directory, name));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (name !== "SHA256SUMS" && verified.get(name) !== digest)
        throw new Error(`Asset changed after validation: ${name}`);
      const existing = release.assets.find((a) => a.name === name);
      if (existing) candidate(existing, name, digest);
      else gh("release", "upload", tag, join(directory, name), "--repo", repo);
    }
    release = await guard();
    if (
      release.assets.length !== assets.length ||
      release.assets.some((a) => !assets.includes(a.name))
    )
      throw new Error("Draft contains unexpected or missing assets.");
    // Download and compare every uploaded byte before the only publish operation.
    for (const asset of release.assets) {
      const expected = createHash("sha256")
        .update(await readFile(join(directory, asset.name)))
        .digest("hex");
      candidate(asset, asset.name, expected);
      const scratch = await mkdtemp(join(tmpdir(), "hukube-upload-"));
      try {
        const downloaded = join(scratch, asset.name);
        const output = openSync(downloaded, "w");
        try {
          execFileSync(
            "gh",
            [
              "api",
              `repos/${repo}/releases/assets/${asset.id}`,
              "-H",
              "Accept: application/octet-stream",
            ],
            { stdio: ["ignore", output, "inherit"] },
          );
        } finally {
          closeSync(output);
        }
        if (
          createHash("sha256")
            .update(await readFile(downloaded))
            .digest("hex") !== expected
        )
          throw new Error(`Remote asset mismatch: ${asset.name}`);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    const finalDraft = await guard();
    if (finalDraft.id !== release.id || finalDraft.assets.length !== release.assets.length)
      throw new Error("Draft changed during asset verification.");
    for (const asset of finalDraft.assets) {
      const original = release.assets.find((a) => a.id === asset.id);
      if (!original || original.name !== asset.name || original.digest !== asset.digest)
        throw new Error("Draft changed during asset verification.");
    }
    const published = JSON.parse(
      gh(
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/releases/${release.id}`,
        "-F",
        "draft=false",
        "-f",
        "make_latest=legacy",
      ),
    );
    if (published.draft || published.immutable !== true)
      throw new Error(
        "Published release is not immutable. Do not mutate it; inspect repository settings and use a new version.",
      );
    // Release attestations are eventually available. Each CLI call verifies the
    // cryptographic statement rather than accepting only the immutable flag.
    let verifiedRelease = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        gh("release", "verify", tag, "--repo", repo);
        verifiedRelease = true;
        break;
      } catch {
        await new Promise((resume) => setTimeout(resume, 5000));
      }
    }
    if (!verifiedRelease)
      throw new Error(
        "Published immutable release attestation could not be verified. Do not republish or change assets.",
      );
    for (const name of assets)
      gh("release", "verify-asset", tag, join(directory, name), "--repo", repo);
    console.log(`Verified immutable release ${tag} at ${sha}`);
    break;
  }
  default:
    throw new Error("Usage: release.ts guard|assemble|publish [candidate-directory]");
}
