import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The OpenCode entry point (package.json "main"). Plain JS, imported as-is so
// the test exercises exactly what OpenCode loads from node_modules.
const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.opencode/plugins/summer.js");

type Hooks = {
  config: (config: Record<string, any>) => Promise<void>;
  "experimental.chat.messages.transform": (input: unknown, output: any) => Promise<void>;
};
type PluginFn = ((input: unknown) => Promise<Hooks>) & {
  SKILLS_DIR: string;
  ORIENTATION: string;
  ORIENTATION_MARKER: string;
};

async function load(): Promise<{ mod: Record<string, unknown>; plugin: PluginFn }> {
  const mod = (await import(pluginPath)) as Record<string, unknown>;
  return { mod, plugin: mod.SummerPlugin as PluginFn };
}

describe(".opencode/plugins/summer.js", () => {
  it("exports exactly one plugin function (OpenCode invokes every export)", async () => {
    const { mod } = await load();
    expect(Object.keys(mod)).toEqual(["SummerPlugin"]);
    expect(typeof mod.SummerPlugin).toBe("function");
  });

  it("registers library/skills as an OpenCode skills path, idempotently", async () => {
    const { plugin } = await load();
    const hooks = await plugin({ client: {}, directory: process.cwd(), worktree: process.cwd() });
    const config: Record<string, any> = {};
    await hooks.config(config);
    await hooks.config(config);
    expect(config.skills.paths).toEqual([plugin.SKILLS_DIR]);
    expect(existsSync(join(plugin.SKILLS_DIR, "using-summer", "SKILL.md"))).toBe(true);
  });

  it("names only skills that exist on disk", async () => {
    const { plugin } = await load();
    const onDisk = new Set(readdirSync(plugin.SKILLS_DIR));
    const body = plugin.ORIENTATION.replace(/summer:/g, " ");
    const slugs = [...body.matchAll(/(?:^|[\s,(])([a-z0-9]+(?:-[a-z0-9]+)+)(?=[\s,.)]|$)/g)].map((m) => m[1]);
    const skillLike = slugs.filter((s) => !["summer-engine", "session-start", "red-flag", "identity-bound"].includes(s));
    expect(skillLike.length).toBeGreaterThan(20);
    for (const slug of skillLike) expect(onDisk.has(slug), slug).toBe(true);
  });

  it("injects the orientation into the first user message exactly once", async () => {
    const { plugin } = await load();
    const hooks = await plugin({});
    const output = {
      messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi", id: "p1" }] }],
    };
    await hooks["experimental.chat.messages.transform"]({}, output);
    await hooks["experimental.chat.messages.transform"]({}, output);
    const parts = output.messages[0].parts;
    expect(parts.filter((p) => p.text === plugin.ORIENTATION)).toHaveLength(1);
    expect(parts[0].text).toContain(plugin.ORIENTATION_MARKER);
    expect(parts[1].text).toBe("hi");
  });
});
