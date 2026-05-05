import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SUMMER_DIR = join(homedir(), ".summer");

export function getSummerDir(): string {
  return SUMMER_DIR;
}

async function ensureSummerDir(): Promise<void> {
  if (!existsSync(SUMMER_DIR)) {
    await mkdir(SUMMER_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function getAuthToken(): Promise<string | null> {
  try {
    const token = await readFile(join(SUMMER_DIR, "auth-token"), "utf-8");
    return token.trim() || null;
  } catch {
    return null;
  }
}

export async function saveAuthToken(token: string): Promise<void> {
  await ensureSummerDir();
  await writeFile(join(SUMMER_DIR, "auth-token"), token, { encoding: "utf-8", mode: 0o600 });
}

export async function getUserInfo(): Promise<{
  id: string;
  email: string;
  name?: string;
} | null> {
  try {
    const data = await readFile(join(SUMMER_DIR, "user.json"), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveUserInfo(info: {
  id: string;
  email: string;
  name?: string;
}): Promise<void> {
  await ensureSummerDir();
  await writeFile(join(SUMMER_DIR, "user.json"), JSON.stringify(info, null, 2), { encoding: "utf-8", mode: 0o600 });
}
