import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeContentHash,
  generateRegistry,
  writeGenerated,
  GenerateError,
  GENERATED_BANNER,
} from "./index.ts";
import { applyManifests } from "./apply.ts";
import { manifestBanner } from "./shared.ts";
import { checkRegistry } from "./check.ts";
import { checkCountClaims, collectCountClaimFiles, CLAIM_PATTERN } from "./count-claims.ts";
import { MANIFEST_TARGETS, allTargets } from "./targets.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const fixtures = path.join(here, "fixtures");
const schemasDir = path.join(repoRoot, "registry", "schemas");
const basicRoot = path.join(fixtures, "basic");

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function copyBasicFixture(): string {
  const dest = tmpDir("genreg-basic-");
  fs.cpSync(basicRoot, dest, { recursive: true });
  return dest;
}

function gen(root: string) {
  return generateRegistry(root, { schemasDir });
}

function parse(files: Map<string, string>, name: string): Record<string, unknown> {
  return JSON.parse(files.get(name)!) as Record<string, unknown>;
}

describe("generateRegistry: catalog outputs", () => {
  it("produces index/counts/aliases/skills-registry/templates-registry plus all six manifests", () => {
    const result = gen(basicRoot);
    expect([...result.files.keys()].sort()).toEqual([
      "aliases.json",
      "counts.json",
      "gemini-extension.json",
      "index.json",
      "marketplace.claude.json",
      "mcp.json",
      "plugin.claude.json",
      "plugin.codex.json",
      "plugin.cursor.json",
      "plugin.factory.json",
      "skills-registry.json",
      "templates-registry.json",
    ]);
    expect(result.counts).toEqual({
      byKind: { collection: 0, example: 0, reference: 1, skill: 2, template: 0, tool: 1 },
      total: 4,
    });
  });

  it("index.json is sorted by id with the contract field order and content hashes", () => {
    const result = gen(basicRoot);
    const index = parse(result.files, "index.json");
    expect(index._generated).toBe(GENERATED_BANNER);
    const resources = index.resources as Array<Record<string, unknown>>;
    expect(resources.map((r) => r.id)).toEqual([
      "reference/engine-versions",
      "skill/alpha-skill",
      "skill/beta-skill",
      "tool/set-node-property",
    ]);
    const alpha = resources[1];
    expect(Object.keys(alpha)).toEqual([
      "id",
      "kind",
      "version",
      "content_hash",
      "summary",
      "use_when",
      "facets",
      "compatibility",
      "related",
      "status",
      "recommended",
    ]);
    expect(alpha.content_hash).toBe(
      computeContentHash(path.join(basicRoot, "library", "skills", "alpha-skill")),
    );
    expect(alpha.content_hash).toMatch(/^[a-f0-9]{64}$/);
    // beta-skill has no compatibility/related: optional keys are omitted
    expect(Object.keys(resources[2])).not.toContain("compatibility");
    expect(Object.keys(resources[2])).not.toContain("related");
  });

  it("index.json carries status for every entry and recommended for skills", () => {
    const result = gen(basicRoot);
    const resources = (parse(result.files, "index.json").resources as Array<Record<string, unknown>>);
    for (const r of resources) expect(["stable", "preview", "deprecated"], String(r.id)).toContain(r.status);
    const alpha = resources.find((r) => r.id === "skill/alpha-skill")!;
    const beta = resources.find((r) => r.id === "skill/beta-skill")!;
    expect(alpha.recommended).toBe(true);
    expect(beta.recommended).toBe(false);
    expect(Object.keys(alpha).slice(-2)).toEqual(["status", "recommended"]);
    // non-skills never carry recommended
    expect(Object.keys(resources.find((r) => r.id === "reference/engine-versions")!)).not.toContain("recommended");
  });

  it("index.json tool entries expose the host mapping: mcp_tool_name, remote, cli_command, authority", () => {
    const result = gen(basicRoot);
    const resources = (parse(result.files, "index.json").resources as Array<Record<string, unknown>>);
    const tool = resources.find((r) => r.id === "tool/set-node-property")!;
    expect(Object.keys(tool)).toEqual([
      "id",
      "kind",
      "version",
      "content_hash",
      "summary",
      "use_when",
      "facets",
      "compatibility",
      "related",
      "status",
      "mcp_tool_name",
      "remote",
      "cli_command",
      "authority",
    ]);
    expect(tool.mcp_tool_name).toBe("summer_set_prop");
    expect(tool.remote).toBe(false); // explicit remote:false in the fixture (schema requires it)
    expect(tool.cli_command).toBe("summer node set-property");
    expect(tool.authority).toEqual({
      filesystem: false,
      editor_mutation: true,
      network: false,
      credentials: false,
      publish: false,
    });
    // skills never carry the tool-only fields
    const alpha = resources.find((r) => r.id === "skill/alpha-skill")!;
    for (const key of ["mcp_tool_name", "remote", "cli_command", "authority"]) {
      expect(Object.keys(alpha)).not.toContain(key);
    }
  });

  it("index.json remote follows surfaces.mcp.remote and cli_command is omitted without a CLI surface", () => {
    const root = copyBasicFixture();
    const yamlPath = path.join(root, "library", "tools", "set-node-property", "resource.yaml");
    const yaml = fs
      .readFileSync(yamlPath, "utf8")
      .replace("  cli:\n    command: summer node set-property\n", "")
      .replace("    remote: false\n", "    remote: true\n");
    fs.writeFileSync(yamlPath, yaml);
    const result = gen(root);
    const resources = (parse(result.files, "index.json").resources as Array<Record<string, unknown>>);
    const tool = resources.find((r) => r.id === "tool/set-node-property")!;
    expect(tool.remote).toBe(true);
    expect(Object.keys(tool)).not.toContain("cli_command");
    expect(tool.mcp_tool_name).toBe("summer_set_prop");
  });

  it("aliases.json maps every alias to its id, sorted", () => {
    const result = gen(basicRoot);
    const aliases = parse(result.files, "aliases.json");
    expect(aliases.aliases).toEqual({
      "references/ENGINE_VERSIONS.md": "reference/engine-versions",
      "skills/workflow/alpha-skill": "skill/alpha-skill",
    });
  });

  it("skills-registry.json uses SKILL.md frontmatter with slug/summary fallbacks", () => {
    const result = gen(basicRoot);
    const reg = parse(result.files, "skills-registry.json");
    expect(reg.skills).toEqual([
      {
        id: "skill/alpha-skill",
        name: "alpha-skill",
        description: 'Use when testing the compiler frontmatter path. Trigger on "alpha".',
        clients: "all",
        recommended: true,
        status: "stable",
        path: "library/skills/alpha-skill/",
      },
      {
        id: "skill/beta-skill",
        name: "beta-skill",
        description: "Fixture skill without frontmatter, exercising fallbacks.",
        clients: "all",
        recommended: false,
        status: "preview",
        path: "library/skills/beta-skill/",
      },
    ]);
  });

  it("every generated file ends with exactly one trailing newline", () => {
    const result = gen(basicRoot);
    for (const [, content] of result.files) {
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    }
  });
});

describe("generateRegistry: manifests (golden shapes)", () => {
  it("plugin.claude.json keeps the current field order and stamps version + tool count", () => {
    const result = gen(basicRoot);
    const manifest = parse(result.files, "plugin.claude.json");
    expect(Object.keys(manifest)).toEqual([
      "$schema",
      "_generated",
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "skills",
      "hooks",
      "mcpServers",
      "userConfig",
    ]);
    expect(manifest.version).toBe("9.9.9");
    expect(manifest.description).toContain("a 1-tool MCP bridge");
    expect(manifest.skills).toEqual([
      "./library/skills/alpha-skill/",
      "./library/skills/beta-skill/",
    ]);
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(manifest.mcpServers).toBe("./.mcp.json");
  });

  it("all manifests carry the full skill list (codex/cursor/factory/gemini gaps are fixed)", () => {
    const result = gen(basicRoot);
    const agents: Record<string, string> = {
      "plugin.claude.json": "claude",
      "plugin.codex.json": "codex",
      "plugin.cursor.json": "cursor",
      "plugin.factory.json": "factory",
      "gemini-extension.json": "gemini",
    };
    for (const [name, agent] of Object.entries(agents)) {
      const manifest = parse(result.files, name);
      expect(manifest.skills, name).toEqual([
        "./library/skills/alpha-skill/",
        "./library/skills/beta-skill/",
      ]);
      expect(manifest._generated, name).toBe(manifestBanner(agent));
    }
  });

  it("manifest banners name the integration they are built from", () => {
    expect(manifestBanner("claude")).toBe(
      "GENERATED from integrations/claude — do not edit; npm run generate:registry",
    );
    const result = gen(basicRoot);
    const marketplace = parse(result.files, "marketplace.claude.json");
    expect(marketplace._generated).toBe(manifestBanner("claude"));
  });

  it("per-agent format differences survive: cursor hooks file, codex interface, gemini mcp block, marketplace wrapper", () => {
    const result = gen(basicRoot);
    const cursor = parse(result.files, "plugin.cursor.json");
    expect(cursor.hooks).toBe("./hooks/hooks-cursor.json");
    expect(cursor.publisher).toBe("summer-engine");

    const codex = parse(result.files, "plugin.codex.json");
    const codexInterface = codex.interface as Record<string, unknown>;
    expect(codexInterface.displayName).toBe("Summer");
    expect(codexInterface.longDescription).toContain("a 1-tool MCP bridge");

    const gemini = parse(result.files, "gemini-extension.json");
    expect(gemini.contextFileName).toBe("GEMINI.md");
    expect((gemini.mcpServers as Record<string, unknown>)["summer-engine"]).toEqual({
      command: "npx",
      args: ["summer-engine", "mcp"],
      cwd: "${extensionPath}",
    });

    const marketplace = parse(result.files, "marketplace.claude.json");
    const plugin = (marketplace.plugins as Array<Record<string, unknown>>)[0];
    expect(plugin.version).toBe("9.9.9");
    expect(plugin.source).toBe("./");
  });
});

describe("generateRegistry: determinism", () => {
  it("two runs produce byte-identical output for every file", () => {
    const first = gen(basicRoot);
    const second = gen(basicRoot);
    expect([...second.files.keys()]).toEqual([...first.files.keys()]);
    for (const [name, content] of first.files) {
      expect(second.files.get(name), name).toBe(content);
    }
  });

  it("content hash changes when any file in the resource dir changes", () => {
    const root = copyBasicFixture();
    const dir = path.join(root, "library", "skills", "alpha-skill");
    const before = computeContentHash(dir);
    fs.appendFileSync(path.join(dir, "SKILL.md"), "\nMore.\n");
    expect(computeContentHash(dir)).not.toBe(before);
  });
});

describe("generateRegistry: failure modes", () => {
  it("fails on a duplicate alias across resources", () => {
    const root = path.join(fixtures, "alias-collision");
    expect(() => gen(root)).toThrow(GenerateError);
    expect(() => gen(root)).toThrow(/duplicate alias "skills\/legacy\/shared-name"/);
  });

  it("fails on duplicate aliases through the compiler's own check even with validation skipped", () => {
    const root = path.join(fixtures, "alias-collision");
    expect(() => generateRegistry(root, { skipValidation: true })).toThrow(
      /duplicate alias "skills\/legacy\/shared-name"/,
    );
  });

  it("fails when validate-library reports schema violations", () => {
    const root = copyBasicFixture();
    fs.writeFileSync(
      path.join(root, "library", "skills", "beta-skill", "resource.yaml"),
      "id: skill/beta-skill\nkind: skill\nversion: not-semver\nsummary: Bad.\nuse_when: [x]\nfacets:\n  lifecycle: [build]\nsource: official\nlicense: MIT\nstatus: stable\n",
    );
    expect(() => gen(root)).toThrow(GenerateError);
  });
});

describe("apply + check: the parity gate", () => {
  function generateAndApply(root: string) {
    const result = gen(root);
    writeGenerated(path.join(root, "registry", "generated"), result);
    applyManifests(root);
    return result;
  }

  it("apply copies every target byte-identically; check then passes", () => {
    const root = copyBasicFixture();
    const result = generateAndApply(root);
    for (const target of allTargets()) {
      const applied = fs.readFileSync(path.join(root, target.destination), "utf8");
      expect(applied, target.destination).toBe(result.files.get(target.generated));
    }
    const check = checkRegistry(root, { schemasDir });
    expect(check.drift).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("check flags a stale committed registry file", () => {
    const root = copyBasicFixture();
    generateAndApply(root);
    const target = path.join(root, "registry", "generated", "counts.json");
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace('"total": 4', '"total": 5'));
    const check = checkRegistry(root, { schemasDir });
    expect(check.ok).toBe(false);
    expect(check.drift.some((d) => d.startsWith("registry/generated/counts.json: stale"))).toBe(true);
  });

  it("check flags a stale applied root manifest", () => {
    const root = copyBasicFixture();
    generateAndApply(root);
    const manifest = path.join(root, ".claude-plugin", "plugin.json");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace('"9.9.9"', '"0.0.1"'));
    const check = checkRegistry(root, { schemasDir });
    expect(check.ok).toBe(false);
    expect(check.drift.some((d) => d.startsWith(".claude-plugin/plugin.json: stale"))).toBe(true);
  });

  it("check flags missing and extra generated files", () => {
    const root = copyBasicFixture();
    generateAndApply(root);
    fs.rmSync(path.join(root, "registry", "generated", "aliases.json"));
    fs.writeFileSync(path.join(root, "registry", "generated", "stray.json"), "{}\n");
    const check = checkRegistry(root, { schemasDir });
    expect(check.drift.some((d) => d.includes("aliases.json: missing"))).toBe(true);
    expect(check.drift.some((d) => d.includes("stray.json: extra file"))).toBe(true);
  });

  it("check flags a doc count claim that contradicts counts.json", () => {
    const root = copyBasicFixture();
    generateAndApply(root);
    fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n\nA 58-tool MCP bridge and 79 skills.\n");
    const check = checkRegistry(root, { schemasDir });
    expect(check.ok).toBe(false);
    expect(check.drift.some((d) => d.includes('"58-tool" says 58 but counts.json has 1 tools'))).toBe(true);
    expect(check.drift.some((d) => d.includes('"79 skills" says 79 but counts.json has 2 skills'))).toBe(true);
  });
});

describe("count-claims guard", () => {
  it("accepts matching claims and ignores non-exact phrasings", () => {
    const counts = { byKind: { tool: 1, skill: 2 } };
    expect(checkCountClaims(basicRoot, counts)).toEqual([]);
  });

  it("reports file, line, claim, found, and expected", () => {
    const root = tmpDir("genreg-claims-");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "line one\nWe ship 7 skills.\n");
    const violations = checkCountClaims(root, { byKind: { tool: 0, skill: 2 } });
    expect(violations).toEqual([
      { file: "AGENTS.md", line: 2, claim: "7 skills", found: 7, expected: 2, noun: "skills" },
    ]);
  });

  it("scans the docs that carry the live claims: references, CLAUDE.md, _persona, .opencode, docs/*.md, integrations", () => {
    const root = tmpDir("genreg-claims-scope-");
    const write = (rel: string, text: string) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    };
    write("CLAUDE.md", "70 tools here\n");
    write("library/references/mcp-tools-reference/mcp-tools-reference.md", "## Tool surface (70 tools)\n");
    write("_persona/summer/SOUL.md", "I know 70 tools\n");
    write(".opencode/INSTALL.md", "installs 83 skills\n");
    write("docs/OVERVIEW.md", "70 tools and 83 skills\n");
    write("docs/design/ROADMAP.md", "historical: 62 tools, 79 skills\n"); // NOT scanned (dated record)
    write("integrations/cursor/README.md", "a 5-skill gap\n");
    write("scripts/notes.md", "9 tools\n"); // NOT scanned
    expect(collectCountClaimFiles(root)).toEqual([
      ".opencode/INSTALL.md",
      "CLAUDE.md",
      "_persona/summer/SOUL.md",
      "docs/OVERVIEW.md",
      "integrations/cursor/README.md",
      "library/references/mcp-tools-reference/mcp-tools-reference.md",
    ]);
    const violations = checkCountClaims(root, { byKind: { tool: 69, skill: 83 } });
    expect(violations.map((v) => `${v.file}:${v.line} ${v.claim}`)).toEqual([
      "CLAUDE.md:1 70 tools",
      "_persona/summer/SOUL.md:1 70 tools",
      "docs/OVERVIEW.md:1 70 tools",
      "integrations/cursor/README.md:1 5-skill",
      "library/references/mcp-tools-reference/mcp-tools-reference.md:1 70 tools",
    ]);
  });

  it("claim pattern: no false positives on versions, compounds, or hyphenated modifiers", () => {
    const matches = (text: string) => [...text.matchAll(CLAIM_PATTERN)].map((m) => m[0]);
    expect(matches("Godot 4.6 tools are great")).toEqual([]); // "4.6 tools" = version
    expect(matches("every pre-v3 skill path has an alias")).toEqual([]); // "v3 skill" = version
    expect(matches("a 12 skills-based approach")).toEqual([]); // "skills-based"
    expect(matches("a 3-toolkit and a 3-tool-chain")).toEqual([]); // hyphen continues the compound
    expect(matches("ships 58-tool MCP bridge with 79 skills and 1 skill.")).toEqual(["58-tool", "79 skills", "1 skill"]);
  });
});

describe("integrations/ manifest-target.json parity with targets.ts", () => {
  it("every committed manifest-target.json matches MANIFEST_TARGETS exactly", () => {
    const integrationsDir = path.join(repoRoot, "integrations");
    const agents = fs
      .readdirSync(integrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(agents).toEqual(Object.keys(MANIFEST_TARGETS).sort());
    for (const agent of agents) {
      const committed = JSON.parse(
        fs.readFileSync(path.join(integrationsDir, agent, "manifest-target.json"), "utf8"),
      ) as { targets: unknown };
      expect(committed.targets, agent).toEqual(MANIFEST_TARGETS[agent]);
    }
  });

  it("every apply target has a corresponding generated manifest", () => {
    const result = gen(basicRoot);
    for (const target of allTargets()) {
      expect(result.files.has(target.generated), target.generated).toBe(true);
    }
  });
});
