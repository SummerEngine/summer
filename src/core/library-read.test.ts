import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOOTER_SUFFIX,
  feedbackFooter,
  readLibraryEntry,
  readLibraryInputSchema,
  relativeLinkTargets,
  resolveLibraryLink,
} from "./library-read.js";
import { loadLibraryIndex } from "./library-search.js";
import { PACKAGE_ROOT } from "./package-root.js";

/** Same shape summer_library_feedback accepts for entry_id (feedback-tools.ts
 *  ENTRY_ID_PATTERN) — inlined so core tests never import the mcp layer. */
const ENTRY_ID = /^(tool|skill|example|template|collection|reference)\/[a-z0-9-]+(@[a-f0-9]{8,64})?$/;
const FOOTER = /^— entry_id: (tool|skill|example|template|collection|reference)\/[a-z0-9-]+@[a-f0-9]{12}\. If this entry is wrong, stale, or you deviate from it, report via summer_library_feedback\.$/;

function lastLine(text: string): string {
  return text.split("\n").at(-1)!;
}

describe("feedback footer (SELF_IMPROVING_LIBRARY §3.1 trigger placement)", () => {
  it("has the exact wording and the first 12 hash chars", () => {
    const footer = feedbackFooter("skill/grappling-hook", "0123456789abcdef".repeat(4));
    expect(footer).toBe(`— entry_id: skill/grappling-hook@0123456789ab. ${FOOTER_SUFFIX}`);
    expect(footer).toMatch(FOOTER);
  });

  it("degrades to the bare id when the index carries no hash", () => {
    expect(feedbackFooter("skill/x", undefined)).toBe(`— entry_id: skill/x. ${FOOTER_SUFFIX}`);
  });
});

describe("readLibraryEntry over the shipped library", () => {
  it("skill: SKILL.md body + metadata, footer is the LAST line, entry_id is feedback-valid", async () => {
    const result = await readLibraryEntry("skill/vfx-water-ripple");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("skill");
    expect(result.body_file).toBe("SKILL.md");
    expect(result.path).toBe("library/skills/vfx-water-ripple");
    expect(result.files).toContain("SKILL.md");
    expect(result.status).toBe("stable");
    expect(result.use_when.length).toBeGreaterThan(0);
    expect(result.related.skills).toContain("skill/scene-scripting");
    expect(result.entry_id).toMatch(ENTRY_ID);
    expect(result.entry_id).toMatch(/^skill\/vfx-water-ripple@[a-f0-9]{12}$/);
    expect(lastLine(result.text)).toBe(result.footer);
    expect(result.footer).toMatch(FOOTER);
    expect(result.text).toContain("name: vfx-water-ripple"); // SKILL.md frontmatter
    expect(result.text).toContain("--- library/skills/vfx-water-ripple/resource.yaml ---");
    expect(result.text).toContain("Invoke: the `vfx-water-ripple` skill");
  });

  it("part=skill omits resource.yaml; part=resource omits the body; all has both", async () => {
    const skill = await readLibraryEntry("skill/vfx-water-ripple", "skill");
    const resource = await readLibraryEntry("skill/vfx-water-ripple", "resource");
    if (!skill.ok || !resource.ok) throw new Error("expected ok");
    expect(skill.text).toContain("--- library/skills/vfx-water-ripple/SKILL.md ---");
    expect(skill.text).not.toContain("/resource.yaml ---");
    expect(resource.text).toContain("/resource.yaml ---");
    expect(resource.text).toContain("id: skill/vfx-water-ripple");
    expect(resource.text).not.toContain("/SKILL.md ---");
    for (const r of [skill, resource]) expect(lastLine(r.text)).toBe(r.footer);
  });

  it("tool: how to call (MCP name, summer tool, engine requirement, authority) + descriptor", async () => {
    const result = await readLibraryEntry("tool/screenshot");
    if (!result.ok) throw new Error("expected ok");
    expect(result.mcp_tool_name).toBe("summer_screenshot");
    expect(result.remote).toBe(false);
    expect(result.text).toContain("MCP: call `summer_screenshot`");
    expect(result.text).toContain("summer tool screenshot --args");
    expect(result.text).toContain("Engine: required");
    expect(result.text).toContain("input_schema:"); // the descriptor text
    expect(lastLine(result.text)).toMatch(/^— entry_id: tool\/screenshot@/);
    const remote = await readLibraryEntry("tool/api-docs", "skill");
    if (!remote.ok) throw new Error("expected ok");
    expect(remote.remote).toBe(true);
    expect(remote.text).toContain("Engine: not required");
    const dedicated = await readLibraryEntry("tool/start-game-task", "skill");
    if (!dedicated.ok) throw new Error("expected ok");
    expect(dedicated.text).toContain("Dedicated command: summer plan");
  });

  it("template: pin + summer create hint (pinned and built-in)", async () => {
    const pinned = await readLibraryEntry("template/2d-platformer", "skill");
    if (!pinned.ok) throw new Error("expected ok");
    expect(pinned.text).toMatch(/Pinned to https:\/\/github\.com\/SummerEngine\/\S+ @ [a-f0-9]{40}/);
    expect(pinned.text).toContain("summer create 2d-platformer [name]");
    const builtin = await readLibraryEntry("template/3d-basic", "skill");
    if (!builtin.ok) throw new Error("expected ok");
    expect(builtin.text).toContain("Built-in template");
    expect(builtin.text).toContain("summer create 3d-basic [name]");
  });

  it("reference: the markdown body", async () => {
    const result = await readLibraryEntry("reference/gd-style", "skill");
    if (!result.ok) throw new Error("expected ok");
    expect(result.body_file).toBe("gd-style.md");
    expect(result.text).toContain("--- library/references/gd-style/gd-style.md ---");
    expect(lastLine(result.text)).toBe(result.footer);
  });

  it("accepts the footer's id@hash form and a bare slug that names exactly one entry", async () => {
    const first = await readLibraryEntry("skill/vfx-water-ripple");
    if (!first.ok) throw new Error("expected ok");
    const viaEntryId = await readLibraryEntry(first.entry_id, "resource");
    expect(viaEntryId.ok && viaEntryId.id).toBe("skill/vfx-water-ripple");
    const viaSlug = await readLibraryEntry("vfx-water-ripple", "resource");
    expect(viaSlug.ok && viaSlug.id).toBe("skill/vfx-water-ripple");
    // "play" names both skill/play and tool/play -> ambiguous -> not found.
    const ambiguous = await readLibraryEntry("play");
    expect(ambiguous.ok).toBe(false);
  });

  it("unknown id -> not_found with the 3 nearest ids from search", async () => {
    const result = await readLibraryEntry("skill/water-rippel");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
    expect(result.id).toBe("skill/water-rippel");
    expect(result.nearest).toHaveLength(3);
    expect(result.nearest).toContain("skill/vfx-water-ripple");
    expect(result.hint).toContain("summer_search_library");
    expect(result.hint).toContain("skill/vfx-water-ripple");
  });
});

describe("input schema", () => {
  it("id required (1-200 chars); part is skill|resource|all", () => {
    expect(readLibraryInputSchema.safeParse({ id: "skill/x" }).success).toBe(true);
    expect(readLibraryInputSchema.safeParse({ id: "" }).success).toBe(false);
    expect(readLibraryInputSchema.safeParse({ id: "skill/x", part: "all" }).success).toBe(true);
    expect(readLibraryInputSchema.safeParse({ id: "skill/x", part: "body" }).success).toBe(false);
    expect(readLibraryInputSchema.safeParse({}).success).toBe(false);
  });
});

// skill/spatial-placement links references/kit-placement-tools.md for
// "arguments, result shapes, limits", but summer_read_library could not load
// it: reference/kit-placement-tools was not_found and part "resource"
// returned only resource.yaml.
describe("linked files load through read_library", () => {
  it("loads a skill's linked reference by <entry id>/<link as written>, with the parent's footer", async () => {
    const result = await readLibraryEntry("skill/spatial-placement/references/kit-placement-tools.md");
    if (!result.ok) throw new Error(`expected ok: ${result.hint}`);
    expect(result.id).toBe("skill/spatial-placement");
    expect(result.linked_file).toBe("references/kit-placement-tools.md");
    expect(result.text).toContain("--- library/skills/spatial-placement/references/kit-placement-tools.md ---");
    expect(result.text).toContain(readFileSync(join(PACKAGE_ROOT, "library/skills/spatial-placement/references/kit-placement-tools.md"), "utf-8").split("\n")[0]);
    expect(result.text).not.toContain("--- library/skills/spatial-placement/SKILL.md ---");
    expect(lastLine(result.text)).toBe(result.footer);
    expect(result.entry_id).toMatch(/^skill\/spatial-placement@[a-f0-9]{12}$/);
  });

  it("also loads it by the bare relative path and by the reference/<slug> guess", async () => {
    for (const id of ["references/kit-placement-tools.md", "./references/kit-placement-tools.md", "reference/kit-placement-tools"]) {
      const result = await readLibraryEntry(id, "skill");
      expect(result.ok && result.linked_file, id).toBe("references/kit-placement-tools.md");
    }
  });

  it("lists every link of a body with the id that loads it", async () => {
    const result = await readLibraryEntry("skill/spatial-placement", "skill");
    if (!result.ok) throw new Error("expected ok");
    expect(result.links).toContainEqual({ target: "references/kit-placement-tools.md", id: "skill/spatial-placement/references/kit-placement-tools.md" });
    expect(result.text).toContain("references/kit-placement-tools.md -> skill/spatial-placement/references/kit-placement-tools.md");
    expect(lastLine(result.text)).toBe(result.footer);
    // A link to another entry's body resolves to that entry's id.
    const checker = await readLibraryEntry("skill/skill-test", "skill");
    if (!checker.ok) throw new Error("expected ok");
    expect(checker.links).toContainEqual({ target: "../../references/collaborative-protocol/collaborative-protocol.md", id: "reference/collaborative-protocol" });
  });

  it("renders an entry when the link names its body file or descriptor", async () => {
    const body = await readLibraryEntry("skill/host-authoritative-state/../setup-multiplayer/SKILL.md", "skill");
    expect(body.ok && body.id).toBe("skill/setup-multiplayer");
    expect(body.ok && body.linked_file).toBeUndefined();
    const descriptor = await readLibraryEntry("skill/spatial-placement/resource.yaml");
    if (!descriptor.ok) throw new Error("expected ok");
    expect(descriptor.part).toBe("resource");
    expect(descriptor.text).toContain("id: skill/spatial-placement");
  });

  it("never reads outside library/ or a file that is not there", async () => {
    for (const id of [
      "skill/spatial-placement/../../../package.json",
      "skill/spatial-placement/../../../../../../etc/passwd",
      "skill/spatial-placement/%2e%2e/%2e%2e/%2e%2e/package.json",
      "skill/spatial-placement//etc/passwd",
      "skill/spatial-placement/references/missing.md",
      "skill/spatial-placement/references",
      "../package.json",
    ]) {
      const result = await readLibraryEntry(id);
      expect(result.ok, id).toBe(false);
      if (!result.ok) expect(result.hint, id).toContain("<entry id>/<link as written>");
    }
  });

  it("extracts markdown links and library-path code spans, not URLs, anchors, project paths or fenced code", () => {
    const md = [
      "See [tools](references/kit-placement-tools.md#connect) and [web](https://example.com/x.md) and [top](#intro).",
      "Also `../../references/gd-style/gd-style.md`, but not `./scripts/player.gd`, `res://a.tscn` or `./World/Player`.",
      "Inline `[x](../nope/SKILL.md)` is code, not a link.",
      "```",
      "[fenced](../fenced/SKILL.md)",
      "```",
    ].join("\n");
    expect(relativeLinkTargets(md).sort()).toEqual(["../../references/gd-style/gd-style.md", "references/kit-placement-tools.md"]);
  });
});

/** Every markdown file a skill ships, as paths inside the skill directory. */
function skillMarkdownFiles(skillDir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(skillDir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(skillDir, rel)).isDirectory()) out.push(...skillMarkdownFiles(skillDir, rel));
    else if (name.toLowerCase().endsWith(".md")) out.push(rel);
  }
  return out;
}

describe("every link in every library skill resolves through read_library", () => {
  const entries = loadLibraryIndex();
  const skillsDir = join(PACKAGE_ROOT, "library", "skills");
  const skills = readdirSync(skillsDir)
    .filter((slug) => statSync(join(skillsDir, slug)).isDirectory())
    .sort();

  it("covers the shipped skills", () => {
    expect(skills.length).toBeGreaterThan(50);
    expect(skills).toContain("spatial-placement");
  });

  it.each(skills)("skill/%s", async (slug) => {
    const entry = entries.find((e) => e.id === `skill/${slug}`);
    expect(entry, `skill/${slug} is in the index`).toBeDefined();
    const skillDir = join(skillsDir, slug);
    const broken: string[] = [];
    for (const file of skillMarkdownFiles(skillDir)) {
      const markdown = readFileSync(join(skillDir, file), "utf-8");
      for (const target of relativeLinkTargets(markdown)) {
        const where = `${file}: ${target}`;
        const canonical = resolveLibraryLink(entry!, file, target, { entries });
        if (!canonical) {
          broken.push(`${where} (not shipped inside library/)`);
          continue;
        }
        // The id an agent builds from the link as written, and the canonical id,
        // both load, and the load carries the target file's text.
        const asWritten = `skill/${slug}/${posix.join(posix.dirname(file), target.split("#")[0]!)}`;
        const targetPath = posix.normalize(posix.join("library/skills", slug, posix.dirname(file), decodeURIComponent(target)));
        const firstLine = readFileSync(join(PACKAGE_ROOT, ...targetPath.split("/")), "utf-8").split("\n").find((l) => l.trim()) ?? "";
        for (const id of [asWritten, canonical]) {
          const loaded = await readLibraryEntry(id);
          if (!loaded.ok) broken.push(`${where} (${id} -> not_found)`);
          else if (!loaded.text.includes(firstLine.trim())) broken.push(`${where} (${id} loads another file)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
