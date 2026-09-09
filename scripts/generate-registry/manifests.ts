/**
 * Agent manifest builders (CONTRACT.md §6.2).
 *
 * Each builder reproduces the CURRENT manifest format of that agent
 * (fields and field order per migration/manifests-inventory.json), with:
 *  - version fields stamped from package.json,
 *  - the FULL skill list in every manifest (the historical 4-skill
 *    codex/cursor gap and the 0-skill factory/gemini gaps were bugs),
 *  - skill paths pointing at ./library/skills/<slug>/,
 *  - skill lists sorted lexicographically (determinism contract),
 *  - tool-count claims in descriptions stamped from the real tool count
 *    (they had drifted to 58/62/52/50+ across manifests).
 *
 * Every manifest carries a `_generated` banner field directly after `$schema`
 * (or first, when there is no `$schema`). Agent hosts ignore unknown fields.
 */

import { manifestBanner, stableJson } from "./shared.ts";

export interface ManifestInputs {
  version: string;
  toolCount: number;
  skillSlugs: string[];
}

function skillPaths(slugs: string[]): string[] {
  return [...slugs].sort().map((slug) => `./library/skills/${slug}/`);
}

/**
 * The ONE MCP server entry every manifest points at. Plugin hosts spawn it
 * from the plugin root, where the npm package is not installed, so it goes
 * through npx. Gemini inlines it; Claude / Codex / Cursor / Factory read it
 * from the generated root `.mcp.json`.
 */
export function bundledMcpServer(): { command: string; args: string[] } {
  return { command: "npx", args: ["summer-engine", "mcp"] };
}

function buildMcpJson(): string {
  return stableJson({
    _generated: manifestBanner("claude"),
    mcpServers: {
      "summer-engine": bundledMcpServer(),
    },
  });
}

function author(): Record<string, string> {
  return {
    name: "Summer Engine",
    email: "founders@summerengine.com",
    url: "https://summerengine.com",
  };
}

function buildClaudePlugin(i: ManifestInputs): string {
  return stableJson({
    $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    _generated: manifestBanner("claude"),
    name: "summer",
    version: i.version,
    description: `Agent tooling for Summer Engine: game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the local desktop app.`,
    author: author(),
    homepage: "https://summerengine.com",
    repository: "https://github.com/SummerEngine/summer-engine-agent",
    license: "MIT",
    keywords: [
      "game-dev",
      "godot",
      "summer-engine",
      "ai-game-engine",
      "skills",
      "workflow",
      "scene-design",
      "level-design",
      "art-direction",
      "vfx",
      "multiplayer",
      "performance",
    ],
    skills: skillPaths(i.skillSlugs),
    hooks: "./hooks/hooks.json",
    mcpServers: "./.mcp.json",
    userConfig: {
      enable_pre_commit_doctor: {
        type: "boolean",
        title: "Run summer doctor before commits",
        description:
          "Block git commits when the Summer Engine setup needs attention (runs `summer doctor` before each `git commit`). Off by default. Reaches the hook as CLAUDE_PLUGIN_OPTION_ENABLE_PRE_COMMIT_DOCTOR; SUMMER_PRE_COMMIT_DOCTOR=1 in the environment enables it too.",
        default: false,
      },
    },
  });
}

function buildClaudeMarketplace(i: ManifestInputs): string {
  return stableJson({
    $schema: "https://json.schemastore.org/claude-code-marketplace.json",
    _generated: manifestBanner("claude"),
    name: "summer-engine",
    description: "Summer Engine plugins for Claude Code",
    owner: {
      name: "Summer Engine",
      email: "founders@summerengine.com",
    },
    plugins: [
      {
        name: "summer",
        source: "./",
        version: i.version,
        description: `Agent tooling for Summer Engine: game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the local desktop app.`,
        author: {
          name: "Summer Engine",
          email: "founders@summerengine.com",
        },
        category: "game-development",
        tags: ["game-dev", "godot", "ai-game-engine"],
        keywords: ["game-dev", "godot", "ai-game-engine", "skills"],
        brandColor: "#FF8F17",
        capabilities: ["Interactive", "Read", "Write"],
        defaultPrompt: ["I want to make a game.", "/summer:brainstorm-game"],
      },
    ],
  });
}

function buildCodexPlugin(i: ManifestInputs): string {
  return stableJson({
    _generated: manifestBanner("codex"),
    name: "summer",
    version: i.version,
    description: `Agent tooling for Summer Engine: game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge. Build games by talking.`,
    author: author(),
    homepage: "https://summerengine.com",
    repository: "https://github.com/SummerEngine/summer-engine-agent",
    license: "MIT",
    keywords: [
      "game-dev",
      "godot",
      "ai-game-engine",
      "skills",
      "workflow",
      "level-design",
      "vfx",
      "multiplayer",
    ],
    skills: skillPaths(i.skillSlugs),
    mcpServers: "./.mcp.json",
    hooks: "./hooks/hooks.json",
    interface: {
      displayName: "Summer",
      shortDescription: "Superpowers for AI game dev. Build games by talking.",
      longDescription: `Summer turns Codex into a game-dev studio for Summer Engine. Users make Summer games with the Summer SDK and GDScript. The plugin adds game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge for guarded project files, scene editing, asset import, play mode, diagnostics, generation, and creator workflows. Git, shell, and grep stay with the host agent. Summer follows its upstream technical base continuously; version-sensitive work uses the bundled compatibility reference instead of a fixed onboarding version. Session-start orients the session. Pre-commit doctor (opt-in) blocks bad commits.`,
      developerName: "Summer Engine",
      category: "Coding",
      capabilities: ["Interactive", "Read", "Write"],
      websiteURL: "https://summerengine.com",
      privacyPolicyURL: "https://summerengine.com/privacy",
      termsOfServiceURL: "https://summerengine.com/terms",
      defaultPrompt: [
        "I want to make a game.",
        "/summer:brainstorm-game",
        "Open this Summer Engine project and tell me what's broken.",
      ],
      brandColor: "#FF8F17",
      screenshots: [],
    },
  });
}

function buildCursorPlugin(i: ManifestInputs): string {
  return stableJson({
    $schema: "https://cursor.com/schemas/cursor-plugin/plugin.json",
    _generated: manifestBanner("cursor"),
    name: "summer",
    displayName: "Summer",
    version: i.version,
    description: `Agent tooling for Summer Engine: game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the local desktop app.`,
    author: {
      name: "Summer Engine",
      email: "founders@summerengine.com",
    },
    publisher: "summer-engine",
    homepage: "https://summerengine.com",
    repository: "https://github.com/SummerEngine/summer-engine-agent",
    license: "MIT",
    category: "developer-tools",
    keywords: [
      "game-dev",
      "godot",
      "ai-game-engine",
      "skills",
      "workflow",
      "level-design",
      "art-direction",
      "vfx",
      "multiplayer",
      "performance",
    ],
    tags: ["game-dev", "ai", "godot", "creative", "design"],
    skills: skillPaths(i.skillSlugs),
    hooks: "./hooks/hooks-cursor.json",
    mcpServers: "./.mcp.json",
  });
}

function buildFactoryPlugin(i: ManifestInputs): string {
  return stableJson({
    _generated: manifestBanner("factory"),
    name: "summer",
    description: `Agent tooling for Summer Engine: game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the local desktop app.`,
    version: i.version,
    author: author(),
    homepage: "https://summerengine.com",
    repository: "https://github.com/SummerEngine/summer-engine-agent",
    license: "MIT",
    keywords: ["game-dev", "godot", "ai-game-engine", "skills", "mcp"],
    skills: skillPaths(i.skillSlugs),
  });
}

function buildGeminiExtension(i: ManifestInputs): string {
  return stableJson({
    _generated: manifestBanner("gemini"),
    name: "summer",
    version: i.version,
    description:
      "Agent tooling for Summer Engine: MCP bridge, context primer, and game-dev skills. Use with the npm CLI for skill files on disk.",
    contextFileName: "GEMINI.md",
    mcpServers: {
      "summer-engine": {
        ...bundledMcpServer(),
        cwd: "${extensionPath}",
      },
    },
    settings: [
      {
        name: "enable_pre_commit_doctor",
        description: "Block git commits when summer doctor needs attention (off by default)",
        envVar: "SUMMER_PRE_COMMIT_DOCTOR",
        sensitive: false,
      },
    ],
    skills: skillPaths(i.skillSlugs),
  });
}

/** Generated-file name -> content, for every agent manifest. */
export function buildManifests(i: ManifestInputs): Map<string, string> {
  const out = new Map<string, string>();
  out.set("plugin.claude.json", buildClaudePlugin(i));
  out.set("marketplace.claude.json", buildClaudeMarketplace(i));
  out.set("plugin.codex.json", buildCodexPlugin(i));
  out.set("plugin.cursor.json", buildCursorPlugin(i));
  out.set("plugin.factory.json", buildFactoryPlugin(i));
  out.set("gemini-extension.json", buildGeminiExtension(i));
  out.set("mcp.json", buildMcpJson());
  return out;
}
