import { defineConfig } from "vitest/config";

// Two isolation rails for the suite (docs/DEVELOPMENT.md "Test the CLI and MCP
// locally"): every test file runs under a throwaway HOME so nothing resolves
// the real ~/.summer by default, and a global guard fails the run if the real
// ~/.summer changed anyway.
export default defineConfig({
  test: {
    setupFiles: ["src/test-helpers/fake-home.ts"],
    globalSetup: ["src/test-helpers/real-summer-dir-guard.ts"],
    // `npm publish` runs the suite again right after a build (prepublishOnly),
    // often on a busy machine: tests that take 2-3 s alone (validating the
    // whole library, spawning processes) passed the 5 s default there. A hung
    // test still fails.
    testTimeout: 20_000,
  },
});
