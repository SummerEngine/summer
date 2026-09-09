import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import open from "open";
import { getClient } from "../server.js";
import { getAuthToken } from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { openArgsShape, runOpen } from "../../core/capabilities/navigation/open.js";

/**
 * summer_open — the MCP face of `summer open`. Same behavior as the CLI
 * (src/core/capabilities/navigation/open.ts runOpen); this file only supplies
 * the engine client and the browser launcher. Design: docs/design/NAVIGATION-DESIGN.md §3.
 */
export function registerNavigationTools(server: McpServer): void {
  server.tool(
    "summer_open",
    `Open the exact summerengine.com page or Summer Engine editor surface the user wants to LOOK at, by intent name — or, with open:false, return the URL / engine op without opening anything. The result ALWAYS carries the resolved url or op, also after opening, so you can tell the user where they landed.

WHEN: the user wants to see, check, or decide something: "open my billing page", "show me my published games", "take me to pricing", "open the MCP setup guide for Cursor", "show me the scene", "select the Player node", "open player.gd". NOT for getting a result (add a node, set a property, publish) — use the mutation tools; opening a UI is a user-visible action, do it because the user asked to look, and say what will open.

target: an id (billing, usage, account, settings, team, my-games, game, pricing, download, mcp-guide, templates, asset-store, docs, scene, main-scene, node, script, file, files, scene-tree, inspector, screen-3d, assistant, project-settings, output, debugger, editor-window, …), an intent phrase ("change my plan"), a res:// path (routed by extension: .tscn -> scene, .gd -> script, else file), or a summerengine.com path ("/pricing"). Omit target to LIST every destination with surface/status/requires.
params: slot values — gameId + section (builds, releases, store-page, analytics, …) for game; guide (agent name: cursor, claude-code, codex, gemini, …) for mcp-guide; username; version; path / node / scene / line / col / tab for editor targets.
open: false resolves only and returns url (+ login_url when the page needs login) or op; nothing opens, no engine needed.

Result: { ok, action: opened | printed | listed | ambiguous | unsupported | engine_not_running | engine_error | not_found | invalid_params, target (with availability for editor ids), url, login_url, logged_in, opened_url, op, engine, failure_reason, matches, hint }.
- Web targets that require login open through /login?returnUrl=<path> when this machine holds no Summer login token (logged_in:false) — the destination loads after sign-in.
- Editor targets need Summer Engine running with the project open; otherwise action engine_not_running with the op that would have been sent and a 'summer run' hint. Nothing was opened.
- Editor destinations are forwarded to the engine's own navigation table (op Navigate; ids advertised in /api/health capabilities.navigation). On an engine that predates it, scene/node/script/file and the three docks still work through their original ops; anything else answers action unsupported with failure_reason engine_lacks_op and an update hint. Never claim those opened. Listing (no target) shows each editor id's availability from the connected engine.
- ambiguous: several destinations match; call again with one of matches[].id.
Only summerengine.com and docs.summerengine.com are ever opened.`,
    openArgsShape,
    async (args) => {
      const result = await runOpen(args, {
        engine: () => getClient(),
        openUrl: (url) => open(url),
        isLoggedIn: async () => (await getAuthToken()) !== null,
        gatewayUrl: resolveGatewayUrl,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        ...(result.ok ? {} : { isError: true as const }),
      };
    }
  );
}
