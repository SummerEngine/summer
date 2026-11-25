import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

const python = process.env.SUMMER_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

it.runIf(spawnSync(python, ["--version"]).status === 0)("binds painted detail tiles and retry keys to the same request", () => {
  execFileSync(python, ["-B", fileURLToPath(new URL("../../tests/painted-detail-cache.py", import.meta.url))], { stdio: "pipe" });
});
