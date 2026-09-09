#!/usr/bin/env node
/**
 * Stub example-eval runner. Exits SKIP (code 0) until library/examples/ and
 * the pinned-engine fetcher exist. The real runner replaces this file behind
 * the same entry point and the ExampleRunner interface in runner-interface.ts.
 *
 * Requires Node >= 22.18 (native TypeScript type stripping).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExampleRunReport } from "./runner-interface.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const examplesDir = path.join(repoRoot, "library", "examples");

const report: ExampleRunReport = {
  engineVersion: "none",
  results: [],
  skipped: true,
  skipReason: fs.existsSync(examplesDir)
    ? "library/examples/ exists but the pinned-engine runner is not implemented yet (ROADMAP §3.4)"
    : "library/examples/ does not exist yet (migration in flight)",
};

console.log(`example-eval: SKIP — ${report.skipReason}`);
process.exit(0);
