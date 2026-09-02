import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSummerDir } from "./auth.js";
import { redactSensitive } from "./redact.js";

const MAX_LOG_BYTES = 512 * 1024;
const RETAIN_LOG_BYTES = 256 * 1024;

export function getMcpLogPath(): string {
  return join(getSummerDir(), "mcp.log");
}

function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    const text = readFileSync(path, "utf-8");
    const retained = text.slice(-RETAIN_LOG_BYTES);
    writeFileSync(path, `{"event":"mcp:log_rotated"}\n${retained}`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // No existing log, or not readable. The next append will recreate it.
  }
}

export function appendMcpLogEvent(
  event: string,
  details: Record<string, unknown> = {}
): void {
  try {
    const dir = getSummerDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = getMcpLogPath();
    rotateIfNeeded(path);
    const safeDetails = redactSensitive(details, { strings: true }) as Record<string, unknown>;
    const payload = {
      ts: new Date().toISOString(),
      event,
      ...safeDetails,
    };
    appendFileSync(path, `${JSON.stringify(payload)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Logging must never affect MCP behavior.
  }
}

export async function readRecentMcpLogLines(maxLines = 120): Promise<string[]> {
  try {
    const text = await readFile(getMcpLogPath(), "utf-8");
    if (!text.trim()) return [];
    return text.trimEnd().split(/\r?\n/).slice(-maxLines);
  } catch {
    return [];
  }
}
