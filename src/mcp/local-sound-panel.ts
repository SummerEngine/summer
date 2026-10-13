import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const LOCAL_SOUND_PANEL_URI = "ui://summer/local-sound-choices-v1.html";
export const LOCAL_SOUND_GENERATE_META = {
  ui: { resourceUri: LOCAL_SOUND_PANEL_URI, visibility: ["model"] },
  "openai/outputTemplate": LOCAL_SOUND_PANEL_URI,
};
export const LOCAL_SOUND_READ_META = {
  ui: { resourceUri: LOCAL_SOUND_PANEL_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": LOCAL_SOUND_PANEL_URI,
  "openai/widgetAccessible": true,
};

const CHOICE_SET_ID = /^[a-f0-9]{32}$/;
const PANEL_ASSET = new URL("../../assets/mcp/local-sound-choices-v1.html", import.meta.url);

/**
 * Bundled from PublicSummerEngine #920 (f0eaa0b4b830a959e09087b0c491029d6fc1a399), sound-choice-panel-html.ts
 * SHA-256 a1c786f0159c640c3e6a62929d48891f10854b37da61f253811e3c599760e4c3
 * and sound-choice-panel-copy.ts SHA-256
 * 1794067e7771f14dcf74cb1d7244c128a47b720333dcfdf242f1f4660a0fdec2.
 * The compiled upstream HTML SHA-256 is
 * 8be229135425bdfdec06dbe2e7696013c1e8882ac011885df7096bcd3dbcd3b8; local SHA-256 is
 * f694b2ee98929d5682c49ca27be846afe06050b449c60d6b0d1d6f9338eafd7c.
 * Local changes only check ok/status, preserve a returned review URL across a
 * free refresh, and validate the link before opening. Refresh from the pinned
 * upstream source and locales when that panel changes; no runtime web dependency.
 */
export async function localSoundPanelHtml(): Promise<string> {
  return readFile(PANEL_ASSET, "utf8");
}

type TextResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

/** Add UI data for valid local choices without changing legacy text or errors. */
export function withLocalSoundPanel<T extends TextResult>(result: T): T & { structuredContent?: Record<string, unknown> } {
  if (result.isError || result.content[0]?.type !== "text") return result;
  try {
    const data: unknown = JSON.parse(result.content[0].text ?? "");
    if (!data || typeof data !== "object" || Array.isArray(data)) return result;
    const view = data as Record<string, unknown>;
    if (view.ok !== true || typeof view.choiceSetId !== "string" || !CHOICE_SET_ID.test(view.choiceSetId)) return result;
    if (view.status !== undefined && view.status !== "pending" && view.status !== "decided") return result;
    if (!Array.isArray(view.clips) || view.clips.length < 1 || view.clips.length > 4) return result;
    if (!view.clips.every((clip) => clip && typeof clip === "object" &&
      typeof clip.modelId === "string" && typeof clip.modelName === "string" && typeof clip.audioUrl === "string")) return result;
    return { ...result, structuredContent: view };
  } catch {
    return result;
  }
}

const resourceDomains = [
  "https://res.cloudinary.com",
  "https://fal.media",
  "https://*.fal.media",
  "https://storage.googleapis.com",
  "https://*.supabase.co",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

export function registerLocalSoundPanel(server: McpServer): void {
  server.registerResource("summer-local-sound-choices", LOCAL_SOUND_PANEL_URI, {
    title: "Sound effect choices",
    mimeType: "text/html;profile=mcp-app",
    description: "Play local Summer sound versions and refresh saved picks.",
  }, async (uri) => ({ contents: [{
    uri: uri.href,
    mimeType: "text/html;profile=mcp-app",
    text: await localSoundPanelHtml(),
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains, frameDomains: [] } },
      "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": "Sound versions with playback and saved approval state. Open Summer Studio to approve versions and leave notes.",
      "openai/widgetCSP": {
        connect_domains: [], resource_domains: resourceDomains, frame_domains: [],
        redirect_domains: ["https://www.summerengine.com"],
      },
    },
  }] }));
}
