import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../core/package-root.js";
import { SUMMER_BLOCK_END, SUMMER_BLOCK_START, projectCommands, renderAgentsBlock, writeAgentInstructions } from "./agent-instructions.js";

const skill = readFileSync(join(PACKAGE_ROOT, "library", "skills", "summer-cli", "SKILL.md"), "utf-8");

describe("the Summer block of AGENTS.md", () => {
  it("copies the five commands from the summer-cli skill", () => {
    const commands = projectCommands(skill);
    expect(commands.split("\n").filter((line) => /^\d\. `summer /.test(line))).toHaveLength(5);
    expect(renderAgentsBlock()).toContain(commands);
  });

  it("is short, marked, and says what the project is, how to work and that publishing needs the owner", () => {
    const block = renderAgentsBlock();
    expect(block.split("\n").length).toBeLessThan(60);
    expect(block.startsWith(SUMMER_BLOCK_START)).toBe(true);
    expect(block.endsWith(SUMMER_BLOCK_END)).toBe(true);
    for (const words of ["Summer Engine, the game engine built for AI", "GDScript", "summer_get_project_context", "summer-cli", "using-summer", "owner approves"]) {
      expect(block).toContain(words);
    }
    expect(block).not.toMatch(/\$\d|\bUSD\b|per credit/i);
  });

  it("fails loudly when the skill loses its list", () => {
    expect(() => projectCommands("# no list")).toThrow(/project-commands/);
  });
});

describe("writeAgentInstructions", () => {
  let dir = "";
  const block = renderAgentsBlock();
  const agents = () => readFileSync(join(dir, "AGENTS.md"), "utf-8");
  const claude = () => readFileSync(join(dir, "CLAUDE.md"), "utf-8");
  const actions = (opts: Parameters<typeof writeAgentInstructions>[1] = {}) => writeAgentInstructions(dir, opts).map((r) => `${r.file} ${r.action}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "summer-agents-md-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates AGENTS.md as the block and CLAUDE.md as @AGENTS.md, then leaves them", () => {
    expect(actions()).toEqual(["AGENTS.md created", "CLAUDE.md created"]);
    expect(agents()).toBe(`${block}\n`);
    expect(claude()).toBe("@AGENTS.md\n");
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);
  });

  it("adds the block once to an AGENTS.md it did not write, and later updates only the block", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# My rules\n\nUse tabs.\n");
    expect(actions()).toEqual(["AGENTS.md added", "CLAUDE.md created"]);
    expect(agents()).toBe(`# My rules\n\nUse tabs.\n\n${block}\n`);
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);

    writeFileSync(join(dir, "AGENTS.md"), `# My rules\n\n${block.replace("## Publishing", "## Old")}\n\nMy footer.\n`);
    expect(actions()).toEqual(["AGENTS.md updated", "CLAUDE.md unchanged"]);
    expect(agents()).toBe(`# My rules\n\n${block}\n\nMy footer.\n`);
  });

  it("imports AGENTS.md from a CLAUDE.md it did not write, once; one that already imports it stays as it is", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "Be brief.\n");
    expect(actions()).toEqual(["AGENTS.md created", "CLAUDE.md added"]);
    expect(claude()).toBe(`Be brief.\n\n${SUMMER_BLOCK_START}\n@AGENTS.md\n${SUMMER_BLOCK_END}\n`);
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);

    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\nBe brief.\n");
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);
    expect(claude()).toBe("@AGENTS.md\nBe brief.\n");
  });

  it("leaves a file whose block lost its end marker, and says why", () => {
    const broken = `Mine.\n\n${SUMMER_BLOCK_START}\nhalf a block\n`;
    writeFileSync(join(dir, "AGENTS.md"), broken);
    const [result] = writeAgentInstructions(dir);
    expect(result).toMatchObject({ file: "AGENTS.md", action: "skipped", reason: expect.stringContaining("no end marker") });
    expect(agents()).toBe(broken);
  });

  it("writes nothing on a dry run", () => {
    expect(actions({ dryRun: true })).toEqual(["AGENTS.md created", "CLAUDE.md created"]);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });
});
