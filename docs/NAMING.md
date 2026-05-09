# Naming conventions

This is the single source of truth for what's called what. **Do not deviate without updating this file first.** A misalignment between the brand, the plugin, the marketplace, and the npm package wastes hours and confuses every reviewer who touches the project.

## The four layers

| Layer | Name | Where it appears |
|---|---|---|
| **Product brand** | `Summer Engine` | Marketing copy, website, README headlines, plugin descriptions to humans. Always two words. |
| **Short brand** | `Summer` | Where the full name is too long: slash command namespaces, install commands, taglines, plugin listing display. |
| **Family slug (whole stack)** | `summer-engine` | npm package, Claude marketplace name, anything that identifies the entire Summer Engine product line in a tech identifier. |
| **Plugin slug (specific plugin)** | `summer` | Plugin manifest `name` field across all harnesses (Claude / Cursor / Codex / Factory / Gemini / Copilot), slash command namespace, CLI binary, OpenCode plugin name. |

## The install command (the most-seen example)

```
claude /plugin marketplace add SummerEngine/summer
claude /plugin install summer@summer-engine
```

Reads as: **"install the `summer` plugin from the `summer-engine` marketplace."**

The asymmetry is intentional. It mirrors obra/superpowers' `superpowers@superpowers-marketplace`. The plugin is one product within the marketplace; the marketplace is named after the family.

## Concrete identifiers

| Thing | Value |
|---|---|
| GitHub org | `SummerEngine` (PascalCase, used only in URLs) |
| Public CLI repo | `SummerEngine/summer` |
| Engine repo (private) | `SummerEngine/SummerEngine` |
| Web app repo | `SummerEngine/PublicSummerEngine` |
| npm package | `summer-engine` |
| CLI binary | `summer` |
| Claude plugin name (`.claude-plugin/plugin.json` → `name`) | `summer` |
| Claude marketplace name (`.claude-plugin/marketplace.json` → `name`) | `summer-engine` |
| Cursor plugin name | `summer` |
| Codex plugin name | `summer` |
| Factory Droid plugin name | `summer` |
| Gemini extension name | `summer` |
| Slash command namespace | `summer:` (e.g., `/summer:debug`, `/summer:brainstorm-game`) |
| User config dir | `~/.summer/` |
| Local API token file | `~/.summer/api-token` |
| Project-side soul file | `.summer/GameSoul.md` |
| Engine binary install location | platform-specific, exposed via `summer status` |

## When to use which brand form in copy

| Situation | Use | Example |
|---|---|---|
| Headline / lede | "Summer Engine is the AI game engine." | README first line. |
| Identifying the plugin in a sentence | "Summer is the open-source plugin that…" | When distinguishing plugin from engine. |
| Inline shorthand once context is clear | "Summer auto-loads the right skills…" | Body copy after the first introduction. |
| Inside example install commands or slash commands | code-style `summer` or `summer-engine` | Whatever the actual identifier is. |

## When NOT to deviate

These changes require an explicit "yes" in the same chat session before commit, **regardless of how obviously correct the change seems**:

- The `name` field of any of: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.factory-plugin/plugin.json`, `gemini-extension.json`, `package.json`.
- The `version` field of `package.json` (npm publish trigger).
- Anything inside `.claude-plugin/` while a marketplace submission is in review.
- The CLI binary name in `package.json` `bin`.
- The slash command namespace.

Silence is not consent on these.

## Checklist before any release

- [ ] All seven plugin manifests have `name: "summer"` (Claude, Cursor, Codex, Factory) or extension equivalent (Gemini).
- [ ] `.claude-plugin/marketplace.json` has `name: "summer-engine"` and a plugin entry with `name: "summer"`.
- [ ] `package.json` has `name: "summer-engine"`, `bin.summer`, and `main: ".opencode/plugins/summer.js"`.
- [ ] README install commands use `summer@summer-engine` (not `summer@summer`).
- [ ] README brand copy uses "Summer Engine" for the product, "Summer" for the plugin/short form, never mixes randomly.
- [ ] Slash commands appear as `summer:<skill>` everywhere — never `summerengine:`, never `summer-engine:`.

If any of these drift, fix them in one commit and update this file's "Concrete identifiers" table to match reality.
