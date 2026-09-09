import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the installed package root.
 *
 * Resolved from this module's own location so it is correct both from the
 * compiled tree (`dist/core/package-root.js`) and from source under vitest
 * (`src/core/package-root.ts`), and independent of `process.cwd()` — the CLI
 * runs from arbitrary project directories and from a global npm install.
 */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
