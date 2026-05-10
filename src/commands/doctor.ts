import { spawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "node:module";
import { platform } from "os";
import { Command } from "commander";
import { getAuthToken, getUserInfo } from "../lib/auth.js";
import { checkEngineHealth, getApiPort, getApiToken } from "../lib/engine.js";
import { brandLine, c, pad, sym, tildeify } from "../lib/format.js";
import {
  buildCliVersionCheck,
  buildSkillsVersionCheck,
  defaultSkillMarkerCandidates,
  fetchLatestRegistryVersion,
} from "../lib/version-check.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

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

const MAC_ENGINE_PATHS = [
  "/Applications/Summer.app/Contents/MacOS/Summer",
  `${process.env.HOME}/Applications/Summer.app/Contents/MacOS/Summer`,
];

const WIN_ENGINE_PATHS = [
  `${process.env.LOCALAPPDATA}\\SummerEngine\\current\\Summer.exe`,
  `${process.env.LOCALAPPDATA}\\Programs\\Summer Engine\\Summer.exe`,
  `${process.env.PROGRAMFILES}\\Summer Engine\\Summer.exe`,
];

export const doctorCommand = new Command("doctor")
  .description("Diagnose Node, login, engine, local API, and MCP boot")
  .option("--json", "Print diagnostics as JSON")
  .action(async (opts: { json?: boolean }) => {
    if (!opts.json) {
      const { createRequire: req } = await import("node:module");
      const ver = req(import.meta.url)("../../package.json").version as string;
      console.log("");
      console.log(brandLine(ver));
      console.log("");
    }
    const result = await runDoctor({ json: Boolean(opts.json) });
    if (!result.ok) {
      process.exit(1);
    }
  });

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
  checks.push(checkSkillsVersion());

  checks.push(await checkLogin());
  checks.push(checkEngineInstall());
  checks.push(await checkLocalApi());
  checks.push(await checkMcpBoot());

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

function checkSkillsVersion(): DoctorCheck {
  const result = buildSkillsVersionCheck({
    installedCliVersion: version,
    candidates: defaultSkillMarkerCandidates(),
  });
  return {
    id: "skills-version-stale",
    label: "Skills up to date",
    status: result.status,
    message: result.message,
    details: result.details,
  };
}

async function checkLogin(): Promise<DoctorCheck> {
  const token = await getAuthToken();
  const user = await getUserInfo();

  if (!token) {
    return {
      id: "login",
      label: "Login",
      status: "warning",
      message: "not signed in (run: summer login)",
    };
  }

  return {
    id: "login",
    label: "Login",
    status: "ok",
    message: user ? user.email : "signed in",
  };
}

function checkEngineInstall(): DoctorCheck {
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
    message: "not installed (run: summer install)",
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

async function checkMcpBoot(): Promise<DoctorCheck> {
  const cliPath = process.argv[1];
  if (!cliPath) {
    return {
      id: "mcp-boot",
      label: "MCP Server",
      status: "fail",
      message: "Could not resolve the current Summer CLI entrypoint.",
    };
  }

  return new Promise<DoctorCheck>((resolve) => {
    const command = cliPath.endsWith(".js") ? process.execPath : cliPath;
    const args = cliPath.endsWith(".js") ? [cliPath, "mcp"] : ["mcp"];
    const child = spawn(command, args, {
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
        details: trimOutput({ stdout, stderr }),
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
          details: trimOutput({ stdout, stderr }),
        });
      }
    });
  });
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

  const labelWidth = 14;
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

function findEngineBinary(): string | null {
  const paths = platform() === "darwin" ? MAC_ENGINE_PATHS : WIN_ENGINE_PATHS;
  for (const path of paths) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

function trimOutput(output: { stdout: string; stderr: string }): Record<string, string> {
  return {
    stdout: output.stdout.trim().slice(0, 500),
    stderr: output.stderr.trim().slice(0, 500),
  };
}
