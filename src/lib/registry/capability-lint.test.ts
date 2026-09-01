import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { lintText, parseAllowedHosts } from "../../../scripts/validate-library/capability-lint.ts";
import { validateAgainstSchema, type JsonSchema, type SchemaStore } from "../../../scripts/validate-library/json-schema.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const schemasDir = path.join(repoRoot, "registry", "schemas");

const allowed = parseAllowedHosts([
  "summerengine.com",
  "docs.summerengine.com",
  "github.com/SummerEngine",
  "raw.githubusercontent.com/SummerEngine",
  "github.com/orgs/SummerEngine",
  "agentskills.io",
]);

describe("capability lint: URL allowlist", () => {
  it("allows exact hosts and org-scoped path prefixes", () => {
    const clean = [
      "See https://summerengine.com/pricing and https://docs.summerengine.com/skills.",
      "Repo: https://github.com/SummerEngine/summer at any path.",
      "Raw: https://raw.githubusercontent.com/SummerEngine/summer/main/README.md",
    ].join("\n");
    expect(lintText(clean, "test", allowed)).toEqual([]);
  });

  it("allows the org-listing URL form via the github.com/orgs/SummerEngine entry", () => {
    expect(lintText("Browse https://github.com/orgs/SummerEngine/repositories for templates.", "test", allowed)).toEqual([]);
    expect(lintText("Spec: https://agentskills.io/specification", "test", allowed)).toEqual([]);
  });

  it("allows loopback URLs on any port (bundled local servers)", () => {
    const clean = [
      "Preview at http://localhost:52341/preview once the companion starts.",
      "The bridge listens on http://127.0.0.1:6550.",
      "Plain https://localhost/health also works.",
    ].join("\n");
    expect(lintText(clean, "test", allowed)).toEqual([]);
  });

  it("rejects other hosts, other GitHub orgs, and lookalike subdomains", () => {
    for (const url of [
      "https://example.com/x",
      "https://github.com/OtherOrg/repo",
      "https://github.com/orgs/OtherOrg/repositories",
      "https://evil.summerengine.com.attacker.tld/x",
      "https://www.summerengine.com/x",
      "https://localhost.attacker.tld/x",
    ]) {
      const findings = lintText(`link: ${url}`, "test", allowed);
      expect(findings.map((f) => f.rule)).toContain("url-allowlist");
    }
  });
});

describe("capability lint: npx targeting", () => {
  it("allows npx summer-engine (with and without -y / version)", () => {
    expect(lintText("Run npx -y summer-engine@latest setup", "test", allowed)).toEqual([]);
    expect(lintText("Run npx summer-engine doctor", "test", allowed)).toEqual([]);
  });

  it("flags npx executing a plausible third-party package token", () => {
    for (const [text, pkg] of [
      ["Run npx some-other-tool now", "some-other-tool"],
      ["Run npx clear-npx-cache && npx -y summer-engine@latest setup", "clear-npx-cache"],
      ["Run npx @scope/tool", "@scope/tool"],
      ["Run npx create-vite2 my-app", "create-vite2"],
    ] as const) {
      const findings = lintText(text, "test", allowed);
      expect(findings.some((f) => f.rule === "install-command" && f.message.includes(pkg))).toBe(true);
    }
  });

  it("flags a forced exec (-y/--yes) even for a bare-word token", () => {
    const findings = lintText("Run npx -y something now", "test", allowed);
    expect(findings.some((f) => f.rule === "install-command" && f.message.includes("something"))).toBe(true);
  });

  it("does not flag prose that merely mentions npx", () => {
    const prose = [
      "`@latest` forces npm/npx to resolve the current published Summer CLI.",
      "This clears old npx package material on machines that keep serving an older Summer.",
      "Use npx when the CLI is not installed globally.",
    ].join("\n");
    expect(lintText(prose, "test", allowed)).toEqual([]);
  });
});

describe("json-schema mini validator: strictness", () => {
  it("throws on unsupported keywords instead of silently skipping them", () => {
    expect(() => validateAgainstSchema({}, { propertyNames: { pattern: "^x" } }, new Map())).toThrow(/unsupported JSON Schema keyword "propertyNames"/);
  });

  it("throws on refs to unknown schema documents", () => {
    expect(() => validateAgainstSchema({}, { $ref: "nope.schema.json" }, new Map())).toThrow(/unknown document/);
  });
});

describe("tool.schema.json: surfaces.mcp.remote", () => {
  function loadStore(): SchemaStore {
    const store: SchemaStore = new Map();
    for (const file of ["resource.schema.json", "tool.schema.json"]) {
      store.set(file, JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8")) as JsonSchema);
    }
    return store;
  }

  function loadFixtureTool(): Record<string, unknown> {
    const yamlPath = path.join(
      repoRoot,
      "scripts",
      "validate-library",
      "fixtures",
      "valid",
      "library",
      "tools",
      "set-node-property",
      "resource.yaml",
    );
    return parseYaml(fs.readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  }

  it("accepts remote: true (CONTRACT.md §5 hosted stateless MCP flag)", () => {
    const store = loadStore();
    const tool = loadFixtureTool();
    (tool.surfaces as Record<string, Record<string, unknown>>).mcp.remote = true;
    expect(validateAgainstSchema(tool, store.get("tool.schema.json")!, store)).toEqual([]);
  });

  it("rejects non-boolean remote values", () => {
    const store = loadStore();
    for (const bad of ["yes", 1, null, {}]) {
      const tool = loadFixtureTool();
      (tool.surfaces as Record<string, Record<string, unknown>>).mcp.remote = bad;
      const errors = validateAgainstSchema(tool, store.get("tool.schema.json")!, store);
      expect(errors.length).toBeGreaterThan(0);
    }
  });
});
