import { describe, expect, it } from "vitest";
import { lintText, parseAllowedHosts } from "../../../scripts/validate-library/capability-lint.ts";
import { validateAgainstSchema } from "../../../scripts/validate-library/json-schema.ts";

const allowed = parseAllowedHosts([
  "summerengine.com",
  "docs.summerengine.com",
  "github.com/SummerEngine",
  "raw.githubusercontent.com/SummerEngine",
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

  it("rejects other hosts, other GitHub orgs, and lookalike subdomains", () => {
    for (const url of [
      "https://example.com/x",
      "https://github.com/OtherOrg/repo",
      "https://evil.summerengine.com.attacker.tld/x",
      "https://www.summerengine.com/x",
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

  it("flags npx targeting any other package", () => {
    const findings = lintText("Run npx some-other-tool now", "test", allowed);
    expect(findings.some((f) => f.rule === "install-command" && f.message.includes("some-other-tool"))).toBe(true);
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
