import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handlerSnippet, handlersInSource, scanToolHandlers, unhandledClientTools } from "./handlers.js";

const names = (source: string) => handlersInSource(source).map((found) => found.name).sort();

describe("GDScript tool handler scan (summer router push refuses unhandled client tools)", () => {
  it("reads the SPEC section 6 dictionary shapes", () => {
    expect(names(`s.tools = {"open_gate": func(args): $Gate.open(); return {"ok": true}}`)).toEqual(["open_gate"]);
    expect(names(`$Guard.tools = {open_gate = _open, give_key = _give}`)).toEqual(["give_key", "open_gate"]);
    expect(names(`extends SummerRouterCharacter\nfunc _ready():\n\ttools = {&"wave": _wave}`)).toEqual(["wave"]);
    expect(names(`var tools: Dictionary[String, Callable] = {"sit": _sit}`)).toEqual(["sit"]);
    expect(names(`guard.tools["open_gate"] = _open\nguard.tools.give_key = _give`)).toEqual(["give_key", "open_gate"]);
    expect(names(`guard.tools.merge({"trade": _trade, 'haggle': _haggle})`)).toEqual(["haggle", "trade"]);
  });

  it("reads the .tool() call and the tools key of talk() and reply() options (engine SDK shapes)", () => {
    expect(names(`s.tool("open_gate", _open)\n$Guard.tool(&"give_key", func(args): return {"ok": true})`)).toEqual(["give_key", "open_gate"]);
    expect(names(`extends SummerRouterCharacter\nfunc _ready():\n\ttool("wave", _wave)`)).toEqual(["wave"]);
    expect(names(`var s := await Summer.client.router.talk("guard", {"mode": "voice", "tools": {"open_gate": _open, give_key = _give}})`)).toEqual(["give_key", "open_gate"]);
    expect(names(`var r := await Summer.client.router.reply("guard", "hi", {\n\t"tools": HANDLERS,\n})\nconst HANDLERS := {"trade": _trade}`)).toEqual(["trade"]);
    // Not registrations: a tool() definition, a call without a name, and a "tools" key holding a list.
    expect(names(`func tool(name: String, f: Callable) -> void:\n\tpass\nx.tool(name, f)\nvar d = {"tools": ["a"]}`)).toEqual([]);
  });

  it("follows a dictionary assigned to a name, and multi-line entries", () => {
    const source = `
const HANDLERS := {
	"open_gate": _on_open_gate, # the guard opens it
	"give_key": func(args: Dictionary) -> Dictionary:
		var reply := {"nested_key": 1}
		return reply,
}

func _ready() -> void:
	$Guard.tools = HANDLERS
`;
    expect(names(source)).toEqual(["give_key", "open_gate"]);
  });

  it("ignores comments, strings, comparisons and dictionary methods", () => {
    expect(names(`# guard.tools = {"open_gate": _open}`)).toEqual([]);
    expect(names(`print('tools = {"open_gate": x}')`)).toEqual([]);
    expect(names(`if guard.tools == {"open_gate": _open}: pass`)).toEqual([]);
    expect(names(`guard.tools.clear()\nvar n = guard.tools.size()`)).toEqual([]);
    expect(names(`var other = {"open_gate": _open}`)).toEqual([]);
  });

  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("scans every .gd under the project, skipping hidden folders, and lists unhandled client tools only", () => {
    root = mkdtempSync(join(tmpdir(), "summer-router-handlers-"));
    mkdirSync(join(root, "npc"), { recursive: true });
    mkdirSync(join(root, ".godot"), { recursive: true });
    writeFileSync(join(root, "npc", "guard.gd"), `func _ready():\n\t$Guard.tools = {"open_gate": _open}\n`);
    writeFileSync(join(root, ".godot", "cache.gd"), `x.tools = {"give_key": _give}\n`);
    const handlers = scanToolHandlers(root);
    expect(handlers.get("open_gate")).toEqual([{ file: "npc/guard.gd", line: 2 }]);
    expect(handlers.has("give_key")).toBe(false);

    const missing = unhandledClientTools(
      [
        {
          id: "guard",
          doc: {
            tools: [
              { name: "open_gate" },
              { name: "give_key", runs_on: "client" },
              { name: "ban_player", runs_on: "authority" },
            ],
          },
        },
      ],
      handlers
    );
    expect(missing).toEqual([{ character: "guard", tool: "give_key" }]);
    const snippet = handlerSnippet(missing);
    expect(snippet).toContain('$Guard.tools = {"give_key": _on_give_key}');
    expect(names(snippet)).toEqual(["give_key"]);
  });
});
