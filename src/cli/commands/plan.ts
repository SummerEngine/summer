import { Command } from "commander";
import {
  ASSET_POLICIES,
  GAME_TASK_MODES,
  GAME_TASK_TARGETS,
  VERIFICATION_LEVELS,
  buildGameTaskPlan,
  type AssetPolicy,
  type GameTaskMode,
  type GameTaskTarget,
  type VerificationLevel,
} from "../../core/capabilities/game-task-plan.js";
import { c } from "../../core/format.js";

interface PlanCommandOptions {
  mode?: string;
  target?: string;
  assetPolicy?: string;
  verification?: string;
  json?: boolean;
}

function parseChoice<T extends string>(
  value: string | undefined,
  choices: readonly T[],
  label: string
): T | undefined {
  if (!value) return undefined;
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${label}: ${value}. Use one of: ${choices.join(", ")}`);
}

function printList(title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  console.log(c.bold(title));
  for (const item of items) {
    console.log(`  - ${item}`);
  }
  console.log("");
}

export const planCommand = new Command("plan")
  .description("Plan the right Summer CLI/MCP workflow for an AI game-building task")
  .argument("<goal...>", "What the user wants to build, fix, polish, or create")
  .option("--mode <mode>", `Task mode: ${GAME_TASK_MODES.join("|")}`)
  .option("--target <target>", `Task target: ${GAME_TASK_TARGETS.join("|")}`)
  .option("--asset-policy <policy>", `Asset policy: ${ASSET_POLICIES.join("|")}`)
  .option("--verification <level>", `Verification level: ${VERIFICATION_LEVELS.join("|")}`)
  .option("--json", "Print the plan as JSON")
  .action((goalParts: string[], opts: PlanCommandOptions) => {
    const plan = buildGameTaskPlan({
      goal: goalParts.join(" "),
      mode: parseChoice(opts.mode, GAME_TASK_MODES, "mode") as GameTaskMode | undefined,
      target: parseChoice(opts.target, GAME_TASK_TARGETS, "target") as GameTaskTarget | undefined,
      assetPolicy: parseChoice(opts.assetPolicy, ASSET_POLICIES, "asset policy") as AssetPolicy | undefined,
      verification: parseChoice(opts.verification, VERIFICATION_LEVELS, "verification") as VerificationLevel | undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    console.log("");
    console.log(c.bold("Summer Game Task Plan"));
    console.log(`Goal: ${plan.goal}`);
    console.log(`Mode: ${plan.mode}`);
    console.log(`Target: ${plan.target}`);
    console.log(`Asset policy: ${plan.assetPolicy}`);
    console.log(`Verification: ${plan.verification}`);
    console.log("");

    console.log(c.bold("Recommended Skills"));
    for (const skill of plan.recommendedSkills) {
      console.log(`  - ${skill.id}: ${skill.why}`);
    }
    console.log("");

    printList("MCP Start", plan.mcpToolPlan.start);
    printList("MCP Mutations", plan.mcpToolPlan.mutate);
    printList("MCP Assets", plan.mcpToolPlan.assets);
    printList("MCP Verify", plan.mcpToolPlan.verify);
    printList("Host File Work", plan.hostFileWork);
    printList("User Gates", plan.userGates);
    printList("Next Agent Steps", plan.nextAgentSteps);
  });
