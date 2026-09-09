/**
 * Count-claims guard — scans the docs that actually make numeric "N tools" /
 * "N skills" claims and fails --check when a number contradicts counts.json.
 *
 * Scope (the earlier README/AGENTS/GEMINI-only scan guarded nothing: those
 * files carry no numeric claims — the live "70 tools" literal sat unscanned in
 * library/references/mcp-tools-reference/):
 *   README.md, AGENTS.md, GEMINI.md, CLAUDE.md,
 *   library/references/** /*.md, _persona/** /*.md, .opencode/** /*.md,
 *   docs/*.md (top level only — docs/design/ is a dated historical record),
 *   integrations/** /*.md
 *
 * Honest limitations (documented, deliberate):
 *  - Only exact numeric claims match: "58 tools", "58-tool", "3 skill".
 *  - "50+ tools", spelled-out numbers ("fifty tools"), and prose that
 *    separates the number from the noun are NOT checked.
 *  - Every match is compared against the library counts; a doc counting
 *    something else under the same noun must rephrase (that ambiguity is
 *    the drift this guard exists to kill).
 */

import fs from "node:fs";
import path from "node:path";

/** Root-level files scanned when present. */
export const COUNT_CLAIM_FILES = ["README.md", "AGENTS.md", "GEMINI.md", "CLAUDE.md"];

/** Directories scanned recursively for *.md. */
export const COUNT_CLAIM_DIRS = ["library/references", "_persona", ".opencode", "integrations"];

/** Directories scanned non-recursively for *.md. */
export const COUNT_CLAIM_SHALLOW_DIRS = ["docs"];

/**
 * (?<![\w.]) — "4.6 tools" is a version, not a count; "pre-v3 skill" is a
 *              version too (the number must not continue a word).
 * [ -]        — "58 tools" / "58-tool".
 * (?![\w-])   — "skills-based", "3-toolkit", "3-tool-chain" are not claims.
 */
export const CLAIM_PATTERN = /(?<![\w.])(\d+)[ -](tools?|skills?)(?![\w-])/g;

export interface CountClaimViolation {
  file: string;
  line: number;
  claim: string;
  found: number;
  expected: number;
  noun: "tools" | "skills";
}

function walkMarkdown(dir: string, recursive: boolean, out: string[]): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && entry.name !== "node_modules") walkMarkdown(abs, true, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(abs);
    }
  }
}

/** Every file the guard scans, as sorted repo-relative POSIX paths. */
export function collectCountClaimFiles(rootDir: string): string[] {
  const abs: string[] = [];
  for (const file of COUNT_CLAIM_FILES) {
    const p = path.join(rootDir, file);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) abs.push(p);
  }
  for (const dir of COUNT_CLAIM_DIRS) walkMarkdown(path.join(rootDir, dir), true, abs);
  for (const dir of COUNT_CLAIM_SHALLOW_DIRS) walkMarkdown(path.join(rootDir, dir), false, abs);
  return abs.map((p) => path.relative(rootDir, p).split(path.sep).join("/")).sort();
}

export function checkCountClaims(
  rootDir: string,
  counts: { byKind: Record<string, number> },
): CountClaimViolation[] {
  const violations: CountClaimViolation[] = [];
  for (const file of collectCountClaimFiles(rootDir)) {
    const lines = fs.readFileSync(path.join(rootDir, file), "utf8").split("\n");
    lines.forEach((text, idx) => {
      for (const match of text.matchAll(CLAIM_PATTERN)) {
        const found = Number(match[1]);
        const noun = match[2].startsWith("tool") ? "tools" : "skills";
        const expected = noun === "tools" ? (counts.byKind.tool ?? 0) : (counts.byKind.skill ?? 0);
        if (found !== expected) {
          violations.push({ file, line: idx + 1, claim: match[0], found, expected, noun });
        }
      }
    });
  }
  return violations;
}
