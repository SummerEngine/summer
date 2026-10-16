#!/usr/bin/env node
/**
 * Copy the hosted Summer server's public operation catalog into this package,
 * byte for byte: registry/operations/public-catalog.json. The source is
 * src/lib/ops/public-catalog.json on main of SummerEngine/PublicSummerEngine;
 * `summer ops search`, `ops describe` and summer_search list every cloud
 * operation from the copy with no sign-in (src/core/ops/public-catalog.ts).
 *
 *   node scripts/sync-public-catalog.ts                  write the copy
 *   node scripts/sync-public-catalog.ts --check          exit 1 when the copy differs from main
 *   ... --from <checkout>                                read origin/main of a local checkout (or PSE_REPO=<checkout>)
 *
 * Without --from it reads GitHub with `gh` (signed in, with read access to
 * the private repository). Run --check before every release.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "src/lib/ops/public-catalog.json";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "registry", "operations", "public-catalog.json");
const args = process.argv.slice(2);
const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : process.env.PSE_REPO;

function readSource(): string {
  const options = { encoding: "utf8" as const, maxBuffer: 64 << 20 };
  if (from) return execFileSync("git", ["-C", from, "show", `origin/main:${SOURCE}`], options);
  return execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/SummerEngine/PublicSummerEngine/contents/${SOURCE}?ref=main`], options);
}

const source = readSource();
const parsed = JSON.parse(source) as { contract?: unknown; operations?: unknown[] };
if (parsed.contract !== 1 || !Array.isArray(parsed.operations) || parsed.operations.length === 0) {
  console.error(`public-catalog: the source is not a contract 1 catalog with operations (${from ?? "GitHub main"}).`);
  process.exit(1);
}

if (args.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    // missing file = drift
  }
  if (committed !== source) {
    console.error("public-catalog: registry/operations/public-catalog.json differs from PublicSummerEngine main. Run: npm run sync:catalog");
    process.exit(1);
  }
  console.log(`public-catalog: current (${parsed.operations.length} operations).`);
} else {
  writeFileSync(target, source);
  console.log(`public-catalog: wrote ${target} (${parsed.operations.length} operations).`);
}
