import { spawn as nodeSpawn } from "node:child_process";

/** One headless engine process: argv only (no shell), the last output kept, killed on timeout. */

const OUTPUT_TAIL_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5_000;

export interface EngineRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
}

/** Spawn the engine (argv only, no shell), keep the last output, kill on timeout. */
export function runEngine(binary: string, args: string[], timeoutMs: number): Promise<EngineRun> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolvePromise({ code, signal, timedOut, output });
    });
  });
}

