import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../core/package-root.js";
import { SUMMER_BLOCK_END, SUMMER_BLOCK_START, findSetupProjectRoot, projectCommands, renderAgentsBlock, writeAgentInstructions } from "./agent-instructions.js";

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
    for (const words of ["Summer Engine, the game engine built for AI", "GDScript", "summer_get_project_context", "summer-cli", "using-summer", "owner's yes"]) {
      expect(block).toContain(words);
    }
    // The first-game look rule sits before the how-to, and nothing says to wait for a staff review.
    expect(block.indexOf("## First game: make it look finished")).toBeGreaterThan(-1);
    expect(block.indexOf("## First game")).toBeLessThan(block.indexOf("## How to work on it"));
    expect(block).toContain("screenshot of the running game");
    expect(block).not.toMatch(/Nothing goes live until/);
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

describe("writeAgentInstructions: links, errors, line endings", () => {
  let root = "";
  let dir = "";
  const read = (name: string) => readFileSync(join(dir, name), "utf-8");
  const actions = () => writeAgentInstructions(dir).map((r) => `${r.file} ${r.action}`);
  const block = renderAgentsBlock();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summer-agents-links-"));
    dir = join(root, "game");
    mkdirSync(dir);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["CLAUDE.md -> AGENTS.md", "AGENTS.md", "CLAUDE.md"],
    ["AGENTS.md -> CLAUDE.md", "CLAUDE.md", "AGENTS.md"],
  ])("%s: one file, the AGENTS.md block once, and no rewrite on the next run", (_name, real, link) => {
    writeFileSync(join(dir, real), "# Our rules\n");
    symlinkSync(real, join(dir, link));
    const [, claude] = writeAgentInstructions(dir);
    expect(claude).toMatchObject({ action: "unchanged", reason: "it is the same file as AGENTS.md" });
    expect(read(real)).toBe(`# Our rules\n\n${block}\n`);
    expect(lstatSync(join(dir, link)).isSymbolicLink()).toBe(true);
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);
  });

  it.each([
    ["CLAUDE.md -> AGENTS.md", "AGENTS.md", "CLAUDE.md"],
    ["AGENTS.md -> CLAUDE.md", "CLAUDE.md", "AGENTS.md"],
  ])("%s with the target missing: the dry run and the run agree, and the target gets the full block", (_name, target, link) => {
    symlinkSync(target, join(dir, link));
    const planned = writeAgentInstructions(dir, { dryRun: true }).map((r) => `${r.file} ${r.action}`);
    expect(planned).toEqual(["AGENTS.md created", "CLAUDE.md unchanged"]);
    expect(actions()).toEqual(planned);
    expect(read(target)).toBe(`${block}\n`);
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);
  });

  it("skips a link to a missing file or to a file outside the project, and writes nothing there", () => {
    const outside = join(root, "shared.md");
    symlinkSync(join(root, "missing.md"), join(dir, "AGENTS.md"));
    writeFileSync(outside, "Shared.\n");
    symlinkSync(outside, join(dir, "CLAUDE.md"));
    const [agents, claude] = writeAgentInstructions(dir);
    expect(agents).toMatchObject({ action: "skipped", reason: "it is a link to a file that does not exist" });
    expect(claude).toMatchObject({ action: "skipped", reason: "it is a link to a file outside the project" });
    expect(existsSync(join(root, "missing.md"))).toBe(false);
    expect(readFileSync(outside, "utf-8")).toBe("Shared.\n");
  });

  it("a file it cannot write is skipped with the reason, and the other is still done", () => {
    mkdirSync(join(dir, "AGENTS.md"));
    writeFileSync(join(dir, "CLAUDE.md"), "Be brief.\n");
    chmodSync(join(dir, "CLAUDE.md"), 0o444);
    const [agents, claude] = writeAgentInstructions(dir);
    expect(agents).toMatchObject({ action: "skipped", reason: expect.stringMatching(/EISDIR/) });
    if (process.getuid?.() !== 0) expect(claude).toMatchObject({ action: "skipped", reason: expect.stringMatching(/EACCES|EPERM/) });
    chmodSync(join(dir, "CLAUDE.md"), 0o644);
  });

  it("keeps a CRLF file CRLF, and a CRLF block counts as current", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "Be brief.\r\nUse tabs.\r\n");
    writeFileSync(join(dir, "AGENTS.md"), `Ours.\r\n\r\n${block.replace(/\n/g, "\r\n")}\r\n`);
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md added"]);
    expect(read("CLAUDE.md")).toBe(`Be brief.\r\nUse tabs.\r\n\r\n${SUMMER_BLOCK_START}\r\n@AGENTS.md\r\n${SUMMER_BLOCK_END}\r\n`);
    expect(actions()).toEqual(["AGENTS.md unchanged", "CLAUDE.md unchanged"]);
  });

  it("leaves a file with two blocks as it is and says why, adds only line breaks around the person's text, and gives an empty file the block alone", () => {
    const two = `A.\n\n${block}\n\nB.\n\n\`\`\`\n${SUMMER_BLOCK_START}\n(an example)\n${SUMMER_BLOCK_END}\n\`\`\`\n`;
    writeFileSync(join(dir, "AGENTS.md"), two);
    writeFileSync(join(dir, "CLAUDE.md"), "Mine.  ");
    const [agents] = writeAgentInstructions(dir, { dryRun: true });
    expect(agents).toMatchObject({ action: "skipped", reason: "it has two Summer blocks; delete one and run setup again" });
    expect(actions()).toEqual(["AGENTS.md skipped", "CLAUDE.md added"]);
    expect(read("AGENTS.md")).toBe(two);
    expect(read("CLAUDE.md")).toBe(`Mine.  \n\n${SUMMER_BLOCK_START}\n@AGENTS.md\n${SUMMER_BLOCK_END}\n`);
    writeFileSync(join(dir, "AGENTS.md"), "");
    writeAgentInstructions(dir);
    expect(read("AGENTS.md")).toBe(`${block}\n`);
  });

  it("an import inside a code fence does not count; @./AGENTS.md does", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "```\n@AGENTS.md\n```\n");
    expect(writeAgentInstructions(dir)[1]!.action).toBe("added");
    writeFileSync(join(dir, "CLAUDE.md"), "@./AGENTS.md\n");
    expect(writeAgentInstructions(dir)[1]!.action).toBe("unchanged");
  });
});

describe("findSetupProjectRoot: where summer setup looks for a project", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summer-setup-root-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds project.godot at or above the working directory, up to the git top level", () => {
    mkdirSync(join(root, "game", ".git"), { recursive: true });
    writeFileSync(join(root, "game", "project.godot"), "");
    mkdirSync(join(root, "game", "scenes", "levels"), { recursive: true });
    expect(findSetupProjectRoot(join(root, "game", "scenes", "levels"))).toBe(realpathSync(join(root, "game")));
  });

  it("never looks above the git top level", () => {
    writeFileSync(join(root, "project.godot"), "");
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "src"));
    expect(findSetupProjectRoot(join(root, "repo", "src"))).toBeNull();
  });

  it("never takes the home folder", () => {
    const home = homedir();
    // The fake HOME of vitest.config.ts: this test writes a project.godot there.
    expect(home).not.toBe(userInfo().homedir);
    writeFileSync(join(home, "project.godot"), "");
    mkdirSync(join(home, "somewhere"), { recursive: true });
    try {
      expect(findSetupProjectRoot(join(home, "somewhere"))).toBeNull();
    } finally {
      rmSync(join(home, "project.godot"), { force: true });
    }
  });
});
