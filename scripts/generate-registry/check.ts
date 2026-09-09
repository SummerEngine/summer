/**
 * --check mode — the CI parity gate (CONTRACT.md §6 invariant:
 * "regenerated output differing from committed registry/generated/").
 *
 * Regenerates in memory and byte-compares against:
 *  1. every committed file in registry/generated/ (missing, extra, differing),
 *  2. every applied root manifest per targets.ts,
 *  3. numeric "N tools"/"N skills" claims in the scanned docs (see
 *     count-claims.ts for the exact scope) vs counts.json.
 *
 * The optional embeddings sidecar (registry/generated/embeddings.json) is
 * NOT parity-checked — vectors are nondeterministic across providers and CI
 * never embeds. It only yields warnings (stale/missing/orphan vectors).
 *
 * Returns a precise drift summary; the CLI exits 1 on any drift.
 */

import fs from "node:fs";
import path from "node:path";
import { generateRegistry, type GenerateOptions } from "./index.ts";
import { allTargets } from "./targets.ts";
import { checkCountClaims } from "./count-claims.ts";
import { EMBEDDINGS_FILE } from "../../src/core/embeddings.ts";
import { checkEmbeddings } from "./embed.ts";

export interface CheckResult {
  ok: boolean;
  drift: string[];
  /** Non-failing notes — today only the optional embeddings sidecar (embed.ts). */
  warnings: string[];
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

function firstDifferingLine(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      return `line ${i + 1}: expected ${JSON.stringify(aLines[i] ?? "<EOF>")}, committed ${JSON.stringify(bLines[i] ?? "<EOF>")}`;
    }
  }
  return "contents differ";
}

export function checkRegistry(rootDir: string, options?: GenerateOptions): CheckResult {
  const drift: string[] = [];
  const result = generateRegistry(rootDir, options);
  const generatedDir = path.join(rootDir, "registry", "generated");

  // 1. registry/generated/ parity
  const committed = new Set(listFiles(generatedDir));
  for (const [name, content] of result.files) {
    const abs = path.join(generatedDir, name);
    if (!committed.has(name)) {
      drift.push(`registry/generated/${name}: missing (regenerate and commit it)`);
      continue;
    }
    const onDisk = fs.readFileSync(abs, "utf8");
    if (onDisk !== content) {
      drift.push(`registry/generated/${name}: stale — ${firstDifferingLine(content, onDisk)}`);
    }
  }
  for (const name of committed) {
    if (name === EMBEDDINGS_FILE) continue; // optional sidecar, checked below as warnings
    if (!result.files.has(name)) {
      drift.push(`registry/generated/${name}: extra file not produced by the compiler — delete it`);
    }
  }

  // 2. applied root manifests parity
  for (const target of allTargets()) {
    const expected = result.files.get(target.generated);
    if (expected === undefined) continue; // compiler bug would already surface above
    const abs = path.join(rootDir, target.destination);
    if (!fs.existsSync(abs)) {
      drift.push(`${target.destination}: missing (run the generator's apply step)`);
      continue;
    }
    const onDisk = fs.readFileSync(abs, "utf8");
    if (onDisk !== expected) {
      drift.push(`${target.destination}: stale vs registry/generated/${target.generated} — ${firstDifferingLine(expected, onDisk)}`);
    }
  }

  // 3. count claims in the docs
  for (const v of checkCountClaims(rootDir, result.counts)) {
    drift.push(
      `${v.file}:${v.line}: count claim "${v.claim}" says ${v.found} but counts.json has ${v.expected} ${v.noun}`,
    );
  }

  return { ok: drift.length === 0, drift, warnings: checkEmbeddings(rootDir, result.resources) };
}
