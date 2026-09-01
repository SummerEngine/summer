/**
 * Count-claims guard — scans README.md, AGENTS.md, GEMINI.md for numeric
 * "N tools" / "N skills" claims and fails --check when a number contradicts
 * counts.json.
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

export const COUNT_CLAIM_FILES = ["README.md", "AGENTS.md", "GEMINI.md"];

const CLAIM_PATTERN = /\b(\d+)[ -](tools?|skills?)\b/g;

export interface CountClaimViolation {
  file: string;
  line: number;
  claim: string;
  found: number;
  expected: number;
  noun: "tools" | "skills";
}

export function checkCountClaims(
  rootDir: string,
  counts: { byKind: Record<string, number> },
): CountClaimViolation[] {
  const violations: CountClaimViolation[] = [];
  for (const file of COUNT_CLAIM_FILES) {
    const abs = path.join(rootDir, file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, "utf8").split("\n");
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
