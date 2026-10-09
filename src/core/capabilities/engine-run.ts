import { spawn as nodeSpawn } from "node:child_process";

/** One headless engine process: argv only (no shell), the last output kept, killed on timeout. */

const OUTPUT_TAIL_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5_000;
const MAX_ERROR_LINES = 20;
const MAX_ERROR_LINE_CHARS = 600;

export interface EngineRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  /** The engine's "ERROR:" / "SCRIPT ERROR:" lines from the whole run (the first 20), even when the tail lost them. */
  errors?: string[];
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** "ERROR: ..." and "SCRIPT ERROR: ..." lines of engine output, without colour codes or the "at:" lines. */
export function engineErrorLines(output: string, limit = MAX_ERROR_LINES): string[] {
  const lines: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(ANSI, "").trim();
    if (!/^(SCRIPT )?ERROR:/.test(line)) continue;
    if (lines.length >= limit) break;
    lines.push(line.slice(0, MAX_ERROR_LINE_CHARS));
  }
  return lines;
}

/** Spawn the engine (argv only, no shell), keep the last output, kill on timeout. */
export function runEngine(binary: string, args: string[], timeoutMs: number): Promise<EngineRun> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    // Error lines are collected per stream as they arrive, so a long run cannot push them out of the tail.
    const errors: string[] = [];
    const partial = { stdout: "", stderr: "" };
    const collect = (text: string) => {
      if (errors.length < MAX_ERROR_LINES) errors.push(...engineErrorLines(text, MAX_ERROR_LINES - errors.length));
    };
    const keep = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-OUTPUT_TAIL_BYTES);
      const lines = (partial[stream] + text).split("\n");
      partial[stream] = (lines.pop() ?? "").slice(-OUTPUT_TAIL_BYTES);
      collect(lines.join("\n"));
    };
    child.stdout?.on("data", keep("stdout"));
    child.stderr?.on("data", keep("stderr"));
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
      collect(`${partial.stdout}\n${partial.stderr}`);
      resolvePromise({ code, signal, timedOut, output, errors });
    });
  });
}

