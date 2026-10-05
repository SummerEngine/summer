/**
 * file-read — ONE implementation of `summer_read_file` for both faces
 * (src/mcp/tools/file-tools.ts and tool-dispatch.ts).
 *
 * The engine's state:read-file returns the first maxBytes of a file plus a
 * sha256 over the WHOLE file; it has no offset (StateProvider::read_file_state).
 * Paging and JSON filtering therefore happen here: the engine reads up to its
 * 1 MB window once, and this module returns only the requested part — a line
 * or byte window, or the entries of a .json picked by json_path / keys — so an
 * agent can read one piece of a 93 KB pieces.json without the host refusing
 * the result. The sha256 stays the full-file receipt, so a guarded overwrite
 * still works after a windowed read.
 */
import { z } from "zod";
import { ToolInputError } from "../tool-errors.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { safeProjectPath } from "./engine-ops.js";

/** The engine's own read cap (and the most this module ever asks for). */
export const FILE_READ_WINDOW_BYTES = 1_000_000;
export const DEFAULT_READ_MAX_BYTES = 200_000;

// Mirrors library/tools/read-file/resource.yaml input_schema (parity-tested).
export const readFileInputShape = {
  path: z.string().describe("Project path, e.g. res://scripts/player.gd"),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(FILE_READ_WINDOW_BYTES)
    .default(DEFAULT_READ_MAX_BYTES)
    .describe("Most bytes of content to return (UTF-8). Default 200000. A window or JSON selection is cut at this size too."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip this many units (lines by default, see unit) before returning content. 0 = from the start."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Return at most this many units (lines by default). The result's window.next_offset continues the read."),
  unit: z
    .enum(["lines", "bytes"])
    .optional()
    .describe("What offset/limit count: 'lines' (default) or 'bytes' (cut on UTF-8 character boundaries)."),
  json_path: z
    .string()
    .optional()
    .describe("For a JSON file: return only this value, e.g. 'pieces.wall_tripple_standard_01', 'pieces[\"a b\"]', 'items[3].size_m'."),
  keys: z
    .array(z.string())
    .max(64)
    .optional()
    .describe("For a JSON object (the file root or the json_path value): keep only these keys; * and ? wildcards, e.g. ['wall_tripple_*']."),
  keys_only: z
    .boolean()
    .optional()
    .describe("For a JSON object: return only its key names (after the keys filter), not the values — a cheap table of contents."),
};

export const readFileInputSchema = z.object(readFileInputShape).strict();
export type ReadFileArgs = z.infer<typeof readFileInputSchema>;

export interface ReadFileClient {
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
}

function failure(failure_reason: string, error: string, extra: JsonRecord = {}): JsonRecord {
  return { ok: false, failure_reason, error, ...extra };
}

// ---------------------------------------------------------------------------
// JSON selection
// ---------------------------------------------------------------------------

type JsonSegment = string | number;

/** Parse `a.b[0]["c d"]['e']` (optionally `$`-prefixed) into segments. */
export function parseJsonPath(path: string): JsonSegment[] {
  let rest = path.trim();
  if (rest.startsWith("$")) rest = rest.slice(1);
  const segments: JsonSegment[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      continue;
    }
    if (rest.startsWith("[")) {
      const match = /^\[\s*(?:(-?\d+)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\]/.exec(rest);
      if (!match) {
        throw new ToolInputError(
          `Invalid json_path near "${rest.slice(0, 40)}": use dots and brackets, e.g. pieces.wall_01, pieces["a b"], items[3].`
        );
      }
      if (match[1] !== undefined) segments.push(Number(match[1]));
      else segments.push((match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1"));
      rest = rest.slice(match[0].length);
      continue;
    }
    const match = /^[^.[\]]+/.exec(rest)!;
    segments.push(match[0]);
    rest = rest.slice(match[0].length);
  }
  return segments;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function describeJsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function keysPreview(value: unknown): JsonRecord {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  const record = asRecord(value);
  if (record) {
    const keys = Object.keys(record);
    return { type: "object", total_keys: keys.length, keys: keys.slice(0, 60), ...(keys.length > 60 ? { keys_truncated: true } : {}) };
  }
  return { type: describeJsonType(value) };
}

function selectJson(
  root: unknown,
  args: Pick<ReadFileArgs, "json_path" | "keys" | "keys_only">
): { value: unknown; meta: JsonRecord } | JsonRecord {
  let current: unknown = root;
  const resolved: JsonSegment[] = [];
  for (const segment of args.json_path !== undefined ? parseJsonPath(args.json_path) : []) {
    let next: unknown;
    let found = false;
    if (Array.isArray(current)) {
      const index = typeof segment === "number" ? segment : /^-?\d+$/.test(segment) ? Number(segment) : Number.NaN;
      const at = index < 0 ? current.length + index : index;
      if (Number.isInteger(at) && at >= 0 && at < current.length) {
        next = current[at];
        found = true;
      }
    } else {
      const record = asRecord(current);
      const key = String(segment);
      if (record && Object.prototype.hasOwnProperty.call(record, key)) {
        next = record[key];
        found = true;
      }
    }
    if (!found) {
      const at = resolved.length > 0 ? resolved.map(String).join(".") : "(root)";
      return failure(
        "json_path_not_found",
        `json_path ${args.json_path}: "${String(segment)}" does not exist under ${at}.`,
        { resolved: at, here: keysPreview(current) }
      );
    }
    current = next;
    resolved.push(segment);
  }

  const meta: JsonRecord = { ...(args.json_path !== undefined ? { json_path: args.json_path } : {}), type: describeJsonType(current) };
  const wantsKeys = args.keys !== undefined || args.keys_only === true;
  if (!wantsKeys) {
    if (Array.isArray(current)) meta.length = current.length;
    else if (asRecord(current)) meta.total_keys = Object.keys(current as JsonRecord).length;
    return { value: current, meta };
  }

  const record = asRecord(current);
  if (!record) {
    return failure(
      "not_an_object",
      `keys/keys_only apply to a JSON object, but ${args.json_path ?? "the file root"} is ${
        Array.isArray(current) ? `an array of ${current.length} items — select one with json_path, e.g. [0]` : `a ${describeJsonType(current)}`
      }.`
    );
  }
  const allKeys = Object.keys(record);
  const patterns = (args.keys ?? []).map(globToRegExp);
  const matched = patterns.length > 0 ? allKeys.filter((key) => patterns.some((pattern) => pattern.test(key))) : allKeys;
  meta.total_keys = allKeys.length;
  meta.matched_keys = matched.length;
  if (args.keys !== undefined) meta.keys = args.keys;
  if (args.keys_only === true) return { value: matched, meta: { ...meta, keys_only: true } };
  const picked: JsonRecord = {};
  for (const key of matched) picked[key] = record[key];
  return { value: picked, meta };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

interface WindowResult {
  content: string;
  /** The returned content is the whole (selected) text. */
  complete: boolean;
  meta: JsonRecord;
}

function lineWindow(
  text: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
  sourceCut: boolean
): WindowResult {
  const lines = text.split("\n");
  // A trailing newline ends the last line; it does not start another one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const wanted = lines.slice(offset, limit !== undefined ? offset + limit : undefined);
  const kept: string[] = [];
  let bytes = 0;
  let cutByMaxBytes = false;
  for (const line of wanted) {
    const cost = utf8Length(line) + 1;
    if (bytes + cost > maxBytes && kept.length > 0) {
      cutByMaxBytes = true;
      break;
    }
    if (bytes + cost > maxBytes) {
      // One line alone is bigger than max_bytes: return its head.
      const buffer = Buffer.from(line, "utf8");
      let end = maxBytes;
      while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
      kept.push(buffer.subarray(0, end).toString("utf8"));
      cutByMaxBytes = true;
      break;
    }
    kept.push(line);
    bytes += cost;
  }
  const returned = kept.length;
  const nextOffset = offset + returned;
  const eof = !sourceCut && !cutByMaxBytes && nextOffset >= total;
  return {
    content: kept.join("\n"),
    complete: offset === 0 && eof,
    meta: {
      unit: "lines",
      offset,
      ...(limit !== undefined ? { limit } : {}),
      returned,
      start_line: returned > 0 ? offset + 1 : null,
      end_line: returned > 0 ? offset + returned : null,
      total_lines: total,
      ...(sourceCut ? { total_lines_is_lower_bound: true } : {}),
      next_offset: eof ? null : nextOffset,
      eof,
      ...(cutByMaxBytes ? { cut_by_max_bytes: true } : {}),
    },
  };
}

function byteWindow(
  text: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
  totalBytes: number,
  sourceCut: boolean
): WindowResult | JsonRecord {
  const buffer = Buffer.from(text, "utf8");
  if (offset > 0 && offset >= buffer.length && sourceCut) {
    return failure(
      "offset_beyond_read_window",
      `offset ${offset} is past the engine's 1 MB read window for this file (${totalBytes} bytes). Only the first 1 MB can be read.`
    );
  }
  let start = Math.min(offset, buffer.length);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  const span = Math.min(limit ?? maxBytes, maxBytes);
  let end = Math.min(buffer.length, start + span);
  while (end > start && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  const cutByMaxBytes = limit !== undefined && limit > maxBytes && end < buffer.length;
  const eof = end >= buffer.length && !sourceCut;
  return {
    content: buffer.subarray(start, end).toString("utf8"),
    complete: start === 0 && eof,
    meta: {
      unit: "bytes",
      offset,
      ...(limit !== undefined ? { limit } : {}),
      start_byte: start,
      end_byte: end,
      returned: end - start,
      total_bytes: totalBytes,
      next_offset: eof ? null : end,
      eof,
      ...(cutByMaxBytes ? { cut_by_max_bytes: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function readProjectFileWindow(client: ReadFileClient, args: ReadFileArgs): Promise<unknown> {
  const path = safeProjectPath(args.path);
  const maxBytes = args.max_bytes ?? DEFAULT_READ_MAX_BYTES;
  const windowed = args.offset !== undefined || args.limit !== undefined || args.unit !== undefined;
  const jsonMode = args.json_path !== undefined || args.keys !== undefined || args.keys_only === true;
  if (args.json_path !== undefined) parseJsonPath(args.json_path); // validate before reading
  if (!windowed && !jsonMode) return client.readProjectFile(path, maxBytes);

  const unit = args.unit ?? "lines";
  const offset = args.offset ?? 0;
  // A byte window from the start of the file needs only that many bytes.
  const engineBytes =
    !jsonMode && unit === "bytes" && args.limit !== undefined
      ? Math.min(FILE_READ_WINDOW_BYTES, offset + Math.min(args.limit, maxBytes) + 4)
      : FILE_READ_WINDOW_BYTES;
  const read = await client.readProjectFile(path, engineBytes);
  const root = asRecord(read);
  const data = asRecord(root?.data);
  if (!root || root.ok === false || !data) return read;
  if (data.encoding === "binary" || typeof data.content !== "string") {
    return failure("binary_file", `${path} is not a text file; offset/limit and json_path apply to text only.`);
  }
  const totalBytes = typeof data.size === "number" ? data.size : utf8Length(data.content);
  const sourceCut = data.truncated === true;

  let text = data.content;
  let json: JsonRecord | undefined;
  if (jsonMode) {
    if (sourceCut) {
      return failure(
        "file_too_large_for_json",
        `${path} is ${totalBytes} bytes, over the 1 MB read window, so it cannot be parsed as a whole. Page it with offset/limit instead.`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return failure("not_json", `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); json_path/keys apply to JSON files only.`);
    }
    const selected = selectJson(parsed, args);
    if ("ok" in selected && selected.ok === false) return selected;
    const { value, meta } = selected as { value: unknown; meta: JsonRecord };
    text = JSON.stringify(value, null, 2) ?? "null";
    json = meta;
  }

  const window =
    unit === "bytes"
      ? byteWindow(text, offset, args.limit, maxBytes, jsonMode ? utf8Length(text) : totalBytes, sourceCut && !jsonMode)
      : lineWindow(text, offset, args.limit, maxBytes, sourceCut && !jsonMode);
  if ("ok" in window && window.ok === false) return window;
  const { content, complete, meta } = window as WindowResult;

  const { content: _full, ...rest } = data;
  void _full;
  return {
    ...root,
    data: {
      ...rest,
      content,
      // truncated: the returned content is not the whole file (or selection).
      truncated: !complete,
      window: meta,
      ...(json ? { json } : {}),
    },
  };
}
