/**
 * Validates that every agent plugin manifest references real, on-disk library
 * skills, and that every on-disk library skill is registered in the Claude
 * Code manifest.
 *
 * The manifests are GENERATED from library/ by `npm run generate:registry`
 * (parity with registry/generated/ is enforced by `generate:registry --check`);
 * this test guards the applied root manifests directly so a stale or
 * hand-edited manifest fails the build even without running the compiler.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

interface Manifest {
  name: string;
  path: string;
  // Either an explicit array of skill paths or a directory pointer
  skillsField: string[] | string;
}

const MANIFESTS: Manifest[] = [
  {
    name: ".claude-plugin/plugin.json",
    path: join(repoRoot, ".claude-plugin", "plugin.json"),
    skillsField: [],
  },
  {
    name: ".cursor-plugin/plugin.json",
    path: join(repoRoot, ".cursor-plugin", "plugin.json"),
    skillsField: [],
  },
  {
    name: ".codex-plugin/plugin.json",
    path: join(repoRoot, ".codex-plugin", "plugin.json"),
    skillsField: [],
  },
  {
    name: ".factory-plugin/plugin.json",
    path: join(repoRoot, ".factory-plugin", "plugin.json"),
    skillsField: [],
  },
];

function loadSkillsField(manifestPath: string): string[] | string {
  const raw = readFileSync(manifestPath, "utf-8");
  const json = JSON.parse(raw) as { skills?: string[] | string };
  if (json.skills === undefined) {
    throw new Error(`${manifestPath}: missing "skills" field`);
  }
  return json.skills;
}

/** Every library/skills/<slug>/ dir containing a SKILL.md, as manifest paths. */
function listLibrarySkillDirs(): string[] {
  const skillsRoot = join(repoRoot, "library", "skills");
  const out: string[] = [];
  for (const slug of readdirSync(skillsRoot)) {
    const skillPath = join(skillsRoot, slug);
    if (!statSync(skillPath).isDirectory()) continue;
    if (existsSync(join(skillPath, "SKILL.md"))) {
      out.push(`./library/skills/${slug}/`);
    }
  }
  return out.sort();
}

describe("repo-lint: agent plugin manifests", () => {
  for (const m of MANIFESTS) {
    describe(m.name, () => {
      it("exists and parses as JSON", () => {
        expect(existsSync(m.path), `${m.name} not found`).toBe(true);
        m.skillsField = loadSkillsField(m.path);
      });

      it("every referenced skill path resolves to a SKILL.md on disk", () => {
        const skills = m.skillsField;
        if (typeof skills === "string") {
          // Directory pointer mode (e.g. "./library/skills/")
          const dir = join(repoRoot, skills);
          expect(existsSync(dir), `${m.name}: skills dir ${skills} missing`).toBe(true);
          return;
        }
        const broken: string[] = [];
        for (const rel of skills) {
          const skillMd = join(repoRoot, rel, "SKILL.md");
          if (!existsSync(skillMd)) broken.push(rel);
        }
        expect(broken, `${m.name} references missing skills:\n${broken.join("\n")}`).toEqual([]);
      });

      it("does not duplicate skill paths", () => {
        const skills = m.skillsField;
        if (typeof skills === "string") return;
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const rel of skills) {
          if (seen.has(rel)) dupes.push(rel);
          seen.add(rel);
        }
        expect(dupes, `${m.name} duplicates: ${dupes.join(", ")}`).toEqual([]);
      });
    });
  }

  describe("library/skills <-> manifest coverage", () => {
    it("every on-disk library skill is listed in .claude-plugin/plugin.json", () => {
      const onDisk = listLibrarySkillDirs();
      const claudeManifest = JSON.parse(
        readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf-8")
      ) as { skills: string[] };
      const listed = new Set(claudeManifest.skills);
      const orphans = onDisk.filter((p) => !listed.has(p));
      expect(
        orphans,
        `On-disk library skills missing from .claude-plugin/plugin.json:\n${orphans.join("\n")}`
      ).toEqual([]);
    });

    it("every generated-registry skill path exists on disk with a resource.yaml", () => {
      const registry = JSON.parse(
        readFileSync(
          join(repoRoot, "registry", "generated", "skills-registry.json"),
          "utf-8"
        )
      ) as { skills: Array<{ path: string }> };
      const broken = registry.skills
        .map((s) => s.path)
        .filter(
          (rel) =>
            !existsSync(join(repoRoot, rel, "SKILL.md")) ||
            !existsSync(join(repoRoot, rel, "resource.yaml"))
        );
      expect(
        broken,
        `skills-registry.json entries without SKILL.md + resource.yaml:\n${broken.join("\n")}`
      ).toEqual([]);
    });
  });
});

describe("repo-lint: skill SKILL.md frontmatter", () => {
  it("every shipped SKILL.md has name and Use-when-style description", () => {
    const skillDirs = listLibrarySkillDirs();
    const failures: string[] = [];

    for (const rel of skillDirs) {
      const file = join(repoRoot, rel, "SKILL.md");
      const text = readFileSync(file, "utf-8");
      const match = text.match(/^---\s*\n([\s\S]+?)\n---/);
      if (!match) {
        failures.push(`${rel}: no frontmatter`);
        continue;
      }
      const fm = match[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (!nameMatch || !nameMatch[1].trim()) failures.push(`${rel}: missing name`);
      if (!descMatch || !descMatch[1].trim()) failures.push(`${rel}: missing description`);
      const desc = descMatch?.[1] ?? "";
      // Auto-trigger discipline: description must contain "Use when"
      if (desc && !/\bUse when\b/i.test(desc)) {
        failures.push(
          `${rel}: description must contain "Use when ..." (got: "${desc.slice(0, 80)}...")`
        );
      }
    }

    expect(
      failures,
      `Skill frontmatter problems:\n${failures.join("\n")}`
    ).toEqual([]);
  });
});
