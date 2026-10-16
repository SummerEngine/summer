/**
 * Agent manifest builders (CONTRACT.md §6.2).
 *
 * Each builder reproduces the CURRENT manifest format of that agent
 * (fields and field order), with:
 *  - version fields stamped from package.json,
 *  - the FULL skill list in every manifest (the historical 4-skill
 *    codex/cursor gap and the 0-skill factory/gemini gaps were bugs),
 *  - skill paths pointing at ./library/skills/<slug>/,
 *  - skill lists sorted lexicographically (determinism contract),
 *  - tool-count claims in descriptions stamped from the real tool count
 *    (they had drifted to 58/62/52/50+ across manifests).
 *
 * Every manifest carries a `_generated` banner field directly after `$schema`
 * (or first, when there is no `$schema`). Agent hosts ignore unknown fields,
 * except the Claude plugin manifests: `claude plugin validate --strict` (the
 * directory's gate) fails on any unknown field, so those carry no banner and
 * only documented fields; `--check` still catches a hand edit.
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
  // `-y` so a non-TTY host never hangs on npx's install prompt, `@latest` so a
  // stale npx cache never serves an old server (README "Troubleshooting").
  return { command: "npx", args: ["-y", "summer-engine@latest", "mcp"] };
}

/**
 * Summer's hosted MCP: the cloud tools (games, assets, Studio, store) over
 * OAuth with the Summer account, for people without the desktop app or Node.
 */
export const HOSTED_MCP_URL = "https://mcp.summerengine.com/mcp";

/** The one-line product description every directory listing leads with. */
const PRODUCT_LINE = "The game engine built for AI. Any agent makes a multiplayer game and publishes it.";

/** The Summer sun, 512x512 PNG, on Summer's own domain (MCP Registry `icons`). */
const ICON_URL = "https://www.summerengine.com/icon/web-app-manifest-512x512.png";

/** The same icon in the repo, for plugin manifests that take a relative path. */
const ICON_PATH = "assets/icon.png";

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

const CLAUDE_DESCRIPTION = `${PRODUCT_LINE} A first-run guide (/summer:start), game-dev skills, and two MCP servers: the bridge to the Summer Engine desktop app, and Summer's hosted cloud server for people without it.`;

function buildClaudePlugin(i: ManifestInputs): string {
  return stableJson({
    $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    name: "summer",
    displayName: "Summer Engine",
    version: i.version,
    description: CLAUDE_DESCRIPTION,
    author: author(),
    homepage: "https://summerengine.com",
    repository: "https://github.com/summerengine/summer",
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
    // Anthropic's directory listing fields; Claude Code ignores them at load time.
    icon: `./${ICON_PATH}`,
    documentationUrl: "https://www.summerengine.com/mcp",
    supportUrl: "https://summer.games/support",
    privacyPolicyUrl: "https://www.summerengine.com/privacy",
    termsOfServiceUrl: "https://www.summerengine.com/terms",
    skills: skillPaths(i.skillSlugs),
    // hooks/hooks.json is the default plugin hooks file, so it is not named here
    // (naming it as well can register every hook twice).
    // Inline, not ./.mcp.json: that pointer is shared with Codex / Cursor / Factory,
    // which do not get the hosted server. summer-engine needs Node and drives the
    // desktop app; summer-cloud needs only a browser sign-in (/mcp).
    mcpServers: {
      "summer-engine": bundledMcpServer(),
      "summer-cloud": { type: "http", url: HOSTED_MCP_URL },
    },
    // No userConfig: Claude Code opens a settings dialog for every option when the
    // plugin is enabled, which is noise on a first run. The opt-in pre-commit
    // doctor hook reads SUMMER_PRE_COMMIT_DOCTOR=1 instead.
  });
}

/** The bundled server at this exact version: Anthropic's plugin directory refuses `@latest` and ranges. */
export function pinnedMcpServer(version: string): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", `summer-engine@${version}`, "mcp"] };
}

/**
 * plugins/claude/.claude-plugin/plugin.json: the same plugin for Anthropic's
 * directory, from its own small folder (mirrors.ts) with the server pinned
 * to this version. Paths are relative to that folder.
 */
function buildClaudeDirectoryPlugin(i: ManifestInputs): string {
  const full = JSON.parse(buildClaudePlugin(i)) as Record<string, unknown>;
  return stableJson({
    ...full,
    repository: "https://github.com/summerengine/summer/tree/main/plugins/claude",
    skills: [...i.skillSlugs].sort().map((slug) => `./skills/${slug}/`),
    mcpServers: {
      "summer-engine": pinnedMcpServer(i.version),
      "summer-cloud": { type: "http", url: HOSTED_MCP_URL },
    },
  });
}

function buildClaudeMarketplace(i: ManifestInputs): string {
  return stableJson({
    $schema: "https://json.schemastore.org/claude-code-marketplace.json",
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
        description: CLAUDE_DESCRIPTION,
        author: {
          name: "Summer Engine",
          email: "founders@summerengine.com",
        },
        category: "game-development",
        tags: ["game-dev", "godot", "ai-game-engine"],
        keywords: ["game-dev", "godot", "ai-game-engine", "skills"],
      },
    ],
  });
}

function buildCodexPlugin(i: ManifestInputs): string {
  return stableJson({
    _generated: manifestBanner("codex"),
    name: "summer",
    version: i.version,
    description: `${PRODUCT_LINE} Game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the Summer Engine desktop app.`,
    author: author(),
    homepage: "https://summerengine.com",
    repository: "https://github.com/summerengine/summer",
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
      displayName: "Summer Engine",
      shortDescription: "Make games with AI",
      longDescription: `Summer Engine is the game engine built for AI. Codex builds a full multiplayer game in it, plays and tests it, and publishes it on summer.games. The plugin adds game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the Summer Engine desktop app: project files, scenes, asset import, play mode, screenshots, diagnostics, asset generation and the store. Git, shell, and grep stay with Codex. Session-start orients each session. The pre-commit doctor (opt-in) blocks bad commits.`,
      developerName: "Summer Labs, Inc.",
      category: "Developer Tools",
      capabilities: ["Interactive", "Read", "Write"],
      websiteURL: "https://www.summerengine.com",
      supportURL: "https://summer.games/support",
      privacyPolicyURL: "https://www.summerengine.com/privacy",
      termsOfServiceURL: "https://www.summerengine.com/terms",
      defaultPrompt: [
        "I want to make a game.",
        "Make a small multiplayer game and let me play it.",
        "Open this Summer Engine project and tell me what's broken.",
      ],
      brandColor: "#FF8F17",
      composerIcon: `./${ICON_PATH}`,
      logo: `./${ICON_PATH}`,
      screenshots: [],
    },
  });
}

function buildCursorPlugin(i: ManifestInputs): string {
  return stableJson({
    $schema: "https://cursor.com/schemas/cursor-plugin/plugin.json",
    _generated: manifestBanner("cursor"),
    name: "summer",
    displayName: "Summer Engine",
    version: i.version,
    description: `${PRODUCT_LINE} Game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the Summer Engine desktop app.`,
    author: {
      name: "Summer Engine",
      email: "founders@summerengine.com",
    },
    publisher: "summer-engine",
    logo: ICON_PATH,
    homepage: "https://summerengine.com",
    repository: "https://github.com/summerengine/summer",
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
    description: `${PRODUCT_LINE} Game-dev skills, lifecycle hooks, and a ${i.toolCount}-tool MCP bridge to the Summer Engine desktop app.`,
    version: i.version,
    author: author(),
    homepage: "https://summerengine.com",
    repository: "https://github.com/summerengine/summer",
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
    description: `${PRODUCT_LINE} The Summer Engine MCP server, context primer and game-dev skills.`,
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

/**
 * The official MCP Registry's name for Summer. It must equal `mcpName` in
 * package.json: the registry checks the published npm package for it. The
 * io.github namespace needs a GitHub sign-in by an Owner of the SummerEngine
 * org, and the registry matches it against the org's login case-sensitively
 * (`io.github.SummerEngine/*`); com.summerengine/* would need a DNS record.
 */
export const MCP_REGISTRY_NAME = "io.github.SummerEngine/summer";

/** server.json for the official MCP Registry: the npm package and the hosted server under one name. */
function buildMcpRegistryServer(i: ManifestInputs): string {
  return stableJson({
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: MCP_REGISTRY_NAME,
    title: "Summer Engine",
    description: PRODUCT_LINE,
    version: i.version,
    websiteUrl: "https://summerengine.com",
    icons: [{ src: ICON_URL, mimeType: "image/png", sizes: ["512x512"] }],
    repository: { url: "https://github.com/summerengine/summer", source: "github" },
    packages: [
      {
        registryType: "npm",
        identifier: "summer-engine",
        version: i.version,
        transport: { type: "stdio" },
        packageArguments: [{ type: "positional", value: "mcp" }],
      },
    ],
    remotes: [{ type: "streamable-http", url: HOSTED_MCP_URL }],
  });
}

/** Generated-file name -> content, for every agent manifest. */
export function buildManifests(i: ManifestInputs): Map<string, string> {
  const out = new Map<string, string>();
  out.set("plugin.claude.json", buildClaudePlugin(i));
  out.set("plugin.claude-directory.json", buildClaudeDirectoryPlugin(i));
  out.set("marketplace.claude.json", buildClaudeMarketplace(i));
  out.set("plugin.codex.json", buildCodexPlugin(i));
  out.set("plugin.cursor.json", buildCursorPlugin(i));
  out.set("plugin.factory.json", buildFactoryPlugin(i));
  out.set("gemini-extension.json", buildGeminiExtension(i));
  out.set("mcp.json", buildMcpJson());
  out.set("server.json", buildMcpRegistryServer(i));
  return out;
}
