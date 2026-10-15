import { homedir } from "node:os";
import { getAuthToken } from "../auth.js";
import { readStoredOAuthToken } from "../oauth.js";
import { TOOLKIT_VERSION } from "../version.js";
import { RouterApiError, seg } from "./api.js";
import type { RouterContext } from "./commands.js";
import { scanToolHandlers, unhandledClientTools } from "./handlers.js";
import { success, failure, type RouterOutcome } from "./outcome.js";
import { CHARACTERS_DIR, findProjectRoot, readCharacterFiles, resolveGameId } from "./project.js";
import { bundledRegistry, loadRegistry, validateCharacter } from "./registry.js";
import { detectRouterAgents, ROUTER_SKILLS } from "./setup.js";
import { resolveInstallLocation } from "../../installer/skill-locations.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { studioRouterUrl } from "./studio.js";

/**
 * `summer router doctor`: every check an agent needs before and after a
 * push, as {ok, checks: [{id, status, message, fix}]}. A "fail" is something
 * that stops Summer Router from working; a "warning" is worth fixing.
 */

export type CheckStatus = "ok" | "warning" | "fail";

export interface RouterCheck {
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
  url?: string;
}

export async function doctor(ctx: RouterContext, home: string = homedir()): Promise<RouterOutcome> {
  const checks: RouterCheck[] = [];
  const add = (check: RouterCheck) => checks.push(check);

  add({ id: "cli", status: "ok", message: `summer-engine ${TOOLKIT_VERSION}` });

  const root = findProjectRoot(ctx.project ? resolve(ctx.cwd, ctx.project) : ctx.cwd);
  add(
    root
      ? { id: "project", status: "ok", message: root }
      : { id: "project", status: "fail", message: "No project.godot at or above this folder.", fix: "Run inside the Summer project, or pass --project <dir>." }
  );

  const { gameId, source } = resolveGameId(root, ctx.game, ctx.env);
  add(
    gameId
      ? { id: "game_id", status: "ok", message: `${gameId} (from ${source})` }
      : { id: "game_id", status: "warning", message: "No game id.", fix: "Add gameId to summer.build.json, set SUMMER_GAME_ID, or pass --game <gameId>." }
  );

  const accountToken = Boolean(await getAuthToken());
  const storeToken = Boolean(await readStoredOAuthToken());
  add(
    accountToken && storeToken
      ? { id: "sign_in", status: "ok", message: "Signed in to Summer (account and store)." }
      : { id: "sign_in", status: "fail", message: accountToken ? "Signed in to the Summer account, not to the store." : "Not signed in to Summer.", fix: "Run summer login (in an agent: run it, show the browser_url to the person, then run summer login --complete)." }
  );

  const { registry, source: registrySource } = await loadRegistry(storeToken ? () => ctx.api.request("GET", "router/registry") : null);
  const bundledVersion = bundledRegistry().version;
  add(
    registrySource === "live" && registry.version !== bundledVersion
      ? { id: "registry", status: "warning", message: `Summer serves registry version ${registry.version}; this CLI ships version ${bundledVersion}.`, fix: "Update the CLI: npx -y summer-engine@latest router doctor" }
      : { id: "registry", status: "ok", message: `Registry version ${registry.version} (${registrySource}).` }
  );

  if (root) {
    const files = readCharacterFiles(root);
    const invalid = files.filter((file) => file.error || validateCharacter(file.doc, registry).length > 0).map((file) => file.id);
    add(
      files.length === 0
        ? { id: "characters", status: "warning", message: `No characters in ${CHARACTERS_DIR}/.`, fix: "summer router character add guard --template voice-npc --tools open_gate" }
        : invalid.length
          ? { id: "characters", status: "fail", message: `Invalid: ${invalid.join(", ")}.`, fix: "Run summer router push --dry-run to see each problem." }
          : { id: "characters", status: "ok", message: `${files.length} valid: ${files.map((file) => file.id).join(", ")}.` }
    );
    const unhandled = unhandledClientTools(files.filter((file) => file.doc), scanToolHandlers(root));
    add(
      unhandled.length
        ? { id: "tool_handlers", status: "fail", message: `No GDScript handler for ${unhandled.map((t) => `${t.character}.${t.tool}`).join(", ")}.`, fix: "Run summer router push --dry-run for the GDScript to add." }
        : { id: "tool_handlers", status: "ok", message: "Every client tool has a GDScript handler." }
    );
  }

  if (gameId && storeToken) {
    const studio = studioRouterUrl(await ctx.gateway(), gameId);
    try {
      const settings = await ctx.api.request<{ enabled?: boolean }>("GET", `games/${seg(gameId)}/router/settings`);
      add(
        settings.enabled
          ? { id: "platform", status: "ok", message: `Summer Router is on for ${gameId}.` }
          : { id: "platform", status: "warning", message: `Summer Router is off for ${gameId} (players get ai_disabled).`, fix: "The game's owner turns it on in Studio.", url: studio }
      );
    } catch (error) {
      const code = error instanceof RouterApiError ? error.code : "error";
      const message = error instanceof Error ? error.message : String(error);
      add({ id: "platform", status: "fail", message: `Summer did not answer for ${gameId}: ${code}: ${message}`, fix: "Check the game id and the sign-in; if the code is unavailable or not_found, Summer Router is not on in this environment yet." });
    }
  }

  const agents = detectRouterAgents(ctx.env, home);
  const missing: string[] = [];
  for (const agent of agents) {
    const location = resolveInstallLocation(agent, "user");
    for (const name of ROUTER_SKILLS) if (!existsSync(join(location.path, name, "SKILL.md"))) missing.push(`${agent}/${name}`);
  }
  add(
    agents.length === 0
      ? { id: "agent_skills", status: "warning", message: "Found no Claude Code or Codex.", fix: "summer router setup --agent claude-code --yes" }
      : missing.length
        ? { id: "agent_skills", status: "warning", message: `Missing skills: ${missing.join(", ")}.`, fix: "summer router setup --yes" }
        : { id: "agent_skills", status: "ok", message: `Summer Router skills installed for ${agents.join(", ")}.` }
  );

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const result = { checks, summary: { ok: checks.length - failures - warnings, warnings, failures } };
  const lines = checks.map((check) => `${check.status === "ok" ? "ok  " : check.status === "warning" ? "warn" : "FAIL"}  ${check.id}: ${check.message}${check.fix ? `  Fix: ${check.fix}` : ""}${check.url ? `  ${check.url}` : ""}`);
  if (failures > 0) {
    return failure({ code: "doctor_failed", message: `${failures} check${failures === 1 ? "" : "s"} failed.`, fix: "Apply the fix on each failed check, then run summer router doctor again." }, { result, lines });
  }
  return success(result, lines);
}
