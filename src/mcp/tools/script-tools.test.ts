import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import {
  isApiDocsBundleInstalled,
  lookupApiDocs,
  registerScriptTools,
  resetApiDocsForTests,
} from "./script-tools.js";

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerScriptTools({
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered.push({ name, handler });
      return { name };
    },
  } as never);
  return registered;
}

function tool(registered: RegisteredTool[], name: string): RegisteredTool {
  const found = registered.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function text(result: unknown): string {
  const envelope = result as { content?: Array<{ text?: string }> };
  return envelope.content?.[0]?.text ?? "";
}

// A tiny synthetic bundle so the lookup logic is tested independently of the
// shipped asset's exact content (which another build step owns).
const FIXTURE_DOCS = {
  technical_base: "4.6.1",
  classes: {
    Shape3D: { inherits: "Resource", brief: "Base class for shapes." },
    BoxShape3D: {
      inherits: "Shape3D",
      brief: "A 3D box shape.",
      properties: [{ name: "size", type: "Vector3", default: "Vector3(1, 1, 1)" }],
    },
    Node3D: {
      inherits: "Node",
      brief: "3D node.",
      properties: [{ name: "position", type: "Vector3" }],
    },
    MeshInstance3D: {
      inherits: "GeometryInstance3D",
      brief: "Mesh instance.",
      properties: [{ name: "mesh", type: "Mesh" }],
    },
    CharacterBody3D: {
      inherits: "PhysicsBody3D",
      brief: "Character body.",
      methods: [{ sig: "move_and_slide() -> bool" }],
      signals: [],
      constants: [{ name: "MOTION_MODE_GROUNDED", value: "0", enum: "MotionMode" }],
    },
  },
};

let tempDirs: string[] = [];

function fixtureBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-api-docs-"));
  tempDirs.push(dir);
  const path = join(dir, "api-docs.json.gz");
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(FIXTURE_DOCS), "utf8")));
  return path;
}

function missingBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-api-docs-missing-"));
  tempDirs.push(dir);
  return join(dir, "api-docs.json.gz");
}

afterEach(() => {
  vi.clearAllMocks();
  resetApiDocsForTests();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("summer_api_docs", () => {
  it("returns a known class with typed properties and the technical base stamp", () => {
    resetApiDocsForTests(fixtureBundle());
    const entry = lookupApiDocs("BoxShape3D") as {
      ok: boolean;
      class: string;
      inherits: string;
      technical_base?: string;
      properties: Array<{ name: string; type: string; default?: string }>;
    };
    expect(entry.ok).toBe(true);
    expect(entry.class).toBe("BoxShape3D");
    expect(entry.inherits).toBe("Shape3D");
    expect(entry.technical_base).toBe("4.6.1");
    const size = entry.properties.find((p) => p.name === "size");
    expect(size?.type).toBe("Vector3");
    expect(size?.default).toBe("Vector3(1, 1, 1)");
  });

  it("is case-insensitive on the class name", () => {
    resetApiDocsForTests(fixtureBundle());
    const entry = lookupApiDocs("boxshape3d") as { ok: boolean; class: string };
    expect(entry.ok).toBe(true);
    expect(entry.class).toBe("BoxShape3D");
  });

  it("resolves a single member across kinds", () => {
    resetApiDocsForTests(fixtureBundle());
    const property = lookupApiDocs("BoxShape3D", "size") as {
      ok: boolean;
      property?: { name: string; type: string };
    };
    expect(property.ok).toBe(true);
    expect(property.property?.type).toBe("Vector3");

    const method = lookupApiDocs("CharacterBody3D", "move_and_slide") as {
      ok: boolean;
      method?: { sig: string };
    };
    expect(method.ok).toBe(true);
    expect(method.method?.sig).toContain("move_and_slide(");

    const constant = lookupApiDocs("CharacterBody3D", "MOTION_MODE_GROUNDED") as {
      ok: boolean;
      constant?: { name: string };
    };
    expect(constant.ok).toBe(true);
    expect(constant.constant?.name).toBe("MOTION_MODE_GROUNDED");
  });

  it("returns closest-name suggestions on a class miss", () => {
    resetApiDocsForTests(fixtureBundle());
    const miss = lookupApiDocs("BoxShap") as {
      ok: boolean;
      error: string;
      suggestions: string[];
    };
    expect(miss.ok).toBe(false);
    expect(miss.suggestions).toContain("BoxShape3D");
  });

  it("returns member suggestions and an inherits hint on a member miss", () => {
    resetApiDocsForTests(fixtureBundle());
    const miss = lookupApiDocs("MeshInstance3D", "position") as {
      ok: boolean;
      hint?: string;
    };
    expect(miss.ok).toBe(false);
    // position is declared on Node3D, not MeshInstance3D — the hint points up.
    expect(miss.hint).toContain("parent class");
  });

  it("marks a miss as isError through the tool handler", async () => {
    resetApiDocsForTests(fixtureBundle());
    const handler = tool(tools(), "summer_api_docs");
    const result = (await handler.handler({ class_name: "NopeNotAClass" })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("suggestions");
  });

  it("answers api_docs_not_installed cleanly when the bundle is absent (never throws)", async () => {
    resetApiDocsForTests(missingBundle());
    expect(isApiDocsBundleInstalled()).toBe(false);
    const direct = lookupApiDocs("BoxShape3D") as { ok: boolean; failure_reason?: string; error: string };
    expect(direct.ok).toBe(false);
    expect(direct.failure_reason).toBe("api_docs_not_installed");
    expect(direct.error).toContain("api docs bundle not installed");

    const handler = tool(tools(), "summer_api_docs");
    const result = (await handler.handler({ class_name: "BoxShape3D" })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("api_docs_not_installed");
    expect(text(result)).toContain("summer-engine");
  });

  it("reads the shipped bundle when it is present", () => {
    resetApiDocsForTests();
    if (!isApiDocsBundleInstalled()) return; // bundle is built by a separate step
    const entry = lookupApiDocs("Node3D") as { ok: boolean; class: string };
    expect(entry.ok).toBe(true);
    expect(entry.class).toBe("Node3D");
  });
});

describe("summer_run_script", () => {
  it("submits a single RunSceneScript op with clamped budget and a matching client timeout", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "RunSceneScript", ran: true }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeIdentityBoundOps } as never);

    const handler = tool(tools(), "summer_run_script");
    const result = (await handler.handler({
      source: "func run(ctx):\n\tpass",
      max_seconds: 500,
    })) as { isError?: boolean };

    expect(result.isError).toBeUndefined();
    const [ops, , timeoutMs] = executeIdentityBoundOps.mock.calls[0]!;
    expect(ops).toEqual([
      {
        op: "RunSceneScript",
        script_source: "func run(ctx):\n\tpass",
        max_seconds: 120, // clamped from 500
        checkpoint: true,
      },
    ]);
    expect(timeoutMs).toBeGreaterThan(120_000);
  });

  it("maps an unknown-op failure (engine without a capability advert) to the engine-too-old hint", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "RunSceneScript", error: "unknown op: RunSceneScript" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeIdentityBoundOps } as never);

    const handler = tool(tools(), "summer_run_script");
    const result = (await handler.handler({ source: "func run(ctx):\n\tpass" })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't support RunSceneScript yet");
    expect(text(result)).toContain("summer_run_editor_script");
  });

  it("refuses BEFORE sending when the engine advertises an op list without RunSceneScript", async () => {
    const executeIdentityBoundOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      executeIdentityBoundOps,
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "SetProp", "RunEditorScript"] }),
      getEngineVersion: () => "0.5.61",
    } as never);

    const handler = tool(tools(), "summer_run_script");
    const result = (await handler.handler({ source: "func run(ctx):\n\tpass" })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_op");
    expect(text(result)).toContain("RunSceneScript");
    expect(text(result)).toContain("0.5.61");
    expect(text(result)).toContain("summer_run_editor_script");
  });

  it("sends normally when the advertised op list includes RunSceneScript", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "RunSceneScript", ran: true }],
    });
    vi.mocked(getClient).mockResolvedValue({
      executeIdentityBoundOps,
      getEngineCapabilities: () => ({ opKinds: ["RunSceneScript"] }),
      getEngineVersion: () => "0.6.0",
    } as never);

    const result = (await tool(tools(), "summer_run_script").handler({
      source: "func run(ctx):\n\tpass",
    })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });
});

describe("summer_run_editor_script", () => {
  it("gives the client poll budget headroom beyond max_seconds", async () => {
    const executeIdentityBoundOps = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ ok: true, op: "RunEditorScript", ran: true }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeIdentityBoundOps } as never);

    const handler = tool(tools(), "summer_run_editor_script");
    await handler.handler({ source: "func _run():\n\tpass", max_seconds: 600 });

    const [ops, , timeoutMs] = executeIdentityBoundOps.mock.calls[0]!;
    expect(ops[0]).toMatchObject({ op: "RunEditorScript", max_seconds: 600 });
    expect(timeoutMs).toBeGreaterThan(600_000);
  });
});
