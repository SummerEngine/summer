/**
 * validate-library — CI gate for library/** (CONTRACT.md §5–§6).
 *
 * Validates every library/**/resource.yaml against its kind schema in
 * registry/schemas/, runs cross-resource integrity checks (duplicate IDs,
 * duplicate aliases, alias/ID collisions, related targets, required body
 * files, evidence media), and runs the capability lint over resource.yaml
 * strings and markdown bodies.
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

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Loudly-reported lint exceptions (allowed, but always printed). */
  exceptions: string[];
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

export function runValidation(rootDir: string, options?: { schemasDir?: string }): ValidationResult {
  const libraryDir = path.join(rootDir, "library");
  const schemasDir = options?.schemasDir ?? path.join(rootDir, "registry", "schemas");
  const errors: string[] = [];
  const exceptions: string[] = [];

  if (!fs.existsSync(libraryDir)) {
    return { ok: true, errors, exceptions, resourceCount: 0, note: `library/ does not exist at ${libraryDir} — nothing to validate (ok)` };
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
    return { ok: true, errors, exceptions, resourceCount: 0, note: "library/ contains no resources — nothing to validate (ok)" };
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
      errors.push(`${prefix}: id "${id}" does not match its directory — expected "${expectedId}"`);
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

  return { ok: errors.length === 0, errors, exceptions, resourceCount: resources.length };
}
