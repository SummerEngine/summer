import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  MAX_APP_EVENTS_WAIT_SECONDS,
  APP_DOCK_FALLBACK,
  appCall,
  appCallArgsSchema,
  appCreate,
  appCreateArgsSchema,
  appData,
  appDataArgsSchema,
  appDockArgsSchema,
  appDockOp,
  appEvents,
  appEventsArgsSchema,
  appGet,
  appGetArgsSchema,
  appGuide,
  appGuideArgsSchema,
  appList,
  appListArgsSchema,
  appPage,
  appPageArgsSchema,
  appPublish,
  appPublishArgsSchema,
  appReportGap,
  appReportGapArgsSchema,
  appScreenshot,
  appScreenshotArgsSchema,
  appUpdate,
  appUpdateArgsSchema,
  appsGateway,
  appTools,
  appToolsArgsSchema,
  type AppsDeps,
} from "../../core/capabilities/apps.js";
import { enablePluginArgsSchema, enablePluginOp, interpretEnablePluginResult } from "../../core/capabilities/enable-plugin.js";
import { missingEngineOpResult, withEngine } from "./with-engine.js";

/**
 * Summer Apps over MCP: tools a game team uses inside Summer Studio, built by
 * the agent. Shared implementation: core/capabilities/apps.ts.
 */

const CLOUD = "Cloud tool: runs on Summer's servers and works without the Summer Engine app open. Requires sign-in: npx -y summer-engine@latest login.";

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], ...(value.ok === false ? { isError: true } : {}) };
}

/** The MCP handler of one cloud tool: validate with the shared schema, call the web API. */
function cloud<S extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  schema: S,
  run: (args: z.output<S>, deps: AppsDeps) => Promise<Record<string, unknown>>
) {
  return async (args: unknown) => {
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) return result({ ok: false, code: "invalid", error: parsed.error.issues[0]?.message ?? "Invalid arguments" });
    return result(await run(parsed.data, { request: appsGateway("mcp", name) }));
  };
}

export function registerAppTools(server: McpServer) {
  server.tool(
    "summer_app_guide",
    `Read this before building or changing a Summer App (a tool for the person's team inside Summer Studio). Start with the default section overview (when to build one, Layout vs code, the build loop, the rules), then read what the app needs: examples (a complete working app to copy), sdk, manifest, kit, design, layout, types (exact SDK TypeScript types).\n\n${CLOUD}`,
    appGuideArgsSchema.shape,
    async (args: unknown) => {
      const parsed = appGuideArgsSchema.safeParse(args ?? {});
      if (!parsed.success) return result({ ok: false, code: "invalid", error: parsed.error.issues[0]?.message ?? "Invalid arguments" });
      const guide = await appGuide(parsed.data, { request: appsGateway("mcp", "summer_app_guide") });
      // The guide reads as Markdown, not as one escaped JSON line.
      return guide.ok === true && typeof guide.markdown === "string" ? { content: [{ type: "text" as const, text: guide.markdown }] } : result(guide);
    }
  );
  server.tool(
    "summer_app_list",
    `The Summer Apps in the person's workspaces: id, name, purpose, folder, status (scratch, kept, archived), version, format.\n\n${CLOUD}`,
    appListArgsSchema.shape,
    cloud("summer_app_list", appListArgsSchema, appList)
  );
  server.tool(
    "summer_app_create",
    `Create a new scratch Summer App; their open Summer Studio tab opens it. Without workspaceId it goes to the person's team (the one their Studio tab is on, else their latest team, else personal); the result's workspace says which: tell the person. Read summer_app_guide first. format code (index.html + JS/CSS) or layout (a JSON layout of kit nodes for a quick decision UI). Then summer_app_publish.\n\n${CLOUD}`,
    appCreateArgsSchema.shape,
    cloud("summer_app_create", appCreateArgsSchema, appCreate)
  );
  server.tool(
    "summer_app_publish",
    `Publish a new immutable version of a Summer App: dir (a local folder with index.html at its root) or files [{path, content, encoding}] for code apps, layout for layout apps, plus the manifest. Limits: 10 MB, 300 files, 5 MB per file. The person's Studio tab boots it. An error names the file or rule to fix: fix it and publish again.\n\n${CLOUD}`,
    appPublishArgsSchema.shape,
    cloud("summer_app_publish", appPublishArgsSchema, appPublish)
  );
  server.tool(
    "summer_app_get",
    `A Summer App's manifest, its current version's files (or layout) and a summary of its shared data. Use it before changing an app.\n\n${CLOUD}`,
    appGetArgsSchema.shape,
    cloud("summer_app_get", appGetArgsSchema, appGet)
  );
  server.tool(
    "summer_app_update",
    `Rename a Summer App, change its purpose or folder, or set its status: kept (the team keeps it), archived (hidden from the app list; restore with scratch or kept), scratch. Archive the scratch apps you made that the person did not keep.\n\n${CLOUD}`,
    appUpdateArgsSchema.shape,
    cloud("summer_app_update", appUpdateArgsSchema, appUpdate)
  );
  server.tool(
    "summer_app_events",
    `Wait for what a Summer App sends you: summer.agent.send events (kind agent), errors in the app (kind error), feedback (kind feedback), agent tool calls (kind tool). Waits up to timeoutSeconds (max ${MAX_APP_EVENTS_WAIT_SECONDS}) for the first event after the cursor; pass the returned cursor as after next time.\n\n${CLOUD}`,
    appEventsArgsSchema.shape,
    cloud("summer_app_events", appEventsArgsSchema, appEvents)
  );
  server.tool(
    "summer_app_page",
    `Read or use the fields and buttons a Summer App declared while it is open in the person's Studio tab or editor dock: no fill and no press reads the page; fill [{field, value}] and press an action id use it. Critical actions (delete, publish, pay, send) are pressed only by the person. app_not_open when the app is not open.\n\n${CLOUD}`,
    appPageArgsSchema.shape,
    cloud("summer_app_page", appPageArgsSchema, appPage)
  );
  server.tool(
    "summer_app_screenshot",
    `See a Summer App without the person: Summer renders its current version (or version) headless with the person's data and returns the picture plus what to fix: console lines, uncaught errors, refused calls, whether the SDK connected and rendered, and the fields, buttons and agent tools it declared. Read-only: writes, sends and paid calls are refused, nothing changes. width 390 for a phone, theme dark, fullPage for the whole scroll, steps to click or press something first (a dialog, a second state); out also saves the PNG. It waits until the app's calls settle. Use it after every publish.\n\n${CLOUD}`,
    appScreenshotArgsSchema.shape,
    async (args: unknown) => {
      const parsed = appScreenshotArgsSchema.safeParse(args ?? {});
      if (!parsed.success) return result({ ok: false, code: "invalid", error: parsed.error.issues[0]?.message ?? "Invalid arguments" });
      const shot = await appScreenshot(parsed.data, { request: appsGateway("mcp", "summer_app_screenshot") });
      if (shot.ok !== true || !("image" in shot)) return result(shot);
      const { image, ...report } = shot as typeof shot & { image: { mimeType: string; base64: string } };
      return { content: [{ type: "image" as const, data: image.base64, mimeType: image.mimeType }, { type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    }
  );
  server.tool(
    "summer_app_data",
    `Read or write a Summer App's shared data, its API: works with no app open, and everyone in the app sees writes live. Without ops it reads records (paged with after) plus declaredCollections, the record shape the app declares; with ops it writes them in one revision: {op: put|patch|remove, collection, recordId, data|patch, ifRevision?}. Writes show as yours (actor kind agent); as: seed writes starter data for the team (kind seed, no author).\n\n${CLOUD}`,
    appDataArgsSchema.shape,
    cloud("summer_app_data", appDataArgsSchema, appData)
  );
  server.tool(
    "summer_app_tools",
    `The agent tools (name, description, input JSON Schema) and the data collections (record fields and types) a Summer App declares. Run a tool with summer_app_call; read or write the collections with summer_app_data.\n\n${CLOUD}`,
    appToolsArgsSchema.shape,
    cloud("summer_app_tools", appToolsArgsSchema, appTools)
  );
  server.tool(
    "summer_app_call",
    `Run one of a Summer App's agent tools inside the person's open app (Studio tab or editor dock) with their rights; waits up to 60 s. app_not_open when the app is not open: use summer_app_data or ask the person to open it. May spend the person's credits when the tool generates.\n\n${CLOUD}`,
    appCallArgsSchema.shape,
    cloud("summer_app_call", appCallArgsSchema, appCall)
  );
  server.tool(
    "summer_app_report_gap",
    `Tell Summer about an SDK capability a Summer App needed and did not have, so it can be built for everyone.\n\n${CLOUD}`,
    appReportGapArgsSchema.shape,
    cloud("summer_app_report_gap", appReportGapArgsSchema, appReportGap)
  );

  server.tool(
    "summer_app_dock",
    `Dock a Summer App as a panel in the running Summer Engine editor (left, right or bottom), close its dock, or list docked apps. Docks persist per project. Engine builds without app docks return engine_lacks_op: open the app in the Summer Studio tab instead.`,
    appDockArgsSchema.shape,
    async (args: unknown) => {
      const parsed = appDockArgsSchema.safeParse(args ?? {});
      if (!parsed.success) return result({ ok: false, code: "invalid", error: parsed.error.issues[0]?.message ?? "Invalid arguments" });
      if (parsed.data.action !== "list" && !parsed.data.appId) return result({ ok: false, code: "invalid", error: `${parsed.data.action} needs appId` });
      const op = appDockOp(parsed.data);
      return withEngine(async (client) => {
        const missing = missingEngineOpResult(client, op.op, APP_DOCK_FALLBACK);
        if (missing) return missing;
        return client.executeOps([op]);
      });
    }
  );

  server.tool(
    "summer_enable_plugin",
    `Enable an editor plugin in the open project (res://addons/<name>/, for example one paired with a Summer App) and report the real result: enabled with the autoloads it registered, or why it failed (code SCRIPT_ERROR, NOT_TOOL, NOT_EDITOR_PLUGIN, CFG_MISSING, TIMEOUT, ...). Older Summer Engine builds only queue the enable; then the result says queued: true and enabled: null, and you check summer_get_debugger_errors before relying on the plugin.`,
    enablePluginArgsSchema.shape,
    async (args: unknown) => {
      const parsed = enablePluginArgsSchema.safeParse(args ?? {});
      if (!parsed.success) return result({ ok: false, code: "invalid", error: parsed.error.issues[0]?.message ?? "Invalid arguments" });
      return withEngine(async (client) => interpretEnablePluginResult(await client.executeOps([enablePluginOp(parsed.data)])));
    }
  );
}
