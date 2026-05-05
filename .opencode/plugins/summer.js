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
Summer Engine is loaded. 19 skills available under the summer plugin.
Workflow skills (slash menu): brainstorm-game, debug, play, design-mechanic, design-level, art-direction, audio-direction, vfx, tune-performance, design-npc, setup-multiplayer, export-and-ship.
Specialists auto-trigger: fps-controller, 3d-lighting, gdscript-patterns, scene-composition, ui-basics, asset-strategy, make-game.
Use OpenCode's native skill tool to load any of them. The summer-engine MCP server (npx summer-engine mcp) provides scene mutation, asset import, render, play, and diagnostics tools.
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

export default SummerPlugin;
