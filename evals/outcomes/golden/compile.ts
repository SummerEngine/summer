#!/usr/bin/env node
/**
 * Compile the readable golden sources (golden/src/*.yaml, golden/src/mutants/
 * *.yaml — multi-line GDScript, one step per tool call) into the replayable
 * trajectory JSONL the runner consumes (golden/<task>.golden.jsonl and
 * golden/mutants/<task>.<mutation>.golden.jsonl), in the toolkit's eval-mode
 * full-capture record shape. Same pattern as the engine E2E's
 * make_fixtures.py: the JSONL is generated, never hand-edited.
 *
 *   node evals/outcomes/golden/compile.ts           regenerate
 *   node evals/outcomes/golden/compile.ts --check   fail on drift (CI, --dry-run)
 *
 * A hand-authored golden's `result` is the EXPECTED outcome of each call
 * (ok:true unless the step says otherwise); a golden recorded from a live
 * session carries the observed one. Replay compares either against the fresh
 * result and reports divergence.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

interface GoldenSource {
  task: string;
  recorded_at: string;
  description?: string;
  mutation?: string;
  expect_fail?: string[];
  steps: Array<{ tool: string; args: Record<string, unknown>; expect?: { ok?: boolean; failure_reason?: string } }>;
}

export interface CompiledGolden {
  /** Output path relative to golden/. */
  out: string;
  text: string;
  source: GoldenSource;
}

function validate(source: GoldenSource, file: string): void {
  const err = (m: string) => {
    throw new Error(`${relative(repoRoot, file)}: ${m}`);
  };
  if (typeof source.task !== "string" || !/^T\d+\.\d+-[a-z0-9-]+$/.test(source.task)) err("task must be a task id");
  if (typeof source.recorded_at !== "string" || Number.isNaN(Date.parse(source.recorded_at))) err("recorded_at must be an ISO timestamp");
  if (!Array.isArray(source.steps) || source.steps.length === 0) err("steps must be a non-empty list");
  for (const [i, step] of source.steps.entries()) {
    if (typeof step.tool !== "string" || !step.tool.startsWith("summer_")) err(`steps[${i}].tool must be a summer_* tool name`);
    if (!step.args || typeof step.args !== "object") err(`steps[${i}].args must be a mapping`);
  }
  const isMutant = file.includes(`${join("src", "mutants")}${"/"}`) || basename(dirname(file)) === "mutants";
  if (isMutant) {
    if (typeof source.mutation !== "string" || !/^[a-z0-9-]+$/.test(source.mutation)) err("mutants need a kebab-case `mutation`");
    if (!Array.isArray(source.expect_fail) || source.expect_fail.length === 0) err("mutants need a non-empty `expect_fail` list of assertion ids");
    if (basename(file) !== `${source.task}.${source.mutation}.yaml`) err(`mutant file must be named <task>.<mutation>.yaml`);
  } else {
    if (source.mutation !== undefined || source.expect_fail !== undefined) err("only mutants (golden/src/mutants/) may declare mutation/expect_fail");
    if (basename(file) !== `${source.task}.yaml`) err("golden file must be named <task>.yaml");
  }
}

export function compileGolden(file: string): CompiledGolden {
  const source = parseYaml(readFileSync(file, "utf8")) as GoldenSource;
  validate(source, file);
  const isMutant = basename(dirname(file)) === "mutants";
  const header = {
    kind: "golden",
    task: source.task,
    ...(source.description ? { description: source.description } : {}),
    ...(isMutant ? { mutation: source.mutation, expect_fail: source.expect_fail } : {}),
    source: relative(repoRoot, file).split("\\").join("/"),
    recorded_at: source.recorded_at,
  };
  const lines = [JSON.stringify(header)];
  for (const step of source.steps) {
    const ok = step.expect?.ok !== false;
    lines.push(
      JSON.stringify({
        ts: source.recorded_at,
        kind: "tool_call",
        tool: step.tool,
        args: step.args,
        result: { ok, ...(step.expect?.failure_reason ? { failureReason: step.expect.failure_reason } : {}), keys: [], fields: {}, media: [] },
        durationMs: 0,
      })
    );
  }
  const out = isMutant ? join("mutants", `${source.task}.${source.mutation}.golden.jsonl`) : `${source.task}.golden.jsonl`;
  return { out, text: lines.join("\n") + "\n", source };
}

export function goldenSourceFiles(goldenDir = here): string[] {
  const src = join(goldenDir, "src");
  const files: string[] = [];
  for (const dir of [src, join(src, "mutants")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) if (name.endsWith(".yaml")) files.push(join(dir, name));
  }
  return files;
}

/** Recompile every source and compare with the committed JSONL. Returns the
 *  list of drifted/missing outputs (empty = in sync). */
export function checkGoldens(goldenDir = here): string[] {
  const drift: string[] = [];
  for (const file of goldenSourceFiles(goldenDir)) {
    const compiled = compileGolden(file);
    const outPath = join(goldenDir, compiled.out);
    if (!existsSync(outPath)) drift.push(`${compiled.out}: missing (run node evals/outcomes/golden/compile.ts)`);
    else if (readFileSync(outPath, "utf8") !== compiled.text) drift.push(`${compiled.out}: differs from its source ${relative(goldenDir, file)}`);
  }
  return drift;
}

export function writeGoldens(goldenDir = here): string[] {
  const written: string[] = [];
  for (const file of goldenSourceFiles(goldenDir)) {
    const compiled = compileGolden(file);
    const outPath = join(goldenDir, compiled.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, compiled.text);
    written.push(compiled.out);
  }
  return written;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    const drift = checkGoldens();
    if (drift.length > 0) {
      console.error("golden drift:\n  " + drift.join("\n  "));
      process.exit(1);
    }
    console.log(`goldens in sync (${goldenSourceFiles().length} sources)`);
  } else {
    for (const out of writeGoldens()) console.log(`wrote golden/${out}`);
  }
}
