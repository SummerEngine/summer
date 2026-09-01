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
    ["template commit not 40-hex", /templates\/bad-pin.*commit: must match pattern \^\[0-9a-f\]\{40\}\$/],
    ["template tree_digest not sha256", /templates\/bad-pin.*tree_digest: must match pattern/],
    ["stable collection item without sha256", /collections\/stable-no-sha.*items\[0\]: sha256 is required when status is "stable"/],
  ])("reports %s", (_name, pattern) => {
    expect(result.errors.some((e) => pattern.test(e))).toBe(true);
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
          "facets:",
          "  lifecycle: [build]",
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
    ["base64 blob over 200 chars", /\[base64-blob\] body\.md: encoded blob detected/],
    ["invisible unicode (zero-width space)", /\[invisible-unicode\] body\.md: invisible\/bidi unicode character detected \(U\+200B\)/],
    ["prompt-injection phrase", /\[prompt-injection-phrase\] body\.md: prompt-injection phrase detected \("ignore previous"\)/],
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
