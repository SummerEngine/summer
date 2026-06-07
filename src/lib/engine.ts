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
  pid?: number;
  instanceId?: string;
  projectId?: string;
  projectIdHash?: string;
  mainAliveMs?: number;
  queueDepth?: number;
  project_name?: string;
  project_path?: string;
  scene?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function checkEngineHealth(
  port: number
): Promise<EngineHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = asRecord(await res.json());
    if (!data) return null;

    const ok = data.ok === true;
    const engine = stringFrom(data.engine);
    const version = stringFrom(data.version);
    const instanceId = stringFrom(data.instanceId);

    if (!ok || engine !== "summer" || !version || !instanceId) {
      return null;
    }

    return {
      ok,
      engine,
      version,
      port: numberFrom(data.port) ?? port,
      pid: numberFrom(data.pid),
      instanceId,
      projectId: stringFrom(data.projectId),
      projectIdHash: stringFrom(data.projectIdHash),
      mainAliveMs: numberFrom(data.mainAliveMs),
      queueDepth: numberFrom(data.queueDepth),
      project_name: stringFrom(data.project_name),
      project_path: stringFrom(data.project_path),
      scene: stringFrom(data.scene),
    };
  } catch {
    return null;
  }
}
