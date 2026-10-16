/**
 * Starting points for `summer router character add`. Each one is a valid
 * character document (registry schemas.character) that a game can push as
 * is; the creator or their agent then edits instructions, tools and voice.
 */

export const TEMPLATES = ["voice-npc", "shopkeeper", "companion"] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export interface CharacterOptions {
  id: string;
  template: TemplateId;
  name?: string;
  /** A text description of the voice; Summer makes a pinned voice from it on push. */
  voice?: string;
  /** A Summer voice id, instead of a description. */
  voiceId?: string;
  tools?: string[];
}

export const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const SHORT_REPLIES = "Keep every reply to one or two short sentences: players hear it out loud.";
const STAY_IN_WORLD = "Stay in character. Never talk about being an AI model, and never step outside the game's world.";

const BODIES: Record<TemplateId, (name: string) => Record<string, unknown>> = {
  "voice-npc": (name) => ({
    instructions: `You are ${name}, a character in this game. ${STAY_IN_WORLD} ${SHORT_REPLIES} When the player asks for something one of your tools can do, call the tool instead of only describing it.`,
    first_message: "Hello there. What brings you here?",
    turn: { mode: "push_to_talk", interruptions: true },
    session: { max_seconds: 300, idle_seconds: 30 },
  }),
  shopkeeper: (name) => ({
    instructions: `You are ${name}, a shopkeeper in this game. You are friendly and like to haggle a little. ${STAY_IN_WORLD} ${SHORT_REPLIES} Only offer what the game told you is in stock. Call a tool to complete a sale; never pretend a sale happened.`,
    first_message: "Welcome! Take a look around.",
    turn: { mode: "push_to_talk", interruptions: true },
    session: { max_seconds: 300, idle_seconds: 45 },
  }),
  companion: (name) => ({
    instructions: `You are ${name}, the player's companion on their journey. You are loyal, curious and a little funny. ${STAY_IN_WORLD} ${SHORT_REPLIES} React to what the game tells you just happened, and give a hint only when the player asks.`,
    first_message: "Ready when you are.",
    turn: { mode: "push_to_talk", interruptions: true },
    session: { max_seconds: 600, idle_seconds: 60 },
  }),
};

/** "guard_captain" -> "Guard Captain". */
export function displayName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildCharacter(options: CharacterOptions): Record<string, unknown> {
  const name = options.name?.trim() || displayName(options.id);
  const doc: Record<string, unknown> = { id: options.id, name, ...BODIES[options.template](name) };
  if (options.voiceId) doc.voice = { id: options.voiceId };
  else if (options.voice?.trim()) doc.voice = { design: options.voice.trim() };
  if (options.tools?.length) {
    doc.tools = options.tools.map((tool) => ({
      name: tool,
      description: `Call this to ${tool.replace(/_/g, " ")}. Say exactly when the character should call it.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      runs_on: "client",
      timeout_ms: 5000,
    }));
  }
  return doc;
}
