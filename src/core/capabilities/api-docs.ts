/**
 * Offline engine class-reference lookup (tool/api-docs). Shared by the MCP
 * tool (summer_api_docs) and the CLI dispatcher (`summer tool api-docs`).
 *
 * Reads assets/api-docs.json.gz — built by a separate step from the engine's
 * class reference and stamped with the technical base it came from. The
 * bundle can be absent from an install; every entry point answers with a
 * structured api_docs_not_installed result instead of throwing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "../package-root.js";
import { gunzipSync } from "node:zlib";

export interface ApiDocsProperty { name: string; type: string; default?: string; desc?: string }
export interface ApiDocsMethod { sig: string; desc?: string }
export interface ApiDocsConstant { name: string; value: string; enum?: string }
export interface ApiDocsClass {
  inherits: string | null;
  brief: string;
  properties?: ApiDocsProperty[];
  methods?: ApiDocsMethod[];
  signals?: ApiDocsMethod[];
  constants?: ApiDocsConstant[];
}
export interface ApiDocs {
  classes: Record<string, ApiDocsClass>;
  /** Engine technical base the asset was generated from. */
  technical_base?: string;
}

const DEFAULT_API_DOCS_PATH = resolve(PACKAGE_ROOT, "assets/api-docs.json.gz");

let apiDocsPath = DEFAULT_API_DOCS_PATH;
let apiDocsCache: ApiDocs | null = null;
let apiDocsIndex: Map<string, string> | null = null;

/** Test seam: point the loader at a fixture (or a missing path) and drop the
 *  cache. Omit the path to restore the shipped bundle. */
export function resetApiDocsForTests(path?: string): void {
  apiDocsPath = path ?? DEFAULT_API_DOCS_PATH;
  apiDocsCache = null;
  apiDocsIndex = null;
}

export function isApiDocsBundleInstalled(): boolean {
  return existsSync(apiDocsPath);
}

export const API_DOCS_NOT_INSTALLED =
  "api docs bundle not installed: this summer-engine install has no assets/api-docs.json.gz, so the offline class reference is unavailable. Reinstall or update the summer-engine package (npx summer-engine@latest). Until then, verify property/method names against the engine itself (summer_inspect_node / summer_inspect_resource) instead of guessing.";

function loadApiDocs(): ApiDocs {
  if (!apiDocsCache) {
    apiDocsCache = JSON.parse(
      gunzipSync(readFileSync(apiDocsPath)).toString("utf8")
    ) as ApiDocs;
    apiDocsIndex = new Map(
      Object.keys(apiDocsCache.classes).map((name) => [name.toLowerCase(), name])
    );
  }
  return apiDocsCache;
}

function suggestClasses(query: string): string[] {
  const docs = loadApiDocs();
  const needle = query.toLowerCase();
  const names = Object.keys(docs.classes);
  const contains = names.filter((name) => name.toLowerCase().includes(needle));
  if (contains.length > 0) return contains.slice(0, 10);
  // No substring hit — fall back to shared-prefix closeness so a typo like
  // "BoxShap3D" still lands near "BoxShape3D".
  const prefixLen = (name: string): number => {
    const lower = name.toLowerCase();
    let i = 0;
    while (i < lower.length && i < needle.length && lower[i] === needle[i]) i++;
    return i;
  };
  return names
    .map((name) => ({ name, score: prefixLen(name) }))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ name }) => name);
}

/** Resolve a class (case-insensitive) and optionally a single member across
 *  properties/methods/signals/constants. Never throws for a missing bundle. */
export function lookupApiDocs(className: string, member?: string): Record<string, unknown> {
  if (!isApiDocsBundleInstalled()) {
    return {
      ok: false,
      failure_reason: "api_docs_not_installed",
      error: API_DOCS_NOT_INSTALLED,
    };
  }
  const docs = loadApiDocs();
  const canonical = apiDocsIndex!.get(className.trim().toLowerCase());
  if (!canonical) {
    return {
      ok: false,
      error: `Unknown class "${className}".`,
      suggestions: suggestClasses(className.trim()),
      hint: "Class names are exact engine class names, e.g. 'BoxShape3D', 'CharacterBody3D'.",
    };
  }
  // Stamp every successful lookup with the technical base the reference was
  // generated from, so version-sensitive answers name their source.
  const base = docs.technical_base ? { technical_base: docs.technical_base } : {};

  const entry = docs.classes[canonical]!;
  if (!member) {
    return { ok: true, class: canonical, ...base, ...entry };
  }

  const needle = member.trim().toLowerCase();
  const property = entry.properties?.find((p) => p.name.toLowerCase() === needle);
  const method = entry.methods?.find((m) => m.sig.toLowerCase().startsWith(needle + "("));
  const signal = entry.signals?.find((s) => s.sig.toLowerCase().startsWith(needle + "("));
  const constant = entry.constants?.find((c) => c.name.toLowerCase() === needle);
  if (property || method || signal || constant) {
    return {
      ok: true,
      class: canonical,
      ...base,
      inherits: entry.inherits,
      ...(property ? { property } : {}),
      ...(method ? { method } : {}),
      ...(signal ? { signal } : {}),
      ...(constant ? { constant } : {}),
    };
  }

  const memberNames = [
    ...(entry.properties ?? []).map((p) => p.name),
    ...(entry.methods ?? []).map((m) => m.sig.split("(")[0]!),
    ...(entry.signals ?? []).map((s) => s.sig.split("(")[0]!),
    ...(entry.constants ?? []).map((c) => c.name),
  ];
  const close = memberNames.filter((name) => name.toLowerCase().includes(needle)).slice(0, 10);
  return {
    ok: false,
    error: `Class ${canonical} has no member "${member}".`,
    suggestions: close,
    hint: entry.inherits
      ? `Members are not inherited into this entry — also check the parent class ${entry.inherits}.`
      : undefined,
  };
}
