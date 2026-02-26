import { readFile } from "fs/promises";
import { join } from "path";
import { getSummerDir } from "./auth.js";

const DEFAULT_PORT = 6550;

export async function getApiToken(): Promise<string | null> {
  try {
    const token = await readFile(join(getSummerDir(), "api-token"), "utf-8");
    return token.trim() || null;
  } catch {
    return null;
  }
}

export async function getApiPort(): Promise<number> {
  try {
    const port = await readFile(join(getSummerDir(), "api-port"), "utf-8");
    const parsed = parseInt(port.trim(), 10);
    return isNaN(parsed) ? DEFAULT_PORT : parsed;
  } catch {
    return DEFAULT_PORT;
  }
}

export interface EngineHealth {
  ok: boolean;
  engine: string;
  version: string;
  port: number;
  project_name?: string;
  project_path?: string;
  scene?: string;
}

export async function checkEngineHealth(
  port: number
): Promise<EngineHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as EngineHealth;
  } catch {
    return null;
  }
}
