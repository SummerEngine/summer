import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../../../scripts/validate-library/json-schema.ts";
import { PACKAGE_ROOT } from "../package-root.js";
import { localEntries, localInputSchema } from "./catalog.js";
import { isLocalOp, legacyNames, localToolsFor, mcpNameOf, opForToolCall, OP_NAME, opFromCli, parseJobId, resolveOpName } from "./contract.js";
import { searchEntries } from "./search.js";

const schema = JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry", "schemas", "operation.schema.json"), "utf8")) as Record<string, unknown>;
const fixturesDir = join(PACKAGE_ROOT, "registry", "operations", "fixtures");
const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));

describe("the operation contract (registry/schemas/operation.schema.json)", () => {
  it.each(fixtures.filter((name) => name.startsWith("valid-")))("accepts %s", (name) => {
    const data = JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
    expect(validateAgainstSchema(data, schema, new Map())).toEqual([]);
  });

  it.each(fixtures.filter((name) => name.startsWith("invalid-")))("rejects %s", (name) => {
    const data = JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
    expect(validateAgainstSchema(data, schema, new Map()).length).toBeGreaterThan(0);
  });
});

describe("3.x names (registry/operations/legacy-names.json)", () => {
  it("maps every 3.x tool to an operation name of the contract", () => {
    const rows = Object.entries(legacyNames());
    expect(rows.length).toBeGreaterThan(200);
    for (const [name, row] of rows) {
      expect(name).toMatch(/^summer_[a-z0-9_]+(#[a-z_]+)?$/);
      expect(row.op).toMatch(OP_NAME);
    }
  });

  it("maps every tool this package registers", async () => {
    const { listToolDispatches } = await import("../capabilities/tool-dispatch.js");
    const names = legacyNames();
    const unmapped = listToolDispatches().map((entry) => entry.name).filter((name) => !names[name]);
    expect(unmapped).toEqual([]);
  });

  it("resolves old names, keeps new ones and says where each runs", () => {
    expect(resolveOpName("summer_set_prop")).toBe("engine.set_prop");
    expect(resolveOpName("summer_grow_prices#set_base")).toBe("pricing.set_base");
    expect(resolveOpName("games.list")).toBe("games.list");
    expect(isLocalOp("engine.set_prop")).toBe(true);
    expect(isLocalOp("docs.search")).toBe(true);
    expect(isLocalOp("docs.workflows")).toBe(false);
    expect(isLocalOp("games.list")).toBe(false);
    expect(localToolsFor("docs.read")).toEqual(["summer_read_library", "summer_get_agent_playbook"]);
    expect(isLocalOp("apps.publish_folder")).toBe(true);
    expect(isLocalOp("apps.publish")).toBe(false);
    expect(localToolsFor("apps.publish_folder")).toEqual(["summer_app_publish"]);
  });

  it("names tools, CLI words and job ids the same way the hosted server does", () => {
    expect(mcpNameOf("games.list")).toBe("summer_games_list");
    expect(opFromCli("assets", "generate-image")).toBe("assets.generate_image");
    expect(opFromCli("whoami")).toBe("whoami");
    expect(parseJobId("apr:g_1:goa_2")).toEqual({ kind: "apr", parts: ["g_1", "goa_2"] });
    expect(parseJobId("4821")).toEqual({ kind: "gen", parts: ["4821"] });
    expect(parseJobId("not a job")).toBeNull();
  });

  it("names the operation behind each call for telemetry", () => {
    expect(opForToolCall("summer_call", { op: "summer_check_job" })).toBe("jobs.get");
    expect(opForToolCall("summer_set_prop", {})).toBe("engine.set_prop");
    expect(opForToolCall("summer_docs_search", {})).toBe("docs.search");
    expect(opForToolCall("summer_search", {})).toBe("ops.search");
    expect(opForToolCall("summer_call", { op: "rm -rf /" })).toBeNull();
  });
});

describe("the local catalog", () => {
  const entries = localEntries();

  it("holds the engine and library operations with their 3.x tools, and no cloud ones", () => {
    expect(entries.find((entry) => entry.name === "engine.set_prop")).toMatchObject({ provider: "engine", mcpTool: "summer_set_prop", effect: "write", approval: "none" });
    expect(entries.find((entry) => entry.name === "docs.search")).toMatchObject({ provider: "local", effect: "read" });
    expect(entries.some((entry) => !isLocalOp(entry.name))).toBe(false);
    expect(entries.find((entry) => entry.name === "apps.publish_folder")).toMatchObject({ provider: "local", mcpTool: "summer_app_publish" });
  });

  it("reads an operation's exact input from its library descriptor", () => {
    expect(localInputSchema("engine.set_prop")).toMatchObject({ type: "object", properties: expect.objectContaining({ scenePath: expect.any(Object) }) });
    expect(localInputSchema("games.list")).toBeNull();
  });

  it("finds operations from plain words", () => {
    expect(searchEntries(entries, "set a property on a node", { limit: 3 }).map((entry) => entry.name)).toContain("engine.set_prop");
    expect(searchEntries(entries, "summer_add_node", { limit: 1 })[0].name).toBe("engine.add_node");
    expect(searchEntries(entries, "search the library docs", { area: "docs", limit: 2 })[0].name).toBe("docs.search");
  });
});
