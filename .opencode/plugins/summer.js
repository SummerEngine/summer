/**
 * Summer Engine plugin for OpenCode.ai
 *
 * Registers the bundled skill library directory and injects a one-line
 * session-start orientation into the first user message of each session.
 *
 * Plugin shape follows @opencode-ai/plugin: an exported async function
 * `({ client, directory, ... }) => Hooks`. Every export of this module is
 * invoked by OpenCode, so this file has exactly one export (the plugin
 * function); constants hang off it for tests.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The skill library ships at <package>/library/skills/<slug>/SKILL.md, which is
 * the `<dir>/<name>/SKILL.md` layout OpenCode's `skills.paths` expects.
 */
const SKILLS_DIR = path.resolve(__dirname, '../../library/skills');

/** Sentinel line: the transform checks for it so the primer is injected once. */
const ORIENTATION_MARKER = 'Summer Engine is loaded.';

const ORIENTATION = `<EXTREMELY_IMPORTANT>
${ORIENTATION_MARKER} Summer skills are available under the summer: namespace.

Activate summer:using-summer FIRST in any Summer Engine session — it sets workflow priority and the red-flag list.

Process skills (run before building): brainstorm-game, debug, play.
Discipline skills (shape what you build): gdscript-patterns, scene-composition, art-direction, audio-direction, asset-strategy.
Build skills (produce artifacts): fps-controller, design-mechanic, design-level, setup-multiplayer, host-authoritative-state, peer-to-peer-multiplayer, design-npc, 3d-lighting, ui-basics, game-feel, vfx-fire, vfx-smoke, vfx-lightning, vfx-hit-spark, tune-performance, export-and-ship, make-game.

Always check for a relevant skill before responding. The summer-engine MCP server (npx -y summer-engine@latest mcp) provides identity-bound project file mutations plus scene, asset, render, play, and diagnostics tools. Git, shell, and grep remain native; do not bypass Summer's file guards when MCP is available.
</EXTREMELY_IMPORTANT>`;

export const SummerPlugin = async (_input) => {
  return {
    name: 'summer',

    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(SKILLS_DIR)) {
        config.skills.paths.push(SKILLS_DIR);
      }
    },

    'experimental.chat.messages.transform': async (_input, output) => {
      if (!output?.messages?.length) return;
      const firstUser = output.messages.find((m) => m.info?.role === 'user');
      if (!firstUser?.parts?.length) return;
      if (firstUser.parts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes(ORIENTATION_MARKER))) return;
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: 'text', text: ORIENTATION });
    },
  };
};

// Exposed for tests without adding module exports OpenCode would try to invoke.
SummerPlugin.SKILLS_DIR = SKILLS_DIR;
SummerPlugin.ORIENTATION = ORIENTATION;
SummerPlugin.ORIENTATION_MARKER = ORIENTATION_MARKER;
