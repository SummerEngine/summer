import { describe, expect, it } from "vitest";
import { FOOTER_SUFFIX, feedbackFooter, readLibraryEntry, readLibraryInputSchema } from "./library-read.js";

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
