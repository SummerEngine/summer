import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAuthToken, getUserInfo } from "../auth.js";
import { ENGINE_BINARY_ENV, findEngineBinary } from "../engine-install.js";
import { checkEngineHealth, getApiPort, getApiToken } from "../engine.js";
import { brandLine, c, pad, sym, tildeify } from "../format.js";
import { getMcpLogPath } from "../mcp-log.js";
import {
  formatProjectPin,
  getProjectMemorySummary,
  type ProjectMemorySummary,
} from "../../project-memory/project-memory.js";
import {
  buildCliVersionCheck,
  buildSkillsVersionCheck,
  defaultSkillMarkerCandidates,
  detectRecordedInstall,
  fetchLatestRegistryVersion,
} from "../../installer/version-check.js";

import { TOOLKIT_VERSION as version } from "../version.js";
const MIN_EXPECTED_MCP_TOOLS = 50;
const REQUIRED_MCP_TOOLS = [
  "summer_get_project_context",
  "summer_generate_image",
  "summer_create_debug_report",
];

export type DoctorStatus = "ok" | "warning" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
  summary: {
    ok: number;
    warnings: number;
    failures: number;
  };
}

interface DoctorOptions {
  json?: boolean;
  quiet?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  checks.push(checkNodeVersion());
  checks.push({
    id: "cli-version",
    label: "Summer CLI",
    status: "ok",
    message: `v${version}`,
  });

  checks.push(await checkCliVersionCurrent());
  checks.push(await checkSkillsVersion());

  checks.push(await checkLogin());
  checks.push(checkEngineInstall());
  checks.push(await checkLocalApi());
  checks.push(await checkProjectMemory());
  checks.push(await checkMcpBoot());
  checks.push(await checkMcpToolsList());

  const result = summarizeChecks(checks);

  if (!options.quiet) {
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printDoctorResult(result);
    }
  }

  return result;
}

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= 18) {
    return {
      id: "node-version",
      label: "Node.js",
      status: "ok",
      message: process.version,
    };
  }

  return {
    id: "node-version",
    label: "Node.js",
    status: "fail",
    message: `${process.version} (need 18+)`,
  };
}

async function checkCliVersionCurrent(): Promise<DoctorCheck> {
  const registry = await fetchLatestRegistryVersion();
  const result = buildCliVersionCheck({
    installedVersion: version,
    registry,
  });
  return {
    id: "cli-version-current",
    label: "CLI up to date",
    status: result.status,
    message: result.message,
    details: result.details,
  };
}

/** Stale skills are a warning, never a failure (TESTING.md §d: only failures
 *  exit 1). The recommended refresh follows how the agent's MCP entry was
 *  recorded by `summer setup`: a `--local-dev` link gets the local-dev form
 *  so the fix does not replace the checkout with the published package. */
async function checkSkillsVersion(): Promise<DoctorCheck> {
  const result = await buildSkillsVersionCheck({
    installedCliVersion: version,
    candidates: defaultSkillMarkerCandidates(),
    recordedInstall: detectRecordedInstall,
  });
  return {
    id: "skills-version-stale",
    label: "Skills up to date",
    status: result.status,
    message: result.message,
    details: result.details,
  };
}

export async function checkLogin(): Promise<DoctorCheck> {
  const token = await getAuthToken();
  const user = await getUserInfo();

  if (!token) {
    return {
      id: "login",
      label: "Login",
      status: "warning",
      message:
        "not signed in (run: summer login — only gateway features need it; engine tools work without)",
    };
  }

  if (process.env.SUMMER_TOKEN?.trim()) {
    return {
      id: "login",
      label: "Login",
      status: "ok",
      message: "token from SUMMER_TOKEN env",
    };
  }

  return {
    id: "login",
    label: "Login",
    status: "ok",
    message: user ? user.email : "signed in",
  };
}

export function checkEngineInstall(): DoctorCheck {
  const binary = findEngineBinary();
  if (binary) {
    // Shorten /Applications/Summer.app/Contents/MacOS/Summer -> /Applications/Summer.app
    const display = binary.replace(/\/Contents\/MacOS\/Summer$/, "");
    return {
      id: "engine-install",
      label: "Engine",
      status: "ok",
      message: tildeify(display),
      details: { path: binary },
    };
  }

  return {
    id: "engine-install",
    label: "Engine",
    status: "warning",
    message: `not installed (run: summer install, or set ${ENGINE_BINARY_ENV} to an existing binary)`,
  };
}

async function checkLocalApi(): Promise<DoctorCheck> {
  const token = await getApiToken();
  const port = await getApiPort();

  if (!token) {
    return {
      id: "local-api",
      label: "Local API",
      status: "warning",
      message: "engine not running",
      details: { port },
    };
  }

  const health = await checkEngineHealth(port);
  if (!health) {
    return {
      id: "local-api",
      label: "Local API",
      status: "warning",
      message: `not responding on :${port}`,
      details: { port },
    };
  }

  return {
    id: "local-api",
    label: "Local API",
    status: "ok",
    message: `:${port}`,
    details: {
      port,
      version: health.version,
      projectName: health.project_name,
      projectPath: health.project_path,
    },
  };
}

async function checkProjectMemory(): Promise<DoctorCheck> {
  const port = await getApiPort();
  const health = await checkEngineHealth(port);

  if (!health?.project_path) {
    return {
      id: "project-memory",
      label: "Project Memory",
      status: "ok",
      message: "no project open",
    };
  }

  const summary = getProjectMemorySummary(health.project_path);
  if (!summary.present) {
    return {
      id: "project-memory",
      label: "Project Memory",
      status: "warning",
      message: ".summer not created yet",
      details: {
        projectPath: health.project_path,
        reason: summary.reason,
        recommendedAction: "Ask your agent to run summer:brainstorm-game.",
      },
    };
  }

  return {
    id: "project-memory",
    label: "Project Memory",
    status: "ok",
    message: describeProjectMemory(summary),
    details: {
      projectPath: health.project_path,
      files: summary.files.length,
      memoryFiles: summary.structured.fileCount,
      locked: summary.structured.lockedCount,
      pin: summary.pin,
      ...(summary.pinError ? { pinError: summary.pinError } : {}),
    },
  };
}

/** The one-line Project Memory verdict: Markdown counts plus the template pin
 *  (`.summer/project.json` is memory too — the first fact a fresh agent
 *  needs). Exported for tests. */
export function describeProjectMemory(summary: ProjectMemorySummary): string {
  const pin = formatProjectPin(summary.pin);
  const pinPart = summary.pinError
    ? `pin unreadable (${summary.pinError})`
    : pin
      ? `pin ${pin}`
      : "no pin";
  return `${summary.files.length} files, ${summary.structured.fileCount} memory, ${summary.structured.lockedCount} locked, ${pinPart}`;
}

async function checkMcpBoot(): Promise<DoctorCheck> {
  const resolved = resolveCurrentMcpCommand();
  if (!resolved) {
    return {
      id: "mcp-boot",
      label: "MCP Server",
      status: "fail",
      message: "Could not resolve the current Summer CLI entrypoint.",
    };
  }

  return new Promise<DoctorCheck>((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    let settled = false;

    const finish = (check: DoctorCheck): void => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(check);
    };

    const timer = setTimeout(() => {
      finish({
        id: "mcp-boot",
        label: "MCP Server",
        status: "fail",
        message: "MCP server did not finish startup within 3 seconds.",
        details: { ...trimOutput({ stdout, stderr }), ...resolved },
      });
    }, 3000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      if (stderr.includes("MCP server running")) {
        clearTimeout(timer);
        finish({
          id: "mcp-boot",
          label: "MCP Server",
          status: "ok",
          message: "ready",
          details: { ...resolved },
        });
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        id: "mcp-boot",
        label: "MCP Server",
        status: "fail",
        message: `Could not start MCP server: ${error.message}`,
        details: { ...resolved },
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!settled) {
        finish({
          id: "mcp-boot",
          label: "MCP Server",
          status: "fail",
          message: `MCP server exited before reporting readiness${code === null ? "" : ` (code ${code})`}.`,
          details: { ...trimOutput({ stdout, stderr }), ...resolved },
        });
      }
    });
  });
}

function resolveCurrentMcpCommand(): { command: string; args: string[] } | null {
  const cliPath = process.argv[1];
  if (!cliPath) return null;
  return cliPath.endsWith(".js")
    ? { command: process.execPath, args: [cliPath, "mcp"] }
    : { command: cliPath, args: ["mcp"] };
}

function inheritedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

async function checkMcpToolsList(): Promise<DoctorCheck> {
  const resolved = resolveCurrentMcpCommand();
  if (!resolved) {
    return {
      id: "mcp-tools-list",
      label: "MCP Tools",
      status: "fail",
      message: "Could not resolve the current Summer CLI entrypoint.",
    };
  }

  const client = new Client({ name: "summer-doctor", version });
  const transport = new StdioClientTransport({
    ...resolved,
    env: inheritedEnv({ SUMMER_MCP_DOCTOR: "1" }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
  });

  try {
    await client.connect(transport, { timeout: 5000 });
    const listed = await client.listTools(undefined, { timeout: 5000 });
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    const missing = REQUIRED_MCP_TOOLS.filter((tool) => !toolNames.includes(tool));
    const details = {
      ...resolved,
      toolCount: toolNames.length,
      requiredTools: REQUIRED_MCP_TOOLS,
      missing,
      server: client.getServerVersion(),
      stderr: stderr.trim().slice(-1000),
      logPath: getMcpLogPath(),
    };

    if (missing.length > 0) {
      return {
        id: "mcp-tools-list",
        label: "MCP Tools",
        status: "fail",
        message: `missing required tools: ${missing.join(", ")}`,
        details,
      };
    }

    if (toolNames.length < MIN_EXPECTED_MCP_TOOLS) {
      return {
        id: "mcp-tools-list",
        label: "MCP Tools",
        status: "fail",
        message: `only ${toolNames.length} tools listed; expected ${MIN_EXPECTED_MCP_TOOLS}+`,
        details,
      };
    }

    return {
      id: "mcp-tools-list",
      label: "MCP Tools",
      status: "ok",
      message: `${toolNames.length} tools registered`,
      details,
    };
  } catch (error) {
    return {
      id: "mcp-tools-list",
      label: "MCP Tools",
      status: "fail",
      message: `protocol handshake/list failed: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        ...resolved,
        stderr: stderr.trim().slice(-1000),
        logPath: getMcpLogPath(),
      },
    };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function summarizeChecks(checks: DoctorCheck[]): DoctorResult {
  const summary = {
    ok: checks.filter((check) => check.status === "ok").length,
    warnings: checks.filter((check) => check.status === "warning").length,
    failures: checks.filter((check) => check.status === "fail").length,
  };

  return {
    ok: summary.failures === 0,
    checks,
    summary,
  };
}

export function printDoctorResult(result: DoctorResult): void {
  console.log(c.bold("Doctor"));
  console.log("");

  // Widest label + 2 so long labels ("CLI up to date") keep their gap.
  const labelWidth =
    result.checks.reduce((w, check) => Math.max(w, check.label.length), 0) + 2;
  for (const check of result.checks) {
    const mark =
      check.status === "ok"
        ? sym.ok()
        : check.status === "warning"
          ? sym.warn()
          : sym.fail();
    console.log(
      `  ${mark}  ${pad(c.bold(check.label), labelWidth)}${c.dim(check.message)}`
    );
  }

  console.log("");
  if (result.summary.failures > 0) {
    console.log(
      c.red(`${result.summary.failures} ${result.summary.failures === 1 ? "issue" : "issues"} to fix.`)
    );
  } else if (result.summary.warnings > 0) {
    console.log(
      c.yellow(
        `${result.summary.warnings} ${result.summary.warnings === 1 ? "warning" : "warnings"}, ${result.summary.ok} OK.`
      )
    );
  } else {
    console.log(c.green("Everything's wired up."));
  }
}

function trimOutput(output: { stdout: string; stderr: string }): Record<string, string> {
  return {
    stdout: output.stdout.trim().slice(0, 500),
    stderr: output.stderr.trim().slice(0, 500),
  };
}
