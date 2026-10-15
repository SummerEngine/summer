import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentHost } from "../agent-host.js";
import { getAuthToken } from "../auth.js";
import { readStoredOAuthToken } from "../oauth.js";
import { getSkillRegistry, resolveSkillDir } from "../skills-registry.js";
import { configureAgentMcp, SUMMER_MCP_SERVER_NAME, type SupportedAgent } from "../../installer/agent-config.js";
import { resolveInstallLocation } from "../../installer/skill-locations.js";
import { failure, success, usageError, type RouterOutcome } from "./outcome.js";

/**
 * `summer router setup`: make the coding agent ready for Summer Router in one
 * idempotent command. For each agent (Claude Code, Codex; detected or named
 * with --agent) it ensures the summer-engine MCP entry and the Summer Router
 * skills, then reports whether this machine is signed in. Without --yes it
 * only reports the plan. It never replaces an existing summer-engine entry
 * (a local or channel build stays as it is).
 */

export const ROUTER_AGENTS = ["claude-code", "codex"] as const;
export type RouterAgent = (typeof ROUTER_AGENTS)[number];
export const ROUTER_SKILLS = ["summer-router", "voice-and-mic-permissions"] as const;

export interface SetupOptions {
  agent?: string;
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

type StepStatus = "already_configured" | "configure" | "configured" | "kept_existing" | "already_installed" | "install" | "installed" | "update" | "updated" | "unavailable";

interface AgentPlan {
  agent: RouterAgent;
  mcp: { status: StepStatus; path: string };
  skills: Array<{ name: string; status: StepStatus; path: string }>;
}

export function detectRouterAgents(env: NodeJS.ProcessEnv, home: string): RouterAgent[] {
  const found = new Set<RouterAgent>();
  const host = resolveAgentHost(env, undefined).id;
  if ((ROUTER_AGENTS as readonly string[]).includes(host)) found.add(host as RouterAgent);
  if (existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json"))) found.add("claude-code");
  if (existsSync(join(home, ".codex"))) found.add("codex");
  return ROUTER_AGENTS.filter((agent) => found.has(agent));
}

async function ensureMcp(agent: RouterAgent, apply: boolean): Promise<AgentPlan["mcp"]> {
  const planned = await configureAgentMcp({ agent: agent as SupportedAgent, scope: "user", dryRun: true });
  if (!planned.changed) return { status: "already_configured", path: planned.path };
  const text = existsSync(planned.path) ? readFileSync(planned.path, "utf8") : "";
  const hasEntry = text.includes(`"${SUMMER_MCP_SERVER_NAME}"`) || text.includes(`mcp_servers.${SUMMER_MCP_SERVER_NAME}]`) || text.includes(`mcp_servers."${SUMMER_MCP_SERVER_NAME}"]`);
  if (hasEntry) return { status: "kept_existing", path: planned.path };
  if (!apply) return { status: "configure", path: planned.path };
  const written = await configureAgentMcp({ agent: agent as SupportedAgent, scope: "user" });
  return { status: written.wrote ? "configured" : "already_configured", path: written.path };
}

function ensureSkill(agent: RouterAgent, name: string, apply: boolean): AgentPlan["skills"][number] {
  const entry = getSkillRegistry().find((skill) => skill.name === name);
  const location = resolveInstallLocation(agent, "user");
  if (!entry || location.kind !== "skill-dir") return { name, status: "unavailable", path: location.path };
  const source = resolveSkillDir(entry);
  const dest = join(location.path, name);
  const installed = existsSync(join(dest, "SKILL.md")) ? readFileSync(join(dest, "SKILL.md"), "utf8") : null;
  const current = readFileSync(join(source, "SKILL.md"), "utf8");
  if (installed === current) return { name, status: "already_installed", path: dest };
  if (!apply) return { name, status: installed === null ? "install" : "update", path: dest };
  mkdirSync(location.path, { recursive: true });
  cpSync(source, dest, { recursive: true, force: true });
  return { name, status: installed === null ? "installed" : "updated", path: dest };
}

export async function setup(opts: SetupOptions): Promise<RouterOutcome> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  let agents: RouterAgent[];
  if (opts.agent) {
    const named = opts.agent === "claude" ? "claude-code" : opts.agent;
    if (!(ROUTER_AGENTS as readonly string[]).includes(named)) {
      return usageError("invalid_input", `Unknown agent "${opts.agent}".`, `Pass --agent ${ROUTER_AGENTS.join(" or --agent ")}. For other agents run: summer setup <agent> --yes`);
    }
    agents = [named as RouterAgent];
  } else {
    agents = detectRouterAgents(env, home);
  }
  if (agents.length === 0) {
    return usageError("no_agent_detected", "Found no Claude Code or Codex on this machine.", "Pass --agent claude-code or --agent codex. For other agents run: summer setup <agent> --yes");
  }

  const apply = Boolean(opts.yes);
  const plans: AgentPlan[] = [];
  try {
    for (const agent of agents) {
      plans.push({ agent, mcp: await ensureMcp(agent, apply), skills: ROUTER_SKILLS.map((name) => ensureSkill(agent, name, apply)) });
    }
  } catch (error) {
    return failure({ code: "setup_failed", message: error instanceof Error ? error.message : String(error), fix: "Fix the agent config file named in the message, then run summer router setup --yes again." });
  }

  const signedIn = Boolean(await getAuthToken()) && Boolean(await readStoredOAuthToken());
  const pending = plans.some((plan) => ["configure", "install", "update"].includes(plan.mcp.status) || plan.skills.some((skill) => ["install", "update"].includes(skill.status)));
  const nextSteps = [
    ...(pending ? ["summer router setup --yes"] : []),
    ...(signedIn ? [] : ["summer login"]),
    "summer router character add guard --template voice-npc --tools open_gate",
    "summer router push --dry-run",
  ];
  const changed = plans.some((plan) => plan.mcp.status === "configured");
  return success(
    { applied: apply, agents: plans, signed_in: signedIn, restart_agent: changed, next_steps: nextSteps },
    [
      ...plans.flatMap((plan) => [
        `${plan.agent}: MCP ${plan.mcp.status.replace(/_/g, " ")} (${plan.mcp.path})`,
        ...plan.skills.map((skill) => `  skill ${skill.name}: ${skill.status.replace(/_/g, " ")}`),
      ]),
      signedIn ? "Signed in to Summer." : "Not signed in to Summer yet.",
      ...(changed ? ["Restart the agent (or run /mcp) so it loads the summer-engine MCP."] : []),
      "Next:",
      ...nextSteps.map((step) => `  ${step}`),
    ]
  );
}
