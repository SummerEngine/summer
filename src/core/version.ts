import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The installed toolkit (npm package) version, read once from package.json.
 *  Resolves from src/core and dist/core alike (package root is two levels up). */
export const TOOLKIT_VERSION: string = (
  require("../../package.json") as { version: string }
).version;
