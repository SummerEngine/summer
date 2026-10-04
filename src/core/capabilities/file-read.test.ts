import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseJsonPath, readProjectFileWindow, type ReadFileArgs } from "./file-read.js";
import { dispatchTool } from "./tool-dispatch.js";

function fileClient(content: string, options: { truncatedAt?: number } = {}) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const readProjectFile = vi.fn(async (_path: string, maxBytes = 200_000) => {
    const limit = Math.min(maxBytes, options.truncatedAt ?? Number.MAX_SAFE_INTEGER);
    const bytes = Buffer.from(content, "utf8");
    const cut = bytes.length > limit;
    return {
      ok: true,
      data: {
        content: bytes.subarray(0, Math.min(bytes.length, limit)).toString("utf8"),
        encoding: "utf-8",
        size: bytes.length,
        truncated: cut,
        sha256,
      },
    };
  });
  return { readProjectFile, sha256 };
}

const read = (client: ReturnType<typeof fileClient>, args: Partial<ReadFileArgs>) =>
  readProjectFileWindow(client, { path: "res://data/pieces.json", max_bytes: 200_000, ...args } as ReadFileArgs) as Promise<{
    ok?: boolean;
    failure_reason?: string;
    error?: string;
    data: { content: string; truncated: boolean; sha256: string; window: Record<string, unknown>; json?: Record<string, unknown> };
  }>;

const PIECES = JSON.stringify(
  {
    about: "kit",
    pieces: {
      alley_floor_a: { scene: "res://kit/alley_floor_a.tscn", size_m: [5.28, 0.105, 7.478] },
      wall_tripple_standard_01: { scene: "res://kit/wall_01.tscn", fits_into: null },
      wall_tripple_standard_door_02: { scene: "res://kit/door_02.tscn", fits_into: null },
      "odd.name": { scene: "res://kit/odd.tscn" },
    },
    list: [10, 20, 30],
  },
  null,
  1
);

describe("summer_read_file without window arguments", () => {
  it("is the engine read, unchanged", async () => {
    const client = fileClient("hello\n");
    await readProjectFileWindow(client, { path: "res://a.txt", max_bytes: 1234 });
    expect(client.readProjectFile).toHaveBeenCalledWith("res://a.txt", 1234);
  });
});

describe("line and byte windows", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

  it("pages by lines with next_offset and keeps the full-file sha256", async () => {
    const client = fileClient(text);
    const first = await read(client, { path: "res://a.txt", offset: 0, limit: 4 });
    expect(first.data.content).toBe("line 1\nline 2\nline 3\nline 4");
    expect(first.data.window).toMatchObject({ unit: "lines", start_line: 1, end_line: 4, total_lines: 10, next_offset: 4, eof: false });
    expect(first.data.truncated).toBe(true);
    expect(first.data.sha256).toBe(client.sha256);
    const last = await read(client, { path: "res://a.txt", offset: 8, limit: 4 });
    expect(last.data.content).toBe("line 9\nline 10");
    expect(last.data.window).toMatchObject({ start_line: 9, end_line: 10, next_offset: null, eof: true });
  });

  it("cuts a line window at max_bytes and says so", async () => {
    const client = fileClient(text);
    const result = await read(client, { path: "res://a.txt", offset: 0, limit: 10, max_bytes: 15 });
    expect(result.data.content).toBe("line 1\nline 2");
    expect(result.data.window).toMatchObject({ returned: 2, next_offset: 2, cut_by_max_bytes: true, eof: false });
  });

  it("pages by bytes on UTF-8 character boundaries", async () => {
    const client = fileClient("aé€b"); // 1 + 2 + 3 + 1 bytes
    const result = await read(client, { path: "res://u.txt", unit: "bytes", offset: 2, limit: 3 });
    // offset 2 is inside "é": the window starts at the next character.
    expect(result.data.content).toBe("€");
    expect(result.data.window).toMatchObject({ start_byte: 3, end_byte: 6, total_bytes: 7, next_offset: 6, eof: false });
  });

  it("says when a file is larger than the engine's read window", async () => {
    const client = fileClient(text, { truncatedAt: 20 });
    const result = await read(client, { path: "res://a.txt", offset: 0, limit: 100 });
    expect(result.data.window).toMatchObject({ total_lines_is_lower_bound: true, eof: false });
  });
});

describe("JSON selection", () => {
  it("json_path returns one entry of a big pieces.json", async () => {
    const result = await read(fileClient(PIECES), { json_path: "pieces.wall_tripple_standard_door_02" });
    expect(JSON.parse(result.data.content)).toEqual({ scene: "res://kit/door_02.tscn", fits_into: null });
    expect(result.data.json).toMatchObject({ json_path: "pieces.wall_tripple_standard_door_02", type: "object", total_keys: 2 });
  });

  it("keys keeps matching object keys (globs); keys_only lists names", async () => {
    const picked = await read(fileClient(PIECES), { json_path: "pieces", keys: ["wall_tripple_*"] });
    expect(Object.keys(JSON.parse(picked.data.content))).toEqual(["wall_tripple_standard_01", "wall_tripple_standard_door_02"]);
    expect(picked.data.json).toMatchObject({ total_keys: 4, matched_keys: 2 });
    const names = await read(fileClient(PIECES), { json_path: "pieces", keys_only: true });
    expect(JSON.parse(names.data.content)).toEqual(["alley_floor_a", "wall_tripple_standard_01", "wall_tripple_standard_door_02", "odd.name"]);
  });

  it("brackets reach keys with dots and array items", async () => {
    const odd = await read(fileClient(PIECES), { json_path: 'pieces["odd.name"].scene' });
    expect(JSON.parse(odd.data.content)).toBe("res://kit/odd.tscn");
    const item = await read(fileClient(PIECES), { json_path: "list[-1]" });
    expect(JSON.parse(item.data.content)).toBe(30);
    expect(parseJsonPath("$.a[0]['b c']")).toEqual(["a", 0, "b c"]);
  });

  it("a missing path names what is there", async () => {
    const result = await read(fileClient(PIECES), { json_path: "pieces.nope" });
    expect(result).toMatchObject({ ok: false, failure_reason: "json_path_not_found", resolved: "pieces" });
    expect((result as unknown as { here: { keys: string[] } }).here.keys).toContain("alley_floor_a");
  });

  it("refuses non-JSON and keys on an array", async () => {
    expect(await read(fileClient("not json"), { json_path: "a" })).toMatchObject({ ok: false, failure_reason: "not_json" });
    expect(await read(fileClient(PIECES), { json_path: "list", keys: ["*"] })).toMatchObject({ ok: false, failure_reason: "not_an_object" });
  });

  it("the CLI face uses the same implementation and schema", async () => {
    const client = fileClient(PIECES);
    const result = (await dispatchTool(
      "read-file",
      { path: "res://data/pieces.json", json_path: "pieces", keys_only: true },
      { engine: async () => client as never }
    )) as { data: { content: string } };
    expect(JSON.parse(result.data.content)).toHaveLength(4);
    await expect(
      dispatchTool("read-file", { path: "res://a.json", unit: "pages" }, { engine: async () => client as never })
    ).rejects.toThrow(/Invalid arguments for read-file/);
  });
});
