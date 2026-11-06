import { expect, test } from "vitest";
import { verificationFailure } from "./compat-smoke-verification.mjs";

function success() {
  return { isError: false, json: { results: [{ op: "RunVerification", ok: true, verdict: "passed", results: { finished: true, capture_failures: [], frames: ["compat.jpg"] }, frames: ["/owned/run/compat.jpg"], captures: [{ file: "compat.jpg", kind: "synchronous_native", readbackCompleted: true }] }] } };
}

test("accepts a completed and verified requested capture", () => {
  expect(verificationFailure(success(), "compat.jpg")).toBeNull();
});

test("rejects transport, verification, and capture failures", () => {
  const cases = [
    { isError: true },
    { json: null },
    { json: { results: [] } },
    { json: { results: [{ op: "RunVerification", ok: true, verdict: "failed", failure_reason: "runtime_error" }] } },
  ];
  const unfinished = success();
  unfinished.json.results[0].results.finished = false;
  cases.push(unfinished);
  const failedCapture = success();
  failedCapture.json.results[0].results.capture_failures = ["compat"];
  cases.push(failedCapture);
  const missingFrame = success();
  missingFrame.json.results[0].results.frames = [];
  cases.push(missingFrame);
  const missingFile = success();
  missingFile.json.results[0].frames = [];
  cases.push(missingFile);
  const unverified = success();
  unverified.json.results[0].captures[0].readbackCompleted = false;
  cases.push(unverified);
  for (const receipt of cases) expect(verificationFailure(receipt, "compat.jpg")).toBeTruthy();
});
