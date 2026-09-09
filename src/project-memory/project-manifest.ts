/**
 * `.summer/project.json` — the project manifest (CONTRACT.md §8).
 *
 * Written by `summer create` so a fresh agent can answer "exactly which
 * template, at which commit, built this project" without the original
 * conversation. Merged, never clobbered: any other keys already in the file
 * survive a rewrite.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PROJECT_MANIFEST_RELPATH = ".summer/project.json";

export type ProjectTemplateRecord =
  | { id: string; version: string; builtin: true }
  | { id: string; version: string; repo: string; commit: string; tree_digest: string };

export interface ProjectManifest {
  template?: ProjectTemplateRecord;
  toolkit_version?: string;
  /** Summer Engine version seen at create time; absent when no engine was reachable. */
  engine_version?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function projectManifestPath(projectDir: string): string {
  return join(projectDir, PROJECT_MANIFEST_RELPATH);
}

export function readProjectManifest(projectDir: string): ProjectManifest | null {
  const file = projectManifestPath(projectDir);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${file} exists but is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} exists but is not a JSON object`);
  }
  return parsed as ProjectManifest;
}

export interface ProjectManifestPatch {
  template: ProjectTemplateRecord;
  toolkit_version: string;
  /** Recorded when given; an existing value survives a patch without one. */
  engine_version?: string;
  /** Override for tests; defaults to now. Only used when the file has no created_at yet. */
  now?: () => Date;
}

/**
 * Write (or merge into) `.summer/project.json`. Existing keys are preserved;
 * `template` and `toolkit_version` (and `engine_version` when given) are
 * replaced; `created_at` is set once.
 */
export function writeProjectManifest(projectDir: string, patch: ProjectManifestPatch): ProjectManifest {
  const existing = readProjectManifest(projectDir) ?? {};
  const now = patch.now ?? (() => new Date());
  const manifest: ProjectManifest = {
    ...existing,
    template: patch.template,
    toolkit_version: patch.toolkit_version,
    ...(patch.engine_version ? { engine_version: patch.engine_version } : {}),
    created_at: typeof existing.created_at === "string" ? existing.created_at : now().toISOString(),
  };
  const file = projectManifestPath(projectDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return manifest;
}
