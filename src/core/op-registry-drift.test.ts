import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_MAIN_REF, readEngineMainFile } from "../test-helpers/engine-main.ts";

/**
 * Consume the engine's generated op registry so this package never sends an
 * `op` the engine has no dispatch branch for.
 *
 * The engine's dispatch ladder is the source of truth; the registry is generated
 * from it (an op_registry.json in the engine source, path below). If this package sends an op the engine lacks, fail here rather than on
 * a user's machine.
 *
 * This is not hypothetical. It is exactly how `ScanChanges` (the filesystem rescan
 * the since-removed Summer Cloud pull sent) went unnoticed: not an engine op on ANY
 * build, wrapped in a catch that called itself an old-build compatibility case, so
 * the editor silently kept showing pre-pull bytes.
 *
 * The registry is read from the engine repo's `origin/main` with `git show`,
 * never from the working tree: the sibling checkout may sit on any branch, and
 * a branch with extra ops would make the honesty test below lie. Engine
 * checkout resolution lives in src/test-helpers/engine-main.ts. Absent repo or
 * ref = visible skip, not a pass and not a failure.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = "modules/1summer_engine/dev/op_registry/op_registry.json";
const registry = readEngineMainFile(REGISTRY_PATH);

/**
 * Ops we knowingly send that the engine's shipped `main` does not implement
 * yet, grouped by the engine capability that adds them. Empty is the goal:
 * when one lands on main the honesty test below fails and the waiver is
 * deleted with the workaround it excused.
 */
const KNOWN_UNIMPLEMENTED: Record<string, string> = {
  CustomBake: "bake helpers",
  Probe: "verify probe op",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function loadKnownOps(): Set<string> {
  const parsed = JSON.parse(registry.text ?? "{}") as {
    ops: Array<{ op: string; dispatch?: { aliases?: string[] } }>;
  };
  const known = new Set<string>();
  for (const entry of parsed.ops) {
    known.add(entry.op);
    for (const alias of entry.dispatch?.aliases ?? []) known.add(alias);
  }
  return known;
}

// Visible skip, never a silent pass: the report names the missing source.
const check = registry.skipReason ? it.skip : it;
const skipNote = registry.skipReason ? ` (SKIPPED: ${registry.skipReason})` : ` (engine ${ENGINE_MAIN_REF})`;

describe("repo-lint: op registry drift", () => {
  check(`never sends an op the engine has no dispatch branch for${skipNote}`, () => {
    const known = loadKnownOps();
    expect(known.size).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of sourceFiles(join(packageRoot, "src"))) {
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(/\bop:\s*["']([A-Z][A-Za-z0-9]*)["']/g)) {
        const op = match[1];
        if (known.has(op) || op in KNOWN_UNIMPLEMENTED) continue;
        offenders.push(`${file.slice(packageRoot.length + 1)} sends unknown op "${op}"`);
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  check(`keeps the known-unimplemented list honest: entries must still be missing${skipNote}`, () => {
    const known = loadKnownOps();
    // When the engine lands one of these, this fails and the waiver gets deleted
    // along with the workaround it was excusing, rather than quietly outliving it.
    for (const [op, source] of Object.entries(KNOWN_UNIMPLEMENTED)) {
      expect(
        known.has(op),
        `"${op}" (${source}) is implemented now — drop it from KNOWN_UNIMPLEMENTED and remove the workaround`
      ).toBe(false);
    }
  });
});
