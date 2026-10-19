/**
 * The extra fields a usage line (telemetry.ts, cli-usage.ts) can carry. Each
 * is a closed shape checked here, so nothing a person typed, no path and no
 * project or file name can reach one:
 *
 * - `projectIdHash`: the engine's own project id hash (sha256 of the random
 *   id Summer Engine keeps in `.summer/local/.project_id`), the same value
 *   Summer already uses to route requests to a project. Not the name or path.
 * - `templateId`, `templateTags`: the library template a project started
 *   from (`.summer/project.json`) and that template's library domains
 *   (`facets.domains`, e.g. `2d`, `platformer`). Only ids from the shipped
 *   catalog; anything else is left out.
 * - `instanceCount`: how many game clients `engine.play` started.
 * - `engineState`: four yes/no answers when a call failed with
 *   `engine_not_running` (is the app installed, is an editor running, is one
 *   holding a project, is the person signed in), from local files only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { currentToolContext } from "./agent-host.js";
import { hasEnvAuthToken } from "./auth.js";
import { listEngineInstances } from "./engine.js";
import { findEngineBinary } from "./engine-install.js";
import { loadLibraryIndex } from "./library-search.js";
import { getSummerDir } from "./store.js";
import { getTemplateRegistry } from "./templates.js";
import { readProjectManifest } from "../project-memory/project-manifest.js";

export interface UsageFields {
  projectIdHash?: string;
  templateId?: string;
  templateTags?: string[];
  instanceCount?: number;
}

export interface EngineState {
  desktopInstalled: boolean;
  engineRunning: boolean;
  projectOpen: boolean;
  signedIn: boolean;
}

const HASH = /^[0-9a-f]{16,128}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TAGS = 8;

/** Only the closed shapes above survive; everything else is dropped. */
export function cleanUsageFields(fields: Record<string, unknown>): UsageFields {
  const out: UsageFields = {};
  if (typeof fields.projectIdHash === "string" && HASH.test(fields.projectIdHash)) out.projectIdHash = fields.projectIdHash;
  if (typeof fields.templateId === "string" && SLUG.test(fields.templateId)) out.templateId = fields.templateId;
  if (Array.isArray(fields.templateTags)) {
    const tags = fields.templateTags.filter((tag): tag is string => typeof tag === "string" && SLUG.test(tag)).slice(0, MAX_TAGS);
    if (tags.length) out.templateTags = tags;
  }
  if (typeof fields.instanceCount === "number" && Number.isInteger(fields.instanceCount) && fields.instanceCount >= 0 && fields.instanceCount <= 64) {
    out.instanceCount = fields.instanceCount;
  }
  return out;
}

// One command per CLI process: its line reads these at exit (cli-usage.ts).
let processNotes: UsageFields = {};
let boundProjectIdHash: string | undefined;

/** A tool or command noted fields for its usage line; never throws. */
export function noteToolUsage(fields: UsageFields): void {
  try {
    const clean = cleanUsageFields(fields as Record<string, unknown>);
    const context = currentToolContext();
    if (context) Object.assign(context.usage, clean);
    Object.assign(processNotes, clean);
  } catch {
    // usage is best-effort
  }
}

/** The fields noted in this process (the CLI line), with the bound project. */
export function processUsageFields(): UsageFields {
  return { ...(boundProjectIdHash ? { projectIdHash: boundProjectIdHash } : {}), ...processNotes };
}

/** The engine connection bound this project (api-client.ts connect and rebind). */
export function noteBoundProject(projectIdHash: string | undefined): void {
  boundProjectIdHash = typeof projectIdHash === "string" && HASH.test(projectIdHash) ? projectIdHash : undefined;
}

export function boundProject(): string | undefined {
  return boundProjectIdHash;
}

/** The library slug for a catalog template id or slug, else null. */
export function catalogTemplateSlug(idOrSlug: string): string | null {
  try {
    const entry = getTemplateRegistry().find((template) => template.id === idOrSlug || template.slug === idOrSlug);
    return entry ? entry.slug : null;
  } catch {
    return null;
  }
}

/** A catalog template's library domains (`facets.domains`), e.g. ["2d", "platformer"]. */
export function templateTags(slug: string): string[] {
  try {
    const entry = loadLibraryIndex().find((resource) => resource.id === `template/${slug}`);
    return (entry?.facets?.domains ?? []).filter((tag) => SLUG.test(tag)).slice(0, MAX_TAGS);
  } catch {
    return [];
  }
}

const templateByHash = new Map<string, string | null>();

/**
 * The catalog template the project with this hash started from: the running
 * editor's registry entry gives its folder, `.summer/project.json` the
 * template. Cached per hash; null when unknown or not a catalog template.
 */
export async function templateForProject(projectIdHash: string): Promise<string | null> {
  if (templateByHash.has(projectIdHash)) return templateByHash.get(projectIdHash) ?? null;
  let slug: string | null = null;
  try {
    const instance = (await listEngineInstances()).find((entry) => entry.projectIdHash === projectIdHash);
    const id = instance ? readProjectManifest(instance.resourceRoot)?.template?.id : undefined;
    slug = typeof id === "string" ? catalogTemplateSlug(id) : null;
  } catch {
    slug = null;
  }
  templateByHash.set(projectIdHash, slug);
  return slug;
}

/** What is true on this machine when the engine could not be reached. Local files only. */
export async function engineState(): Promise<EngineState> {
  const instances = await listEngineInstances(Date.now(), getSummerDir(), { anyHeartbeat: true }).catch(() => []);
  return {
    desktopInstalled: findEngineBinary() !== null,
    engineRunning: instances.length > 0,
    projectOpen: instances.some((instance) => !!instance.projectIdHash),
    signedIn: hasEnvAuthToken() || existsSync(join(getSummerDir(), "auth-token")),
  };
}

/**
 * The extra fields of one usage line: what the call noted, else the bound
 * project and its template, and the engine state for engine_not_running.
 * Never throws.
 */
export async function usageLineFields(noted: UsageFields, error?: string | null): Promise<Record<string, unknown>> {
  try {
    const fields = cleanUsageFields(noted as Record<string, unknown>);
    if (fields.projectIdHash && !fields.templateId) {
      const template = await templateForProject(fields.projectIdHash);
      if (template) fields.templateId = template;
    }
    return { ...fields, ...(error === "engine_not_running" ? { engineState: await engineState() } : {}) };
  } catch {
    return {};
  }
}

/** Test-only: forget notes, the bound project and the template cache. */
export function _resetUsageFieldsForTests(): void {
  processNotes = {};
  boundProjectIdHash = undefined;
  templateByHash.clear();
}
