#!/usr/bin/env node
/**
 * Render library/references/product-map/product-map.md from the navigation data.
 *
 *   node scripts/navigation/render-product-map.ts          write the file
 *   node scripts/navigation/render-product-map.ts --check  exit 1 when the committed file differs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The navigation modules use `.js` internal imports (they ship in dist/), which
// node's type stripping cannot resolve from src/ — so the scripts consume the
// built output. `npm run generate:product-map` builds first.
const built = join(root, "dist", "core", "capabilities", "navigation", "render-product-map.js");
if (!existsSync(built)) {
  console.error(`product-map: ${built} not found. Run \`npm run build\` first (or \`npm run generate:product-map\`).`);
  process.exit(1);
}
const { renderProductMap } = (await import(pathToFileURL(built).href)) as { renderProductMap: () => string };
const target = join(root, "library", "references", "product-map", "product-map.md");
const rendered = renderProductMap();

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    // missing file = drift
  }
  if (committed !== rendered) {
    console.error(`product-map: ${target} is stale. Run: node scripts/navigation/render-product-map.ts`);
    process.exit(1);
  }
  console.log("product-map: no drift.");
} else {
  writeFileSync(target, rendered);
  console.log(`product-map: wrote ${target}`);
}
