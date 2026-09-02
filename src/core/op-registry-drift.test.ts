import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 2 of the 0.6 MCP/CLI brief: consume O2's generated op registry.
 *
 * The engine's dispatch ladder is the source of truth; the registry is generated
 * from it (modules/1summer_engine/dev/op_registry/). This test closes the loop from
 * our side: if this package sends an `op` the engine has no branch for, fail here
 * rather than at a user's machine.
 *
 * This is not hypothetical. It is exactly how `ScanChanges` — the filesystem rescan
 * the since-removed Summer Cloud pull sent — went unnoticed: not an engine op on ANY
 * build, wrapped in a catch that called itself an old-build compatibility case, so
 * the editor silently kept showing pre-pull bytes.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registryPath = resolve(
  packageRoot, "..", "..", "modules", "1summer_engine", "dev", "op_registry", "op_registry.json",
);

/** Ops we knowingly send that the engine does not implement, with why. Empty is the goal. */
const KNOWN_UNIMPLEMENTED: Record<string, string> = {};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("op registry drift", () => {
  it("never sends an op the engine has no dispatch branch for", () => {
    // Only enforceable inside the engine monorepo; the published package has no
    // modules/ tree, so skip rather than fail there.
    if (!existsSync(registryPath)) return;

    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      ops: Array<{ op: string; dispatch?: { aliases?: string[] } }>;
    };
    const known = new Set<string>();
    for (const entry of registry.ops) {
      known.add(entry.op);
      for (const alias of entry.dispatch?.aliases ?? []) known.add(alias);
    }
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

  it("keeps the known-unimplemented list honest — entries must still be missing", () => {
    if (!existsSync(registryPath)) return;
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as { ops: Array<{ op: string }> };
    const known = new Set(registry.ops.map((entry) => entry.op));

    // When O2 lands one of these, this fails and the waiver gets deleted along with
    // the workaround it was excusing — rather than the waiver quietly outliving the bug.
    for (const op of Object.keys(KNOWN_UNIMPLEMENTED)) {
      expect(known.has(op), `"${op}" is implemented now — drop it from KNOWN_UNIMPLEMENTED and remove the workaround`).toBe(false);
    }
  });
});
