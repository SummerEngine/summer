/**
 * Manifest apply targets — source of truth for where each generated manifest
 * lands at the repo root so the published package stays compatible.
 *
 * integrations/<agent>/manifest-target.json are committed copies of this map;
 * a test asserts they never drift from here.
 */

export interface ManifestTarget {
  /** file name inside registry/generated/ */
  generated: string;
  /** destination path relative to the repo root */
  destination: string;
}

/**
 * One key per SUPPORTED client (mirrors integrations/<agent>/ — a test keeps
 * the two in lockstep). Clients without a generated manifest today have an
 * empty target list; their integrations README documents exactly what
 * `summer setup <client>` writes instead.
 */
export const MANIFEST_TARGETS: Record<string, ManifestTarget[]> = {
  claude: [
    { generated: "plugin.claude.json", destination: ".claude-plugin/plugin.json" },
    { generated: "marketplace.claude.json", destination: ".claude-plugin/marketplace.json" },
    // Root .mcp.json is the MCP pointer shared by the claude, codex, cursor
    // (and factory, via its mcp.json convention) manifests; owned here once.
    { generated: "mcp.json", destination: ".mcp.json" },
  ],
  codex: [{ generated: "plugin.codex.json", destination: ".codex-plugin/plugin.json" }],
  cursor: [{ generated: "plugin.cursor.json", destination: ".cursor-plugin/plugin.json" }],
  factory: [{ generated: "plugin.factory.json", destination: ".factory-plugin/plugin.json" }],
  gemini: [{ generated: "gemini-extension.json", destination: "gemini-extension.json" }],
  // The clients below have no generated manifest file in this repo today —
  // `summer setup <client>` writes their MCP config and skills at install time.
  windsurf: [],
  cline: [],
  "roo-code": [],
  "kilo-code": [],
  "github-copilot": [],
  "vscode-copilot": [],
  "lm-studio": [],
  // OpenCode consumes the package as a JS module (.opencode/plugins/summer.js)
  // and auto-discovers skills from disk — no generated manifest today.
  opencode: [],
};

export function allTargets(): ManifestTarget[] {
  return Object.values(MANIFEST_TARGETS).flat();
}
