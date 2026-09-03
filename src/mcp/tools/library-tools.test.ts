import { describe, expect, it } from "vitest";
import { READ_LIBRARY_DESCRIPTION, SEARCH_LIBRARY_DESCRIPTION, registerLibraryTools } from "./library-tools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

interface Registered {
  description: string;
  shape: Record<string, unknown>;
  handler: Handler;
}

function register(): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  registerLibraryTools({
    tool(name: string, description: string, shape: Record<string, unknown>, handler: Handler) {
      tools.set(name, { description, shape, handler });
      return { name };
    },
  } as never);
  return tools;
}

describe("registerLibraryTools", () => {
  const tools = register();

  it("registers exactly summer_search_library and summer_read_library with zod shapes", () => {
    expect([...tools.keys()].sort()).toEqual(["summer_read_library", "summer_search_library"]);
    expect(Object.keys(tools.get("summer_search_library")!.shape).sort()).toEqual(["include_preview", "kinds", "limit", "query"]);
    expect(Object.keys(tools.get("summer_read_library")!.shape).sort()).toEqual(["id", "part"]);
    expect(tools.get("summer_search_library")!.description).toBe(SEARCH_LIBRARY_DESCRIPTION);
    expect(tools.get("summer_read_library")!.description).toBe(READ_LIBRARY_DESCRIPTION);
  });

  it("the descriptions tell the agent the loop: search first, read before acting, footer -> feedback", () => {
    expect(SEARCH_LIBRARY_DESCRIPTION).toContain("FIRST MOVE");
    expect(SEARCH_LIBRARY_DESCRIPTION).toContain("summer_read_library");
    expect(SEARCH_LIBRARY_DESCRIPTION).toContain("matched_by");
    expect(READ_LIBRARY_DESCRIPTION).toContain("entry_id");
    expect(READ_LIBRARY_DESCRIPTION).toContain("summer_library_feedback");
  });

  it("search returns a JSON list plus the read hint", async () => {
    const result = await tools.get("summer_search_library")!.handler({ query: "make stylized water", limit: 3 });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text) as { results: Array<{ id: string; matched_by: string[] }>; hint: string; count: number };
    expect(payload.count).toBe(3);
    expect(payload.results.map((r) => r.id)).toContain("skill/vfx-water-ripple");
    expect(payload.results[0]!.matched_by).toEqual(["lexical"]);
    expect(payload.hint).toContain("summer_read_library");
  });

  it("read returns the rendered entry as text whose last line is the feedback footer", async () => {
    const result = await tools.get("summer_read_library")!.handler({ id: "skill/vfx-water-ripple" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text.startsWith("skill/vfx-water-ripple — skill v")).toBe(true);
    expect(text.split("\n").at(-1)).toMatch(
      /^— entry_id: skill\/vfx-water-ripple@[a-f0-9]{12}\. If this entry is wrong, stale, or you deviate from it, report via summer_library_feedback\.$/
    );
  });

  it("read of an unknown id is an error payload with not_found and 3 nearest ids", async () => {
    const result = await tools.get("summer_read_library")!.handler({ id: "skill/water-rippel" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text) as { ok: boolean; error: string; nearest: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("not_found");
    expect(payload.nearest).toHaveLength(3);
    expect(payload.nearest).toContain("skill/vfx-water-ripple");
  });
});
