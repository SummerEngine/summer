# Summer Engine Skills System — Internal Documentation

**INTERNAL ONLY.** This document is excluded from the public repo sync. Do not reference internal strategy, pricing, or private repos in skill content that ships publicly.

---

## Overview

Skills are best-practice guides that make AI agents better at game development with Summer Engine. They follow the [Agent Skills](https://agentskills.io/) open standard and are consumed by AI coding tools (Cursor, Claude Code, Windsurf) when building games via MCP.

**Naming:** This package is published as `summer-engine` (npm), not `summer-cli`. The repo is `summer-engine-cli`. See DEVELOPMENT.md for full naming guidance.

**Key concepts:**
- **Format:** SKILL.md with YAML frontmatter (Agent Skills standard)
- **Storage:** Bundled in CLI package at `skills/`
- **Install target:** `~/.summer/skills/<name>/`
- **Distribution:** Ships with npm package; no separate repo

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Tool (Cursor / Claude Code / Windsurf)                        │
│  Agent reads ~/.summer/skills/<name>/SKILL.md when building      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ summer skills install <name>
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Summer Engine CLI (~/.summer/skills/)                           │
│  Installed skills copied from package                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ bundled with
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  npm package (summer-engine)                                     │
│  node_modules/summer-engine/skills/                              │
│    gdscript-patterns/  scene-composition/  fps-controller/       │
│    3d-lighting/        ui-basics/                                │
└─────────────────────────────────────────────────────────────────┘
```

### How Agents Use Skills

1. User or agent runs `summer skills install fps-controller`
2. CLI copies `skills/fps-controller/` to `~/.summer/skills/fps-controller/`
3. Agent (or user) reads `~/.summer/skills/fps-controller/SKILL.md` when building an FPS game
4. Agent follows the patterns in the skill (scene structure, GDScript, MCP tool usage)

**Agent discovery:** Skills are not auto-injected into agent context. The agent must either:
- Be explicitly told to read the skill file (e.g. "Read ~/.summer/skills/fps-controller/SKILL.md before building")
- Have a Cursor rule or project rule that references it
- Or the user invokes the skill manually (e.g. `/fps-controller` if using Cursor/Claude skills)

**Future:** We could add `--as-cursor-rule` to install to `~/.cursor/skills/` so Cursor auto-discovers them.

---

## Format Specification

### File Structure

Each skill is a directory with `SKILL.md` as the required entrypoint:

```
skill-name/
├── SKILL.md           # Required — main instructions
├── reference.md       # Optional — detailed docs (loaded on demand)
├── examples.md        # Optional — usage examples
└── scripts/           # Optional — executable helpers
    └── validate.sh
```

### SKILL.md Frontmatter

```yaml
---
name: skill-name          # Required. Max 64 chars, lowercase, hyphens only
description: What it does. Use when [trigger scenarios].  # Required.
license: MIT              # Optional. SPDX identifier
compatibility:            # Optional. List of agents
  - Cursor
  - Claude Code
---
```

### Description Best Practices

The description is critical for discovery. Agents use it to decide when to apply the skill.

**Formula:** "[What it does]. [Key capabilities]. Use when [triggers]."

**Examples:**
- ✅ `gdscript-patterns`: "Common GDScript idioms, signals, exports, type hints. Use when writing GDScript, attaching scripts, or connecting signals."
- ✅ `fps-controller`: "First-person character controller with movement, camera, and physics. Use when building an FPS game or first-person movement."
- ❌ Avoid: "Helps with code" (too vague)

**Third person:** Write as if describing the skill to the agent, not as "I can help you."

### Content Guidelines

- **Length:** Keep SKILL.md under 500 lines. Move detail to `reference.md`.
- **MCP references:** Include explicit tool names: `summer_add_node`, `summer_set_prop`, `summer_set_resource_property`, etc.
- **Godot format:** Use Godot string syntax for SetProp values:
  - `Vector3(0, 10, 0)` — position, scale, rotation_degrees
  - `Color(1, 0.5, 0, 1)` — RGBA
  - `BoxMesh`, `CapsuleShape3D` — resource class names
- **Progressive disclosure:** Reference supporting files from SKILL.md: "For complete API details, see [reference.md](reference.md)"

---

## CLI Implementation

### Commands

| Command | Description |
|---------|-------------|
| `summer skills list` | List available skills (from bundled `skills/`) |
| `summer skills install <name>` | Copy skill to `~/.summer/skills/<name>/` |
| `summer skills install --all` | Install all bundled skills |
| `summer skills install <name> --as-claude-skill` | Install to `~/.claude/skills/` for Claude Code |
| `summer skills install <name> --as-cursor-skill` | Install to `~/.cursor/skills/` for Cursor |
| `summer skills info <name>` | Show description and preview |

### Path Resolution

**Bundled skills location:** When running from npm package, skills are at `node_modules/summer-engine/skills/`. When running from source, `tools/summer-cli/skills/`.

**Resolution strategy:**
```typescript
// In skills command:
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// For CLI: dist/commands/skills.js → skills are at ../../skills/
// For package: dist/ is relative to package root, skills/ is sibling
const skillsDir = join(__dirname, "..", "..", "skills");
```

**Install target:** `~/.summer/skills/` or `process.env.SUMMER_SKILLS_DIR` if set.

### Package.json

```json
"files": ["dist", "skills"]
```

Ensures `skills/` is included in npm publish tarball.

---

## Sync Exclusion (Public Repo)

This file (`SKILLS_SYSTEM.md`) is **excluded** from the public repo sync. Do not reference it in public-facing docs.

**DEVELOPMENT.md release checklist** includes:
```bash
--exclude='docs/SKILLS_SYSTEM.md' \
```

**Before adding new exclusions:** Update the rsync command in DEVELOPMENT.md and the "Before committing" checklist.

---

## Adding a New Skill

1. Create `skills/<skill-name>/SKILL.md` with frontmatter and content
2. Follow format spec above (name, description, under 500 lines)
3. Reference MCP tools and Godot values correctly
4. Run `summer skills list` to verify it appears
5. Run `summer skills install <skill-name>` to test install
6. Update smoke-test.sh if needed
7. Document in Mintlify `ai-tools/skills.mdx` (public docs)

**Skills are public.** They sync to the open-source repo. No internal strategy, pricing, or private URLs.

---

## Available Skills (Current)

| Name | Description |
|------|-------------|
| gdscript-patterns | Common GDScript idioms, signals, exports, type hints |
| scene-composition | Scene structure, sub-scenes, node hierarchy |
| fps-controller | First-person character controller |
| 3d-lighting | Lighting, environment, sky, shadows |
| ui-basics | HUD, menus, health bars, responsive layout |

---

## Related Documents

- **Plan:** `doc/SUMMER/SKILLS_SYSTEM_PLAN.md` — full implementation plan
- **MCP Strategy:** `docs/MCP_PRODUCT_STRATEGY.md` — product context
- **Adding Tools:** `docs/ADDING_TOOLS.md` — MCP tool patterns (skills reference these)
- **Development:** `docs/DEVELOPMENT.md` — release sync, exclusions
