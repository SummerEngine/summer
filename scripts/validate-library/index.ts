/**
 * validate-library — CI gate for library/** (CONTRACT.md §5–§6).
 *
 * Validates every library/<kind-plural>/<slug>/resource.yaml against its kind schema in
 * registry/schemas/, runs cross-resource integrity checks (duplicate IDs,
 * duplicate aliases, alias/ID collisions, related targets, required body
 * files, evidence media), enforces minimum routing metadata (per-kind
 * use_when / facets.domains counts), and runs the capability lint over
 * resource.yaml strings and markdown bodies.
 *
 * Pure library: `runValidation(rootDir)` — the CLI lives in cli.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema, type JsonSchema, type SchemaStore } from "./json-schema.ts";
import {
  collectStrings,
  lintText,
  parseAllowedHosts,
  LINT_RULES,
  type AllowedHost,
  type LintFinding,
} from "./capability-lint.ts";

export const MEDIA_SIZE_LIMIT_BYTES = 200 * 1024;

const KIND_DIRS: Record<string, string> = {
  tool: "tools",
  skill: "skills",
  example: "examples",
  template: "templates",
  collection: "collections",
  reference: "references",
};

const DIR_KINDS: Record<string, string> = Object.fromEntries(
  Object.entries(KIND_DIRS).map(([kind, dir]) => [dir, kind]),
);

/**
 * Minimum routing metadata (CONTRACT.md §5). Routing searches summary +
 * use_when + facets.domains; one-line use_when and single-domain entries are
 * what the 2026-09-02 audit found unfindable. Character minimums (summary
 * 40..160, use_when item >= 12) live in resource.schema.json; the per-kind
 * counts live here so the message can say why.
 */
const MIN_USE_WHEN_ITEMS: Record<string, number> = {
  skill: 2,
  tool: 2,
  example: 2,
  reference: 2,
  template: 1,
  collection: 1,
};
const MIN_DOMAINS_KINDS = new Set(["skill", "tool", "example", "reference"]);
export const MIN_DOMAINS = 2;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Loudly-reported lint exceptions (allowed, but always printed). */
  exceptions: string[];
  /** Non-blocking hints, printed but never part of `ok` — e.g. one-way skill<->skill related links. */
  warnings: string[];
  resourceCount: number;
  note?: string;
}

interface LoadedResource {
  /** e.g. "skills/create-environment-kit" (relative to library/) */
  relDir: string;
  absDir: string;
  kindDir: string;
  slug: string;
  data: Record<string, unknown>;
}

function loadSchemas(schemasDir: string): { store: SchemaStore; allowedHosts: AllowedHost[] } {
  const store: SchemaStore = new Map();
  const files = [
    "resource.schema.json",
    "tool.schema.json",
    "skill.schema.json",
    "example.schema.json",
    "template.schema.json",
    "collection.schema.json",
    "reference.schema.json",
    // Controlled facet vocabularies (facets.domains / facets.modalities),
    // reached from resource.schema.json via $ref "domains.json#/…".
    "domains.json",
  ];
  for (const file of files) {
    const abs = path.join(schemasDir, file);
    store.set(file, JSON.parse(fs.readFileSync(abs, "utf8")) as JsonSchema);
  }
  const hosts = JSON.parse(fs.readFileSync(path.join(schemasDir, "allowed-hosts.json"), "utf8")) as {
    allowed: string[];
  };
  return { store, allowedHosts: parseAllowedHosts(hosts.allowed) };
}

function listDirs(parent: string): string[] {
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(abs);
    }
  }
  return out.sort();
}

/** Where MCP tools are registered; scanned for `server.tool("summer_*")` calls. */
export const MCP_SOURCE_DIR = "src/mcp";

const MCP_REGISTRATION_RE = /\.(?:tool|registerTool)\(\s*["'](summer_[a-z0-9_]+)["']/g;

/**
 * Parse `server.tool("summer_x", ...)` / `registerTool("summer_x", ...)`
 * registrations out of src/mcp/server.ts and src/mcp/tools/*.ts (tests
 * excluded). Returns null when src/mcp does not exist (fail closed upstream).
 */
export function collectMcpRegistrations(rootDir: string): Map<string, string[]> | null {
  const mcpDir = path.join(rootDir, MCP_SOURCE_DIR);
  if (!fs.existsSync(mcpDir) || !fs.statSync(mcpDir).isDirectory()) return null;
  const files: string[] = [];
  const serverTs = path.join(mcpDir, "server.ts");
  if (fs.existsSync(serverTs)) files.push(serverTs);
  const toolsDir = path.join(mcpDir, "tools");
  if (fs.existsSync(toolsDir)) {
    for (const entry of fs.readdirSync(toolsDir).sort()) {
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(path.join(toolsDir, entry));
    }
  }
  const out = new Map<string, string[]>();
  for (const abs of files) {
    const rel = path.relative(rootDir, abs).split(path.sep).join("/");
    const text = fs.readFileSync(abs, "utf8");
    for (const match of text.matchAll(MCP_REGISTRATION_RE)) {
      out.set(match[1], [...(out.get(match[1]) ?? []), rel]);
    }
  }
  return out;
}

/** (a) implementation.module must be a file under src/ (".ts" may be omitted). */
function moduleProblem(rootDir: string, mod: string): string | null {
  if (!mod.startsWith("src/")) return `"${mod}" must be a repo-relative path under src/`;
  if (mod.includes("..")) return `"${mod}" may not contain ".."`;
  const candidates = mod.endsWith(".ts") ? [mod] : [mod, `${mod}.ts`];
  for (const rel of candidates) {
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return null;
  }
  return `"${mod}" does not resolve to a file under ${rootDir}/src/`;
}

const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const PROPERTY_TYPE_KEYWORDS = ["type", "$ref", "anyOf", "oneOf", "allOf", "enum", "const"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** (c) input_schema must be a structurally valid JSON Schema object (the zod/commander source). */
export function inputSchemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(schema)) return ['must be a JSON Schema object with type "object"'];
  if (schema.type !== "object") {
    problems.push(`type must be "object", got ${JSON.stringify(schema.type)}`);
  }
  if (!isPlainObject(schema.properties)) {
    problems.push(`properties must be an object mapping names to schemas, got ${JSON.stringify(schema.properties)}`);
    return problems;
  }
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (!isPlainObject(prop)) {
      problems.push(`properties.${name} must be a schema object, got ${JSON.stringify(prop)}`);
      continue;
    }
    if (!PROPERTY_TYPE_KEYWORDS.some((k) => k in prop)) {
      problems.push(`properties.${name} has no type (needs one of ${PROPERTY_TYPE_KEYWORDS.join("/")})`);
      continue;
    }
    if ("type" in prop) {
      const types = Array.isArray(prop.type) ? prop.type : [prop.type];
      for (const t of types) {
        if (typeof t !== "string" || !JSON_SCHEMA_TYPES.has(t)) {
          problems.push(`properties.${name}.type ${JSON.stringify(t)} is not a JSON Schema type`);
        }
      }
    }
  }
  if ("required" in schema) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
      problems.push(`required must be an array of property names, got ${JSON.stringify(schema.required)}`);
    } else {
      for (const r of schema.required as string[]) {
        if (!(r in schema.properties)) problems.push(`required names "${r}" which is not in properties`);
      }
    }
  }
  if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean" && !isPlainObject(schema.additionalProperties)) {
    problems.push(`additionalProperties must be a boolean or a schema, got ${JSON.stringify(schema.additionalProperties)}`);
  }
  return problems;
}

/** SKILL.md frontmatter (--- yaml ---); {} when absent or unparsable. */
function parseFrontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1]);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function runValidation(rootDir: string, options?: { schemasDir?: string }): ValidationResult {
  const libraryDir = path.join(rootDir, "library");
  const schemasDir = options?.schemasDir ?? path.join(rootDir, "registry", "schemas");
  const errors: string[] = [];
  const exceptions: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(libraryDir)) {
    return { ok: true, errors, exceptions, warnings, resourceCount: 0, note: `library/ does not exist at ${libraryDir} — nothing to validate (ok)` };
  }

  const { store, allowedHosts } = loadSchemas(schemasDir);

  // --- Walk library/ ---
  const resources: LoadedResource[] = [];
  for (const topDir of listDirs(libraryDir)) {
    if (!(topDir in DIR_KINDS)) {
      errors.push(`library/${topDir}: unexpected directory — resources live under ${Object.values(KIND_DIRS).join("|")} (flat per kind, CONTRACT.md §2)`);
      continue;
    }
    for (const slug of listDirs(path.join(libraryDir, topDir))) {
      const relDir = `${topDir}/${slug}`;
      const absDir = path.join(libraryDir, topDir, slug);
      const yamlPath = path.join(absDir, "resource.yaml");
      if (!fs.existsSync(yamlPath)) {
        errors.push(`library/${relDir}: missing resource.yaml`);
        continue;
      }
      let data: unknown;
      try {
        data = parseYaml(fs.readFileSync(yamlPath, "utf8"));
      } catch (err) {
        errors.push(`library/${relDir}/resource.yaml: YAML parse error — ${(err as Error).message.split("\n")[0]}`);
        continue;
      }
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        errors.push(`library/${relDir}/resource.yaml: must be a YAML mapping`);
        continue;
      }
      resources.push({ relDir, absDir, kindDir: topDir, slug, data: data as Record<string, unknown> });
    }
  }

  if (resources.length === 0 && errors.length === 0) {
    return { ok: true, errors, exceptions, warnings, resourceCount: 0, note: "library/ contains no resources — nothing to validate (ok)" };
  }

  // --- Per-resource schema validation ---
  for (const res of resources) {
    const prefix = `library/${res.relDir}/resource.yaml`;
    const kind = res.data.kind;
    const schemaFile = typeof kind === "string" && kind in KIND_DIRS ? `${kind}.schema.json` : "resource.schema.json";
    if (schemaFile === "resource.schema.json") {
      errors.push(`${prefix}: kind must be one of ${Object.keys(KIND_DIRS).join("|")}, got ${JSON.stringify(kind)}`);
    }
    const schema = store.get(schemaFile)!;
    for (const err of validateAgainstSchema(res.data, schema, store)) {
      errors.push(`${prefix}: ${err.path === "" ? "" : `${err.path}: `}${err.message}`);
    }
  }

  // --- Identity checks: id <-> kind <-> directory ---
  for (const res of resources) {
    const prefix = `library/${res.relDir}/resource.yaml`;
    const id = res.data.id;
    const kind = res.data.kind;
    if (typeof id !== "string" || typeof kind !== "string") continue; // schema already flagged
    const expectedKind = DIR_KINDS[res.kindDir];
    if (kind !== expectedKind) {
      errors.push(`${prefix}: kind "${kind}" does not match its directory library/${res.kindDir}/ (expected "${expectedKind}")`);
    }
    const expectedId = `${expectedKind}/${res.slug}`;
    if (id !== expectedId) {
      // CONTRACT.md §4: "<publisher>/<kind>/<slug>" is the namespace for
      // external (side-loaded) resources. Everything under library/ is the
      // official namespace and must carry the bare "<kind>/<slug>" id.
      const namespaced = /^[a-z0-9][a-z0-9-]*\/(tool|skill|example|template|collection|reference)\//.test(id);
      errors.push(
        namespaced
          ? `${prefix}: id "${id}" is publisher-namespaced — namespaced ids are only valid for side-loaded resources outside library/; official resources use "${expectedId}"`
          : `${prefix}: id "${id}" does not match its directory — expected "${expectedId}"`,
      );
    }
  }

  // --- Duplicate IDs, duplicate aliases, alias colliding with a live ID ---
  const idOwners = new Map<string, string[]>();
  const aliasOwners = new Map<string, string[]>();
  for (const res of resources) {
    const id = res.data.id;
    if (typeof id === "string") {
      idOwners.set(id, [...(idOwners.get(id) ?? []), res.relDir]);
    }
    const aliases = res.data.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string") {
          aliasOwners.set(alias, [...(aliasOwners.get(alias) ?? []), res.relDir]);
        }
      }
    }
  }
  for (const [id, owners] of idOwners) {
    if (owners.length > 1) {
      errors.push(`duplicate id "${id}" declared by: ${owners.map((o) => `library/${o}`).join(", ")}`);
    }
  }
  for (const [alias, owners] of aliasOwners) {
    if (owners.length > 1) {
      errors.push(`duplicate alias "${alias}" declared by: ${owners.map((o) => `library/${o}`).join(", ")}`);
    }
    if (idOwners.has(alias)) {
      errors.push(`alias "${alias}" (declared by ${owners.map((o) => `library/${o}`).join(", ")}) collides with a live resource id`);
    }
  }

  // --- related (and collection.recommended) targets must exist ---
  for (const res of resources) {
    const prefix = `library/${res.relDir}/resource.yaml`;
    const targets: Array<{ where: string; id: unknown }> = [];
    const related = res.data.related;
    if (related !== null && typeof related === "object" && !Array.isArray(related)) {
      for (const [group, list] of Object.entries(related as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          list.forEach((id, i) => targets.push({ where: `related.${group}[${i}]`, id }));
        }
      }
    }
    const recommended = res.data.recommended;
    if (recommended !== null && typeof recommended === "object" && !Array.isArray(recommended)) {
      for (const [group, list] of Object.entries(recommended as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          list.forEach((id, i) => targets.push({ where: `recommended.${group}[${i}]`, id }));
        }
      }
    }
    for (const t of targets) {
      if (typeof t.id === "string" && !idOwners.has(t.id)) {
        errors.push(`${prefix}: ${t.where}: target "${t.id}" does not exist in the library`);
      }
    }
  }

  // --- Reciprocity hint (warning, never an error): skill A lists skill B in
  //     related.skills but B does not list A. One-way links are legitimate
  //     (hub skills fan out); the hint keeps them visible so authors decide.
  const skillById = new Map<string, LoadedResource>();
  for (const res of resources) {
    if (res.data.kind === "skill" && typeof res.data.id === "string") skillById.set(res.data.id, res);
  }
  const relatedSkills = (res: LoadedResource): string[] => {
    const related = res.data.related;
    if (!isPlainObject(related) || !Array.isArray(related.skills)) return [];
    return (related.skills as unknown[]).filter((s): s is string => typeof s === "string");
  };
  for (const [id, res] of skillById) {
    for (const target of relatedSkills(res)) {
      const other = skillById.get(target);
      if (!other || other === res) continue; // not a skill, or a missing target (reported above)
      if (!relatedSkills(other).includes(id)) {
        warnings.push(
          `library/${res.relDir}/resource.yaml: related.skills lists ${target}, but library/${other.relDir}/resource.yaml does not list ${id} back (reciprocity hint)`,
        );
      }
    }
  }

  // --- Kind-specific file requirements ---
  for (const res of resources) {
    const kind = res.data.kind;
    if (kind === "skill" && !fs.existsSync(path.join(res.absDir, "SKILL.md"))) {
      errors.push(`library/${res.relDir}: skill is missing SKILL.md`);
    }
    if (kind === "reference") {
      const hasBody = fs
        .readdirSync(res.absDir)
        .some((f) => f.toLowerCase().endsWith(".md") && fs.statSync(path.join(res.absDir, f)).isFile());
      if (!hasBody) {
        errors.push(`library/${res.relDir}: reference is missing a body .md file`);
      }
    }
    if (kind === "collection" && res.data.status === "stable" && Array.isArray(res.data.items)) {
      (res.data.items as unknown[]).forEach((item, i) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (typeof record.sha256 !== "string") {
            errors.push(`library/${res.relDir}/resource.yaml: items[${i}]: sha256 is required when status is "stable" (optional only for preview)`);
          }
        }
      });
    }
  }

  // --- Minimum routing metadata: enough use_when situations and domains to be findable ---
  for (const res of resources) {
    const prefix = `library/${res.relDir}/resource.yaml`;
    const kind = res.data.kind;
    if (typeof kind !== "string" || !(kind in KIND_DIRS)) continue; // schema already flagged
    const summary = typeof res.data.summary === "string" ? res.data.summary.trim() : null;
    const useWhen = Array.isArray(res.data.use_when) ? (res.data.use_when as unknown[]) : null;
    const minItems = MIN_USE_WHEN_ITEMS[kind] ?? 2;
    if (useWhen !== null && useWhen.length < minItems) {
      errors.push(
        `${prefix}: use_when has ${useWhen.length} item(s) — a ${kind} needs at least ${minItems} (each item is a distinct situation that should trigger this resource; routing searches them)`,
      );
    }
    if (useWhen !== null && summary !== null) {
      useWhen.forEach((item, i) => {
        if (typeof item === "string" && item.trim() === summary) {
          errors.push(`${prefix}: use_when[${i}] repeats the summary verbatim — describe a situation that calls for this resource, not the resource itself`);
        }
      });
    }
    if (MIN_DOMAINS_KINDS.has(kind)) {
      const facets = res.data.facets;
      const domains = isPlainObject(facets) && Array.isArray(facets.domains) ? (facets.domains as unknown[]) : [];
      if (domains.length < MIN_DOMAINS) {
        const listed = domains.length > 0 ? ` [${domains.map(String).join(", ")}]` : "";
        errors.push(
          `${prefix}: facets.domains has ${domains.length} item(s)${listed} — a ${kind} needs at least ${MIN_DOMAINS} domains from registry/schemas/domains.json (facet filters and routing rely on them)`,
        );
      }
    }
  }

  // --- Cross-checks against the host code: a descriptor may not describe fiction ---
  // (a) tool.implementation.module resolves to a real file under src/
  // (b) surfaces.mcp.tool_name set == server.tool("summer_*") registrations in src/mcp
  // (c) input_schema is a structurally valid JSON Schema object
  // (d) evidence.verified_at parses and is not in the future
  // (e) SKILL.md frontmatter name equals the slug (or is a declared alias)
  const toolResources = resources.filter((res) => res.data.kind === "tool");
  for (const res of toolResources) {
    const prefix = `library/${res.relDir}/resource.yaml`;
    const implementation = res.data.implementation;
    if (implementation !== null && typeof implementation === "object" && !Array.isArray(implementation)) {
      const mod = (implementation as Record<string, unknown>).module;
      if (typeof mod === "string") {
        const problem = moduleProblem(rootDir, mod);
        if (problem) errors.push(`${prefix}: implementation.module: ${problem}`);
      }
    }
    for (const problem of inputSchemaProblems(res.data.input_schema)) {
      errors.push(`${prefix}: input_schema: ${problem}`);
    }
  }

  const descriptorToolNames = new Map<string, string[]>();
  for (const res of toolResources) {
    const surfaces = res.data.surfaces;
    if (surfaces === null || typeof surfaces !== "object" || Array.isArray(surfaces)) continue;
    const mcp = (surfaces as Record<string, unknown>).mcp;
    if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) continue;
    const name = (mcp as Record<string, unknown>).tool_name;
    if (typeof name === "string") {
      descriptorToolNames.set(name, [...(descriptorToolNames.get(name) ?? []), res.relDir]);
    }
  }
  if (descriptorToolNames.size > 0) {
    const registrations = collectMcpRegistrations(rootDir);
    if (registrations === null) {
      errors.push(
        `cannot cross-check surfaces.mcp.tool_name: ${MCP_SOURCE_DIR} not found under ${rootDir} — ${descriptorToolNames.size} tool descriptor(s) declare an MCP surface that nothing registers`,
      );
    } else {
      for (const [name, dirs] of descriptorToolNames) {
        if (dirs.length > 1) {
          errors.push(`duplicate surfaces.mcp.tool_name "${name}" declared by: ${dirs.map((d) => `library/${d}`).join(", ")}`);
        }
        if (!registrations.has(name)) {
          errors.push(`library/${dirs[0]}/resource.yaml: surfaces.mcp.tool_name "${name}" is not registered by any server.tool() call in ${MCP_SOURCE_DIR}`);
        }
      }
      for (const [name, files] of registrations) {
        if (!descriptorToolNames.has(name)) {
          errors.push(`${files.join(", ")}: MCP tool "${name}" is registered but has no library/tools/<slug>/resource.yaml descriptor (surfaces.mcp.tool_name)`);
        }
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const res of resources) {
    const evidence = res.data.evidence;
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) continue;
    const verifiedAt = (evidence as Record<string, unknown>).verified_at;
    if (typeof verifiedAt !== "string") continue; // schema-flagged
    const prefix = `library/${res.relDir}/resource.yaml: evidence.verified_at`;
    const parsed = Date.parse(`${verifiedAt}T00:00:00Z`);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== verifiedAt) {
      errors.push(`${prefix}: "${verifiedAt}" is not a real calendar date`);
    } else if (verifiedAt > today) {
      errors.push(`${prefix}: "${verifiedAt}" is in the future (today is ${today})`);
    }
  }

  for (const res of resources) {
    if (res.data.kind !== "skill") continue;
    const skillMd = path.join(res.absDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue; // reported below
    const fm = parseFrontmatter(fs.readFileSync(skillMd, "utf8"));
    const name = fm.name;
    const aliases = Array.isArray(res.data.aliases) ? (res.data.aliases as unknown[]).filter((a): a is string => typeof a === "string") : [];
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`library/${res.relDir}/SKILL.md: frontmatter is missing "name" (hosts load skills by this name; it must be "${res.slug}")`);
    } else if (name !== res.slug && !aliases.includes(name)) {
      errors.push(`library/${res.relDir}/SKILL.md: frontmatter name "${name}" does not match the slug "${res.slug}" and is not listed in aliases`);
    }
  }

  // --- Evidence media: in-repo files must exist, stay inside the resource dir, and be <=200KB ---
  for (const res of resources) {
    const evidence = res.data.evidence;
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) continue;
    const media = (evidence as Record<string, unknown>).media;
    if (!Array.isArray(media)) continue;
    media.forEach((item, i) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return;
      const rel = (item as Record<string, unknown>).path;
      if (typeof rel !== "string") return; // URL media or schema-flagged
      const abs = path.resolve(res.absDir, rel);
      if (!abs.startsWith(path.resolve(res.absDir) + path.sep)) {
        errors.push(`library/${res.relDir}/resource.yaml: evidence.media[${i}].path escapes the resource directory: ${rel}`);
        return;
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        errors.push(`library/${res.relDir}/resource.yaml: evidence.media[${i}].path does not exist: ${rel}`);
        return;
      }
      const size = fs.statSync(abs).size;
      if (size > MEDIA_SIZE_LIMIT_BYTES) {
        errors.push(
          `library/${res.relDir}/${rel}: in-repo evidence media is ${size} bytes (> ${MEDIA_SIZE_LIMIT_BYTES} = 200KB) — host it by URL + sha256 instead (CONTRACT.md §2)`,
        );
      }
    });
  }

  // --- Capability lint ---
  const knownRules = new Set<string>(LINT_RULES);
  for (const res of resources) {
    const prefix = `library/${res.relDir}`;

    const excepted = new Set<string>();
    const declared = res.data.lint_exceptions;
    if (Array.isArray(declared)) {
      for (const rule of declared) {
        if (typeof rule !== "string") continue;
        if (!knownRules.has(rule)) {
          errors.push(`${prefix}/resource.yaml: lint_exceptions names unknown rule "${rule}" (known: ${LINT_RULES.join(", ")})`);
          continue;
        }
        excepted.add(rule);
      }
      // Reason presence is enforced by the schema (dependentRequired); report
      // every granted exception loudly regardless.
      const reason = typeof res.data.lint_exception_reason === "string" ? res.data.lint_exception_reason : "(no reason given)";
      for (const rule of excepted) {
        exceptions.push(`${prefix}: LINT EXCEPTION "${rule}" — ${reason}`);
      }
    }

    const findings: LintFinding[] = [];

    // 1. Every string value in resource.yaml (except the exception mechanism's
    //    own fields, which describe rules and reasons).
    const strings: Array<{ path: string; text: string }> = [];
    const { lint_exceptions: _ex, lint_exception_reason: _reason, ...rest } = res.data;
    collectStrings(rest, "", strings);
    for (const s of strings) {
      findings.push(...lintText(s.text, `resource.yaml ${s.path}`, allowedHosts));
    }

    // 2. Every markdown body in the resource dir (SKILL.md, README.md,
    //    reference bodies, references/*.md, ...).
    for (const mdAbs of walkMarkdownFiles(res.absDir)) {
      const mdRel = path.relative(res.absDir, mdAbs);
      findings.push(...lintText(fs.readFileSync(mdAbs, "utf8"), mdRel, allowedHosts));
    }

    for (const f of findings) {
      if (excepted.has(f.rule)) continue;
      errors.push(`${prefix} [${f.rule}] ${f.location}: ${f.message}`);
    }
  }

  return { ok: errors.length === 0, errors, exceptions, warnings, resourceCount: resources.length };
}
