import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const exportSkill = readFileSync(
  resolve(packageRoot, "library/skills/export-and-ship/SKILL.md"),
  "utf8"
);
const remoteDeploySkill = readFileSync(
  resolve(packageRoot, "library/skills/remote-deploy/SKILL.md"),
  "utf8"
);

describe("repo-lint: deployment skills prove capabilities before actions", () => {
  it("places export capability proof before destination choice or commands", () => {
    const proof = exportSkill.indexOf("### 1. Prove local export capability");
    const destination = exportSkill.indexOf(
      "### 2. Pick among proven destinations"
    );
    const firstCommand = exportSkill.indexOf(
      '"$ENGINE" --headless --path "$PROJ"'
    );

    expect(proof).toBeGreaterThan(-1);
    expect(destination).toBeGreaterThan(proof);
    expect(firstCommand).toBeGreaterThan(destination);
    expect(exportSkill.slice(proof, firstCommand)).toContain(
      "Do not create its preset"
    );
  });

  it("never embeds an export command for an unproven named target", () => {
    expect(exportSkill).not.toMatch(
      /--export-release\s+"(?:Windows Desktop|Linux|macOS|Web|Android|iOS)"/
    );
    expect(exportSkill).toMatch(
      /Web export is\s+incompatible with that Mono build/
    );
  });

  it("gates remote deploy before preset or device instructions", () => {
    const proof = remoteDeploySkill.indexOf(
      "## Step 1 — prove the requested target is available"
    );
    const prerequisites = remoteDeploySkill.indexOf(
      "## Step 2 — prerequisites for a proven target"
    );
    const deploy = remoteDeploySkill.indexOf(
      "## Step 3 — deploy after proof"
    );

    expect(proof).toBeGreaterThan(-1);
    expect(prerequisites).toBeGreaterThan(proof);
    expect(deploy).toBeGreaterThan(prerequisites);
    expect(remoteDeploySkill).not.toContain('"Run in Browser"');
    expect(remoteDeploySkill).toMatch(/Do not add a Web Runnable\s+preset/);
  });
});
