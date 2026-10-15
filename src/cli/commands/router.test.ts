import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRouterContext, defaultRouterIo, routerCommand, routerRuntime } from "./router.js";

let root = "";
let out: string[] = [];
let exitCode: number | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "summer-router-cli-"));
  writeFileSync(join(root, "project.godot"), "[application]\n");
  out = [];
  exitCode = undefined;
  routerRuntime.io = () => ({ out: (text) => out.push(text), err: () => undefined, isTTY: false, env: {} });
  routerRuntime.context = (opts) => ({ ...defaultRouterContext(opts), cwd: root });
  routerRuntime.exit = (code) => {
    exitCode = code;
  };
});

afterEach(() => {
  routerRuntime.io = defaultRouterIo;
  routerRuntime.context = defaultRouterContext;
  rmSync(root, { recursive: true, force: true });
});

const run = (argv: string[]) => routerCommand.parseAsync(argv, { from: "user" });

describe("summer router command wiring", () => {
  it("runs character add, then push --dry-run, with global options after the subcommand", async () => {
    await run(["character", "add", "guard", "--tools", "open_gate", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ ok: true, character: "guard", unhandled_tools: ["open_gate"] });

    out = [];
    await run(["push", "--dry-run", "--project", root]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(out.join("\n")).error.code).toBe("tool_unhandled");

    writeFileSync(join(root, "gate.gd"), `func _ready():\n\t$Guard.tools = {"open_gate": _open}\n`);
    out = [];
    await run(["push", "--dry-run"]);
    expect(exitCode).toBe(0);
  });

  it("exits 2 on a usage error", async () => {
    await run(["test", "guard", "--game", "game_1"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(out.join("\n")).error.code).toBe("invalid_input");
  });
});
