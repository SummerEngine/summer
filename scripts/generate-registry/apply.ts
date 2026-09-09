/**
 * Apply step — copies generated agent manifests from registry/generated/ to
 * their repo-root destinations (.claude-plugin/plugin.json, etc.) so the
 * published package keeps its existing layout. Application is part of
 * generation; the --check gate verifies both copies stay in parity.
 */

import fs from "node:fs";
import path from "node:path";
import { allTargets } from "./targets.ts";

export interface ApplyResult {
  copied: Array<{ from: string; to: string }>;
}

export function applyManifests(rootDir: string, generatedDir?: string): ApplyResult {
  const genDir = generatedDir ?? path.join(rootDir, "registry", "generated");
  const copied: ApplyResult["copied"] = [];
  for (const target of allTargets()) {
    const from = path.join(genDir, target.generated);
    if (!fs.existsSync(from)) {
      throw new Error(`apply: generated manifest missing: ${from}`);
    }
    const to = path.join(rootDir, target.destination);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(from));
    copied.push({ from: path.relative(rootDir, from), to: target.destination });
  }
  return { copied };
}
