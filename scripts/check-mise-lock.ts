// CI installs tools with `mise install --locked`, which fails when mise.lock
// lacks a tool's version or a download URL for the runner's platform. This
// catches both before a push.
import { $ } from "bun";

interface LockEntry {
  version: string;
  backend: string;
  [platform: `platforms.${string}`]: { url?: string } | undefined;
}

const problems: string[] = [];

const changes: { name: string; new_versions: string[] }[] = await $`mise lock --dry-run --json`
  .quiet()
  .json();
for (const change of changes) {
  problems.push(`${change.name} ${change.new_versions.join(", ")} is not locked`);
}

const lock = Bun.TOML.parse(await Bun.file("mise.lock").text()) as {
  tools: Record<string, LockEntry[]>;
};
// Linux x64 for CI and contributors, the others for contributors. Not every
// tool publishes musl or Windows builds, so those are not required.
const platforms = ["linux-x64", "linux-arm64", "macos-arm64", "macos-x64"] as const;
for (const [name, entries] of Object.entries(lock.tools)) {
  for (const entry of entries) {
    // Go-backend tools build from source, so they have no download URLs.
    if (entry.backend.startsWith("go:")) continue;
    for (const platform of platforms) {
      if (!entry[`platforms.${platform}`]?.url) {
        problems.push(`${name}@${entry.version} has no URL for ${platform}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`mise.lock is incomplete:\n  ${problems.join("\n  ")}\nRun \`mise lock\`.`);
  process.exit(1);
}
