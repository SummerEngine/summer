import { lstat, readFile, readdir, realpath, stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import { getSummerDir } from "./auth.js";

const DEFAULT_PORT = 6550;
const INSTANCE_SCHEMA_VERSION = 1;
const INSTANCE_STALE_MS = 180_000;
const MAX_INSTANCE_FILE_BYTES = 64 * 1024;

export interface EngineSelection {
  instanceId?: string;
  projectPath?: string;
  cwd?: string;
}

export interface EngineDiscoveryOptions {
  summerDir?: string;
  nowMs?: number;
}

export interface EngineInstance {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  port: number;
  token: string;
  projectId?: string;
  projectIdHash?: string;
  resourceRoot: string;
  projectName?: string;
  heartbeatAt: number;
  engineVersion?: string;
}

export interface EngineConnection {
  port: number;
  token: string;
  health: EngineHealth;
  instance?: EngineInstance;
  selection: EngineSelection | null;
  source: "registry" | "legacy";
}

export async function getApiToken(
  summerDir = getSummerDir()
): Promise<string | null> {
  try {
    const token = await readFile(join(summerDir, "api-token"), "utf-8");
    return token.trim() || null;
  } catch {
    return null;
  }
}

export async function getApiPort(
  summerDir = getSummerDir()
): Promise<number> {
  try {
    const port = await readFile(join(summerDir, "api-port"), "utf-8");
    const parsed = parseInt(port.trim(), 10);
    return isNaN(parsed) ? DEFAULT_PORT : parsed;
  } catch {
    return DEFAULT_PORT;
  }
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function findProjectRoot(
  startPath: string
): Promise<string | null> {
  let current = await canonicalPath(startPath);
  try {
    if (!(await stat(current)).isDirectory()) {
      current = dirname(current);
    }
  } catch {
    return null;
  }

  while (true) {
    try {
      if ((await stat(join(current, "project.godot"))).isFile()) {
        return current;
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseEngineInstance(value: unknown): EngineInstance | null {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== INSTANCE_SCHEMA_VERSION) return null;

  const instanceId = stringFromUnknown(record.instanceId);
  const pid = numberFromUnknown(record.pid);
  const port = numberFromUnknown(record.port);
  const token = stringFromUnknown(record.token);
  const resourceRoot = stringFromUnknown(record.resourceRoot);
  const heartbeatAt = numberFromUnknown(record.heartbeatAt);

  if (
    !instanceId ||
    !pid ||
    !Number.isInteger(pid) ||
    !port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !token ||
    !resourceRoot ||
    !heartbeatAt
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    instanceId,
    pid,
    port,
    token,
    projectId: stringFromUnknown(record.projectId),
    projectIdHash: stringFromUnknown(record.projectIdHash),
    resourceRoot,
    projectName: stringFromUnknown(record.projectName),
    heartbeatAt,
    engineVersion: stringFromUnknown(record.engineVersion),
  };
}

export async function listEngineInstances(
  nowMs = Date.now(),
  summerDir = getSummerDir()
): Promise<EngineInstance[]> {
  const instancesDir = join(summerDir, "instances");
  try {
    const dirInfo = await lstat(instancesDir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return [];
  } catch {
    return [];
  }

  const entries = await readdir(instancesDir, { withFileTypes: true });
  const instances: EngineInstance[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(instancesDir, entry.name);
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > MAX_INSTANCE_FILE_BYTES
      ) {
        continue;
      }
      const parsed = parseEngineInstance(
        JSON.parse(await readFile(path, "utf-8"))
      );
      if (!parsed || !processIsAlive(parsed.pid)) continue;
      if (nowMs - parsed.heartbeatAt * 1000 > INSTANCE_STALE_MS) continue;
      parsed.resourceRoot = await canonicalPath(parsed.resourceRoot);
      instances.push(parsed);
    } catch {
      // One malformed or concurrently-replaced entry must not hide other editors.
    }
  }

  return instances.sort((a, b) =>
    a.resourceRoot.localeCompare(b.resourceRoot) ||
    a.instanceId.localeCompare(b.instanceId)
  );
}

function formatInstances(instances: EngineInstance[]): string {
  return instances
    .map((instance) => {
      const label = instance.projectName
        ? `${instance.projectName} (${instance.resourceRoot})`
        : instance.resourceRoot;
      return `  - ${label} [${instance.instanceId}]`;
    })
    .join("\n");
}

async function connectionForInstance(
  instance: EngineInstance,
  selection: EngineSelection
): Promise<EngineConnection> {
  const health = await checkEngineHealth(instance.port);
  if (!health) {
    throw new Error(
      `Summer Engine instance ${instance.instanceId} is not responding on port ${instance.port}.`
    );
  }
  if (health.instanceId !== instance.instanceId) {
    throw new Error(
      `Summer Engine registry identity changed on port ${instance.port}; refusing to connect to the wrong editor.`
    );
  }
  if (
    instance.projectIdHash &&
    health.projectIdHash &&
    instance.projectIdHash !== health.projectIdHash
  ) {
    throw new Error(
      `Summer Engine project identity changed on port ${instance.port}; refusing to connect to the wrong project.`
    );
  }

  return {
    port: instance.port,
    token: instance.token,
    health,
    instance,
    selection: { ...selection },
    source: "registry",
  };
}

export async function resolveEngineConnection(
  selection: EngineSelection = {},
  options: EngineDiscoveryOptions = {}
): Promise<EngineConnection> {
  const summerDir = options.summerDir ?? getSummerDir();
  const explicitInstanceId = stringFromUnknown(selection.instanceId);
  const explicitProjectPath = stringFromUnknown(selection.projectPath);
  const cwd = stringFromUnknown(selection.cwd);
  const requestedProjectRoot = explicitProjectPath
    ? await findProjectRoot(explicitProjectPath)
    : !explicitInstanceId && cwd
      ? await findProjectRoot(cwd)
      : null;

  if (explicitProjectPath && !requestedProjectRoot) {
    throw new Error(
      `No project.godot found at or above ${resolve(explicitProjectPath)}.`
    );
  }

  const instances = await listEngineInstances(
    options.nowMs ?? Date.now(),
    summerDir
  );
  let candidates = instances;
  if (explicitInstanceId) {
    candidates = candidates.filter(
      (instance) => instance.instanceId === explicitInstanceId
    );
  }
  if (requestedProjectRoot) {
    const canonicalRoot = await canonicalPath(requestedProjectRoot);
    candidates = candidates.filter(
      (instance) => instance.resourceRoot === canonicalRoot
    );
  }

  if (explicitInstanceId || requestedProjectRoot) {
    if (candidates.length === 1) {
      return connectionForInstance(candidates[0], {
        ...selection,
        projectPath: requestedProjectRoot ?? selection.projectPath,
      });
    }
    if (candidates.length > 1) {
      throw new Error(
        `More than one Summer editor matches this project. Select one with \`summer mcp --instance <id>\`:\n${formatInstances(candidates)}`
      );
    }
    const canUseLegacyForInferredProject =
      instances.length === 0 &&
      !explicitInstanceId &&
      !explicitProjectPath &&
      Boolean(requestedProjectRoot);
    if (!canUseLegacyForInferredProject) {
      const target = explicitInstanceId
        ? `instance ${explicitInstanceId}`
        : `project ${requestedProjectRoot}`;
      throw new Error(
        `No running Summer editor matches ${target}. Open that project in Summer Engine and retry.`
      );
    }
  }

  if (instances.length === 1) {
    return connectionForInstance(instances[0], selection);
  }
  if (instances.length > 1) {
    throw new Error(
      "Multiple Summer editors are running and this agent is not inside a Summer project. " +
      "Start the agent from the project directory, or pass `summer mcp --project <path>`.\n" +
      formatInstances(instances)
    );
  }

  const [port, token] = await Promise.all([
    getApiPort(summerDir),
    getApiToken(summerDir),
  ]);
  if (!token) {
    throw new Error(
      "Summer Engine is not running (no api-token found). Open Summer Engine first."
    );
  }
  const health = await checkEngineHealth(port);
  if (!health) {
    throw new Error(
      `Summer Engine is not responding on port ${port}. Make sure it's open.`
    );
  }
  return {
    port,
    token,
    health,
    selection: null,
    source: "legacy",
  };
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
