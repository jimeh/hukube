import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../../.."));
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const desktop = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
const lock = await readFile(join(root, "bun.lock"), "utf8");
const workspace = lock.match(/"apps\/desktop":\s*\{[\s\S]*?"version":\s*"([^"]+)"[^\n]*/)?.[0];
if (
  rootPackage.version !== desktop.version ||
  !workspace?.includes(`"version": "${desktop.version}", // x-release-please-version`)
)
  throw new Error(
    "Root, desktop and bun.lock versions must agree. Keep x-release-please-version on the desktop workspace version in bun.lock after dependency changes.",
  );
const config = JSON.parse(await readFile(join(root, ".github/release-please-config.json"), "utf8"));
if (
  !config.packages["."]["extra-files"]?.some(
    (file: { type: string; path: string }) => file.type === "generic" && file.path === "bun.lock",
  )
)
  throw new Error("Release Please must update bun.lock's annotated workspace version.");
console.log(`Release versions agree at ${desktop.version}.`);
