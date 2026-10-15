/**
 * MCP tool profiles (`summer mcp --profile`, SUMMER_PROFILE) and the toolsets
 * they pick. Shared by the MCP server (src/mcp/tool-surface.ts) and setup,
 * which writes a profile into an agent's MCP entry. `full` is today's
 * surface exactly and the default, so existing configs keep it.
 */

export const TOOLSETS = [
  "core",
  "assets",
  "tools",
  "engine",
  "ui",
  "ship",
  "uploads",
  "apps",
  "board",
  "grow",
  "studio",
  "cloud",
  "other",
] as const;
export type Toolset = (typeof TOOLSETS)[number];

export const PROFILES = {
  /** Every tool, local and hosted (today's surface). */
  full: TOOLSETS,
  /** Summer Engine creators: engine, generation and the store. Fits clients with a 128-tool limit. */
  engine: ["core", "assets", "engine", "ship"],
  /** Any engine or none: generation, the asset library, account and library search. No engine tools. */
  assets: ["core", "assets", "tools"],
} as const satisfies Record<string, readonly Toolset[]>;
export type Profile = keyof typeof PROFILES;

/** Non-full profiles never register more tools than this (VS Code Copilot's per-request limit). */
export const PROFILE_TOOL_LIMIT = 128;

/** A profile name, or null when the value names none. */
export function parseProfile(value: string | undefined): Profile | null {
  const name = (value ?? "").trim().toLowerCase();
  return Object.hasOwn(PROFILES, name) ? (name as Profile) : null;
}
