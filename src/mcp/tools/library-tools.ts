/**
 * summer_search_library / summer_read_library — the MCP face of the runtime
 * librarian. Behavior lives in src/core/library-search.ts and
 * src/core/library-read.ts; `summer tool search-library|read-library`
 * (src/core/capabilities/tool-dispatch.ts) calls the same functions.
 * Engine-free: both read the library shipped with this package.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readLibraryEntry, readLibraryInputShape } from "../../core/library-read.js";
import { runSearchLibrary, searchLibraryInputShape } from "../../core/library-search.js";
import { textJson } from "./text-json.js";

export const SEARCH_LIBRARY_DESCRIPTION =
  "Search the Summer library — skills, tools, templates, references, examples, collections — by describing the task in plain words " +
  "('make stylized water', 'the player falls through the floor', 'which tool reads script errors'). " +
  "This is the FIRST MOVE for any task: even a 1% chance the library covers it means you search, then read the entry you pick with " +
  "summer_read_library before acting — never act on a summary alone. " +
  "Ranking: BM25 over ids, summaries, use_when lines and facets with kind-aware priors and related-entry boosts (the same ranker the routing eval gates). " +
  "When this install ships registry/generated/embeddings.json and the embedding endpoint answers within 1.5s, lexical and semantic rankings are fused " +
  "(reciprocal rank fusion) and each hit's matched_by says which side found it; offline or without embeddings it is lexical only and never fails for that reason. " +
  "Returns {query, semantic, count, results: [{id, kind, status, summary, use_when, score, matched_by, mcp_tool_name?}], hint}. " +
  "Scores compare only within one response. kinds narrows to some of the six kinds; include_preview:false hides preview entries; deprecated entries never surface. " +
  "No engine needed. Privacy: only when semantic search is active is the query text sent to the Summer gateway to be embedded; nothing else leaves the machine.";

export const READ_LIBRARY_DESCRIPTION =
  "Load one library entry by id (<kind>/<slug>, as returned by summer_search_library). " +
  "Skills: the SKILL.md body plus metadata (status, use_when, related) and how to invoke the skill in your host (bare slug). " +
  "Tools: how to call it (MCP name, `summer tool <slug> --args`, engine requirement, authority) plus the descriptor. " +
  "Templates: the pinned repo @ commit and tree digest (or built-in) and the `summer create <slug>` command. References: the markdown body. " +
  "part: 'skill' = body only, 'resource' = the resource.yaml descriptor only, 'all' (default) = both. " +
  "The LAST line of every load is the feedback footer `— entry_id: <id>@<content-hash>. If this entry is wrong, stale, or you deviate from it, report via summer_library_feedback.` " +
  "— copy that entry_id verbatim into summer_library_feedback once you have verified the outcome in-engine. " +
  "Unknown id -> {ok:false, error:'not_found', nearest:[up to 3 ids]}. No engine needed; reads the library shipped with this package.";

export function registerLibraryTools(server: McpServer): void {
  server.tool("summer_search_library", SEARCH_LIBRARY_DESCRIPTION, searchLibraryInputShape, async (args) => {
    try {
      return textJson(await runSearchLibrary(args));
    } catch (error) {
      return textJson({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
    }
  });

  server.tool("summer_read_library", READ_LIBRARY_DESCRIPTION, readLibraryInputShape, async (args) => {
    try {
      const result = await readLibraryEntry(args.id, args.part ?? "all");
      if (!result.ok) return textJson(result, true);
      return { content: [{ type: "text" as const, text: result.text }] };
    } catch (error) {
      return textJson({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
    }
  });
}
