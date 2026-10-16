import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runValidation } from "../../../scripts/validate-library/index.ts";
import {
  SHELL_SECTION_END,
  SHELL_SECTION_START,
  V4_ONLY_OPS,
  callsOfTool,
  loadShellCatalog,
  planShellSections,
  shellCommandOf,
  shellRows,
  unknownTools,
  withShellSection,
  writeShellSections,
} from "../../../scripts/validate-library/shell-commands.ts";
import { isLocalOp } from "../../core/ops/contract.js";
import { TAKES_OUT } from "../../core/ops/save-files.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const schemasDir = path.join(repoRoot, "registry", "schemas");
const catalog = loadShellCatalog(repoRoot)!;

const commandsOf = (name: string) => callsOfTool(name, catalog).map(shellCommandOf);

describe("shell commands: each MCP tool name to its summer command", () => {
  it("an engine tool runs as summer engine <action>", () => {
    expect(commandsOf("summer_set_prop")).toEqual(["summer engine set-prop"]);
    expect(commandsOf("summer_get_scene_tree")).toEqual(["summer engine get-scene-tree"]);
  });

  it("a 4.0 name is its operation, and a 3.x name the operation it maps to", () => {
    expect(commandsOf("summer_assets_generate_image")).toEqual(["summer assets generate-image"]);
    expect(commandsOf("summer_jobs_wait")).toEqual(["summer jobs wait"]);
    expect(commandsOf("summer_api_docs")).toEqual(["summer docs engine-api"]);
    expect(commandsOf("summer_store_submit")).toEqual(["summer store publish"]);
  });

  it("a split tool gives one command per action; a merged tool keeps the input its note fixes", () => {
    expect(commandsOf("summer_ui_actions")).toEqual(["summer engine list-ui-actions", "summer engine invoke-ui-action"]);
    expect(commandsOf("summer_list_my_assets")).toEqual(["summer assets search --scope mine"]);
    expect(commandsOf("summer_build_begin_upload")).toEqual(["summer store upload-begin --kind bundle"]);
  });

  it("a merged tool whose operation runs here runs as the 3.x tool: the note's input is not one the operation takes", () => {
    expect(commandsOf("summer_get_agent_playbook")).toEqual(["summer tool get-agent-playbook"]);
  });

  it("summer_search is summer ops search; summer_call and names that are no tool have no row", () => {
    expect(commandsOf("summer_search")).toEqual(['summer ops search "<what you want>"']);
    expect(commandsOf("summer_call")).toEqual([]);
    expect(commandsOf("summer_probe_base")).toEqual([]);
    expect(commandsOf("summer_retarget_motion")).toEqual([]);
  });

  it("a 4.0 name runs only an operation the catalog has; a typo is reported, not printed", () => {
    expect(commandsOf("summer_assets_genrate_image")).toEqual([]);
    expect(unknownTools(["Use `summer_assets_genrate_image`, `summer_jobs_wait`, `summer_play` and `summer_probe_base`."], catalog)).toEqual(["summer_assets_genrate_image"]);
  });

  it("the 4.0-only operations are ones this package knows", () => {
    for (const op of V4_ONLY_OPS) expect(TAKES_OUT.has(op) || isLocalOp(op)).toBe(true);
    expect(catalog.ops.has("jobs.wait")).toBe(true);
  });
});

describe("shell commands: the section in SKILL.md", () => {
  const known = catalog;
  const skill = "---\nname: x\n---\n\n# X\n\nCall `summer_play`, then `assets.generate_image({ prompt })` and `jobs.wait`.\nNot `res://summer_probe_base.gd` or `world.json`.\n";

  it("lists the tools and operations the skill names, one row per command, sorted by command", () => {
    const rows = shellRows([skill], known);
    expect(rows).toEqual([
      { names: ["assets.generate_image"], commands: ["summer assets generate-image"] },
      { names: ["summer_play"], commands: ["summer engine play"] },
      { names: ["jobs.wait"], commands: ["summer jobs wait"] },
    ]);
  });

  it("appends the section once and rewrites it in place; a skill that names nothing is left byte for byte", () => {
    const once = withShellSection(skill, shellRows([skill], known));
    expect(once.startsWith(skill.trimEnd())).toBe(true);
    expect(once).toContain(`${SHELL_SECTION_START}\n## From a shell`);
    expect(once.trimEnd().endsWith(SHELL_SECTION_END)).toBe(true);
    expect(withShellSection(once, shellRows([once], known))).toBe(once);
    const plain = "# Y\n\nNo tools here.\n\n\n";
    expect(withShellSection(plain, shellRows([plain], known))).toBe(plain);
  });

  it("drops the section when the skill stops naming tools", () => {
    const once = withShellSection(skill, shellRows([skill], known));
    const edited = once.replace("Call `summer_play`, then `assets.generate_image({ prompt })` and `jobs.wait`.\n", "");
    expect(withShellSection(edited, shellRows([edited], known))).not.toContain(SHELL_SECTION_START);
  });
});

describe("shell commands: the library lint", () => {
  function fixtureRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summer-shell-commands-"));
    fs.cpSync(path.join(repoRoot, "scripts", "validate-library", "fixtures", "valid"), root, { recursive: true });
    fs.mkdirSync(path.join(root, "registry", "operations"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "registry", "operations", "legacy-names.json"),
      JSON.stringify({ contract: 1, names: { summer_play: { kind: "keep", note: "", op: "engine.play" } } })
    );
    fs.appendFileSync(path.join(root, "library", "skills", "create-environment-kit", "SKILL.md"), "\nPlay it with `summer_play`.\n");
    return root;
  }

  it("fails a skill that names a 4.0 tool the catalog does not have", () => {
    const root = fixtureRoot();
    try {
      fs.appendFileSync(path.join(root, "library", "skills", "create-environment-kit", "SKILL.md"), "Then `summer_assets_genrate_image`.\n");
      writeShellSections(root);
      expect(runValidation(root, { schemasDir }).errors.filter((e) => e.includes("summer_assets_genrate_image"))).toEqual([
        expect.stringContaining("names summer_assets_genrate_image, but the operation catalog has no assets.genrate_image"),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a skill whose section is missing or stale, and generate:registry's writer fixes it", () => {
    const root = fixtureRoot();
    try {
      const before = runValidation(root, { schemasDir });
      expect(before.errors.filter((e) => e.includes('"From a shell"'))).toEqual([
        expect.stringContaining("library/skills/create-environment-kit/SKILL.md: the \"From a shell\" section does not match the operation catalog"),
      ]);
      expect(writeShellSections(root)).toEqual(["library/skills/create-environment-kit/SKILL.md"]);
      const text = fs.readFileSync(path.join(root, "library", "skills", "create-environment-kit", "SKILL.md"), "utf8");
      expect(text).toContain("| `summer_play` | `summer engine play` |");
      expect(runValidation(root, { schemasDir }).errors.filter((e) => e.includes('"From a shell"'))).toEqual([]);
      expect(writeShellSections(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks nothing in a tree without the operation catalog", () => {
    expect(planShellSections(path.join(repoRoot, "scripts", "validate-library", "fixtures", "valid"))).toEqual([]);
  });
});
