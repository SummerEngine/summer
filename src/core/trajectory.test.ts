import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTrajectoryEvalMode,
  recordToolCall,
  redactTrajectoryArgs,
  registrationHasInputSchema,
  summarizeToolResult,
  TRAJECTORY_RESULT_FIELD_ALLOWLIST,
  trajectoryArgsFor,
} from "./trajectory.js";

let tempDirs: string[] = [];
const originalEnv = process.env.SUMMER_TRAJECTORY_DIR;
const originalEvalEnv = process.env.SUMMER_TRAJECTORY_EVAL;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

function readLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "trajectory.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readFullLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "trajectory.full.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  if (originalEnv === undefined) delete process.env.SUMMER_TRAJECTORY_DIR;
  else process.env.SUMMER_TRAJECTORY_DIR = originalEnv;
  if (originalEvalEnv === undefined) delete process.env.SUMMER_TRAJECTORY_EVAL;
  else process.env.SUMMER_TRAJECTORY_EVAL = originalEvalEnv;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("trajectory capture", () => {
  it("is a no-op when SUMMER_TRAJECTORY_DIR is unset — never throws, writes nothing", () => {
    delete process.env.SUMMER_TRAJECTORY_DIR;
    expect(recordToolCall({ tool: "summer_play", args: { scene: "res://main.tscn" } })).toBe(false);
  });

  it("never throws when the directory is unwritable", () => {
    const dir = makeDir();
    // Point at a path that exists as a FILE, so mkdir/append both fail.
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "occupied");
    process.env.SUMMER_TRAJECTORY_DIR = join(blocked, "nested");
    expect(recordToolCall({ tool: "summer_play" })).toBe(false);
  });

  it("appends one JSONL record per tool call with redacted args and classifiers", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;

    const bigSource = "x".repeat(5000);
    expect(
      recordToolCall({
        tool: "summer_run_script",
        args: { source: bigSource, max_seconds: 20 },
        isError: true,
        terminalState: "timed_out",
        errorClass: "transient",
        failureReason: "timeout",
        durationMs: 1234,
      })
    ).toBe(true);

    const [line] = readLines(dir);
    expect(line!.kind).toBe("tool_call");
    expect(line!.tool).toBe("summer_run_script");
    expect(line!.ok).toBe(false);
    expect(line!.terminalState).toBe("timed_out");
    expect(line!.errorClass).toBe("transient");
    expect(line!.failureReason).toBe("timeout");
    expect(line!.durationMs).toBe(1234);
    expect(typeof line!.ts).toBe("string");
    const args = line!.argsRedacted as Record<string, unknown>;
    // Shape kept, body dropped.
    expect(args.source).toBe("[redacted 5000 chars]");
    expect(args.max_seconds).toBe(20);
  });

  it("keeps library-feedback outcomes intact in the stream (short strings survive redaction)", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;

    expect(recordToolCall({ tool: "summer_screenshot" })).toBe(true);
    expect(
      recordToolCall({
        tool: "summer_library_feedback",
        args: {
          reports: [{ entry_id: "skill/scene-scripting@1a2b3c4d", outcome: "worked_with_fixes" }],
          engine_version: "4.6.1",
        },
      })
    ).toBe(true);

    const lines = readLines(dir);
    expect(lines).toHaveLength(2);
    const args = lines[1]!.argsRedacted as { reports: Array<Record<string, unknown>> };
    expect(args.reports[0]!.outcome).toBe("worked_with_fixes");
    expect(args.reports[0]!.entry_id).toBe("skill/scene-scripting@1a2b3c4d");
  });

  it("rotates at the size cap and keeps only the last 4 rotated files", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;

    const live = join(dir, "trajectory.jsonl");
    // Pre-seed 5 stale rotations and an over-cap live file; the next append
    // rotates the live file and prunes down to 4 rotated files.
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, `trajectory-${1000 + i}.jsonl`), "{}\n");
    }
    writeFileSync(live, Buffer.alloc(16 * 1024 * 1024 + 1, 0x7b)); // > 16MB

    expect(recordToolCall({ tool: "summer_play" })).toBe(true);

    const names = readdirSync(dir).sort();
    const rotated = names.filter((name) => /^trajectory-\d+\.jsonl$/.test(name));
    expect(rotated).toHaveLength(4);
    // The oldest two stale rotations were pruned; the fresh rotation survives.
    expect(rotated).not.toContain("trajectory-1001.jsonl");
    expect(rotated).not.toContain("trajectory-1002.jsonl");
    // The live stream restarted with exactly the new record.
    const lines = readLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.tool).toBe("summer_play");
  });
});

describe("eval-mode full capture (SUMMER_TRAJECTORY_EVAL=1)", () => {
  const bigSource = "func run(ctx):\n\tpass\n" + "#".repeat(600);
  const mcpResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          results: [{ ok: true, op: "ScenePreview", framing: "camera", used_scene_camera: true, environment_used: "scene_world_environment", used_synthetic_camera: false, image_base64: "AAAA", secret_body: "never" }],
          terminalState: "applied",
        }),
      },
      { type: "image", data: Buffer.from("jpegbytes").toString("base64"), mimeType: "image/jpeg" },
    ],
  };

  it("is off unless BOTH the directory and the flag are set", () => {
    delete process.env.SUMMER_TRAJECTORY_DIR;
    process.env.SUMMER_TRAJECTORY_EVAL = "1";
    expect(isTrajectoryEvalMode()).toBe(false);
    // The flag alone records nothing at all (capture itself is off).
    expect(recordToolCall({ tool: "summer_run_script", args: { source: bigSource }, result: mcpResult })).toBe(false);

    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;
    delete process.env.SUMMER_TRAJECTORY_EVAL;
    expect(isTrajectoryEvalMode()).toBe(false);
    expect(recordToolCall({ tool: "summer_run_script", args: { source: bigSource }, result: mcpResult })).toBe(true);
    // Default behavior unchanged: the redacted stream exists, the full one does not.
    expect(readdirSync(dir)).toEqual(["trajectory.jsonl"]);
    expect((readLines(dir)[0]!.argsRedacted as Record<string, unknown>).source).toBe(`[redacted ${bigSource.length} chars]`);
  });

  it("writes an unredacted sibling stream with a bounded result summary, leaving the redacted stream unchanged", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;
    process.env.SUMMER_TRAJECTORY_EVAL = "1";
    expect(isTrajectoryEvalMode()).toBe(true);

    expect(
      recordToolCall({
        tool: "summer_screenshot",
        args: { target: "scene", framing: "camera", note: bigSource },
        terminalState: "applied",
        durationMs: 42,
        result: mcpResult,
      })
    ).toBe(true);

    expect(readdirSync(dir).sort()).toEqual(["trajectory.full.jsonl", "trajectory.jsonl"]);
    // Redacted stream: same record as without the flag.
    const [redacted] = readLines(dir);
    expect((redacted!.argsRedacted as Record<string, unknown>).note).toBe(`[redacted ${bigSource.length} chars]`);
    expect(redacted!.result).toBeUndefined();

    // Full stream: full args, summary only for the result.
    const [full] = readFullLines(dir);
    expect(full!.kind).toBe("tool_call");
    expect(full!.tool).toBe("summer_screenshot");
    expect((full!.args as Record<string, unknown>).note).toBe(bigSource);
    const result = full!.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.terminalState).toBe("applied");
    expect(result.keys).toEqual(["status", "results", "terminalState"]);
    expect(result.fields).toEqual({
      framing: "camera",
      used_scene_camera: true,
      environment_used: "scene_world_environment",
      used_synthetic_camera: false,
    });
    // Media by hash, never inline; no result bodies leak.
    const media = result.media as Array<Record<string, unknown>>;
    expect(media).toHaveLength(1);
    expect(media[0]!.mime).toBe("image/jpeg");
    expect(media[0]!.bytes).toBe(Buffer.byteLength("jpegbytes"));
    expect(typeof media[0]!.sha256).toBe("string");
    const line = readFileSync(join(dir, "trajectory.full.jsonl"), "utf-8");
    expect(line).not.toContain("AAAA");
    expect(line).not.toContain("secret_body");
    expect(line).not.toContain("jpegbytes");
    expect(full!.durationMs).toBe(42);
  });

  it("summarizes plain CLI-face results, counts errors/frame_warnings, and stays inside the allowlist", () => {
    const summary = summarizeToolResult(
      {
        status: "ok",
        results: [
          {
            ok: false,
            op: "RunSceneScript",
            rolled_back: true,
            budget_exceeded: false,
            errors: ["a", "b"],
            results: { frame_warnings: ["w"] },
            script_output_body: "x".repeat(1000),
          },
        ],
      },
      { ok: false, failureReason: "script_runtime_error" }
    );
    expect(summary.ok).toBe(false);
    expect(summary.failureReason).toBe("script_runtime_error");
    expect(summary.keys).toEqual(["status", "results"]);
    expect(summary.fields).toEqual({ rolled_back: true, budget_exceeded: false, errors_count: 2, frame_warnings_count: 1 });
    for (const key of Object.keys(summary.fields)) {
      expect([...TRAJECTORY_RESULT_FIELD_ALLOWLIST, "errors_count", "frame_warnings_count"]).toContain(key);
    }
    expect(summary.media).toEqual([]);
    // Non-JSON text and undefined results summarize to an empty shape, never throw.
    expect(summarizeToolResult({ content: [{ type: "text", text: "plain prose" }] }, { ok: true })).toEqual({ ok: true, keys: [], fields: {}, media: [] });
    expect(summarizeToolResult(undefined, { ok: true })).toEqual({ ok: true, keys: [], fields: {}, media: [] });
  });

  it("records a handler throw in the full stream with the unredacted message", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;
    process.env.SUMMER_TRAJECTORY_EVAL = "1";
    const message = "No main scene configured. " + "x".repeat(400);
    expect(recordToolCall({ tool: "summer_open_main_scene", args: {}, exception: message })).toBe(true);
    const [full] = readFullLines(dir);
    expect((full!.result as Record<string, unknown>).ok).toBe(false);
    expect((full!.result as Record<string, unknown>).errorClass).toBe("exception");
    expect(full!.exception).toBe(message);
    expect(readLines(dir)[0]!.exception).toBe(`[redacted ${message.length} chars]`);
  });
});

describe("redactTrajectoryArgs", () => {
  it("keeps short strings, numbers, booleans and structure", () => {
    expect(
      redactTrajectoryArgs({ a: "short", n: 3, b: true, nested: { c: [1, "two"] } })
    ).toEqual({ a: "short", n: 3, b: true, nested: { c: [1, "two"] } });
  });

  it("replaces long strings with a length marker at any depth", () => {
    const long = "y".repeat(201);
    expect(redactTrajectoryArgs({ deep: { source: long } })).toEqual({
      deep: { source: "[redacted 201 chars]" },
    });
  });

  it("caps depth, so circular input still serializes instead of throwing", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(recordToolCall({ tool: "t", args: circular })).toBe(true);
    const [line] = readLines(dir);
    expect(JSON.stringify(line!.argsRedacted)).toContain("[redacted: depth]");
  });
});

describe("schema-less tools and handler throws", () => {
  it("registrationHasInputSchema: raw shape / {} / zod instance yes; description-only or annotations no", () => {
    const zodish = { _def: {}, safeParse: () => ({ success: true }) };
    const cb = async () => ({});
    expect(registrationHasInputSchema(["t", "desc", { path: zodish }, cb])).toBe(true);
    expect(registrationHasInputSchema(["t", "desc", {}, cb])).toBe(true);
    expect(registrationHasInputSchema(["t", { path: zodish }, cb])).toBe(true);
    expect(registrationHasInputSchema(["t", "desc", zodish, cb])).toBe(true);
    expect(registrationHasInputSchema(["t", "desc", cb])).toBe(false);
    expect(registrationHasInputSchema(["t", cb])).toBe(false);
    // ToolAnnotations (flat primitives) is not a schema.
    expect(registrationHasInputSchema(["t", "desc", { readOnlyHint: true, title: "x" }, cb])).toBe(false);
  });

  it("trajectoryArgsFor: parsed args when there is a schema, null (never the SDK extra) when there is none", () => {
    const extra = { signal: new AbortController().signal, requestId: 7 };
    expect(trajectoryArgsFor(true, [{ scene: "res://a.tscn" }, extra])).toEqual({ scene: "res://a.tscn" });
    expect(trajectoryArgsFor(true, [])).toEqual({});
    expect(trajectoryArgsFor(false, [extra])).toBeNull();
  });

  it("records args:null as argsRedacted:null instead of an empty object", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;
    expect(recordToolCall({ tool: "summer_stop", args: null })).toBe(true);
    const [line] = readLines(dir);
    expect(line!.argsRedacted).toBeNull();
    expect(line!.ok).toBe(true);
  });

  it("records a handler throw as ok:false, errorClass exception, with the (redacted) message", () => {
    const dir = makeDir();
    process.env.SUMMER_TRAJECTORY_DIR = dir;
    expect(
      recordToolCall({
        tool: "summer_open_main_scene",
        args: {},
        exception: "No main scene configured. " + "x".repeat(400),
        durationMs: 12,
      })
    ).toBe(true);
    const [line] = readLines(dir);
    expect(line!.ok).toBe(false);
    expect(line!.errorClass).toBe("exception");
    expect(line!.exception).toBe("[redacted 426 chars]");
    expect(line!.durationMs).toBe(12);
  });
});
