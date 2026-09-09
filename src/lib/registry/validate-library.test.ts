import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runValidation, MEDIA_SIZE_LIMIT_BYTES } from "../../../scripts/validate-library/index.ts";

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
    fs.writeFileSync(path.join(abs, "SKILL.md"), `---\nname: ${dir}\ndescription: Fixture.\n---\n\n# ${dir}\n`);
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
