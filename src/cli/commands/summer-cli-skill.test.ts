import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { PACKAGE_ROOT } from "../../core/package-root.js";
import { CLI_AREAS } from "../../core/ops/areas.js";
import { localEntries } from "../../core/ops/catalog.js";
import { isLocalOp, legacyNames, opFromCli } from "../../core/ops/contract.js";
import { ENGINE_SPLIT_OPS } from "../../core/ops/engine.js";
import { TAKES_OUT } from "../../core/ops/save-files.js";
import { loginCommand } from "./login.js";
import { opsCliCommands, runOpFromCli, type OpsCliDeps } from "./ops.js";
import { previewCommand } from "./preview.js";
import { runCommand } from "./run.js";
import { setupCommand } from "./setup.js";
import { statusCommand } from "./status.js";
import { toolCommand } from "./tool.js";
import { renderAgentsBlock } from "../../project-memory/agent-instructions.js";

/**
 * The summer-cli skill, and the AGENTS.md block summer create writes from it,
 * teach real commands only: every `summer …` it writes
 * names a command summer has, with options that command takes, and every
 * operation it runs is in the catalog and passes a dry run here (engine and
 * library operations check their input against the real descriptors; cloud
 * ones go to a stand-in for Summer's server).
 */
const skill = readFileSync(join(PACKAGE_ROOT, "library", "skills", "summer-cli", "SKILL.md"), "utf-8");

/** Commands in bash blocks (comments dropped) and in inline code. */
function taughtCommands(markdown: string): string[] {
  const found = new Set<string>();
  for (const block of markdown.matchAll(/^```bash\n([\s\S]*?)^```/gm)) {
    for (const line of block[1]!.split("\n")) {
      const command = line.replace(/\s+#.*$/, "").trim();
      if (command.startsWith("summer ")) found.add(command);
    }
  }
  for (const span of markdown.matchAll(/`(summer [^`]+)`/g)) found.add(span[1]!);
  return [...found];
}

/** Shell words: quotes group and are removed; `$(cat build.gd)` stands for the file's text. */
function words(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const word = match[1] ?? match[2] ?? match[3]!;
    out.push(word === "$(cat build.gd)" ? "func run(ctx):\n\tctx.save_scene()\n" : word.replace(/^<(id|op)>$/, (_m, kind: string) => (kind === "op" ? "engine.play" : "x1")));
  }
  return out;
}

const commands = new Map<string, Command>(
  [loginCommand, statusCommand, runCommand, setupCommand, toolCommand, previewCommand, ...opsCliCommands()].map((command) => [command.name(), command])
);
const areas = new Set<string>(CLI_AREAS);
const local = new Set([...localEntries().map((entry) => entry.name), ...Object.keys(ENGINE_SPLIT_OPS)]);
const cloud = new Set([...Object.values(legacyNames()).map((row) => row.op), ...TAKES_OUT]);

function stubDeps(): OpsCliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const envelope = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  return {
    hosted: vi.fn(async (_name: string, args: Record<string, unknown>) =>
      envelope(args.op === "ops.describe" ? { ok: true, status: "done", result: {} } : { ok: true, status: "dry_run", preview: { summary: "stand-in" } })
    ),
    dispatch: vi.fn(async () => ({ ok: true })),
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    out,
    err,
  };
}

describe("the summer-cli skill and a project's AGENTS.md teach real commands", () => {
  // `summer <area> <action>` and `summer engine …` name the pattern, not one command.
  const taught = taughtCommands(`${skill}\n${renderAgentsBlock()}`).filter((command) => !command.startsWith("summer <area>") && !command.includes("…"));

  it("teaches the sign-in, search, describe, run, wait, files and engine commands", () => {
    for (const expected of ["summer login", "summer ops search", "summer ops describe", "summer jobs wait", "summer engine run-script", "summer run", "summer status", "summer preview"]) {
      expect(taught.some((command) => command.startsWith(expected))).toBe(true);
    }
  });

  it.each(taught.map((command) => [command]))("%s", async (command) => {
    const [, name, ...rest] = words(command);
    if (areas.has(name!)) {
      const [action, ...flags] = rest;
      const op = opFromCli(name!, action);
      expect(isLocalOp(op) ? local.has(op) : cloud.has(op)).toBe(true);
      const deps = stubDeps();
      const code = await runOpFromCli(op, [...flags, "--dry-run"], deps);
      expect({ code, err: deps.err }).toEqual({ code: 0, err: [] });
      return;
    }
    if (name === "--version") return; // the program's own option
    let target = commands.get(name!);
    expect(target, `summer has a ${name} command`).toBeDefined();
    const sub = target!.commands.find((child) => child.name() === rest[0]);
    if (sub) target = sub;
    const longs = new Set(target!.options.map((option) => option.long));
    for (const flag of rest.filter((word) => word.startsWith("--"))) expect(longs, `${command}: ${flag}`).toContain(flag);
  });
});
