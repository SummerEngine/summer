import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../package-root.js";
import type { CatalogEntry } from "./catalog.js";
import { CONTRACT_VERSION, isLocalOp, type Approval, type Effect } from "./contract.js";
import { withOutField } from "./save-files.js";

/**
 * The hosted Summer server's public operation catalog, shipped in this
 * package: registry/operations/public-catalog.json, a byte copy of the
 * server's own file (`npm run sync:catalog`; `-- --check` fails when it is
 * behind). Search and describe list every cloud operation from it with no
 * sign-in; a signed-in search lays the server's live rows over it.
 */

const PUBLIC_CATALOG_FILE = join("registry", "operations", "public-catalog.json");

export interface PublicOperation {
  name: string;
  title: string;
  summary: string;
  effect: Effect;
  approval: Approval;
  permission: string;
  provider: "cloud";
  auth: string;
  status: "stable" | "preview" | "deprecated";
  since: string;
  mcpTool: string;
  direct: string[];
  idempotencyKey?: "required" | "optional";
  job?: { typicalSeconds: number };
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  legacy?: string[];
  tags?: string[];
  examples: Array<{ input: Record<string, unknown>; note: string }>;
  deprecated?: { replacedBy: string; after: string };
}

export interface PublicCatalog {
  contract: number;
  operations: PublicOperation[];
  /** The operations the server leaves to this package (engine and local ones), with their 3.x names. */
  localOperations: Array<{ name: string; legacy: string[] }>;
}

let catalogCache: PublicCatalog | null = null;

export function publicCatalog(): PublicCatalog {
  if (catalogCache) return catalogCache;
  try {
    catalogCache = JSON.parse(readFileSync(join(PACKAGE_ROOT, PUBLIC_CATALOG_FILE), "utf8")) as PublicCatalog;
  } catch {
    catalogCache = { contract: CONTRACT_VERSION, operations: [], localOperations: [] };
  }
  return catalogCache;
}

/** The cloud operations as search rows; the ones that save files show `out` in their input. */
export function shippedCloudEntries(): CatalogEntry[] {
  return publicCatalog()
    .operations.filter((op) => !isLocalOp(op.name))
    .map((op) => ({
      name: op.name,
      title: op.title,
      summary: op.summary,
      effect: op.effect,
      approval: op.approval,
      provider: "cloud",
      status: op.status,
      available: true,
      ...(op.tags?.length ? { tags: op.tags } : {}),
      ...(op.legacy?.length ? { legacy: op.legacy } : {}),
      input: withOutField(op.name, op.input) as Record<string, unknown>,
    }));
}

/** The catalog's title of an operation, for the local ones it lists too. */
export function shippedTitle(op: string): string | undefined {
  return publicCatalog().operations.find((candidate) => candidate.name === op)?.title;
}

/** One cloud operation as ops.describe answers it, from the shipped catalog; null when it has no such row. */
export function shippedWireForm(op: string): Record<string, unknown> | null {
  const found = publicCatalog().operations.find((candidate) => candidate.name === op);
  if (!found || isLocalOp(op)) return null;
  // `direct` names the hosted profiles that list it as a tool; it says nothing here.
  const { direct: _direct, ...wire } = found;
  return { contract: CONTRACT_VERSION, ...wire, input: withOutField(op, found.input), needsSignIn: true };
}
