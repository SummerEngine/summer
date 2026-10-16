# The Summer App manifest

Sent as `manifest` on every `apps.publish` and written into the app as
`summer.app.json`. Unknown keys and unknown permissions are refused with a message that
names them. Every field:

```json
{
  "name": "Loot table",
  "purpose": "Balance item stats and write them to res://data/items.json",
  "permissions": ["data", "assets:read", "generate", "ai", "team:read", "engine:read", "engine:write"],
  "engineFiles": ["res://data/items.json"],
  "collections": {
    "items": {
      "description": "One weapon or armour piece",
      "fields": {
        "name": { "type": "string", "required": true },
        "damage": { "type": "number", "description": "Damage per hit" },
        "speed": { "type": "number", "description": "Attacks per second" },
        "tags": { "type": "array" }
      }
    }
  },
  "agentEvents": ["items.written"],
  "agentTools": [
    {
      "name": "nerf_item",
      "description": "Lower one item's damage by a percent",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" }, "percent": { "type": "number" } },
        "required": ["id", "percent"]
      }
    }
  ],
  "surface": "both",
  "dock": { "preferred": "bottom" },
  "plugin": { "name": "loot_tools" }
}
```

| Key | Rules |
|---|---|
| `name` | Required, 1-80 characters. |
| `purpose` | Up to 280 characters: what the tool does and where its data goes. |
| `permissions` | Only these: `data`, `assets:read`, `assets:write`, `generate`, `ai`, `projects:read`, `team:read`, `grow:read`, `engine:read`, `engine:write`, `choices`. `engine:write` includes `engine:read`; `assets:write` includes `assets:read`. No permission is needed for `app.*`, `agent.*`, `page.*` and `team.presence`. |
| `engineFiles` | Up to 50 `res://` paths `engine.readFile` / `writeFile` may touch. |
| `collections` | Up to 50, keyed by collection name (lowercase `a-z 0-9 _ . -`). Each: `description`, `fields` (up to 50, name `[A-Za-z_][A-Za-z0-9_]*`) with `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`, `any`), `description`, `required`. Descriptive: agents and people read it; writes are not rejected for it. |
| `agentEvents` | Up to 50 names (`a-z 0-9 _ . -`) the app sends with `summer.agent.send`. |
| `agentTools` | Up to 20: `name` (`a-z 0-9 _`, max 64), `description` (max 1,000), `input` (JSON Schema, up to 8 KB). |
| `surface` | `page` (the Studio app page, default), `dock` (an editor dock) or `both`. A dock layout must work from 320 px wide; docked apps get selection and scene events (`summer.engine.onEvent`). |
| `dock` | `{ "preferred": "left" \| "right" \| "bottom" }`. |
| `plugin` | `{ "name": "<folder>" }`: the app may also write `res://addons/<folder>/`. |
| `entry` | Always `index.html` (you can leave it out). |

The whole manifest is at most 200 KB. A code app's bundle: `index.html` at the root, at most
300 files, 10 MB, 5 MB per file.
