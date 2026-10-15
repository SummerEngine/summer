import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getAuthToken } from "../auth.js";
import { resolveGatewayUrl } from "../config.js";
import { summerRequestHeaders } from "../agent-host.js";
import { codedFailure, describeNetworkError, networkDetails, NOT_SIGNED_IN, SIGN_IN_AGAIN_RECOVERY } from "../error-codes.js";

/**
 * Summer Apps (summer_app_*): tools a game team uses inside Summer Studio,
 * built by agents. Every cloud tool here calls the Summer web API under
 * /api/mcp/apps with the signed-in Summer account; summer_app_dock asks the
 * running editor to dock an app (engine ops OpenAppDock / CloseAppDock /
 * ListAppDocks).
 *
 * One implementation for both faces: the MCP tools (src/mcp/tools/app-tools.ts)
 * and `summer tool app-*` (tool-dispatch.ts) share the schemas and functions
 * here and pass their own client surface.
 */

export const APPS_ENDPOINT = "/api/mcp/apps";
/** The server's long-poll ceiling for summer_app_events. */
export const MAX_APP_EVENTS_WAIT_SECONDS = 50;
export const APP_GUIDE_SECTIONS = ["all", "overview", "manifest", "sdk", "kit", "layout", "design", "examples", "types"] as const;
export const APP_DOCK_SLOTS = ["left", "right", "bottom"] as const;

/** Bundle limits the server enforces (checked here first for a clear local error). */
const MAX_FILES = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".txt", ".md", ".svg", ".gltf"]);

const appId = z.string().uuid().describe("The app id from summer_app_create or summer_app_list");
const jsonObject = z.record(z.unknown());

export const appGuideArgsSchema = z.object({
  section: z
    .enum(APP_GUIDE_SECTIONS)
    .default("overview")
    .describe("Start with overview (the default), then read what the app needs: examples (a working app to copy), sdk, manifest, kit, design, layout, types (exact SDK TypeScript types). all returns every section but types (about 100 KB)"),
});

export const appListArgsSchema = z.object({
  workspaceId: z.string().uuid().optional().describe("Only this workspace (team). Default: every workspace the person is in"),
  q: z.string().max(200).optional().describe("Search app names and purposes"),
});

export const appCreateArgsSchema = z.object({
  name: z.string().min(1).max(80),
  purpose: z.string().max(280).optional().describe("One line: what the tool does and where its data goes"),
  format: z.enum(["code", "layout"]).default("code").describe("code: index.html + JS/CSS (default). layout: a JSON layout of kit nodes, for quick decision UIs"),
  workspaceId: z.string().uuid().optional().describe("A workspace id. Default: the person's team (the one their Studio tab is on, else their latest team, else personal); the result's workspace says which"),
  folder: z.string().min(1).max(80).optional(),
});

export const appPublishArgsSchema = z.object({
  appId,
  dir: z
    .string()
    .min(1)
    .optional()
    .describe("A local folder holding the app (index.html at its root). Every file under it is published; dotfiles, node_modules and .d.ts files are skipped"),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(200),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      })
    )
    .max(MAX_FILES)
    .optional()
    .describe("The files instead of dir: [{path, content, encoding}]"),
  layout: jsonObject.optional().describe("Layout apps: { version: 1, title, root }"),
  manifest: jsonObject.describe("The manifest {name, purpose, permissions, engineFiles, agentEvents, agentTools} (summer_app_guide section manifest)"),
  note: z.string().max(500).optional().describe("What changed, shown in the version list"),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const appGetArgsSchema = z.object({ appId });

export const appEventsArgsSchema = z.object({
  appId,
  after: z.number().int().min(0).default(0).describe("Return events after this cursor (0: from the start). Pass the returned cursor next time"),
  timeoutSeconds: z.number().int().min(0).max(MAX_APP_EVENTS_WAIT_SECONDS).default(25).describe("Wait up to this long (max 50) for the first new event"),
  kinds: z.array(z.enum(["agent", "error", "feedback", "tool"])).max(4).optional().describe("Default: agent, error, feedback"),
});

export const appPageArgsSchema = z.object({
  appId,
  fill: z
    .array(z.object({ field: z.string().min(1).max(200), value: z.union([z.string().max(10_000), z.number(), z.boolean()]) }))
    .max(50)
    .optional()
    .describe("Values to set: [{field, value}] with field ids from a read"),
  press: z.string().min(1).max(200).optional().describe("An action id to press after filling"),
});

export const appUpdateArgsSchema = z.object({
  appId,
  name: z.string().min(1).max(80).optional(),
  purpose: z.string().max(280).optional(),
  status: z.enum(["scratch", "kept", "archived"]).optional().describe("kept: the team keeps it. archived: hidden from the app list (restore with scratch or kept)"),
  folder: z.string().min(1).max(80).nullable().optional().describe("null takes it out of its folder"),
});

export const appScreenshotArgsSchema = z.object({
  appId,
  version: z.number().int().positive().optional().describe("A published version. Default: the current one"),
  width: z.number().int().min(320).max(1920).default(1280).describe("Viewport width in px: 390 for a phone"),
  height: z.number().int().min(320).max(1600).default(800),
  theme: z.enum(["light", "dark"]).default("light"),
  fullPage: z.boolean().default(false).describe("Capture the whole scroll height (up to 4000 px)"),
  params: z.record(z.string().max(500)).optional().describe("Launch params, as in /studio/apps/<id>?key=value"),
  steps: z
    .array(z.object({ click: z.string().max(300).optional(), press: z.string().max(40).optional(), wait: z.number().int().min(0).max(3000).optional() }))
    .max(5)
    .optional()
    .describe('Before the capture, in order: click a CSS selector in the app (">>>" reaches inside kit components), press a declared action id, or wait ms. Use it to see a dialog or a second state'),
  out: z.string().min(1).optional().describe("Also save the PNG to this local path"),
});

export const appDataArgsSchema = z.object({
  appId,
  collection: z.string().max(48).optional().describe("Read: one collection. Default: all"),
  after: z.string().max(200).optional().describe("Read: the next cursor from the previous page"),
  limit: z.number().int().min(1).max(500).default(200),
  ops: z
    .array(jsonObject)
    .min(1)
    .max(100)
    .optional()
    .describe("Write: [{op: put, collection, recordId, data}, {op: patch, collection, recordId, patch}, {op: remove, collection, recordId}]; ifRevision on an op applies it only at that record revision (0: must not exist)"),
  as: z.enum(["agent", "seed"]).optional().describe("Write: seed for starter data that belongs to the team (no author). Default: agent"),
});

export const appToolsArgsSchema = z.object({ appId });

export const appCallArgsSchema = z.object({
  appId,
  tool: z.string().min(1).max(64).describe("The agent tool name from summer_app_tools"),
  input: jsonObject.default({}).describe("Input matching the tool's input schema"),
});

export const appReportGapArgsSchema = z.object({
  capability: z.string().min(1).max(200).describe('What the app needed, e.g. "read Steam reviews"'),
  detail: z.string().max(2000).optional(),
  method: z.string().max(100).optional().describe("The SDK method name you wished existed"),
  appId: appId.optional(),
});

export const appDockArgsSchema = z.object({
  action: z.enum(["open", "close", "list"]).default("open"),
  appId: appId.optional().describe("open, close: the app"),
  slot: z.enum(APP_DOCK_SLOTS).default("right").describe("open: left, right or bottom"),
});

// ---------------------------------------------------------------------------
// The web API
// ---------------------------------------------------------------------------

export interface AppsReply {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

export interface AppsDeps {
  request(method: "GET" | "POST", endpoint: string, init: { query?: URLSearchParams; body?: unknown; timeoutMs: number }): Promise<AppsReply>;
  readDir?: (dir: string) => Promise<Array<{ path: string; content: string; encoding: "utf8" | "base64" }>>;
}

/** Fetch with the Summer account token; errors come back as replies, never throws. */
export function appsGateway(surface: "mcp" | "cli", tool: string): AppsDeps["request"] {
  return async (method, endpoint, { query, body, timeoutMs }) => {
    const token = await getAuthToken();
    if (!token)
      return {
        ok: false,
        status: 401,
        data: { error: { code: "not_signed_in", message: NOT_SIGNED_IN } },
      };
    const gateway = await resolveGatewayUrl();
    const suffix = query?.toString() ? `?${query.toString()}` : "";
    let response: Response;
    try {
      response = await fetch(`${gateway}${endpoint}${suffix}`, {
        method,
        headers: {
          ...summerRequestHeaders({ tool, surface }),
          Authorization: `Bearer ${token}`,
          "X-Summer-MCP-Endpoint": endpoint,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, status: 0, data: { error: { code: "unavailable", message: `Request failed: ${describeNetworkError(error)}`, ...networkDetails(error) } } };
    }
    const text = await response.text().catch(() => "");
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = { message: text.slice(0, 1000) };
    }
    return { ok: response.ok, status: response.status, data };
  };
}

/** The server's `{error: {code, message}}` as one flat result an agent can act on.
 *  Not signed in, no credits and network failures carry the shared codes
 *  (core/error-codes.ts); the server's own codes pass through. */
function failure(reply: AppsReply): Record<string, unknown> {
  const error = reply.data.error;
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : reply.status === 404 ? "not_found" : "unavailable";
  const message = typeof record.message === "string" ? record.message : typeof reply.data.message === "string" ? reply.data.message : `Request failed (${reply.status})`;
  const { error: _error, message: _message, ...rest } = reply.data;
  const extra = { status: reply.status, ...rest, ...(record.details ? { details: record.details } : {}) };
  if (code === "not_signed_in") return codedFailure("not_signed_in", message, extra);
  if (code === "unauthorized" || reply.status === 401) return codedFailure("not_signed_in", message, extra, SIGN_IN_AGAIN_RECOVERY);
  if (reply.status === 402) return codedFailure("no_credits", message, extra);
  if (reply.status === 0) return codedFailure("unavailable", message, extra);
  const hints: Record<string, string> = {
    not_found: "Summer Apps is not available for this account yet, or the app id is wrong: summer_app_list shows the person's apps.",
    app_not_open: "Use summer_app_data, or ask the person to open the app in Summer Studio.",
    invalid: "Fix what the message names and try again (summer_app_guide has the rules).",
    too_large: "Limits: 10 MB per app, 300 files, 5 MB per file.",
    rate_limited: "Wait a minute and try again.",
  };
  return { ok: false, code, error: message, status: reply.status, ...(hints[code] ? { hint: hints[code] } : {}), ...rest, ...(record.details ? { details: record.details } : {}) };
}

const done = (reply: AppsReply) => (reply.ok ? { ok: true, ...reply.data } : failure(reply));
const params = (values: Record<string, string | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") query.set(key, value);
  return query;
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function appGuide(args: z.output<typeof appGuideArgsSchema>, deps: AppsDeps) {
  return done(await deps.request("GET", `${APPS_ENDPOINT}/guide`, { query: params({ section: args.section }), timeoutMs: 30_000 }));
}

export async function appList(args: z.output<typeof appListArgsSchema>, deps: AppsDeps) {
  return done(await deps.request("GET", APPS_ENDPOINT, { query: params({ workspaceId: args.workspaceId, q: args.q }), timeoutMs: 30_000 }));
}

export async function appCreate(args: z.output<typeof appCreateArgsSchema>, deps: AppsDeps) {
  const reply = await deps.request("POST", APPS_ENDPOINT, { body: args, timeoutMs: 30_000 });
  if (!reply.ok) return failure(reply);
  const studio = reply.data.studio as { queued?: boolean } | undefined;
  const workspace = reply.data.workspace as { name?: string; kind?: string } | undefined;
  const where = workspace?.name ? `It is in ${workspace.kind === "personal" ? "the person's personal workspace" : `the team ${workspace.name}`}: tell them. ` : "";
  return {
    ok: true,
    ...reply.data,
    next: `${where}${studio?.queued ? "The person's Summer Studio tab is opening the app. " : ""}Write the app (summer_app_guide first), then summer_app_publish with appId and the files or dir.`,
  };
}

/** Every file under dir (dotfiles, node_modules and .d.ts type files skipped), as publish files. */
export async function readAppDir(dir: string): Promise<Array<{ path: string; content: string; encoding: "utf8" | "base64" }>> {
  const root = path.resolve(dir);
  const files: Array<{ path: string; content: string; encoding: "utf8" | "base64" }> = [];
  let total = 0;
  const walk = async (current: string) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.endsWith(".d.ts")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || (await lstat(full)).isSymbolicLink()) continue;
      const bytes = await readFile(full);
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path.relative(root, full)} is over 5 MB`);
      total += bytes.length;
      if (total > MAX_BUNDLE_BYTES) throw new Error(`${dir} is over the 10 MB app limit`);
      const relative = path.relative(root, full).split(path.sep).join("/");
      const text = TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
      files.push({ path: relative, content: bytes.toString(text ? "utf8" : "base64"), encoding: text ? "utf8" : "base64" });
      if (files.length > MAX_FILES) throw new Error(`${dir} has more than ${MAX_FILES} files`);
    }
  };
  await walk(root);
  return files;
}

export async function appPublish(args: z.output<typeof appPublishArgsSchema>, deps: AppsDeps) {
  const sources = [args.dir, args.files, args.layout].filter((value) => value !== undefined).length;
  if (sources !== 1) return { ok: false, code: "invalid", error: "Send exactly one of dir, files or layout." };
  let files = args.files;
  if (args.dir) {
    try {
      files = await (deps.readDir ?? readAppDir)(args.dir);
    } catch (error) {
      return { ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) };
    }
  }
  const body = { ...(files ? { files } : { layout: args.layout }), manifest: args.manifest, ...(args.note ? { note: args.note } : {}), ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) };
  const reply = await deps.request("POST", `${APPS_ENDPOINT}/${args.appId}/publish`, { body, timeoutMs: 120_000 });
  if (!reply.ok) return failure(reply);
  const version = reply.data.version as { version?: number } | undefined;
  return {
    ok: true,
    ...reply.data,
    next: `Version ${version?.version ?? "?"} is live in the person's Studio. Wait for what the app sends with summer_app_events, or publish again to change it.`,
  };
}

export async function appGet(args: z.output<typeof appGetArgsSchema>, deps: AppsDeps) {
  return done(await deps.request("GET", `${APPS_ENDPOINT}/${args.appId}`, { timeoutMs: 60_000 }));
}

export async function appEvents(args: z.output<typeof appEventsArgsSchema>, deps: AppsDeps) {
  return done(
    await deps.request("GET", `${APPS_ENDPOINT}/${args.appId}/events`, {
      query: params({ after: String(args.after), timeoutMs: String(args.timeoutSeconds * 1000), kinds: args.kinds?.join(",") }),
      timeoutMs: (args.timeoutSeconds + 20) * 1000,
    })
  );
}

export async function appPage(args: z.output<typeof appPageArgsSchema>, deps: AppsDeps) {
  const { appId: id, ...body } = args;
  return done(await deps.request("POST", `${APPS_ENDPOINT}/${id}/page`, { body, timeoutMs: 60_000 }));
}

export async function appUpdate(args: z.output<typeof appUpdateArgsSchema>, deps: AppsDeps) {
  const { appId: id, ...body } = args;
  return done(await deps.request("POST", `${APPS_ENDPOINT}/${id}/update`, { body, timeoutMs: 30_000 }));
}

/**
 * summer_app_screenshot: the server renders the app headless and read-only as the
 * person and answers the PNG (base64) with its console, errors and declared page.
 * The image moves to `image`; `out` also writes it to disk.
 */
export async function appScreenshot(args: z.output<typeof appScreenshotArgsSchema>, deps: AppsDeps & { writeFile?: (file: string, data: Buffer) => Promise<void> }) {
  const { appId: id, out, ...body } = args;
  const result = done(await deps.request("POST", `${APPS_ENDPOINT}/${id}/screenshot`, { body, timeoutMs: 90_000 }));
  if (result.ok !== true) return result;
  const { image, ...report } = result as Record<string, unknown> & { image?: { mimeType: string; base64: string } };
  if (!image) return { ...report, ok: false, code: "invalid", error: "The server answered without an image" };
  if (out) await (deps.writeFile ?? ((file, data) => import("node:fs/promises").then((fs) => fs.writeFile(file, data))))(path.resolve(out), Buffer.from(image.base64, "base64"));
  return { ...report, image, ...(out ? { savedTo: path.resolve(out) } : {}) };
}

export async function appData(args: z.output<typeof appDataArgsSchema>, deps: AppsDeps) {
  if (args.ops) return done(await deps.request("POST", `${APPS_ENDPOINT}/${args.appId}/data`, { body: { ops: args.ops, ...(args.as ? { as: args.as } : {}) }, timeoutMs: 30_000 }));
  return done(
    await deps.request("GET", `${APPS_ENDPOINT}/${args.appId}/data`, {
      query: params({ collection: args.collection, after: args.after, limit: String(args.limit) }),
      timeoutMs: 30_000,
    })
  );
}

export async function appTools(args: z.output<typeof appToolsArgsSchema>, deps: AppsDeps) {
  return done(await deps.request("GET", `${APPS_ENDPOINT}/${args.appId}/tools`, { timeoutMs: 30_000 }));
}

export async function appCall(args: z.output<typeof appCallArgsSchema>, deps: AppsDeps) {
  const { appId: id, ...body } = args;
  return done(await deps.request("POST", `${APPS_ENDPOINT}/${id}/call`, { body, timeoutMs: 90_000 }));
}

export async function appReportGap(args: z.output<typeof appReportGapArgsSchema>, deps: AppsDeps) {
  return done(await deps.request("POST", `${APPS_ENDPOINT}/report-gap`, { body: args, timeoutMs: 30_000 }));
}

// ---------------------------------------------------------------------------
// summer_app_dock (engine)
// ---------------------------------------------------------------------------

export const APP_DOCK_FALLBACK =
  "This engine build cannot dock apps yet. Open the app in the Summer Studio tab instead (summer_studio_open with /studio/apps/<appId>), or update Summer Engine.";

/** The engine op for one dock action. */
export function appDockOp(args: z.output<typeof appDockArgsSchema>): { op: string; [key: string]: unknown } {
  if (args.action === "list") return { op: "ListAppDocks" };
  if (!args.appId) throw new Error(`${args.action} needs appId`);
  return args.action === "open" ? { op: "OpenAppDock", appId: args.appId, slot: args.slot } : { op: "CloseAppDock", appId: args.appId };
}
