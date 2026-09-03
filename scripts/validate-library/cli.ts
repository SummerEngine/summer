#!/usr/bin/env node
/**
 * npm run validate:library
 *
 * Validates library/** against registry/schemas/ and the capability lint.
 * Exits 0 when clean (including when library/ does not exist yet), 1 on any
 * violation. Warnings (WARN lines, e.g. one-way skill<->skill related links)
 * are printed but never change the exit code. Requires Node >= 22.18 (native
 * TypeScript type stripping).
 *
 * Usage: node scripts/validate-library/cli.ts [rootDir]
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runValidation } from "./index.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "..", "..");
const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot;

// Schemas always come from this repo's registry/schemas, even when validating
// another root (e.g. a fixture tree).
const result = runValidation(rootDir, { schemasDir: path.join(defaultRoot, "registry", "schemas") });

if (result.note) {
  console.log(`validate-library: ${result.note}`);
}

if (result.exceptions.length > 0) {
  console.log("");
  console.log("================ LINT EXCEPTIONS (allowed, review carefully) ================");
  for (const line of result.exceptions) console.log(`  !! ${line}`);
  console.log("=============================================================================");
  console.log("");
}

if (result.warnings.length > 0) {
  for (const line of result.warnings) console.log(`WARN ${line}`);
  console.log(`validate-library: ${result.warnings.length} warning(s) — hints only, exit code unaffected.`);
  console.log("");
}

for (const error of result.errors) {
  console.error(`ERROR ${error}`);
}

if (result.ok) {
  if (result.resourceCount > 0) {
    const extras = [
      result.exceptions.length > 0 ? `${result.exceptions.length} loud lint exception(s)` : "",
      result.warnings.length > 0 ? `${result.warnings.length} warning(s)` : "",
    ].filter(Boolean);
    console.log(`validate-library: ${result.resourceCount} resource(s) valid, 0 errors${extras.length > 0 ? `, ${extras.join(", ")}` : ""}.`);
  }
  process.exit(0);
} else {
  console.error(`validate-library: ${result.errors.length} error(s) across ${result.resourceCount} resource(s).`);
  process.exit(1);
}
