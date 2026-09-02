/**
 * generate-registry — the registry compiler (CONTRACT.md §6).
 *
 * Reads every library/<kind-plural>/<slug>/resource.yaml and emits the
 * generated registry into registry/generated/: the searchable catalog
 * (index.json), canonical counts (counts.json), the legacy alias map
 * (aliases.json), the skills registry data (skills-registry.json), and every
 * agent manifest (plugin.claude.json, plugin.codex.json, plugin.cursor.json,
 * plugin.factory.json, gemini-extension.json, marketplace.claude.json).
 *
 * Pure library: `generateRegistry(rootDir)` returns the full file map.
 * The CLI (generate / apply / --check) lives in cli.ts.
 *
 * Determinism contract: output depends only on library/** content and
 * package.json's version. Stable key order, sorted resource/skill lists,
 * 2-space JSON, trailing newline.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { runValidation } from "../validate-library/index.ts";
import { buildManifests } from "./manifests.ts";
import { GENERATED_BANNER, stableJson } from "./shared.ts";

export { GENERATED_BANNER, stableJson };

export const KIND_DIRS: Record<string, string> = {
  tool: "tools",
  skill: "skills",
  example: "examples",
  template: "templates",
  collection: "collections",
  reference: "references",
};

export const ALL_KINDS = Object.keys(KIND_DIRS).sort();

export interface LoadedResource {
  id: string;
  kind: string;
  slug: string;
  /** e.g. "skills/create-environment-kit" relative to library/ */
  relDir: string;
  absDir: string;
  data: Record<string, unknown>;
  contentHash: string;
}

export interface GenerateResult {
  /** relative output path (within registry/generated/) -> exact file bytes */
  files: Map<string, string>;
  counts: { byKind: Record<string, number>; total: number };
  resources: LoadedResource[];
}

export interface GenerateOptions {
  /** Skip the validate-library gate (tests exercising compiler-only checks). */
  skipValidation?: boolean;
  /** Schemas dir for the validation gate (defaults to <rootDir>/registry/schemas). */
  schemasDir?: string;
}

export class GenerateError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`generate-registry failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "GenerateError";
    this.problems = problems;
  }
}

// ---------- content_hash (formula documented in README.md) ----------

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

/**
 * sha256 over the resource dir: for every regular file (recursive), sorted by
 * POSIX relative path, concatenate "<relpath>\n<sha256hex(bytes)>\n"; the
 * content_hash is the sha256 hex of that UTF-8 manifest string.
 */
export function computeContentHash(resourceDir: string): string {
  const files = listFilesRecursive(resourceDir)
    .map((abs) => ({
      rel: path.relative(resourceDir, abs).split(path.sep).join("/"),
      abs,
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let manifest = "";
  for (const f of files) {
    manifest += `${f.rel}\n${sha256Hex(fs.readFileSync(f.abs))}\n`;
  }
  return sha256Hex(manifest);
}

// ---------- loading ----------

function listDirs(parent: string): string[] {
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function loadResources(rootDir: string): LoadedResource[] {
  const libraryDir = path.join(rootDir, "library");
  const resources: LoadedResource[] = [];
  for (const kindDir of Object.values(KIND_DIRS)) {
    for (const slug of listDirs(path.join(libraryDir, kindDir))) {
      const absDir = path.join(libraryDir, kindDir, slug);
      const yamlPath = path.join(absDir, "resource.yaml");
      if (!fs.existsSync(yamlPath)) continue; // validate-library reports this
      const data = parseYaml(fs.readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
      resources.push({
        id: String(data.id),
        kind: String(data.kind),
        slug,
        relDir: `${kindDir}/${slug}`,
        absDir,
        data,
        contentHash: computeContentHash(absDir),
      });
    }
  }
  return resources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- helpers ----------

export function readPackageVersion(rootDir: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    version?: string;
  };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new GenerateError(["package.json has no version to stamp into manifests"]);
  }
  return pkg.version;
}

/** Parse SKILL.md frontmatter (--- yaml ---). Returns {} when absent/unparsable. */
export function parseSkillFrontmatter(skillMdPath: string): Record<string, unknown> {
  if (!fs.existsSync(skillMdPath)) return {};
  const text = fs.readFileSync(skillMdPath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1]);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ---------- output builders ----------

function buildIndex(resources: LoadedResource[]): string {
  const entries = resources.map((res) => {
    const d = res.data;
    const entry: Record<string, unknown> = {
      id: res.id,
      kind: res.kind,
      version: d.version,
      content_hash: res.contentHash,
      summary: d.summary,
      use_when: d.use_when,
      facets: d.facets,
    };
    if (d.compatibility !== undefined) entry.compatibility = d.compatibility;
    if (d.related !== undefined) entry.related = d.related;
    entry.status = d.status;
    if (res.kind === "tool") {
      // CONTRACT.md §5 tool extensions an agent needs to map an index entry to
      // its host surface: MCP tool name, hosted-MCP eligibility, CLI command,
      // and the authority booleans. Without these the index cannot be routed.
      const surfaces = asRecord(d.surfaces);
      const mcp = asRecord(surfaces.mcp);
      const cli = asRecord(surfaces.cli);
      if (typeof mcp.tool_name === "string") entry.mcp_tool_name = mcp.tool_name;
      entry.remote = mcp.remote === true;
      if (typeof cli.command === "string") entry.cli_command = cli.command;
      entry.authority = d.authority;
    }
    if (res.kind === "skill") {
      entry.recommended = d.recommended === true;
    }
    return entry;
  });
  return stableJson({ _generated: GENERATED_BANNER, resources: entries });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildCounts(resources: LoadedResource[]): {
  json: string;
  counts: { byKind: Record<string, number>; total: number };
} {
  const byKind: Record<string, number> = {};
  for (const kind of ALL_KINDS) byKind[kind] = 0;
  for (const res of resources) byKind[res.kind] = (byKind[res.kind] ?? 0) + 1;
  const counts = { byKind, total: resources.length };
  return {
    json: stableJson({ _generated: GENERATED_BANNER, byKind, total: counts.total }),
    counts,
  };
}

function buildAliases(resources: LoadedResource[]): { json: string; problems: string[] } {
  const problems: string[] = [];
  const owners = new Map<string, string[]>();
  for (const res of resources) {
    const aliases = res.data.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      owners.set(alias, [...(owners.get(alias) ?? []), res.id]);
    }
  }
  const aliasMap: Record<string, string> = {};
  for (const alias of [...owners.keys()].sort()) {
    const ids = owners.get(alias)!;
    if (ids.length > 1) {
      problems.push(`duplicate alias "${alias}" declared by: ${ids.join(", ")}`);
      continue;
    }
    aliasMap[alias] = ids[0];
  }
  return { json: stableJson({ _generated: GENERATED_BANNER, aliases: aliasMap }), problems };
}

function buildSkillsRegistry(resources: LoadedResource[]): string {
  const skills = resources
    .filter((res) => res.kind === "skill")
    .map((res) => {
      const fm = parseSkillFrontmatter(path.join(res.absDir, "SKILL.md"));
      const name = typeof fm.name === "string" && fm.name.length > 0 ? fm.name : res.slug;
      const description =
        typeof fm.description === "string" && fm.description.length > 0
          ? fm.description
          : String(res.data.summary ?? "");
      return {
        id: res.id,
        name,
        description,
        clients: "all",
        recommended: res.data.recommended === true,
        // The installer reads this: bulk installs take `stable` and `preview`
        // (preview is a label; --stable-only skips it), never `deprecated`.
        status: String(res.data.status ?? "stable"),
        path: `library/skills/${res.slug}/`,
      };
    });
  return stableJson({ _generated: GENERATED_BANNER, skills });
}

function buildTemplatesRegistry(resources: LoadedResource[]): string {
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const templates = resources
    .filter((res) => res.kind === "template")
    .map((res) => {
      const d = res.data;
      const builtin = d.builtin === true;
      const pin = builtin
        ? null
        : {
            repo: String(d.repo ?? ""),
            commit: String(d.commit ?? ""),
            tree_digest: String(d.tree_digest ?? ""),
            ...(typeof d.default_branch === "string" ? { default_branch: d.default_branch } : {}),
          };
      return {
        id: res.id,
        slug: res.slug,
        version: String(d.version ?? ""),
        summary: String(d.summary ?? ""),
        status: String(d.status ?? "stable"),
        aliases: strList(d.aliases),
        systems: strList(d.systems),
        do_not_use_when: strList(d.do_not_use_when),
        path: `library/templates/${res.slug}/`,
        builtin,
        pin,
      };
    });
  return stableJson({ _generated: GENERATED_BANNER, templates });
}

// ---------- duplicate-id/alias compiler checks (also caught by validate-library) ----------

function compilerChecks(resources: LoadedResource[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string[]>();
  for (const res of resources) {
    seen.set(res.id, [...(seen.get(res.id) ?? []), res.relDir]);
  }
  for (const [id, dirs] of seen) {
    if (dirs.length > 1) {
      problems.push(`duplicate id "${id}" declared by: ${dirs.map((d) => `library/${d}`).join(", ")}`);
    }
  }
  return problems;
}

// ---------- entry point ----------

export function generateRegistry(rootDir: string, options?: GenerateOptions): GenerateResult {
  if (!options?.skipValidation) {
    const validation = runValidation(rootDir, {
      schemasDir: options?.schemasDir ?? path.join(rootDir, "registry", "schemas"),
    });
    if (!validation.ok) {
      throw new GenerateError(validation.errors);
    }
  }

  const resources = loadResources(rootDir);
  const problems = compilerChecks(resources);
  const { json: aliasesJson, problems: aliasProblems } = buildAliases(resources);
  problems.push(...aliasProblems);
  if (problems.length > 0) {
    throw new GenerateError(problems);
  }

  const version = readPackageVersion(rootDir);
  const { json: countsJson, counts } = buildCounts(resources);

  const files = new Map<string, string>();
  files.set("index.json", buildIndex(resources));
  files.set("counts.json", countsJson);
  files.set("aliases.json", aliasesJson);
  files.set("skills-registry.json", buildSkillsRegistry(resources));
  files.set("templates-registry.json", buildTemplatesRegistry(resources));

  const skillSlugs = resources.filter((r) => r.kind === "skill").map((r) => r.slug);
  for (const [name, content] of buildManifests({
    version,
    toolCount: counts.byKind.tool ?? 0,
    skillSlugs,
  })) {
    files.set(name, content);
  }

  return { files, counts, resources };
}

/** Write a generate result into an output directory (registry/generated/). */
export function writeGenerated(outDir: string, result: GenerateResult): void {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [rel, content] of result.files) {
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}
