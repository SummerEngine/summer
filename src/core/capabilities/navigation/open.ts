/**
 * `summer open` / `summer_open` — one behavior, two faces (CONTRACT §3).
 *
 * Resolve a target (id, intent phrase, res:// path or summerengine.com path)
 * against the product map (./targets.ts), then either open it — the browser
 * for web targets (through /login?returnUrl= when login is required and the
 * CLI is not logged in), the running Summer Engine via the local API for
 * editor targets — or, with `open: false`, return what would open without
 * opening.
 *
 * Editor targets are FORWARDED, not implemented here: when the engine
 * advertises `capabilities.navigation` the tool sends the one-table op
 * `Navigate { target, ...args }`; on an engine that predates it the few ids the
 * original ops can serve (scene, node, script, file, the three docks) use those
 * ops and everything else answers `engine_lacks_op`. See NAVIGATION-PLAN.md.
 *
 * Both faces call runOpen(); the CLI (tool-dispatch + `summer open`) and the
 * MCP tool (src/mcp/tools/navigation-tools.ts) only differ in how the engine
 * client and the browser launcher are supplied.
 */
import { z } from "zod";
import type { EngineCapabilities } from "../../capability-skew.js";
import { extractOpError } from "../engine-receipt.js";
import {
  NAV_TARGETS,
  WEB_CATALOG,
  getNavTarget,
  type EditorTargetMeta,
  type NavParam,
  type NavSurface,
  type NavTarget,
} from "./targets.js";

export type OpenSurface = "auto" | NavSurface;

/** The ONE argument shape both faces validate with (mirrors
 *  library/tools/open/resource.yaml input_schema; parity-tested). */
export const openArgsShape = {
  target: z
    .string()
    .optional()
    .describe(
      'Where to go: a target id (billing, my-games, mcp-guide, scene, node, inspector, …), an intent phrase ("change my plan"), a res:// path, or a summerengine.com path ("/pricing"). Omit to list every target.'
    ),
  params: z
    .record(z.string())
    .optional()
    .describe(
      "Slot values for the target: gameId, section, username, version, guide (agent name or guide slug), path (res://…), node, scene, line, col, tab."
    ),
  surface: z
    .enum(["auto", "web", "editor"])
    .optional()
    .describe('Restrict matching to the website or the editor. "auto" (default) considers both.'),
  open: z
    .boolean()
    .optional()
    .describe("Default true: open it. false = resolve only — return the URL or engine op and open nothing (works without the engine and without a browser). The CLI's --print."),
};

export const openArgsSchema = z.object(openArgsShape).strict();

export type OpenArgs = z.infer<typeof openArgsSchema>;

export type OpenAction =
  | "opened"
  | "printed"
  | "listed"
  | "ambiguous"
  | "unsupported"
  | "engine_not_running"
  | "engine_error"
  | "not_found"
  | "invalid_params";

export interface OpenMatch {
  id: string;
  surface: NavSurface;
  title: string;
  score: number;
}

export type EditorAvailability = "available" | "legacy" | "unavailable" | "unknown";

export interface OpenTargetSummary {
  id: string;
  surface: NavSurface;
  title: string;
  description: string;
  requires: NavTarget["requires"];
  params?: readonly NavParam[];
  /** Editor rows: whether the connected engine can open it. `legacy` = served by
   *  a pre-Navigate op; `unknown` = engine not reachable when listing. */
  availability?: EditorAvailability;
}

export interface OpenResult {
  ok: boolean;
  action: OpenAction;
  target?: OpenTargetSummary;
  /** Web: the destination URL. */
  url?: string;
  /** Web: the login deep link when the target requires login. */
  login_url?: string;
  /** Web: whether this CLI holds a Summer login token (a hint; the browser may still ask). */
  logged_in?: boolean;
  /** Web: the URL actually launched (url or login_url). */
  opened_url?: string;
  /** Web: the path was not in the map but is on an allowed origin. */
  unmapped?: boolean;
  /** Editor: the op that was (or would be) sent. */
  op?: Record<string, unknown>;
  /** Editor: engine state. */
  engine?: { running: boolean; version?: string; navigation?: boolean; error?: string };
  /** Editor: the raw engine receipt on success. */
  receipt?: unknown;
  /** Structured failure class for ok:false results (engine_lacks_op, …). */
  failure_reason?: string;
  matches?: OpenMatch[];
  targets?: OpenTargetSummary[];
  hint?: string;
}

/** The slice of the engine client the tool needs (EngineApiClient satisfies it). */
export interface OpenEngineClient {
  executeOps(ops: Array<Record<string, unknown>>): Promise<unknown>;
  getProjectState(prefix?: string): Promise<unknown>;
  getEngineVersion?(): string | undefined;
  getEngineCapabilities?(): EngineCapabilities | undefined;
}

export interface OpenDeps {
  /** Connect to the running engine; MUST throw when it is not reachable. */
  engine(): Promise<OpenEngineClient>;
  openUrl(url: string): Promise<unknown>;
  isLoggedIn(): Promise<boolean>;
  gatewayUrl(): Promise<string>;
  docsOrigin?: string;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "my", "me", "i", "to", "of", "in", "on", "for", "please", "open", "show",
  "go", "page", "want", "up", "take", "it", "is", "do", "how", "can", "you", "where", "with",
  "and", "that", "this", "at", "into", "see", "let", "get", "bring", "our", "your", "im", "am",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok))
    .map((tok) => (tok.length > 3 && tok.endsWith("s") ? tok.slice(0, -1) : tok));
}

function phraseScore(queryTokens: string[], phrase: string): number {
  const phraseTokens = tokenize(phrase);
  if (queryTokens.length === 0 || phraseTokens.length === 0) return 0;
  if (queryTokens.join(" ") === phraseTokens.join(" ")) return 1;
  const phraseSet = new Set(phraseTokens);
  const overlap = queryTokens.filter((tok) => phraseSet.has(tok)).length;
  if (overlap === 0) return 0;
  const coverage = overlap / queryTokens.length;
  const precision = overlap / phraseTokens.length;
  return coverage * (0.7 + 0.3 * precision);
}

function scoreTarget(queryTokens: string[], target: NavTarget): number {
  let best = 0;
  for (const phrase of [target.id.replace(/-/g, " "), target.title, ...target.intents, ...(target.aliases ?? [])]) {
    best = Math.max(best, phraseScore(queryTokens, phrase));
    if (best === 1) break;
  }
  return best;
}

const MIN_SCORE = 0.5;

/** Rank every target for a free-text query. Exported for tests. */
export function rankTargets(query: string, surface: OpenSurface = "auto"): OpenMatch[] {
  const queryTokens = tokenize(query);
  const candidates = NAV_TARGETS.filter((target) => surface === "auto" || target.surface === surface);
  return candidates
    .map((target) => ({
      id: target.id,
      surface: target.surface,
      title: target.title,
      score: round(scoreTarget(queryTokens, target)),
    }))
    .filter((match) => match.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

type Resolution =
  | { kind: "target"; target: NavTarget; params: Record<string, string> }
  | { kind: "url"; url: string }
  | { kind: "ambiguous"; matches: OpenMatch[] }
  | { kind: "not_found"; matches: OpenMatch[]; hint: string };

function resolveResourcePath(path: string, params: Record<string, string>): Resolution {
  const lower = path.toLowerCase();
  const id = lower.endsWith(".tscn") || lower.endsWith(".scn") ? "scene" : lower.endsWith(".gd") || lower.endsWith(".cs") ? "script" : "file";
  return { kind: "target", target: getNavTarget(id)!, params: { ...params, path } };
}

function resolveWebPath(path: string, params: Record<string, string>): Resolution {
  const wanted = path.replace(/\/+$/, "") || "/";
  for (const target of NAV_TARGETS) {
    if (!target.web || target.web.origin !== "gateway") continue;
    const literal = target.web.path.replace(/\[\/\{[a-zA-Z]+\}\]/g, "");
    if (literal.includes("{")) continue;
    if (literal.replace(/\/+$/, "") === wanted || literal === wanted) {
      return { kind: "target", target, params };
    }
  }
  return { kind: "url", url: path };
}

export function resolveTarget(rawTarget: string, params: Record<string, string>, surface: OpenSurface): Resolution {
  const raw = rawTarget.trim();
  if (raw.startsWith("res://")) return resolveResourcePath(raw, params);
  if (raw.startsWith("/") && !raw.startsWith("//")) return resolveWebPath(raw, params);

  const direct = getNavTarget(raw.toLowerCase().replace(/\s+/g, "-"));
  if (direct && (surface === "auto" || direct.surface === surface)) {
    return { kind: "target", target: direct, params };
  }

  const matches = rankTargets(raw, surface);
  if (matches.length === 0) {
    return {
      kind: "not_found",
      matches,
      hint: `No destination matches "${raw}". Run 'summer open --list' (or call summer_open with no target) to see every target, or pass a res:// path or a summerengine.com path.`,
    };
  }
  const [top, second] = matches;
  const clear =
    top!.score >= 0.999
      ? !second || second.score < 0.999
      : top!.score >= 0.6 && (!second || top!.score - second.score >= 0.25);
  if (clear) return { kind: "target", target: getNavTarget(top!.id)!, params };
  return { kind: "ambiguous", matches: matches.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function summarize(target: NavTarget, availability?: EditorAvailability): OpenTargetSummary {
  return {
    id: target.id,
    surface: target.surface,
    title: target.title,
    description: target.description,
    requires: target.requires,
    ...(target.params ? { params: target.params } : {}),
    ...(availability ? { availability } : {}),
  };
}

class ParamError extends Error {}

function normalizeParam(param: NavParam, value: string): string {
  const clean = value.trim();
  if (!param.values) return clean;
  const lower = clean.toLowerCase();
  if ((param.values as readonly string[]).includes(lower)) return lower;
  const alias = param.valueAliases?.[lower];
  if (alias) return alias;
  throw new ParamError(
    `${param.name} must be one of: ${param.values.join(", ")}` +
      (param.valueAliases ? ` (or an alias: ${Object.keys(param.valueAliases).join(", ")})` : "")
  );
}

/** Fill a web path template. `{slot}` required, `[/{slot}]` optional. */
export function renderWebPath(template: string, params: Record<string, string>, declared: readonly NavParam[] = []): string {
  const byName = new Map(declared.map((param) => [param.name, param]));
  const lookup = (name: string): string | undefined => {
    const value = params[name];
    if (value === undefined || value === "") return undefined;
    const param = byName.get(name);
    return param ? normalizeParam(param, value) : value.trim();
  };
  let out = template.replace(/\[\/\{([a-zA-Z]+)\}\]/g, (_m, name: string) => {
    const value = lookup(name);
    return value === undefined ? "" : `/${encodeURIComponent(value)}`;
  });
  out = out.replace(/\{([a-zA-Z]+)\}/g, (_m, name: string) => {
    const value = lookup(name);
    if (value === undefined) throw new ParamError(`Missing required param: ${name}`);
    return encodeURIComponent(value);
  });
  return out;
}

function requireParams(meta: EditorTargetMeta, params: Record<string, string>): void {
  for (const param of meta.params ?? []) {
    if (param.required && (params[param.name] === undefined || params[param.name] === "")) {
      throw new ParamError(`Missing required param: ${param.name}`);
    }
  }
}

/** Numeric args (line, col) travel as numbers; everything else as trimmed strings. */
function argValue(name: string, value: string): string | number {
  const trimmed = value.trim();
  return (name === "line" || name === "col") && /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : trimmed;
}

/** The one-table op: Navigate { target, ...args }. */
export function buildNavigateOp(meta: EditorTargetMeta, params: Record<string, string>): Record<string, unknown> {
  const op: Record<string, unknown> = { op: "Navigate", target: meta.navigate.target, ...(meta.navigate.fixed ?? {}) };
  for (const [paramName, argName] of Object.entries(meta.navigate.map ?? {})) {
    const value = params[paramName];
    if (value !== undefined && value !== "") op[argName] = argValue(argName, value);
  }
  return op;
}

/** The pre-Navigate op for engines that predate the table (only some rows have one). */
export function buildLegacyOp(meta: EditorTargetMeta, params: Record<string, string>): Record<string, unknown> | null {
  if (!meta.legacy) return null;
  const op: Record<string, unknown> = { op: meta.legacy.op, ...(meta.legacy.fixed ?? {}) };
  for (const [paramName, field] of Object.entries(meta.legacy.map ?? {})) {
    const value = params[paramName];
    if (value !== undefined && value !== "") op[field] = value.trim();
  }
  return op;
}

function mainSceneFrom(projectState: unknown): string | null {
  const root = (projectState ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const entries = data.entries;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const item = (entry ?? {}) as Record<string, unknown>;
      if (item.key === "application/run/main_scene" || item.key === "run/main_scene") {
        return typeof item.value === "string" && item.value.length > 0 ? item.value : null;
      }
    }
  }
  for (const key of ["mainScene", "main_scene", "mainScenePath", "main_scene_path"]) {
    const value = data[key] ?? root[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Which ids the connected engine can open. undefined = engine predates the advert. */
export function advertisedNavigation(client: OpenEngineClient): Set<string> | undefined {
  const targets = client.getEngineCapabilities?.()?.navigation?.targets;
  return targets ? new Set(targets.map((t) => t.id)) : undefined;
}

export function editorAvailability(meta: EditorTargetMeta, advertised: Set<string> | undefined): EditorAvailability {
  if (advertised) return advertised.has(meta.navigate.target) ? "available" : "unavailable";
  return meta.legacy ? "legacy" : "unavailable";
}

export function listTargets(surface: OpenSurface = "auto", advertised?: Set<string> | undefined | "unknown"): OpenTargetSummary[] {
  return NAV_TARGETS.filter((target) => surface === "auto" || target.surface === surface).map((target) =>
    target.editor
      ? summarize(target, advertised === "unknown" ? "unknown" : editorAvailability(target.editor, advertised))
      : summarize(target)
  );
}

// ---------------------------------------------------------------------------
// The behavior
// ---------------------------------------------------------------------------

export async function runOpen(args: OpenArgs, deps: OpenDeps): Promise<OpenResult> {
  const surface: OpenSurface = args.surface ?? "auto";
  const params = args.params ?? {};
  const print = args.open === false;
  const docsOrigin = deps.docsOrigin ?? WEB_CATALOG.docsBase;

  if (!args.target || args.target.trim() === "") {
    let advertised: Set<string> | undefined | "unknown" = "unknown";
    if (surface !== "web") {
      try {
        advertised = advertisedNavigation(await deps.engine());
      } catch {
        advertised = "unknown";
      }
    }
    return {
      ok: true,
      action: "listed",
      targets: listTargets(surface, advertised),
      hint:
        "Pass a target id, an intent phrase, a res:// path, or a summerengine.com path. Editor availability comes from the connected engine: available = Navigate op; legacy = served by an older op; unavailable = update Summer Engine; unknown = engine not running.",
    };
  }

  const gateway = (await deps.gatewayUrl()).replace(/\/+$/, "");

  // A full URL is accepted only on the two origins this tool ever opens; the
  // path is then resolved like a summerengine.com path.
  let rawTarget = args.target.trim();
  if (/^https?:\/\//i.test(rawTarget)) {
    let parsed: URL;
    try {
      parsed = new URL(rawTarget);
    } catch {
      return { ok: false, action: "not_found", hint: `"${rawTarget}" is not a valid URL.` };
    }
    const sameGateway = parsed.origin === gateway || parsed.origin.replace("://www.", "://") === gateway.replace("://www.", "://");
    if (parsed.origin === docsOrigin) {
      const url = `${docsOrigin}${parsed.pathname}${parsed.search}`;
      if (print) return { ok: true, action: "printed", url, unmapped: true };
      await deps.openUrl(url);
      return { ok: true, action: "opened", url, opened_url: url, unmapped: true };
    }
    if (!sameGateway) {
      return {
        ok: false,
        action: "not_found",
        hint: `summer_open only opens ${gateway} and ${docsOrigin}; "${parsed.origin}" is not a Summer destination.`,
      };
    }
    rawTarget = `${parsed.pathname}${parsed.search}`;
  }

  const resolution = resolveTarget(rawTarget, params, surface);

  if (resolution.kind === "not_found") {
    return { ok: false, action: "not_found", matches: resolution.matches, hint: resolution.hint };
  }
  if (resolution.kind === "ambiguous") {
    return {
      ok: false,
      action: "ambiguous",
      matches: resolution.matches,
      hint: `"${args.target}" matches several destinations. Call again with one of the ids listed in matches.`,
    };
  }
  if (resolution.kind === "url") {
    const url = `${gateway}${resolution.url}`;
    const base: OpenResult = {
      ok: true,
      action: print ? "printed" : "opened",
      url,
      unmapped: true,
      hint: "This path is not in the product map; it was opened on the Summer gateway origin as given.",
    };
    if (print) return base;
    await deps.openUrl(url);
    return { ...base, opened_url: url };
  }

  const { target } = resolution;

  // ---- web -----------------------------------------------------------------
  if (target.web) {
    const summary = summarize(target);
    let path: string;
    try {
      path = renderWebPath(target.web.path, resolution.params, target.params);
    } catch (error) {
      if (error instanceof ParamError) return { ok: false, action: "invalid_params", target: summary, hint: error.message };
      throw error;
    }
    const origin = target.web.origin === "docs" ? docsOrigin : gateway;
    const url = `${origin}${path}`;
    const needsLogin = target.requires.login === true && target.web.origin === "gateway";
    const loggedIn = needsLogin ? await deps.isLoggedIn() : undefined;
    const loginUrl = needsLogin
      ? `${gateway}${WEB_CATALOG.login.path}?${WEB_CATALOG.login.returnParam}=${encodeURIComponent(path)}`
      : undefined;
    const result: OpenResult = {
      ok: true,
      action: print ? "printed" : "opened",
      target: summary,
      url,
      ...(loginUrl ? { login_url: loginUrl } : {}),
      ...(loggedIn !== undefined ? { logged_in: loggedIn } : {}),
    };
    if (print) return result;
    const toOpen = needsLogin && loggedIn === false ? loginUrl! : url;
    await deps.openUrl(toOpen);
    return {
      ...result,
      opened_url: toOpen,
      ...(needsLogin && loggedIn === false
        ? { hint: "Not logged in on this machine, so the login page was opened with returnUrl set; the destination loads after sign-in." }
        : {}),
    };
  }

  // ---- editor: forward to the engine's table -------------------------------
  const meta = target.editor!;
  try {
    requireParams(meta, resolution.params);
  } catch (error) {
    if (error instanceof ParamError) return { ok: false, action: "invalid_params", target: summarize(target), hint: error.message };
    throw error;
  }

  let client: OpenEngineClient;
  try {
    client = await deps.engine();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const navigateOp = buildNavigateOp(meta, resolution.params);
    if (meta.mainSceneDefault && navigateOp.path === undefined) navigateOp.path = "<application/run/main_scene>";
    const summary = summarize(target, meta.legacy ? "legacy" : "unknown");
    if (print) {
      return { ok: true, action: "printed", target: summary, op: navigateOp, engine: { running: false, error: message } };
    }
    return {
      ok: false,
      action: "engine_not_running",
      target: summary,
      op: navigateOp,
      engine: { running: false, error: message },
      hint: `Summer Engine is not running (or no project is open), so nothing was opened. Start it with 'summer run <project>' or open the project in the Summer desktop app, then retry. What would open: ${target.title} — ${target.description}`,
    };
  }

  const version = client.getEngineVersion?.();
  const advertised = advertisedNavigation(client);
  const availability = editorAvailability(meta, advertised);
  const summary = summarize(target, availability);
  const engine = { running: true, version, navigation: advertised !== undefined };

  if (availability === "unavailable") {
    const navigateOp = buildNavigateOp(meta, resolution.params);
    return {
      ok: false,
      action: "unsupported",
      target: summary,
      op: navigateOp,
      engine,
      failure_reason: "engine_lacks_op",
      hint: advertised
        ? `This Summer Engine build (${version ?? "unknown version"}) has the Navigate op but does not advertise the "${meta.navigate.target}" destination. Update Summer Engine; until then tell the user what to open by hand: ${target.title}.`
        : `This Summer Engine build (${version ?? "unknown version"}) predates the Navigate op, and "${target.id}" has no legacy equivalent. Update Summer Engine (restart it after updating); until then tell the user what to open by hand: ${target.title}.`,
    };
  }

  const op = availability === "legacy" ? buildLegacyOp(meta, resolution.params)! : buildNavigateOp(meta, resolution.params);

  if (meta.mainSceneDefault && op.path === undefined) {
    const mainScene = mainSceneFrom(await client.getProjectState("application/"));
    if (!mainScene) {
      return {
        ok: false,
        action: "engine_error",
        target: summary,
        op,
        engine,
        hint: "The project has no application/run/main_scene configured. Pass params.path with an explicit res://…tscn.",
      };
    }
    op.path = mainScene;
  }

  if (print) return { ok: true, action: "printed", target: summary, op, engine };

  const receipt = await client.executeOps([op]);
  const failure = extractOpError(receipt);
  if (failure) {
    return { ok: false, action: "engine_error", target: summary, op, engine, receipt, hint: failure };
  }
  return { ok: true, action: "opened", target: summary, op, engine, receipt };
}
