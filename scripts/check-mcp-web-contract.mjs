#!/usr/bin/env node

import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRootIndex = process.argv.indexOf("--web-root");
const webRoot =
  webRootIndex >= 0 ? process.argv[webRootIndex + 1] : process.env.SUMMER_WEB_ROOT;

if (!webRoot) {
  console.error(
    "Usage: npm run check:mcp-web-contract -- --web-root /path/to/PublicSummerEngine"
  );
  process.exit(2);
}

const canonicalRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resolvedWebRoot = resolve(webRoot);
const pairs = [
  [
    "contracts/mcp-character-v1.json",
    "contracts/mcp-character-v1.json",
  ],
  [
    "src/mcp/fixtures/character-package-v2.json",
    "tests/fixtures/character-package-v2.json",
  ],
];

for (const [canonicalPath, webPath] of pairs) {
  const canonicalValue = JSON.parse(
    readFileSync(resolve(canonicalRoot, canonicalPath), "utf8")
  );
  const webValue = JSON.parse(
    readFileSync(resolve(resolvedWebRoot, webPath), "utf8")
  );
  if (!isDeepStrictEqual(canonicalValue, webValue)) {
    console.error(`Contract drift: ${canonicalPath} != ${webPath}`);
    process.exit(1);
  }
}

console.log("MCP character contract aligned across canonical and web repositories.");
