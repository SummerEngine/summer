import { describe, expect, it } from "vitest";
import {
  defaultDebugReportFilename,
  renderDebugReportMarkdown,
  type DebugReport,
} from "./debug-report.js";

describe("debug report", () => {
  it("renders a support-ready markdown report with redaction and handoff prompt", () => {
    const report: DebugReport = {
      generatedAt: "2026-06-16T10:30:00.000Z",
      issue: "Player crashes after pickup",
      environment: {
        cliVersion: "2.6.0",
        nodeVersion: "v20.0.0",
        platform: "darwin",
        release: "25.0.0",
        cwd: "/Users/test/project",
        hostname: "workstation",
      },
      doctor: {
        ok: true,
        checks: [
          {
            id: "login",
            label: "Login",
            status: "ok",
            message: "signed in",
            details: { authToken: "secret" },
          },
        ],
        summary: { ok: 1, warnings: 0, failures: 0 },
      },
      mcp: {
        logPath: "/Users/test/.summer/mcp.log",
        recentLog: [
          JSON.stringify({
            event: "mcp:ready",
            toolCount: 52,
          }),
        ],
      },
      engine: {
        connected: true,
        health: {
          ok: true,
          project_name: "Test Game",
          project_path: "/Users/test/project",
          scene: "res://main.tscn",
        },
        diagnostics: { apiToken: "secret", errors: 0 },
      },
    };

    const markdown = renderDebugReportMarkdown(report);

    expect(markdown).toContain("# Summer Debug Report");
    expect(markdown).toContain("Player crashes after pickup");
    expect(markdown).toContain("## Before Sending");
    expect(markdown).toContain("## MCP Lifecycle Log");
    expect(markdown).toContain("mcp:ready");
    expect(markdown).toContain("## Agent Handoff Prompt");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).not.toContain("secret");
  });

  it("creates filesystem-safe default report names", () => {
    expect(defaultDebugReportFilename(new Date("2026-06-16T10:30:00.123Z"))).toBe(
      "summer-debug-report-2026-06-16T10-30-00-123Z.md"
    );
  });
});
