import { describe, expect, it, vi } from "vitest";
import { grepProject } from "./grep.js";
import { dispatchTool } from "./tool-dispatch.js";

const PIECES = [
  "{",
  ' "pieces": {',
  '  "door_tripple_standard_03": {',
  '   "scene": "res://kit/door_03.tscn",',
  '   "fits_into": "wall_tripple_standard_door_02",',
  '   "local_offset_m": [',
  "     0,",
  "     0,",
  "     -0.105",
  "   ]",
  "  }",
  " }",
  "}",
].join("\n");

function grepClient(result: unknown, files: Record<string, string> = { "res://kit/pieces.json": PIECES }) {
  return {
    executeOps: vi.fn(async () => result),
    readProjectFile: vi.fn(async (path: string) =>
      path in files ? { ok: true, data: { content: files[path], encoding: "utf-8" } } : { ok: false, error: "file not found" }
    ),
  };
}

const matchResult = {
  ok: true,
  results: [
    {
      ok: true,
      op: "Grep",
      matches: [{ file: "res://kit/pieces.json", line: 5, content: '"fits_into": "wall_tripple_standard_door_02",', matchStart: 4, matchEnd: 15 }],
      totalMatches: 1,
      filesSearched: 1,
      returned: 1,
      truncated: false,
    },
  ],
};

describe("summer_grep", () => {
  it("sends one Grep op with the mapped arguments and returns compact matches", async () => {
    const client = grepClient(matchResult);
    const result = (await grepProject(client, { pattern: "fits_into", path: "res://kit", glob: "*.json", case_sensitive: true })) as Record<string, unknown>;
    expect(client.executeOps).toHaveBeenCalledWith([
      { op: "Grep", pattern: "fits_into", maxResults: 50, path: "res://kit", glob: "*.json", caseSensitive: true },
    ]);
    expect(result).toMatchObject({ ok: true, returned: 1, files_with_matches: 1, truncated: false });
    expect(result.matches).toEqual([{ file: "res://kit/pieces.json", line: 5, text: '"fits_into": "wall_tripple_standard_door_02",' }]);
    expect(client.readProjectFile).not.toHaveBeenCalled();
  });

  it("adds context lines read back from the matched file (the engine op drops ripgrep's context)", async () => {
    const client = grepClient(matchResult);
    const result = (await grepProject(client, { pattern: "fits_into", context_lines: 4 })) as { matches: Array<Record<string, unknown>> };
    expect(result.matches[0]).toEqual({
      file: "res://kit/pieces.json",
      line: 5,
      text: '   "fits_into": "wall_tripple_standard_door_02",',
      before: ["{", ' "pieces": {', '  "door_tripple_standard_03": {', '   "scene": "res://kit/door_03.tscn",'],
      after: ['   "local_offset_m": [', "     0,", "     0,", "     -0.105"],
    });
  });

  it("clips long lines and reports a cap", async () => {
    const long = { ...matchResult, results: [{ ...matchResult.results[0], matches: [{ file: "res://min.js", line: 1, content: "x".repeat(1000) }], truncated: true }] };
    const result = (await grepProject(grepClient(long), { pattern: "x", max_line_chars: 40 })) as { matches: Array<{ text: string }>; truncated: boolean; notes: string[] };
    expect(result.matches[0]!.text).toBe(`${"x".repeat(40)}…[+960 chars]`);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toContain("max_results");
  });

  it("classifies a missing path instead of passing ripgrep's error string through", async () => {
    const failure = { ok: false, results: [{ ok: false, op: "Grep", error: "Ripgrep search error (exit code 2): rg: /p/nope: No such file or directory (os error 2)" }] };
    const result = await grepProject(grepClient(failure), { pattern: "x", path: "res://nope" });
    expect(result).toMatchObject({ ok: false, failure_reason: "path_not_found" });
  });

  it("hints at .gitignore when nothing matched without a glob", async () => {
    const empty = { ok: true, results: [{ ok: true, op: "Grep", matches: [], totalMatches: 0, returned: 0, truncated: false }] };
    const result = (await grepProject(grepClient(empty), { pattern: "x", path: "res://starter" })) as { notes: string[] };
    expect(result.notes.join(" ")).toContain(".gitignore");
  });

  it("refuses before sending on an engine that provably lacks Grep, and keeps paths inside the project", async () => {
    const client = { ...grepClient(matchResult), getEngineCapabilities: () => ({ opKinds: ["AddNode"] }) };
    expect(await grepProject(client, { pattern: "x" })).toMatchObject({ ok: false, failure_reason: "engine_lacks_op" });
    expect(client.executeOps).not.toHaveBeenCalled();
    await expect(grepProject(grepClient(matchResult), { pattern: "x", path: "/etc" })).rejects.toThrow(/res:\/\//);
  });

  it("the CLI face runs the same search", async () => {
    const client = grepClient(matchResult);
    const result = (await dispatchTool("grep", { pattern: "fits_into", context_lines: 1 }, { engine: async () => client as never })) as {
      matches: Array<{ before: string[]; after: string[] }>;
    };
    expect(result.matches[0]!.before).toEqual(['   "scene": "res://kit/door_03.tscn",']);
    expect(result.matches[0]!.after).toEqual(['   "local_offset_m": [']);
  });
});
