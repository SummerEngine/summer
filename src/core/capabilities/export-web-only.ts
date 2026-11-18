import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EngineApiClient } from "../api-client.js";
import { extractOpError } from "./engine-receipt.js";
import { BuildToolError, hashFile } from "./summer-bundle.js";

export interface WebOnlyClient {
  getEngineCapabilities(): { gameBuildFormats?: string[] } | undefined;
  executeIdentityBoundOps(
    ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number
  ): Promise<unknown>;
}

export type WebOnlyConnect = (project: string) => Promise<WebOnlyClient>;
export const connectWebOnly: WebOnlyConnect = (project) => EngineApiClient.connect({ projectPath: project });

function jobData(reply: unknown, jobId: string): Record<string, unknown> {
  const failure = extractOpError(reply);
  if (failure) {
    throw new BuildToolError(
      "web_export_failed", `The editor could not export this web project: ${failure}`,
      "Recovery: inspect the editor's build output and correct the named error.",
      undefined, { jobId, receipt: reply }
    );
  }
  const envelope = reply as { results?: Array<{ ok?: boolean; data?: unknown }> };
  const result = envelope?.results?.[0];
  const data = result?.data;
  if (!result || result.ok !== true || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new BuildToolError(
      "web_export_invalid_receipt", "The editor did not return a valid web build job receipt.",
      "Recovery: inspect this job in the editor before starting another export.", undefined, { jobId }
    );
  }
  const job = data as Record<string, unknown>;
  if (job.schema !== "summer.game-build.v1" || job.jobId !== jobId || typeof job.state !== "string") {
    throw new BuildToolError(
      "web_export_invalid_receipt", "The editor returned a different or malformed build job.",
      "Recovery: inspect the original job before starting another export.", undefined, { jobId }
    );
  }
  return job;
}

function timeout(jobId: string): BuildToolError {
  return new BuildToolError(
    "export_timeout", "The web export is still running after the requested timeout.",
    "Recovery: inspect this job in the editor; do not blindly start another.", undefined, { jobId }
  );
}

export async function exportWebOnly(
  project: string, out: string | null, timeoutMs: number, connect: WebOnlyConnect = connectWebOnly
): Promise<{ path: string; sha256: string; sizeBytes: number }> {
  const jobId = randomUUID();
  const client = await connect(project);
  if (!client.getEngineCapabilities()?.gameBuildFormats?.includes("web-zip")) {
    throw new BuildToolError(
      "engine_web_export_unsupported", "The connected Summer editor does not advertise Web-only game builds.",
      "Recovery: update Summer Engine to a build that supports web-zip, reopen this exact project, then export again."
    );
  }
  const deadline = Date.now() + timeoutMs;
  const call = async (op: string) => {
    const reply = await client.executeIdentityBoundOps(
      [{ op, jobId }], undefined, Math.max(1, deadline - Date.now())
    );
    return jobData(reply, jobId);
  };
  let job = await call("ExportGameBuild");
  while (job.state !== "ready") {
    if (["failed", "canceled", "interrupted"].includes(String(job.state))) {
      throw new BuildToolError(
        "web_export_failed", `The web build ${job.state}: ${String(job.error ?? "see editor build output")}.`,
        "Recovery: fix the named build failure before exporting again.", undefined, { jobId, job }
      );
    }
    const active = ["queued", "preparing", "exporting", "checking", "running", "building", "snapshotting"];
    if (!active.includes(String(job.state))) {
      throw new BuildToolError(
        "web_export_invalid_receipt", `Unexpected web build state ${String(job.state)}.`,
        "Recovery: inspect this job in the editor.", undefined, { jobId }
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeout(jobId);
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(500, remaining)));
    if (Date.now() >= deadline) throw timeout(jobId);
    job = await call("GameBuildStatus");
  }
  const artifact = job.artifact as Record<string, unknown> | undefined;
  const expectedRel = `.summer/export-jobs/game-${jobId}/game.zip`;
  const targets = artifact?.targetPlatforms;
  const valid = artifact?.format === "web-zip" && artifact.relativePath === expectedRel &&
    artifact.entryPoint === "index.html" && Array.isArray(targets) &&
    targets.length === 1 && targets[0] === "web" &&
    typeof artifact.sha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.sizeBytes) && Number(artifact.sizeBytes) > 0;
  if (!valid || !artifact) {
    throw new BuildToolError(
      "web_export_invalid_receipt", "The completed web job did not name its expected ZIP and digest.",
      "Recovery: inspect the editor build result and export again only after resolving the mismatch.",
      undefined, { jobId }
    );
  }
  const root = await realpath(project);
  for (const part of [".summer", ".summer/export-jobs", `.summer/export-jobs/game-${jobId}`, expectedRel]) {
    if ((await lstat(join(root, part))).isSymbolicLink()) {
      throw new BuildToolError(
        "web_export_invalid_receipt", "The job output contains a symbolic link.",
        "Recovery: inspect the project export-jobs directory.", undefined, { jobId }
      );
    }
  }
  const artifactPath = join(root, expectedRel);
  const actual = await hashFile(artifactPath);
  if (actual.sha256 !== artifact.sha256 || actual.sizeBytes !== artifact.sizeBytes) {
    throw new BuildToolError(
      "web_export_changed", "The web build bytes do not match the editor's completed job.",
      "Recovery: inspect the build job before exporting again.", undefined, { jobId }
    );
  }
  let path = artifactPath;
  if (out && resolve(out) !== artifactPath) {
    await mkdir(dirname(out), { recursive: true });
    const temporary = join(dirname(out), `.summer-web-export-${randomUUID()}.tmp`);
    try {
      await copyFile(artifactPath, temporary);
      const copied = await hashFile(temporary);
      if (copied.sha256 !== actual.sha256 || copied.sizeBytes !== actual.sizeBytes) {
        throw new BuildToolError(
          "web_export_changed", "The copied export did not match the completed build.",
          "Recovery: check the output location and export again.", undefined, { jobId }
        );
      }
      await rename(temporary, out);
      path = resolve(out);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { path, ...actual };
}
