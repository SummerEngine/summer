import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatToolList,
  parseJsonArgs,
  resolveToolForCli,
  resolveViaRegistryIndex,
  toolCommand,
} from "./tool.js";
import { listToolDispatches } from "../../core/capabilities/tool-dispatch.js";

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
});
