import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../package-root.js";
import { readStoreJson, writeStoreJson } from "../store.js";
import { validateSchema, type JsonSchema, type SchemaIssue } from "./schema.js";

/**
 * The Summer Router registry (summer-platform contracts/summer-router/
 * registry.json) is the one source for character and settings schemas, error
 * tags and limit keys. The CLI reads it live from the management API
 * (GET router/registry), keeps the last copy in ~/.summer/router-registry.json,
 * and falls back to the copy bundled in assets/router/registry.json, so
 * `summer router push --dry-run` works offline and without a sign-in.
 */

export interface RegistryError {
  tag: string;
  http_status: number;
  retryable: boolean;
  fix: string;
  studio_url?: string;
}

export interface RouterRegistry {
  registry: string;
  version: number;
  limit_keys: Array<{ id: string; title: string; window: string; setting: string }>;
  errors: RegistryError[];
  schemas: { character: JsonSchema; settings: JsonSchema };
}

export type RegistrySource = "live" | "cache" | "bundled";

export const REGISTRY_CACHE_FILE = "router-registry.json";
export const BUNDLED_REGISTRY_PATH = join(PACKAGE_ROOT, "assets", "router", "registry.json");
export const DOCS_BASE = "https://docs.summerengine.com/router";

export function isRegistry(value: unknown): value is RouterRegistry {
  const doc = value as RouterRegistry | null;
  return Boolean(
    doc &&
      doc.registry === "summer-router" &&
      typeof doc.version === "number" &&
      doc.schemas?.character &&
      typeof doc.schemas.character === "object" &&
      Array.isArray(doc.errors)
  );
}

export function bundledRegistry(path = BUNDLED_REGISTRY_PATH): RouterRegistry {
  const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRegistry(doc)) throw new Error(`${path} is not a Summer Router registry.`);
  return doc;
}

/** Live (and cache it), else the cached copy, else the bundled copy. */
export async function loadRegistry(
  fetchLive: (() => Promise<unknown>) | null
): Promise<{ registry: RouterRegistry; source: RegistrySource }> {
  if (fetchLive) {
    try {
      const live = await fetchLive();
      if (isRegistry(live)) {
        await writeStoreJson(REGISTRY_CACHE_FILE, live).catch(() => undefined);
        return { registry: live, source: "live" };
      }
    } catch {
      // offline, signed out or not served yet: use a copy
    }
  }
  const cached = await readStoreJson<unknown>(REGISTRY_CACHE_FILE).catch(() => null);
  if (isRegistry(cached)) return { registry: cached, source: "cache" };
  return { registry: bundledRegistry(), source: "bundled" };
}

export function validateCharacter(doc: unknown, registry: RouterRegistry): SchemaIssue[] {
  return validateSchema(doc, registry.schemas.character);
}

export function validateSettings(doc: unknown, registry: RouterRegistry): SchemaIssue[] {
  return validateSchema(doc, registry.schemas.settings);
}

export function errorDocsUrl(tag: string): string {
  return `${DOCS_BASE}/errors#${tag}`;
}

export function registryError(registry: RouterRegistry, tag: string): RegistryError | undefined {
  return registry.errors.find((entry) => entry.tag === tag);
}
