import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatToolList,
  parseJsonArgs,
  resolveToolForCli,
  resolveViaRegistryIndex,
  toolCommand,
} from "./tool.js";
import { listToolDispatches } from "../../core/capabilities/tool-dispatch.js";
import { EngineApiClient } from "../../core/api-client.js";

// The default dispatch context connects through EngineApiClient.connect();
// stub that one seam so `summer tool` runs against a scripted engine.
vi.mock("../../core/api-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/api-client.js")>();
  return { ...actual, EngineApiClient: { connect: vi.fn() } };
});

describe("summer tool command", () => {
  it("is registered as 'tool' with --list and --args; --json is a hidden deprecated alias", () => {
    expect(toolCommand.name()).toBe("tool");
    const optionNames = toolCommand.options.map((option) => option.long);
    expect(optionNames).toContain("--list");
    expect(optionNames).toContain("--args");
    const json = toolCommand.options.find((option) => option.long === "--json");
    expect(json?.hidden).toBe(true);
    expect(toolCommand.helpInformation()).toContain("--args <json>");
    expect(toolCommand.helpInformation()).not.toContain("--json");
  });

  it("lists every dispatchable tool with a one-line summary", () => {
    const entries = listToolDispatches();
    const output = formatToolList(entries);
    expect(output).toContain(`Summer tools (${entries.length})`);
    for (const entry of ["add-node", "generate-image", "creator-releases", "library-feedback"]) {
      expect(output).toContain(entry);
    }
    expect(output).toContain("[engine]");
  });

  it("resolves both slugs and summer_ aliases", () => {
    expect(resolveToolForCli("screenshot")?.name).toBe("summer_screenshot");
    expect(resolveToolForCli("summer_screenshot")?.slug).toBe("screenshot");
    expect(resolveToolForCli("definitely-not-a-tool")).toBeNull();
  });

  it("parses --args into an args object and rejects non-objects", () => {
    expect(parseJsonArgs(undefined)).toEqual({});
    expect(parseJsonArgs('{"path": "res://a.gd"}')).toEqual({ path: "res://a.gd" });
    expect(() => parseJsonArgs("not json")).toThrow(/valid JSON/);
    expect(() => parseJsonArgs('["array"]')).toThrow(/JSON object/);
  });

  it("resolves ids and legacy aliases through a generated registry index", () => {
    const root = mkdtempSync(join(tmpdir(), "summer-tool-test-"));
    mkdirSync(join(root, "registry", "generated"), { recursive: true });
    writeFileSync(
      join(root, "registry", "generated", "index.json"),
      JSON.stringify({
        resources: [
          { id: "tool/add-node", kind: "tool", aliases: ["summer_add_node"] },
          { id: "skill/some-skill", kind: "skill", aliases: ["summer_add_node_skill"] },
        ],
      })
    );
    expect(resolveViaRegistryIndex("tool/add-node", root)).toBe("add-node");
    expect(resolveViaRegistryIndex("summer_add_node", root)).toBe("add-node");
    expect(resolveViaRegistryIndex("nope", root)).toBeNull();
    // Missing index: falls back cleanly.
    expect(resolveViaRegistryIndex("tool/add-node", join(root, "missing"))).toBeNull();
  });

  it("prints an old engine's unknown-op answer as the structured engine_lacks_op result and exits 1", async () => {
    // Engine 0.5.65: advertises singleOnlyOps but no opKinds, so the capability
    // pre-flight cannot refuse and the engine itself answers "unknown op".
    vi.mocked(EngineApiClient.connect).mockResolvedValue({
      getEngineCapabilities: () => ({ singleOnlyOps: ["SaveScene"] }),
      executeOps: async () => ({ ok: false, error: "unknown op: GetWorldSnapshot" }),
    } as never);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const previousExitCode = process.exitCode;
    try {
      await toolCommand.parseAsync(["world-snapshot"], { from: "user" });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
    }
    const printed = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(printed).toMatchObject({ ok: false, op: "GetWorldSnapshot", failure_reason: "engine_lacks_op" });
    expect(String(printed.error)).toContain("summer_get_scene_tree");
    expect(String(printed.error)).toContain("update Summer Engine");
    expect(String(printed.error)).toContain("Engine said: unknown op: GetWorldSnapshot");
  });

  async function runToolCommand(argv: string[]): Promise<{ exitCode: number | string | undefined; printed: Record<string, unknown> }> {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await toolCommand.parseAsync(argv, { from: "user" });
      return { exitCode: process.exitCode, printed: JSON.parse(lines.join("\n")) as Record<string, unknown> };
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
    }
  }

  it("exits 1 and prints the engine's failure envelope when a read fails — the CLI twin of the MCP face's isError (E2E F-06)", async () => {
    // Engine 0.5.65 answers a missing node with HTTP 200 + {ok:false, error}
    // (state_provider.cpp inspector_state); the MCP face marks that isError.
    vi.mocked(EngineApiClient.connect).mockResolvedValue({
      inspectNode: async () => ({ ok: false, error: "node not found: DoesNotExist", appliedThroughSeq: 12 }),
    } as never);
    const { exitCode, printed } = await runToolCommand(["inspect-node", "--args", '{"path":"DoesNotExist"}']);
    expect(exitCode).toBe(1);
    expect(printed).toMatchObject({ ok: false, error: "node not found: DoesNotExist" });
  });

  it("exits 1 on a failed scene-mutation receipt, which the handler returns rather than throws", async () => {
    vi.mocked(EngineApiClient.connect).mockResolvedValue({
      executeIdentityBoundOps: async () => ({
        ok: false,
        results: [{ ok: false, op: "AddNode", error: "parent not found: Nope" }],
      }),
    } as never);
    const { exitCode, printed } = await runToolCommand([
      "add-node",
      "--args",
      '{"scenePath":"res://main.tscn","parent":"Nope","type":"Label","name":"E2ELabel"}',
    ]);
    expect(exitCode).toBe(1);
    expect(printed.ok).toBe(false);
    expect(printed.error).toBe("Engine request failed (AddNode).");
    expect((printed.results as Array<{ error?: string }>)[0]?.error).toBe("parent not found: Nope");
  });

  it("exits 0 and prints the payload on success (control)", async () => {
    vi.mocked(EngineApiClient.connect).mockResolvedValue({
      inspectNode: async () => ({ ok: true, node_name: "Player", props: [] }),
    } as never);
    const { exitCode, printed } = await runToolCommand(["inspect-node", "--args", '{"path":"Player"}']);
    expect(exitCode).toBeUndefined();
    expect(printed).toEqual({ ok: true, node_name: "Player", props: [] });
  });
});
