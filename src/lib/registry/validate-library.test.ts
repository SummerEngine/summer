import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runValidation, MEDIA_SIZE_LIMIT_BYTES, SKILL_DESCRIPTION_BUDGET } from "../../../scripts/validate-library/index.ts";
import { argumentNames, checkCallExamples, type ToolSignature } from "../../../scripts/validate-library/call-examples.ts";
import { escapingSkillPaths } from "../../../scripts/validate-library/skill-links.ts";
import { checkSceneEditExamples } from "../../../scripts/validate-library/scene-edits.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fixtures = path.join(repoRoot, "scripts", "validate-library", "fixtures");
const schemasDir = path.join(repoRoot, "registry", "schemas");

function run(fixture: string) {
  return runValidation(path.join(fixtures, fixture), { schemasDir });
}

describe("validate-library: clean states", () => {
  it("passes a valid library with all six kinds", () => {
    const result = run("valid");
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.resourceCount).toBe(6);
    expect(result.exceptions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("exits ok with a note when library/ does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-no-library-"));
    try {
      const result = runValidation(tmp, { schemasDir });
      expect(result.ok).toBe(true);
      expect(result.resourceCount).toBe(0);
      expect(result.note).toMatch(/does not exist/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits ok with a note when library/ is empty", () => {
    const result = run("empty-library");
    expect(result.ok).toBe(true);
    expect(result.resourceCount).toBe(0);
    expect(result.note).toMatch(/no resources/);
  });
});

describe("validate-library: schema violations", () => {
  const result = run("invalid-schema");

  it("fails overall", () => {
    expect(result.ok).toBe(false);
  });

  it.each([
    ["bad semver version", /tools\/bad-tool.*version: must match pattern/],
    ["summary over 160 chars", /tools\/bad-tool.*summary: must be at most 160 characters/],
    ["authority missing a required boolean", /tools\/bad-tool.*authority: missing required field "publish"/],
    ["unknown extra field rejected", /tools\/bad-tool.*extra_field: unknown field/],
    ["example without evidence", /examples\/no-evidence.*missing required field "evidence"/],
    ["invalid lifecycle facet", /skills\/bad-enums.*lifecycle\[0\]: must be one of \["build","launch","grow","support"\]/],
    ["invalid status enum", /skills\/bad-enums.*status: must be one of \["stable","preview","deprecated"\]/],
    ["domain token outside registry/schemas/domains.json", /skills\/bad-enums.*facets\.domains\[0\]: unknown domain "retro-vibes"; allowed: 2d, 3d, agent-workflow, .* \(add it to registry\/schemas\/domains\.json by PR\)/],
    ["modality token outside registry/schemas/domains.json", /skills\/bad-enums.*facets\.modalities\[0\]: unknown modality "hologram"; allowed: 3d-models, animation, .* \(add it to registry\/schemas\/domains\.json by PR\)/],
    ["template commit not 40-hex", /templates\/bad-pin.*commit: must match pattern \^\[0-9a-f\]\{40\}\$/],
    ["template tree_digest not sha256", /templates\/bad-pin.*tree_digest: must match pattern/],
    ["template that is builtin AND pinned", /templates\/builtin-with-pin.*matches 2 of the allowed shapes \(oneOf\)/],
    ["stable collection item without sha256", /collections\/stable-no-sha.*items\[0\]: sha256 is required when status is "stable"/],
  ])("reports %s", (_name, pattern) => {
    expect(result.errors.some((e) => pattern.test(e))).toBe(true);
  });

  it("does not flag vocabulary tokens that are listed (bad-enums also carries \"scenes\" at index 1)", () => {
    expect(result.errors.some((e) => /facets\.(domains|modalities)\[1\]/.test(e))).toBe(false);
  });
});

describe("validate-library: controlled vocabularies (registry/schemas/domains.json)", () => {
  const vocab = JSON.parse(fs.readFileSync(path.join(schemasDir, "domains.json"), "utf8")) as Record<string, unknown>;

  it.each(["domains", "modalities"])("%s is a sorted, duplicate-free list of kebab-case tokens", (key) => {
    const list = vocab[key] as string[];
    expect(Array.isArray(list) && list.length > 0).toBe(true);
    expect(list).toEqual([...new Set(list)].sort());
    for (const token of list) expect(token).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("validate-library: identity violations", () => {
  const result = run("invalid-identity");

  it("fails overall", () => {
    expect(result.ok).toBe(false);
  });

  it.each([
    ["duplicate id", /duplicate id "skill\/dup-a" declared by: library\/skills\/dup-a, library\/skills\/dup-b/],
    ["duplicate alias", /duplicate alias "legacy\/skills\/one"/],
    ["alias colliding with a live id", /alias "skill\/dup-a".*collides with a live resource id/],
    ["related target missing", /related\.examples\[0\]: target "example\/does-not-exist" does not exist/],
    ["id not matching its directory", /id "skill\/dup-a" does not match its directory — expected "skill\/dup-b"/],
  ])("reports %s", (_name, pattern) => {
    expect(result.errors.some((e) => pattern.test(e))).toBe(true);
  });
});

describe("validate-library: id namespacing (CONTRACT.md §4)", () => {
  function writeSkill(root: string, dir: string, id: string): void {
    const abs = path.join(root, "library", "skills", dir);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "SKILL.md"), `---\nname: ${dir}\ndescription: Fixture skill used to exercise publisher-namespaced ids.\n---\n\n# ${dir}\n`);
    fs.writeFileSync(
      path.join(abs, "resource.yaml"),
      [
        `id: ${id}`,
        "kind: skill",
        "version: 1.0.0",
        "summary: Fixture skill used to exercise publisher-namespaced ids.",
        "use_when:",
        "  - testing id namespacing",
        "  - checking how the validator treats a publisher prefix on an id",
        "facets:",
        "  lifecycle: [build]",
        "  domains: [meta, verification]",
        "source: official",
        "license: MIT",
        "status: stable",
        "",
      ].join("\n"),
    );
  }

  it("the schema accepts a <publisher>/<kind>/<slug> id; the library rejects it as side-load-only (not a pattern violation)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-namespaced-"));
    try {
      writeSkill(tmp, "forest-kit", "acme/skill/forest-kit");
      const result = runValidation(tmp, { schemasDir });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => /id: must match pattern/.test(e))).toBe(false);
      expect(
        result.errors.some((e) =>
          /id "acme\/skill\/forest-kit" is publisher-namespaced — namespaced ids are only valid for side-loaded resources outside library\/; official resources use "skill\/forest-kit"/.test(e),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still rejects malformed publisher prefixes at the schema level", () => {
    for (const bad of ["Acme/skill/forest-kit", "acme//skill/forest-kit", "-acme/skill/forest-kit", "acme/acme/skill/forest-kit"]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-namespaced-bad-"));
      try {
        writeSkill(tmp, "forest-kit", bad);
        const result = runValidation(tmp, { schemasDir });
        expect(result.errors.some((e) => /id: must match pattern/.test(e)), bad).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
});

describe("validate-library: cross-checks against host code (descriptors may not describe fiction)", () => {
  const result = run("invalid-crosscheck");

  it("fails overall", () => {
    expect(result.ok).toBe(false);
  });

  it.each([
    ["(a) implementation.module that does not resolve under src/", /tools\/ghost-module.*implementation\.module: "src\/core\/capabilities\/does-not-exist\.ts" does not resolve to a file under .*\/src\//],
    ["(b) descriptor tool_name with no server.tool() registration", /tools\/unregistered.*surfaces\.mcp\.tool_name "summer_unregistered" is not registered by any server\.tool\(\) call in src\/mcp/],
    ["(b) server.tool() registration with no descriptor", /src\/mcp\/tools\/fixture-tools\.ts: MCP tool "summer_orphan_registration" is registered but has no library\/tools\/<slug>\/resource\.yaml descriptor/],
    ["(c) input_schema with a non-object type", /tools\/bad-input-schema.*input_schema: type must be "object", got "banana"/],
    ["(c) input_schema with non-object properties", /tools\/bad-input-schema.*input_schema: properties must be an object mapping names to schemas, got 5/],
    ["(c) property without any type keyword", /tools\/untyped-prop.*input_schema: properties\.foo has no type/],
    ["(c) property with a made-up type", /tools\/untyped-prop.*input_schema: properties\.bar\.type "strang" is not a JSON Schema type/],
    ["(c) required naming an unknown property", /tools\/untyped-prop.*input_schema: required names "baz" which is not in properties/],
    ["(d) evidence.verified_at in the future", /examples\/future-evidence.*evidence\.verified_at: "2999-01-01" is in the future \(today is \d{4}-\d{2}-\d{2}\)/],
    ["(d) evidence.verified_at that is not a real date", /examples\/impossible-date.*evidence\.verified_at: "2026-13-45" is not a real calendar date/],
    ["(e) SKILL.md frontmatter name != slug", /skills\/wrong-name\/SKILL\.md: frontmatter name "something-else" does not match the slug "wrong-name" and is not listed in aliases/],
    ["(e) SKILL.md without a frontmatter name", /skills\/nameless\/SKILL\.md: frontmatter is missing "name"/],
  ])("reports %s", (_name, pattern) => {
    expect(result.errors.some((e) => pattern.test(e))).toBe(true);
  });

  it("(e) accepts a frontmatter name that is a declared alias", () => {
    expect(result.errors.some((e) => /skills\/aliased-name/.test(e))).toBe(false);
  });

  it("(a)/(b) do not fire on descriptors whose module exists and whose tool is registered", () => {
    expect(result.errors.some((e) => /summer_ghost"/.test(e) && /not registered/.test(e))).toBe(false);
    expect(result.errors.some((e) => /tools\/unregistered.*implementation\.module/.test(e))).toBe(false);
  });

  it("(b) fails closed when src/mcp is absent but descriptors declare MCP surfaces", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-no-mcp-"));
    try {
      fs.cpSync(path.join(fixtures, "valid"), tmp, { recursive: true });
      fs.rmSync(path.join(tmp, "src", "mcp"), { recursive: true, force: true });
      const r = runValidation(tmp, { schemasDir });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => /cannot cross-check surfaces\.mcp\.tool_name: src\/mcp not found/.test(e))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("validate-library: minimum routing metadata", () => {
  const result = run("invalid-metadata");

  it("fails overall", () => {
    expect(result.ok).toBe(false);
  });

  it.each([
    ["summary under 40 chars (schema)", /skills\/thin.*summary: must be at least 40 character\(s\), got 10/],
    ["use_when item under 12 chars (schema)", /skills\/thin.*use_when\[0\]: must be at least 12 character\(s\), got 5/],
    ["skill with one use_when item", /skills\/thin.*use_when has 1 item\(s\) — a skill needs at least 2 \(each item is a distinct situation/],
    ["skill with one domain", /skills\/thin.*facets\.domains has 1 item\(s\) \[scenes\] — a skill needs at least 2 domains from registry\/schemas\/domains\.json/],
    ["use_when item identical to the summary", /references\/echo.*use_when\[0\] repeats the summary verbatim/],
  ])("reports %s", (_name, pattern) => {
    expect(result.errors.some((e) => pattern.test(e))).toBe(true);
  });

  it("lets a template carry one use_when and one domain", () => {
    expect(result.errors.filter((e) => /templates\/lone/.test(e))).toEqual([]);
  });

  it("does not flag the second, situation-style use_when item of the echo reference", () => {
    expect(result.errors.some((e) => /references\/echo.*use_when\[1\]/.test(e))).toBe(false);
  });
});

describe("validate-library: reciprocity hint (warning, never an error)", () => {
  const result = run("reciprocity");

  it("stays ok with no errors", () => {
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("warns once per one-way skill->skill link; reciprocated pairs and non-skill sources stay silent", () => {
    expect(result.warnings).toEqual([
      "library/skills/alpha/resource.yaml: related.skills lists skill/beta, but library/skills/beta/resource.yaml does not list skill/alpha back (reciprocity hint)",
    ]);
  });
});

describe("validate-library: file requirements", () => {
  const result = run("invalid-files");

  it.each([
    ["skill without SKILL.md", /skills\/no-skill-md: skill is missing SKILL\.md/],
    ["reference without a body .md", /references\/no-body: reference is missing a body \.md file/],
    ["evidence media path that does not exist", /examples\/missing-media.*evidence\.media\[0\]\.path does not exist/],
  ])("reports %s", (_name, pattern) => {
    expect(result.errors.some((e) => pattern.test(e))).toBe(true);
  });

  it("rejects in-repo evidence media over 200KB", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-media-"));
    try {
      const dir = path.join(tmp, "library", "examples", "big-media", "evidence");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "huge.png"), Buffer.alloc(MEDIA_SIZE_LIMIT_BYTES + 1));
      fs.writeFileSync(
        path.join(tmp, "library", "examples", "big-media", "resource.yaml"),
        [
          "id: example/big-media",
          "kind: example",
          "version: 1.0.0",
          "summary: Example with an oversized in-repo screenshot.",
          "use_when:",
          "  - testing media size limits",
          "  - checking that oversized evidence media is pushed to URL + sha256",
          "facets:",
          "  lifecycle: [build]",
          "  domains: [meta, verification]",
          "source: official",
          "license: MIT",
          "status: stable",
          "evidence:",
          '  engine_version: "4.6.1"',
          "  verified_at: 2026-09-01",
          "  checks: [runs]",
          "  media:",
          "    - path: evidence/huge.png",
          "",
        ].join("\n"),
      );
      const result = runValidation(tmp, { schemasDir });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => /huge\.png: in-repo evidence media is \d+ bytes \(> 204800 = 200KB\)/.test(e))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("validate-library: capability lint", () => {
  const result = run("invalid-lint");

  it("fails overall", () => {
    expect(result.ok).toBe(false);
  });

  it.each([
    ["URL outside the allowlist", /\[url-allowlist\] body\.md: URL host not in registry\/schemas\/allowed-hosts\.json: https:\/\/evil\.example\.com\/payload/],
    ["install command (npm install)", /\[install-command\] body\.md: install command detected \(npm install\)/],
    ["pipe-to-shell (curl | sh)", /\[install-command\] body\.md: install command detected \(curl \| sh\)/],
    ["credential pattern in markdown (~/.ssh)", /\[credential-pattern\] body\.md: credential\/env pattern detected \(~\/\.ssh\)/],
    ["credential pattern in resource.yaml strings (token=)", /\[credential-pattern\] resource\.yaml use_when\[0\]: credential\/env pattern detected \(token=\)/],
    ["base64 blob at or over 160 chars", /\[base64-blob\] body\.md: encoded blob detected/],
    ["invisible unicode (zero-width space)", /\[invisible-unicode\] body\.md: invisible\/bidi unicode character detected \(U\+200B\)/],
    ["prompt-injection phrase", /\[prompt-injection-phrase\] body\.md: prompt-injection phrase detected \("ignore \(all\) previous\/prior\/above\/earlier"\)/],
    ["lint_exceptions without lint_exception_reason", /exception-no-reason.*field "lint_exceptions" requires field "lint_exception_reason"/],
  ])("reports %s", (_name, pattern) => {
    expect(result.errors.some((e) => pattern.test(e))).toBe(true);
  });

  it("allows an excepted rule but reports it loudly", () => {
    const excepted = run("exceptions");
    expect(excepted.ok).toBe(true);
    expect(excepted.errors).toEqual([]);
    expect(excepted.exceptions).toHaveLength(1);
    expect(excepted.exceptions[0]).toContain('LINT EXCEPTION "url-allowlist"');
    expect(excepted.exceptions[0]).toContain("Asset licenses require linking the original author pages.");
  });
});

// "the shipped library fits the budget" validates the whole library: slow on a busy machine.
describe("validate-library: skills as installed (budget, links, call examples)", () => {
  function withSkillBody(body: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-skill-body-"));
    fs.cpSync(path.join(fixtures, "valid"), tmp, { recursive: true });
    const skillMd = path.join(tmp, "library", "skills", "create-environment-kit", "SKILL.md");
    fs.writeFileSync(skillMd, `${fs.readFileSync(skillMd, "utf8")}\n${body}\n`);
    try {
      return runValidation(tmp, { schemasDir });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("sums the installed skills' descriptions against the budget", () => {
    const result = run("valid");
    expect(result.skillDescriptionChars).toBe("Build a coherent, reusable environment kit for a scene.".length);
    expect(result.skillDescriptionChars!).toBeLessThanOrEqual(SKILL_DESCRIPTION_BUDGET);
  });

  it("the shipped library fits the budget", () => {
    const result = runValidation(repoRoot, { schemasDir });
    expect(result.skillDescriptionChars!).toBeLessThanOrEqual(SKILL_DESCRIPTION_BUDGET);
    expect(result.errors.filter((e) => /skill descriptions total/.test(e))).toEqual([]);
  });

  it("rejects a path that climbs out of the skill folder, and accepts a library id", () => {
    const bad = withSkillBody("See `../../references/gd-style/gd-style.md` and [the kit](../other-skill/SKILL.md).");
    expect(bad.errors.filter((e) => /leaves the skill folder/.test(e))).toHaveLength(2);
    const good = withSkillBody("See `summer_docs_read` id `reference/gd-style`.");
    expect(good.errors).toEqual([]);
  });

  it("rejects a call example without a required argument or with one the tool does not take", () => {
    const bad = withSkillBody('```\nsummer_set_prop(node_path="./A")\nsummer_set_prop(node_path="./A", value="1", colour="red")\n```');
    expect(bad.errors.some((e) => /summer_set_prop example leaves out required value/.test(e))).toBe(true);
    expect(bad.errors.some((e) => /summer_set_prop example passes colour, which the tool does not take/.test(e))).toBe(true);
    const good = withSkillBody('```\nsummer_set_prop(node_path="./A", value="1")\nsummer_set_prop(node_path="./A", ...)\n```');
    expect(good.errors).toEqual([]);
    expect(good.callExamples).toEqual({ checked: 1, skipped: 1 });
  });

  it("rejects a chain of 4 single scene edits unless the line before the fence says why", () => {
    const calls = Array.from({ length: 4 }, () => 'summer_set_prop(node_path="./A", value="1")').join("\n");
    const bad = withSkillBody(`\`\`\`\n${calls}\n\`\`\``);
    expect(bad.errors.filter((e) => /chains 4 single scene edits/.test(e))).toHaveLength(1);
    const marked = withSkillBody(`<!-- single-edits-ok: the before picture -->\n\`\`\`\n${calls}\n\`\`\``);
    expect(marked.errors).toEqual([]);
    expect(marked.sceneEditBlocks).toBeGreaterThan(0);
  });
}, 60_000);

describe("scene-edit examples: one script, not a chain", () => {
  const chain = (n: number) =>
    Array.from({ length: n }, (_, i) => `summer_set_prop(scenePath="res://a.tscn", path="./A", key="k${i}", value="1")`).join("\n");

  it("flags a block of 4 single scene edits and keeps one of 3", () => {
    expect(checkSceneEditExamples(`\`\`\`\n${chain(4)}\n\`\`\``)).toEqual({ blocks: 1, problems: [{ line: 1, kind: "chain", calls: 4 }] });
    expect(checkSceneEditExamples(`\`\`\`\n${chain(3)}\n\`\`\``)).toEqual({ blocks: 1, problems: [] });
  });

  it("accepts a chain the line before the fence explains, and counts across tools", () => {
    expect(checkSceneEditExamples(`<!-- single-edits-ok: shows what the script replaces -->\n\`\`\`\n${chain(5)}\n\`\`\``).problems).toEqual([]);
    const mixed = "```\nsummer_add_node(a)\nsummer_set_prop(b)\nsummer_connect_signal(c)\nsummer_instantiate_scene(d)\n```";
    expect(checkSceneEditExamples(mixed).problems).toEqual([{ line: 1, kind: "chain", calls: 4 }]);
  });

  it("ignores prose outside fences and names untyped inference from ctx", () => {
    expect(checkSceneEditExamples(`${chain(6)}\n`).problems).toEqual([]);
    const script = "Intro\n```\nfunc run(ctx):\n    var a := ctx.add_node(\"Node3D\", \"A\")\n    var b = ctx.find(\"B\")\n    var c := Vector3.ZERO\n```";
    expect(checkSceneEditExamples(script)).toEqual({ blocks: 1, problems: [{ line: 4, kind: "untyped_ctx" }] });
  });
});

describe("skill links: what counts as leaving the folder", () => {
  it("flags ../ escapes from SKILL.md and from references/, keeps paths inside and NodePaths", () => {
    expect(escapingSkillPaths("`../../references/a/a.md` and `../other/SKILL.md`", "SKILL.md")).toEqual([
      "../../references/a/a.md",
      "../other/SKILL.md",
    ]);
    expect(escapingSkillPaths("[back](../SKILL.md) and `../../x/references/y.md`", "references/notes.md")).toEqual(["../../x/references/y.md"]);
    expect(escapingSkillPaths("anim_player is `../AnimationPlayer` from a sibling", "SKILL.md")).toEqual([]);
    expect(escapingSkillPaths('```\nNodePath("../World")\nsee ../../references/a/a.md\n```', "SKILL.md")).toEqual([]);
    expect(escapingSkillPaths("read ../../references/a/a.md first", "SKILL.md")).toEqual(["../../references/a/a.md"]);
  });
});

describe("call examples: argument names", () => {
  const tools = new Map<string, ToolSignature>([
    ["summer_add_node", { required: ["scenePath", "parent", "type"], properties: ["scenePath", "parent", "type", "name"] }],
    ["summer_app_screenshot", { required: ["appId"], properties: ["appId", "width", "theme"] }],
  ]);

  it("reads keyword, positional-name, JSON and shorthand-object forms", () => {
    expect(argumentNames('scenePath="res://a.tscn", parent="./", type="Node3D"')).toEqual(["scenePath", "parent", "type"]);
    expect(argumentNames("scenePath, parent, type")).toEqual(["scenePath", "parent", "type"]);
    expect(argumentNames('{"appId": "a", "width": 390}')).toEqual(["appId", "width"]);
    expect(argumentNames('{ appId, theme: "dark", nested: { a: 1, b } }')).toEqual(["appId", "theme", "nested"]);
    expect(argumentNames('scenePath="res://a.tscn", ...')).toBeNull();
    expect(argumentNames('"res://a.tscn"')).toBeNull();
  });

  it("checks both written forms against the signature and skips unknown tools", () => {
    const text = [
      'summer_add_node(parent="./", type="Node3D")',
      'summer_add_node(scenePath="res://a.tscn", parent="./", type="Node3D", name="A")',
      "`summer_app_screenshot {width: 390}`",
      "summer_store_submit(gameId)",
    ].join("\n");
    const result = checkCallExamples(text, tools);
    expect(result.checked).toBe(3);
    expect(result.problems).toEqual([
      { tool: "summer_add_node", line: 1, missing: ["scenePath"], unknown: [] },
      { tool: "summer_app_screenshot", line: 3, missing: ["appId"], unknown: [] },
    ]);
  });
});

describe("validate-library: 3.x docs-area tool names", () => {
  const result = run("retired-tool-names");

  it("fails overall", () => {
    expect(result.ok).toBe(false);
  });

  it.each([
    ["summer_search_library", 3, /write summer_docs_search$/],
    ["summer_read_library", 3, /write summer_docs_read$/],
    ["summer_library_feedback", 5, /write summer_call \{"op":"docs\.feedback"\}$/],
  ])("names %s on its line with the 4.0 form", (name, line, fix) => {
    const hit = result.errors.find((e) => e.includes(`body.md:${line}: "${name}"`));
    expect(hit).toMatch(fix);
  });

  it("allows a 3.x name called through summer_call or explained as 3.x", () => {
    expect(result.errors.filter((e) => /body\.md:(7|9):/.test(e))).toEqual([]);
    expect(result.errors).toHaveLength(3);
  });
});
