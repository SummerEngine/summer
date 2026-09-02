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
  recordToolCall,
  redactTrajectoryArgs,
  registrationHasInputSchema,
  trajectoryArgsFor,
} from "./trajectory.js";

let tempDirs: string[] = [];
const originalEnv = process.env.SUMMER_TRAJECTORY_DIR;

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

afterEach(() => {
  if (originalEnv === undefined) delete process.env.SUMMER_TRAJECTORY_DIR;
  else process.env.SUMMER_TRAJECTORY_DIR = originalEnv;
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
