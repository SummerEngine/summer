#!/usr/bin/env node
/**
 * npm run generate:registry            — generate registry/generated/ + apply
 *                                        manifests to their root destinations.
 * npm run generate:registry -- --check — CI parity gate: regenerate, byte-compare
 *                                        against committed output AND applied root
 *                                        manifests, verify doc count claims.
 *
 * Flags:
 *   --check        parity gate only; writes nothing; exit 1 on any drift.
 *   --no-apply     generate registry/generated/ but skip copying manifests
 *                  to the repo root.
 *   --allow-empty  permit generation from an empty/missing library/ (default:
 *                  refuse, so a half-migrated tree can't clobber the real
 *                  root manifests with empty skill lists).
 *   --embed        ALSO write the optional registry/generated/embeddings.json
 *                  sidecar (one vector per resource, cached by content_hash).
 *                  Needs a Summer login (or SUMMER_EMBED_URL). Never run in
 *                  CI; --check only warns about a stale sidecar. See embed.ts.
 *
 * Requires Node >= 22.18 (native TypeScript type stripping), same as
 * scripts/validate-library/cli.ts.
 *
 * Usage: node scripts/generate-registry/cli.ts [rootDir] [flags]
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { generateRegistry, writeGenerated, GenerateError } from "./index.ts";
import { applyManifests } from "./apply.ts";
import { checkRegistry } from "./check.ts";
import { createProviderFromEnvironment, embedRegistry } from "./embed.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "..", "..");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const rootDir = positional[0] ? path.resolve(positional[0]) : defaultRoot;

// Schemas always come from this repo's registry/schemas, even when generating
// for another root (e.g. a fixture tree) — mirrors validate-library/cli.ts.
const options = { schemasDir: path.join(defaultRoot, "registry", "schemas") };

try {
  if (flags.has("--check")) {
    if (flags.has("--embed")) {
      console.error("generate-registry: --check writes nothing; run --embed without --check.");
      process.exit(1);
    }
    const result = checkRegistry(rootDir, options);
    for (const line of result.warnings) console.warn(`  WARN ${line}`);
    if (result.ok) {
      console.log("generate-registry --check: no drift.");
      process.exit(0);
    }
    console.error(`generate-registry --check: ${result.drift.length} drift issue(s):`);
    for (const line of result.drift) console.error(`  DRIFT ${line}`);
    console.error("Fix: run `npm run generate:registry` and commit the output (or correct the doc claim).");
    process.exit(1);
  }

  // Resolve the embedding provider BEFORE generating so a misconfigured
  // --embed (no login, no endpoint) fails fast and writes nothing.
  const embed = flags.has("--embed") ? createProviderFromEnvironment() : null;

  const result = generateRegistry(rootDir, options);

  if (result.counts.total === 0 && !flags.has("--allow-empty")) {
    console.error(
      "generate-registry: library/ has no resources — refusing to generate (and apply) empty manifests.",
    );
    console.error("Pass --allow-empty once the empty state is intentional.");
    process.exit(1);
  }

  const outDir = path.join(rootDir, "registry", "generated");
  writeGenerated(outDir, result);
  console.log(
    `generate-registry: wrote ${result.files.size} file(s) to registry/generated/ (${result.counts.total} resource(s): ${Object.entries(
      result.counts.byKind,
    )
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ") || "none"}).`,
  );

  if (!flags.has("--no-apply")) {
    const applied = applyManifests(rootDir, outDir);
    for (const { to } of applied.copied) console.log(`generate-registry: applied ${to}`);
  }

  if (embed) {
    const { provider, endpoint } = embed;
    console.log(`generate-registry --embed: embedding via ${endpoint.source} (${endpoint.url}) ...`);
    const summary = await embedRegistry(rootDir, result.resources, provider, { log: console.log });
    console.log(
      `generate-registry --embed: wrote ${summary.file} — ${summary.total} vector(s) (${summary.computed} computed, ${summary.reused} reused, ${summary.pruned} pruned), model ${summary.model}, ${summary.dims} dims, ${Math.round(summary.bytes / 1024)} KB.`,
    );
  }
  process.exit(0);
} catch (err) {
  if (err instanceof GenerateError) {
    console.error("generate-registry: generation failed:");
    for (const p of err.problems) console.error(`  ERROR ${p}`);
  } else {
    console.error(`generate-registry: ${(err as Error).message}`);
  }
  process.exit(1);
}
