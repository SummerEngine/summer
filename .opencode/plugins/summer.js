/**
 * Summer Engine plugin for OpenCode.ai
 *
 * Registers the skills directory and injects a one-line session-start
 * orientation into the first user message of each session.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(__dirname, '../../skills');

const ORIENTATION = `<EXTREMELY_IMPORTANT>
Summer is loaded. 24 skills available under the summer: namespace.

Activate summer:using-summer FIRST in any Summer Engine session — it sets workflow priority and the red-flag list.

Process skills (run before building): brainstorm-game, debug, play.
Discipline skills (shape what you build): gdscript-patterns, scene-composition, art-direction, audio-direction, asset-strategy.
Build skills (produce artifacts): fps-controller, design-mechanic, design-level, setup-multiplayer, host-authoritative-state, peer-to-peer-multiplayer, design-npc, 3d-lighting, ui-basics, vfx, tune-performance, export-and-ship, make-game.

Always check for a relevant skill before responding. The summer-engine MCP server (npx summer-engine mcp) provides identity-bound project file mutations plus scene, asset, render, play, and diagnostics tools. Git, shell, and grep remain native; do not bypass Summer's file guards when MCP is available.
</EXTREMELY_IMPORTANT>`;

export const SummerPlugin = async ({ client, directory }) => {
  return {
    name: "summer",

    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }
    },

    'experimental.chat.messages.transform': async (_input, output) => {
      if (!output.messages?.length) return;
      const firstUser = output.messages.find((m) => m.info.role === 'user');
      if (!firstUser?.parts?.length) return;
      if (firstUser.parts.some((p) => p.type === 'text' && p.text.includes('Summer Engine is loaded'))) return;
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: 'text', text: ORIENTATION });
    },

    'session.created': async () => {
      // No-op placeholder; full session-start work runs in CLI hook on Claude Code.
      // OpenCode users get the orientation via the message transform above.
    }
  };
};
