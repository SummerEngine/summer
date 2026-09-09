import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Consume the engine's generated op registry so this package never sends an
 * `op` the engine has no dispatch branch for.
 *
 * The engine's dispatch ladder is the source of truth; the registry is generated
 * from it (modules/1summer_engine/dev/op_registry/op_registry.json in the engine
 * repo). If this package sends an op the engine lacks, fail here rather than on
 * a user's machine.
 *
 * This is not hypothetical. It is exactly how `ScanChanges` — the filesystem rescan
 * the since-removed Summer Cloud pull sent — went unnoticed: not an engine op on ANY
 * build, wrapped in a catch that called itself an old-build compatibility case, so
 * the editor silently kept showing pre-pull bytes.
 *
 * Engine checkout resolution: $SUMMER_ENGINE_REPO, else the `summerengine` sibling
 * of this package. This package is NOT inside the engine monorepo, so the old
 * `../../modules/...` path never existed and the check silently never ran.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const engineRepo = process.env.SUMMER_ENGINE_REPO
  ? resolve(process.env.SUMMER_ENGINE_REPO)
  : resolve(packageRoot, "..", "summerengine");
const registryPath = join(
  engineRepo, "modules", "1summer_engine", "dev", "op_registry", "op_registry.json",
);
const registryFound = existsSync(registryPath);

/**
 * Ops we knowingly send that engine `main` does not implement, with the branch
 * that adds them. Empty is the goal: when one lands on main the honesty test
 * below fails and the waiver is deleted with the workaround it excused.
 */
const KNOWN_UNIMPLEMENTED: Record<string, string> = {
  Navigate: "engine branch feat/navigate-op (one-table editor navigation; summer_open forwards to it)",
  RunSceneScript: "engine PR #156 (scene scripting: run_script ctx API)",
  GetWorldSnapshot: "engine PR #156 (runtime inspection / world snapshots)",
  DiffWorldSnapshot: "engine PR #156 (runtime inspection / world snapshots)",
  GetRuntimeSceneTree: "engine PR #156 (runtime inspection)",
  GetRuntimeNode: "engine PR #156 (runtime inspection)",
  AlignDistribute3D: "codex spatial branch (6 spatial ops)",
  NavigationProbe3D: "codex spatial branch (6 spatial ops)",
  SnapToSurface: "codex spatial branch (6 spatial ops)",
  TestPlacement3D: "codex spatial branch (6 spatial ops)",
  Starcast3D: "engine PR #147 (codex/starcast-spatial-probe: read-only 26-direction placement rundown)",
  SaveCameraBookmark: "engine PR #156 follow-up (camera bookmarks, wave I)",
  ListCameraBookmarks: "engine PR #156 follow-up (camera bookmarks, wave I)",
  DeleteCameraBookmark: "engine PR #156 follow-up (camera bookmarks, wave I)",
  CustomBake: "engine PR #155/#156 (bake helpers) — not on engine main",
  Probe: "engine PR #155/#156 (verify probe op) — not on engine main",
  FabricateMesh: "engine PR #156 follow-up (FabricateMesh, wave K)",
  UiListActions: "engine PR #156 follow-up (editor UI control, wave L)",
  UiInvoke: "engine PR #156 follow-up (editor UI control, wave L)",
  UiTree: "engine PR #156 follow-up (editor UI control, wave L)",
  UiActivate: "engine PR #156 follow-up (editor UI control, wave L)",
  UiScreenshot: "engine PR #156 follow-up (editor UI control, wave L)",
  UiDialogs: "engine PR #156 follow-up (editor UI control, wave L)",
  UiDismissDialog: "engine PR #156 follow-up (editor UI control, wave L)",
  SetRuntimeProp: "engine PR #156 follow-up (runtime control, wave I)",
  CallRuntimeMethod: "engine PR #156 follow-up (runtime control, wave I)",
  SpawnRuntimeScene: "engine PR #156 follow-up (runtime control, wave I)",
  FreeRuntimeNode: "engine PR #156 follow-up (runtime control, wave I)",
  RuntimeAnimation: "engine PR #156 follow-up (runtime control, wave I)",
  RuntimeAnimationTree: "engine PR #156 follow-up (runtime control, wave I)",
  GetRuntimeBones: "engine PR #156 follow-up (runtime control, wave I)",
  GamePause: "engine PR #156 follow-up (runtime control, wave I)",
  GameStep: "engine PR #156 follow-up (runtime control, wave I)",
  GameSpeed: "engine PR #156 follow-up (runtime control, wave I)",
  SimulateInputScript: "engine PR #156 follow-up (runtime control, wave I)",
  InputRecordStart: "engine PR #156 follow-up (runtime control, wave I)",
  InputRecordStop: "engine PR #156 follow-up (runtime control, wave I)",
  InputReplay: "engine PR #156 follow-up (runtime control, wave I)",
  GameProbe: "engine PR #156 follow-up (runtime control, wave I)",
  ListGameInstances: "engine PR #156 follow-up (runtime control, wave I)",
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
  const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as {
    ops: Array<{ op: string; dispatch?: { aliases?: string[] } }>;
  };
  const known = new Set<string>();
  for (const entry of registry.ops) {
    known.add(entry.op);
    for (const alias of entry.dispatch?.aliases ?? []) known.add(alias);
  }
  return known;
}

// Visible skip, never a silent pass: the report names the missing path.
const check = registryFound ? it : it.skip;
const skipNote = registryFound
  ? ""
  : ` (SKIPPED: no engine op registry at ${registryPath}; set SUMMER_ENGINE_REPO)`;

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

  check(`keeps the known-unimplemented list honest — entries must still be missing${skipNote}`, () => {
    const known = loadKnownOps();
    // When the engine lands one of these, this fails and the waiver gets deleted
    // along with the workaround it was excusing — rather than quietly outliving it.
    for (const [op, source] of Object.entries(KNOWN_UNIMPLEMENTED)) {
      expect(
        known.has(op),
        `"${op}" (${source}) is implemented now — drop it from KNOWN_UNIMPLEMENTED and remove the workaround`
      ).toBe(false);
    }
  });
});
