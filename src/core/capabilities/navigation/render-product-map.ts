/**
 * Renders library/references/product-map/product-map.md from the same data
 * `summer_open` uses (targets.ts): the web rows from the vendored
 * /agent-routes.json snapshot, the editor rows from the engine-id metadata.
 * `node scripts/navigation/render-product-map.ts` writes it; navigation.test.ts
 * fails when the committed file differs from this render.
 */
import { EDITOR_TARGETS, WEB_CATALOG, type EditorTargetMeta, type NavParam, type WebRoute } from "./targets.js";

function esc(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function intents(list: readonly string[]): string {
  return esc(list.slice(0, 4).map((i) => `"${i}"`).join(", "));
}

function params(list: readonly NavParam[] | undefined): string {
  if (!list || list.length === 0) return "—";
  return list.map((p) => `\`${p.name}\`${p.required ? " (required)" : ""}`).join(", ");
}

function idCell(id: string, aliases: readonly string[] | undefined): string {
  return `\`${id}\`${aliases && aliases.length ? ` (${aliases.map((a) => `\`${a}\``).join(", ")})` : ""}`;
}

function webRow(route: WebRoute): string {
  // The apex host is what the capability lint allows; the tool itself uses the
  // configured gateway (www. in production).
  const origin = route.origin === "docs" ? WEB_CATALOG.docsBase : "https://summerengine.com";
  return `| ${idCell(route.id, route.aliases)} | web | ${intents(route.intents)} | \`${esc(origin + route.path)}\` | ${params(route.params)} | ${route.auth === "signed-in" ? "login" : "—"} | ${esc(route.description)} |`;
}

function editorRow(meta: EditorTargetMeta): string {
  const nav = meta.navigate;
  const navArgs = [
    ...Object.entries(nav.fixed ?? {}).map(([k, v]) => `${k}=${v}`),
    ...Object.entries(nav.map ?? {}).map(([p, a]) => `${a}=<${p}>`),
  ];
  const where = `Navigate target=${nav.target}${navArgs.length ? " " + navArgs.join(" ") : ""}${meta.mainSceneDefault ? " (path defaults to the main scene)" : ""}`;
  const legacy = meta.legacy
    ? `\`${meta.legacy.op}\`${meta.legacy.fixed ? " " + JSON.stringify(meta.legacy.fixed) : ""}`
    : "— (needs an engine with the Navigate op)";
  return `| ${idCell(meta.id, meta.aliases)} | editor | ${intents(meta.intents)} | \`${esc(where)}\` | ${params(meta.params)} | ${legacy} | ${esc(meta.description)} |`;
}

export function renderProductMap(): string {
  const lines: string[] = [];
  lines.push("# Summer product map");
  lines.push("");
  lines.push(
    "> Every place an agent can send the user: pages on summerengine.com and docs.summerengine.com, and surfaces inside the Summer Engine editor. One table, two surfaces. Open any row with `summer_open` (MCP) or `summer open <id>` (CLI); the `navigate-summer` skill says when to open a surface for the user and when to act through the API instead."
  );
  lines.push("");
  lines.push("**Generated file.** Rendered from the tool's own data by `node scripts/navigation/render-product-map.ts`; a test fails when this file and the data disagree. Do not edit by hand.");
  lines.push("");
  lines.push("## Who owns what");
  lines.push("");
  lines.push(
    "- **Web rows** come from summerengine.com's own route catalog (`/agent-routes.json`, published from the web repo's `src/lib/navigation/routes.ts`). The toolkit vendors a snapshot (`assets/navigation/web-routes.json`, refreshed with `npm run sync:web-routes`); it does not invent pages."
  );
  lines.push(
    "- **Editor rows** are ids of Summer Engine's one navigation table (`navigate_ops.cpp`, op `Navigate`). The running engine advertises which ids it can open in `/api/health` `capabilities.navigation`; `summer open --list` shows availability from the connected engine. Engines that predate the `Navigate` op can still serve the rows with a legacy op (last-but-one column); every other row answers `engine_lacks_op` with an update hint."
  );
  lines.push("");
  lines.push("## How to read a row");
  lines.push("");
  lines.push("- **id** — what you pass as `target`. Aliases in parentheses also resolve. Intent phrases in the third column resolve too (`summer open \"change my plan\"`).");
  lines.push(`- **where** — the URL (web) or the engine op (editor). \`{slot}\` is a required param; \`[/{slot}]\` is optional. Web URLs are shown on the apex host; the tool uses the configured gateway (\`gateway.url\` / \`SUMMER_GATEWAY_URL\`), so a staging gateway opens staging.`);
  lines.push(
    "- **params** — slot values passed as `params: { … }`. `guide` accepts an agent name (`cursor`, `claude-code`, `codex`, `gemini`, …) or a guide slug; `section` is one of the game's Studio sections; `line`/`col` are for `script`."
  );
  lines.push(
    `- **login** — the page needs a Summer account; when this machine has no CLI login token the tool opens \`${WEB_CATALOG.login.path}?${WEB_CATALOG.login.returnParam}=<path>\` and the destination loads after sign-in. Editor rows need Summer Engine running with the project open; otherwise the tool reports \`engine_not_running\` and nothing opens.`
  );
  lines.push("");
  lines.push(
    "Things that do not exist and are therefore not in the map (verified against the web app, 2026-09-03): a public play URL for a published game (`/games` is a curated gallery; distribution runs through a game's Builds / Releases / Store page in Studio, so \"my published games\" is `my-games`), and an API-token or MCP-credential page (CLI login is a device-code flow started by `summer login`)."
  );
  lines.push("");
  lines.push("## Web");
  lines.push("");
  lines.push("| id | surface | intents (excerpt) | where | params | login | what the user sees |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const route of WEB_CATALOG.routes) lines.push(webRow(route));
  lines.push("");
  lines.push("## Editor");
  lines.push("");
  lines.push("| id | surface | intents (excerpt) | where (Navigate op) | params | legacy op (pre-Navigate engines) | what the user sees |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const meta of EDITOR_TARGETS) lines.push(editorRow(meta));
  lines.push("");
  lines.push("## Shorthands the tool also accepts");
  lines.push("");
  lines.push("- A `res://` path: `.tscn`/`.scn` → `scene`, `.gd`/`.cs` → `script`, anything else → `file`.");
  lines.push("- A summerengine.com path: `/pricing` resolves to the matching row; an unknown path on the gateway origin opens as given and is reported `unmapped: true`.");
  lines.push("- Anything that is not on summerengine.com or docs.summerengine.com is refused.");
  lines.push("");
  return lines.join("\n");
}
