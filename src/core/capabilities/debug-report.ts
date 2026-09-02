import { mkdir, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { EngineApiClient } from "../api-client.js";
import { shapeEngineLogResponse } from "../log-filters.js";
import { tildeify } from "../format.js";
import { getMcpLogPath, readRecentMcpLogLines } from "../mcp-log.js";
import { redactLogLine, redactSensitive } from "../redact.js";
import { runDoctor, type DoctorResult } from "./doctor.js";

import { asRecord } from "../util/json.js";
import { sleep } from "../util/sleep.js";
import { TOOLKIT_VERSION as version } from "../version.js";

export interface DebugReportOptions {
  issue?: string;
  outputPath?: string;
  includePlaySession?: boolean;
  playWaitMs?: number;
  maxConsoleLines?: number;
  maxDebuggerEntries?: number;
  includeDoctor?: boolean;
  baseDir?: string;
}

export interface DebugReportArtifact {
  path: string;
  markdown: string;
  report: DebugReport;
}

export interface DebugReport {
  generatedAt: string;
  issue: string | null;
  environment: {
    cliVersion: string;
    nodeVersion: string;
    platform: string;
    release: string;
    cwd: string;
    hostname: string;
  };
  doctor: DoctorResult | null;
  mcp: {
    logPath: string;
    recentLog: string[];
  };
  engine: {
    connected: boolean;
    error?: string;
    health?: unknown;
    project?: unknown;
    scene?: unknown;
    diagnostics?: unknown;
    console?: unknown;
    debuggerErrors?: unknown;
    debuggerWarnings?: unknown;
    playSession?: unknown;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function defaultDebugReportFilename(date = new Date()): string {
  return `summer-debug-report-${timestampForFile(date)}.md`;
}

function pickString(value: unknown, keys: string[]): string | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function projectPathFromReport(report: DebugReport): string | null {
  return pickString(report.engine.health, ["project_path", "projectPath", "projectRoot", "project_root"]);
}

function resolveOutputPath(report: DebugReport, options: DebugReportOptions): string {
  if (options.outputPath) {
    return isAbsolute(options.outputPath)
      ? options.outputPath
      : resolve(process.cwd(), options.outputPath);
  }
  const baseDir = options.baseDir ?? projectPathFromReport(report) ?? process.cwd();
  return join(baseDir, defaultDebugReportFilename(new Date(report.generatedAt)));
}

async function writeMarkdown(path: string, markdown: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf-8");
}

async function safeCollect(label: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return {
      ok: false,
      label,
      error: errorMessage(error),
    };
  }
}

function firstOpsResult(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value);
  const results = root?.results;
  if (Array.isArray(results) && results.length > 0) {
    return asRecord(results[0]);
  }
  return root;
}

function isGamePlaying(value: unknown): boolean {
  return firstOpsResult(value)?.playing === true;
}

async function collectConsole(
  client: EngineApiClient,
  maxConsoleLines: number
): Promise<unknown> {
  const raw = await client.executeOps([
    { op: "GetConsoleOutput", max_lines: maxConsoleLines },
  ]);
  return shapeEngineLogResponse(raw, {
    errorsOnly: false,
    maxEntries: maxConsoleLines,
  }).result;
}

async function collectDebugger(
  client: EngineApiClient,
  type: "error" | "warning",
  maxEntries: number
): Promise<unknown> {
  const op: Record<string, unknown> = {
    op: "GetDebuggerErrors",
    max_errors: maxEntries,
    include_stack: true,
  };
  if (type === "warning") op.type = "warning";
  const raw = await client.executeOps([op]);
  return shapeEngineLogResponse(raw, { maxEntries }).result;
}

async function collectPlaySession(
  client: EngineApiClient,
  options: Required<Pick<DebugReportOptions, "playWaitMs" | "maxConsoleLines" | "maxDebuggerEntries">>
): Promise<unknown> {
  const session: Record<string, unknown> = {
    requested: true,
    waitMs: options.playWaitMs,
  };

  session.before = await safeCollect("is-running-before", () =>
    client.executeOps([{ op: "IsGameRunning" }])
  );
  const wasPlaying = isGamePlaying(session.before);
  session.wasPlayingBefore = wasPlaying;

  if (wasPlaying) {
    session.note =
      "Game was already running. Collected current runtime diagnostics without clearing console, launching, or stopping.";
  } else {
    session.clearConsole = await safeCollect("clear-console", () =>
      client.executeOps([{ op: "ClearConsoleOutput" }])
    );
    session.play = await safeCollect("play", () => client.play());
  }

  await sleep(options.playWaitMs);
  session.diagnostics = await safeCollect("diagnostics-after-play", () =>
    client.getDiagnostics()
  );
  session.console = await safeCollect("console-after-play", () =>
    collectConsole(client, options.maxConsoleLines)
  );
  session.debuggerErrors = await safeCollect("debugger-errors-after-play", () =>
    collectDebugger(client, "error", options.maxDebuggerEntries)
  );
  session.debuggerWarnings = await safeCollect("debugger-warnings-after-play", () =>
    collectDebugger(client, "warning", options.maxDebuggerEntries)
  );
  if (!wasPlaying) {
    session.stop = await safeCollect("stop", () => client.stop());
  }

  return session;
}

/** Debug reports also blank hostnames — a support artifact needs none. */
function redact(value: unknown): unknown {
  return redactSensitive(value, { extraKeys: /hostname/i, strings: true });
}

export function redactDebugReport(report: DebugReport): DebugReport {
  return redact(report) as DebugReport;
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(redact(value), null, 2)}\n\`\`\``;
}

function doctorSummary(doctor: DoctorResult | null): string {
  if (!doctor) return "Doctor was skipped.";
  return `${doctor.summary.failures} failures, ${doctor.summary.warnings} warnings, ${doctor.summary.ok} OK.`;
}

function issueText(issue: string | null): string {
  return issue && issue.trim().length > 0 ? issue.trim() : "No issue text provided.";
}

export function renderDebugReportMarkdown(report: DebugReport): string {
  const health = asRecord(report.engine.health);
  const projectName = pickString(health, ["project_name", "projectName"]) ?? "unknown";
  const projectPath = pickString(health, ["project_path", "projectPath"]) ?? "unknown";
  const scene = pickString(health, ["scene", "scenePath", "scene_path"]) ?? "unknown";

  return `# Summer Debug Report

Generated: ${report.generatedAt}

## Before Sending

This report is meant for Summer Engine support or an assisting AI agent. It does not include auth tokens or project file contents, but it may include local paths, project names, console output, and stack traces. Review it before sending.

## User Issue

${issueText(report.issue)}

## Quick Summary

- Doctor: ${doctorSummary(report.doctor)}
- Engine connected: ${report.engine.connected ? "yes" : "no"}
- Project: ${projectName}
- Project path: ${tildeify(projectPath)}
- Scene: ${scene}

## Environment

${jsonBlock({
  ...report.environment,
  cwd: tildeify(report.environment.cwd),
  hostname: report.environment.hostname ? "[local-hostname-present]" : "",
})}

## Doctor Checks

${report.doctor ? jsonBlock(report.doctor) : "Doctor was skipped."}

## MCP Lifecycle Log

Log path: ${tildeify(report.mcp.logPath)}

${report.mcp.recentLog.length > 0 ? `\`\`\`jsonl\n${report.mcp.recentLog.map(redactLogLine).join("\n")}\n\`\`\`` : "No MCP lifecycle log entries found."}

## Engine Health

${report.engine.health ? jsonBlock(report.engine.health) : report.engine.error ?? "Engine was not reachable."}

## Project State

${report.engine.project ? jsonBlock(report.engine.project) : "No project state collected."}

## Scene State

${report.engine.scene ? jsonBlock(report.engine.scene) : "No scene state collected."}

## Diagnostics

${report.engine.diagnostics ? jsonBlock(report.engine.diagnostics) : "No diagnostics collected."}

## Console

${report.engine.console ? jsonBlock(report.engine.console) : "No console output collected."}

## Debugger Errors

${report.engine.debuggerErrors ? jsonBlock(report.engine.debuggerErrors) : "No debugger errors collected."}

## Debugger Warnings

${report.engine.debuggerWarnings ? jsonBlock(report.engine.debuggerWarnings) : "No debugger warnings collected."}

## Play Session

${report.engine.playSession ? jsonBlock(report.engine.playSession) : "No play session requested. Re-run with --play if the issue only appears while the game is running."}

## Agent Handoff Prompt

\`\`\`text
You are debugging a Summer Engine project. Use the Summer debug skill and this report as the starting evidence.

User issue:
${issueText(report.issue)}

Process:
1. Start with the collected diagnostics, console output, and debugger errors in this report.
2. Form one specific hypothesis before editing.
3. Ask before making project changes.
4. After a fix, re-run the diagnostic that found the issue and update the report or final answer with the exact evidence.
\`\`\`
`;
}

export async function collectDebugReport(
  options: DebugReportOptions = {}
): Promise<DebugReport> {
  const generatedAt = new Date().toISOString();
  const includeDoctor = options.includeDoctor ?? true;
  const report: DebugReport = {
    generatedAt,
    issue: options.issue?.trim() || null,
    environment: {
      cliVersion: version,
      nodeVersion: process.version,
      platform: platform(),
      release: release(),
      cwd: process.cwd(),
      hostname: hostname(),
    },
    doctor: null,
    mcp: {
      logPath: getMcpLogPath(),
      recentLog: [],
    },
    engine: {
      connected: false,
    },
  };

  if (includeDoctor) {
    report.doctor = await runDoctor({ quiet: true });
  }
  report.mcp.recentLog = await readRecentMcpLogLines();

  let client: EngineApiClient;
  try {
    client = await EngineApiClient.connect();
    report.engine.connected = true;
  } catch (error) {
    report.engine.error = errorMessage(error);
    report.mcp.recentLog = await readRecentMcpLogLines();
    return report;
  }

  const maxConsoleLines = options.maxConsoleLines ?? 200;
  const maxDebuggerEntries = options.maxDebuggerEntries ?? 100;

  report.engine.health = await safeCollect("health", () => client.health());
  report.engine.project = await safeCollect("project-state", () => client.getProjectState());
  report.engine.scene = await safeCollect("scene-state", () => client.getSceneState());
  report.engine.diagnostics = await safeCollect("diagnostics", () => client.getDiagnostics());
  report.engine.console = await safeCollect("console", () =>
    collectConsole(client, maxConsoleLines)
  );
  report.engine.debuggerErrors = await safeCollect("debugger-errors", () =>
    collectDebugger(client, "error", maxDebuggerEntries)
  );
  report.engine.debuggerWarnings = await safeCollect("debugger-warnings", () =>
    collectDebugger(client, "warning", maxDebuggerEntries)
  );

  if (options.includePlaySession) {
    report.engine.playSession = await collectPlaySession(client, {
      playWaitMs: options.playWaitMs ?? 2500,
      maxConsoleLines,
      maxDebuggerEntries,
    });
  }

  report.mcp.recentLog = await readRecentMcpLogLines();
  return report;
}

export async function createDebugReportArtifact(
  options: DebugReportOptions = {}
): Promise<DebugReportArtifact> {
  const report = await collectDebugReport(options);
  const markdown = renderDebugReportMarkdown(report);
  const path = resolveOutputPath(report, options);
  await writeMarkdown(path, markdown);
  return { path, markdown, report };
}
