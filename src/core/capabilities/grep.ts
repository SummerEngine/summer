/**
 * grep — ONE implementation of `summer_grep` for both faces
 * (src/mcp/tools/file-tools.ts and tool-dispatch.ts), over the engine's
 * ripgrep-backed Grep op (modules/1summer_engine/editor/ops/search_ops.cpp).
 *
 * The engine op returns {file, line, content} per match and parses only
 * ripgrep's "match" events, so its contextLines flag adds nothing to the
 * result. Context lines are therefore cut here, from the matched files read
 * back through state:read-file, under a file and size budget. Every line is
 * clipped to max_line_chars so a minified file cannot flood the reply.
 */
import { z } from "zod";
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { safeProjectPath } from "./engine-ops.js";
import { extractOpError, withOldEngineHint } from "./engine-receipt.js";
import { GREP_FALLBACK } from "./engine-fallbacks.js";

export const GREP_DEFAULT_MAX_RESULTS = 50;
export const GREP_MAX_RESULTS = 500;
export const GREP_DEFAULT_LINE_CHARS = 240;
/** Distinct files read back for context lines. */
const CONTEXT_MAX_FILES = 25;
/** Soft cap on the whole reply's context text. */
const CONTEXT_BUDGET_CHARS = 60_000;

// Mirrors library/tools/grep/resource.yaml input_schema (parity-tested).
export const grepInputShape = {
  pattern: z.string().min(1).describe("Ripgrep regular expression, e.g. '\"fits_into\"' or 'func _on_.*_pressed'"),
  path: z
    .string()
    .optional()
    .describe("Search scope: a res:// directory or file, e.g. 'res://starter/real-city-alley-kit/pieces.json'. Default: the whole project."),
  glob: z
    .string()
    .optional()
    .describe("File filter passed to ripgrep --glob, e.g. '*.gd', '**/pieces.json', '!addons/**'. A glob also reaches files .gitignore would skip."),
  case_sensitive: z.boolean().optional().describe("Match case exactly (default false: case-insensitive)."),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Lines of context before and after each match (0-10, default 0)."),
  max_results: z
    .number()
    .int()
    .positive()
    .max(GREP_MAX_RESULTS)
    .optional()
    .describe(`Most matches to return (default ${GREP_DEFAULT_MAX_RESULTS}, max ${GREP_MAX_RESULTS}). truncated:true means there were more.`),
  max_line_chars: z
    .number()
    .int()
    .min(40)
    .max(2000)
    .optional()
    .describe(`Clip every returned line to this many characters (default ${GREP_DEFAULT_LINE_CHARS}).`),
  multiline: z.boolean().optional().describe("Let the pattern span lines (ripgrep -U --multiline-dotall)."),
};

export const grepInputSchema = z.object(grepInputShape).strict();
export type GrepArgs = z.infer<typeof grepInputSchema>;

export interface GrepClient extends CapabilityAdvertisingClient {
  executeOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
}

function clip(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}…[+${line.length - max} chars]` : line;
}

function grepPayload(result: unknown): JsonRecord | null {
  const root = asRecord(result);
  if (!root) return null;
  if (Array.isArray(root.matches)) return root;
  const results = Array.isArray(root.results) ? root.results : [];
  return asRecord(results.find((entry) => asRecord(entry)?.op === "Grep") ?? results[0]) ?? null;
}

/** Turn the engine's raw ripgrep failures into a classified result. */
function classifyGrepFailure(result: unknown, path: string | undefined): unknown {
  const message = extractOpError(result);
  if (!message) return result;
  const lower = message.toLowerCase();
  if (lower.includes("no such file") || lower.includes("os error 2") || lower.includes("cannot find the path")) {
    return {
      ok: false,
      failure_reason: "path_not_found",
      error: `summer_grep: ${path ?? "the search path"} does not exist in the project. Check the res:// path (or drop path to search the whole project).`,
    };
  }
  if (lower.includes("ripgrep") && (lower.includes("unavailable") || lower.includes("not found") || lower.includes("failed to start"))) {
    return {
      ok: false,
      failure_reason: "ripgrep_unavailable",
      error: `summer_grep: this engine build has no usable ripgrep (${message}). ${GREP_FALLBACK}; or send the slower SearchInFiles op through summer_batch.`,
    };
  }
  return result;
}

export async function grepProject(client: GrepClient, args: GrepArgs): Promise<unknown> {
  const path = args.path !== undefined && args.path.trim() !== "" ? safeProjectPath(args.path) : undefined;
  const maxResults = args.max_results ?? GREP_DEFAULT_MAX_RESULTS;
  const lineChars = args.max_line_chars ?? GREP_DEFAULT_LINE_CHARS;
  const contextLines = args.context_lines ?? 0;

  const missing = missingEngineOpResult(client, "Grep", GREP_FALLBACK);
  if (missing) return { ...missing };

  const op: JsonRecord = { op: "Grep", pattern: args.pattern, maxResults };
  if (path) op.path = path;
  if (args.glob) op.glob = args.glob;
  if (args.case_sensitive) op.caseSensitive = true;
  if (args.multiline) op.multiline = true;
  const result = withOldEngineHint(await client.executeOps([op]), "Grep", GREP_FALLBACK);
  if (extractOpError(result)) return classifyGrepFailure(result, path);
  const payload = grepPayload(result);
  if (!payload || !Array.isArray(payload.matches)) return result;

  const rawMatches = payload.matches
    .map((m) => asRecord(m))
    .filter((m): m is JsonRecord => !!m && typeof m.file === "string");
  const matches: JsonRecord[] = rawMatches.slice(0, maxResults).map((m) => ({
    file: m.file,
    line: typeof m.line === "number" ? m.line : Number(m.line ?? 0),
    text: clip(String(m.content ?? ""), lineChars),
  }));

  const notes: string[] = [];
  let contextTruncated = false;
  if (contextLines > 0 && matches.length > 0) {
    const files = [...new Set(matches.map((m) => String(m.file)))];
    const readable = files.filter((f) => f.startsWith("res://")).slice(0, CONTEXT_MAX_FILES);
    if (readable.length < files.length) contextTruncated = true;
    const linesByFile = new Map<string, string[]>();
    for (const file of readable) {
      try {
        const read = asRecord(await client.readProjectFile(file, 1_000_000));
        const content = asRecord(read?.data)?.content;
        if (read?.ok !== false && typeof content === "string") linesByFile.set(file, content.replace(/\r\n?/g, "\n").split("\n"));
      } catch {
        // A file that cannot be read back keeps its match without context.
      }
    }
    let budget = CONTEXT_BUDGET_CHARS;
    for (const match of matches) {
      const lines = linesByFile.get(String(match.file));
      const line = Number(match.line);
      if (!lines || !Number.isInteger(line) || line < 1 || line > lines.length) continue;
      if (budget <= 0) {
        contextTruncated = true;
        break;
      }
      const before = lines.slice(Math.max(0, line - 1 - contextLines), line - 1).map((l) => clip(l, lineChars));
      const after = lines.slice(line, line + contextLines).map((l) => clip(l, lineChars));
      match.text = clip(lines[line - 1]!, lineChars);
      if (before.length) match.before = before;
      if (after.length) match.after = after;
      budget -= [...before, ...after].reduce((sum, l) => sum + l.length + 1, 0);
    }
    if (contextTruncated) {
      notes.push(`context lines were added for the first matches only (budget ${CONTEXT_MAX_FILES} files / ${CONTEXT_BUDGET_CHARS} chars); narrow path/glob for more`);
    }
  }

  const engineTruncated = payload.truncated === true || rawMatches.length > maxResults;
  if (matches.length === 0 && !args.glob) {
    notes.push("no matches: ripgrep skips files ignored by .gitignore/.ignore — pass a glob (e.g. '*.json') to search those too");
  }
  if (engineTruncated) {
    notes.push(`stopped at ${maxResults} matches; narrow the pattern/path/glob or raise max_results`);
  }

  return {
    ok: true,
    pattern: args.pattern,
    ...(path ? { path } : {}),
    ...(args.glob ? { glob: args.glob } : {}),
    returned: matches.length,
    // ripgrep stops early once max_results is reached, so this counts what it saw.
    matches_seen: typeof payload.totalMatches === "number" ? payload.totalMatches : rawMatches.length,
    files_with_matches: new Set(rawMatches.map((m) => String(m.file))).size,
    truncated: engineTruncated,
    ...(contextLines > 0 ? { context_lines: contextLines } : {}),
    ...(contextTruncated ? { context_truncated: true } : {}),
    matches,
    ...(notes.length ? { notes } : {}),
  };
}
