import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerAuditTools } from "./audit-tools.js";
import { fakeEngine } from "../../test-helpers/seeing-engine.js";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Content[] };
type Registered = { name: string; description: string; schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }>; handler: (args: Record<string, unknown>) => Promise<unknown> };

function tools(): Registered[] {
  const out: Registered[] = [];
  registerAuditTools({
    tool(name: string, description: string, schema: Registered["schema"], handler: Registered["handler"]) {
      out.push({ name, description, schema, handler });
      return { name };
    },
  } as never);
  return out;
}

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "audit-mcp-"));
  writeFileSync(join(project, "project.godot"), "config_version=5\n");
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  vi.mocked(getClient).mockReset();
});

const ID9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const kernel = () => ({
  ok: true,
  stage: "done",
  ms: { total: 500 },
  stats: { nodes: 10 },
  instances: Array.from({ length: 120 }, (_, i) => ({ p: `Props/Crate_${i}`, k: `crate_${i}`, s: `res://kit/crate_${i}.tscn`, r: "prop", in: true, o: [i, 0, 0], b: ID9, sc: [1, 1, 1], det: 1, c: [i, 0.5, 0], e: [1, 1, 1], le: [1, 1, 1], lc: [0, 0.5, 0], m: 1, f: [0, 0, 0], cl: Array(16).fill(6) })),
  support: Array.from({ length: 120 }, (_, i) => [i, 0.5, 0.9, [[0, -1], [0, -1], [0, -1], [0, -1], [0, -1]]]),
});

describe("summer_scene_audit — MCP face", () => {
  it("registers one tool whose description states read-only, the 5 KB page and the checks", () => {
    const registered = tools();
    expect(registered.map((t) => t.name)).toEqual(["summer_scene_audit"]);
    const d = registered[0]!.description;
    for (const word of ["Read-only", "5 KB", "through_hole", "orientation", "uv_stretch", "never node or file names", "offset", "min_severity", "render", "failure_reason"]) expect(d).toContain(word);
    expect(d).not.toMatch(/manifest|insert_host|mount_gap|mount_side|fits_into/);
    expect(registered[0]!.schema).not.toHaveProperty("manifests");
  });

  it("rejects malformed arguments at the schema boundary", () => {
    const schema = tools()[0]!.schema;
    expect(schema.checks!.safeParse(["through_hole", "orientation"]).success).toBe(true);
    expect(schema.checks!.safeParse(["everything"]).success).toBe(false);
    expect(schema.min_severity!.safeParse("fatal").success).toBe(false);
    expect(schema.limit!.safeParse(0).success).toBe(false);
    expect(schema.limit!.safeParse(51).success).toBe(false);
    expect(schema.render!.safeParse("gif").success).toBe(false);
    expect(schema.offset!.safeParse(-1).success).toBe(false);
    expect(schema.budget_ms!.safeParse(3000).success).toBe(true);
    expect(schema.budget_ms!.safeParse(100).success).toBe(false);
    expect(schema.budget_ms!.safeParse(60001).success).toBe(false);
  });

  it("returns ONE text block of at most 5 KB (no image unless asked)", async () => {
    vi.mocked(getClient).mockResolvedValue(fakeEngine({ projectRoot: project, audit: kernel }) as never);
    const result = (await tools()[0]!.handler({ scenePath: "res://a.tscn" })) as Result;
    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.type)).toEqual(["text"]);
    expect(Buffer.byteLength(result.content[0]!.text!)).toBeLessThanOrEqual(5000);
    const body = JSON.parse(result.content[0]!.text!);
    expect(body).toMatchObject({ ok: true, tool: "summer_scene_audit" });
    // 120 floating crates. The one at x 0 is one of a row of siblings
    // (placed, not left at the origin).
    expect(body.total).toBe(120);
    expect(body.next_offset).toBeGreaterThan(0);
  });

  it("render sheet adds one inline image before the text", async () => {
    vi.mocked(getClient).mockResolvedValue(fakeEngine({ projectRoot: project, audit: kernel }) as never);
    const result = (await tools()[0]!.handler({ scenePath: "res://a.tscn", render: "sheet" })) as Result;
    expect(result.content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });

  it("hostile input is invalid_input with nothing sent", async () => {
    const engine = fakeEngine({ projectRoot: project, audit: kernel });
    vi.mocked(getClient).mockResolvedValue(engine as never);
    const result = (await tools()[0]!.handler({ scenePath: "res://a.tscn", root: '"); OS.execute("rm' })) as Result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ failure_reason: "invalid_input", sent: false });
    expect(engine.calls).toEqual([]);
  });

  it("structured failures come back as isError with failure_reason", async () => {
    vi.mocked(getClient).mockResolvedValue(fakeEngine({ projectRoot: project, silentKernel: true }) as never);
    const result = (await tools()[0]!.handler({ scenePath: "res://a.tscn" })) as Result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ ok: false, failure_reason: "audit_did_not_run" });
  });
});
