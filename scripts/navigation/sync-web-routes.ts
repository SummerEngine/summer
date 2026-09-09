#!/usr/bin/env node
/**
 * Refresh assets/navigation/web-routes.json — the vendored copy of
 * summerengine.com's route/intent catalog that `summer_open` builds its web
 * destinations from.
 *
 *   node scripts/navigation/sync-web-routes.ts                      fetch https://www.summerengine.com/agent-routes.json
 *   node scripts/navigation/sync-web-routes.ts --from-url <url>     fetch another origin (staging)
 *   node scripts/navigation/sync-web-routes.ts --from-file <path>   read a catalog JSON (e.g. one the web repo emitted)
 *   node scripts/navigation/sync-web-routes.ts --check              exit 1 when the vendored snapshot differs from the source
 *
 * The catalog is validated (ids unique, every route has id/path/title/
 * description) before anything is written. The web repo owns the content
 * (src/lib/navigation/routes.ts); this file only copies it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Consumes the built module (see render-product-map.ts for why).
const built = join(root, "dist", "core", "capabilities", "navigation", "targets.js");
if (!existsSync(built)) {
  console.error(`web-routes: ${built} not found. Run \`npm run build\` first (or \`npm run sync:web-routes\`).`);
  process.exit(1);
}
type Catalog = { routes: unknown[] } & Record<string, unknown>;
const { parseWebRoutesCatalog } = (await import(pathToFileURL(built).href)) as {
  parseWebRoutesCatalog: (raw: unknown, where?: string) => Catalog;
};
const target = join(root, "assets", "navigation", "web-routes.json");
const DEFAULT_URL = "https://www.summerengine.com/agent-routes.json";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadSource(): Promise<{ raw: unknown; from: string }> {
  const file = argValue("--from-file");
  if (file) return { raw: JSON.parse(readFileSync(file, "utf8")), from: file };
  const url = argValue("--from-url") ?? DEFAULT_URL;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return { raw: await res.json(), from: url };
}

const { raw, from } = await loadSource();
const catalog = parseWebRoutesCatalog(raw, from);
const serialized = JSON.stringify(
  { ...catalog, source: `Synced from ${from} on ${new Date().toISOString().slice(0, 10)}. Refresh with: npm run sync:web-routes` },
  null,
  2
) + "\n";

if (process.argv.includes("--check")) {
  const committed = readFileSync(target, "utf8");
  const strip = (s: string) => s.replace(/"source": "[^"]*",?\n/, "");
  if (strip(committed) !== strip(serialized)) {
    console.error(`web-routes: snapshot differs from ${from}. Run: npm run sync:web-routes`);
    process.exit(1);
  }
  console.log(`web-routes: snapshot matches ${from} (${catalog.routes.length} routes).`);
} else {
  writeFileSync(target, serialized);
  console.log(`web-routes: wrote ${catalog.routes.length} routes from ${from} to ${target}`);
}
