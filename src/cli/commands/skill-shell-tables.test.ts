import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHELL_SECTION_START, planShellSections } from "../../../scripts/validate-library/shell-commands.ts";
import { dispatchTool, EngineUnavailableError } from "../../core/capabilities/tool-dispatch.js";
import { CLI_AREAS } from "../../core/ops/areas.js";
import { localEntries } from "../../core/ops/catalog.js";
import { isLocalOp, legacyNames, opFromCli } from "../../core/ops/contract.js";
import { ENGINE_SPLIT_OPS } from "../../core/ops/engine.js";
import { shippedCloudEntries } from "../../core/ops/public-catalog.js";
import { runOpFromCli, type OpsCliDeps } from "./ops.js";
import { resolveToolForCli } from "./tool.js";

/**
 * The "From a shell" tables at the end of the skills (scripts/validate-library/
 * shell-commands.ts) print commands this CLI has: each names a summer command
 * and an operation this package runs or the catalog knows, and the rows that
 * run here with a fixed input really run, offline.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const sections = planShellSections(repoRoot)
  .map((plan) => plan.expected)
  .filter((text) => text.includes(SHELL_SECTION_START))
  .map((text) => text.slice(text.indexOf(SHELL_SECTION_START)));
const commands = new Set(
  sections.flatMap((section) => [...section.matchAll(/^\| .* \| (.*) \|$/gm)].flatMap((row) => [...row[1]!.matchAll(/`(summer [^`]+)`/g)].map((m) => m[1]!)))
);

describe("shell commands: every command the library prints runs", () => {
  const areas = new Set<string>(CLI_AREAS);
  const local = new Set([...localEntries().map((entry) => entry.name), ...Object.keys(ENGINE_SPLIT_OPS)]);
  // Include 3.x bridges such as docs.workflows as well as current cloud ops.
  const cloud = new Set([...Object.values(legacyNames()).map((row) => row.op), ...shippedCloudEntries().map((entry) => entry.name)]);

  it("the library has sections, and every one is current", () => {
    expect(commands.size).toBeGreaterThan(50);
    expect(planShellSections(repoRoot).filter((plan) => plan.current !== plan.expected).map((plan) => plan.file)).toEqual([]);
  });

  it("names a command summer has, and an operation this package runs or the catalog names", () => {
    const problems: string[] = [];
    for (const command of commands) {
      const [, area, action] = command.split(" ");
      if (area === "ops" || area === "whoami") continue;
      if (area === "tool") {
        if (!resolveToolForCli(action!)) problems.push(`${command}: summer tool has no ${action}`);
        continue;
      }
      if (!areas.has(area!)) {
        problems.push(`${command}: summer has no ${area} command`);
        continue;
      }
      const op = opFromCli(area!, action);
      if (!(isLocalOp(op) ? local : cloud).has(op)) problems.push(`${command}: ${op} is not in the catalog`);
    }
    expect(problems).toEqual([]);
  });
});

describe("character rig shell command", () => {
  it("forwards the approved asset ID to the hosted operation", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const output: string[] = [];
    const deps: OpsCliDeps = {
      hosted: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "running", job: { id: "gen:42", state: "queued" } }) }] };
      },
      dispatch: dispatchTool,
      print: (text) => output.push(text),
      printError: (text) => output.push(text),
    };
    const assetId = "7b1c0e9e-4a4f-4d55-9f1e-2c3d4e5f6a7b";
    expect(commands.has("summer assets rig")).toBe(true);
    expect(await runOpFromCli(opFromCli("assets", "rig"), ["--asset-id", assetId, "--json"], deps)).toBe(0);
    expect(calls).toEqual([
      { name: "summer_call", args: { op: "ops.describe", input: { name: "assets.rig" } } },
      { name: "summer_call", args: { op: "assets.rig", input: { assetId } } },
    ]);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "running", job: { id: "gen:42" } });
  });
});

describe("shell commands: rows that run here with a fixed input run, offline", () => {
  const fixed = [...commands].filter((command) => /^summer (?:tool \S+$|[a-z]+ [a-z0-9-]+ --)/.test(command));
  const deps: OpsCliDeps = {
    hosted: async () => {
      throw new Error("a local row must not reach Summer's server");
    },
    dispatch: dispatchTool,
    print: () => undefined,
    printError: () => undefined,
  };
  const local = fixed.filter((command) => command.startsWith("summer tool ") || isLocalOp(opFromCli(command.split(" ")[1]!, command.split(" ")[2])));

  it("the library has such rows", () => {
    expect(local).toContain("summer tool get-agent-playbook");
  });

  it.each(local.map((command) => [command]))("%s", async (command) => {
    const [, area, action, ...flags] = command.split(" ");
    try {
      if (area === "tool") {
        const entry = resolveToolForCli(action!);
        expect(entry).not.toBeNull();
        expect(await dispatchTool(entry!.slug, {})).toBeTruthy();
      } else {
        expect(await runOpFromCli(opFromCli(area!, action), [...flags, "--json"], deps)).toBe(0);
      }
    } catch (error) {
      // An engine read gets as far as the engine: its input was accepted.
      if (!(error instanceof EngineUnavailableError)) throw error;
    }
  });
});
