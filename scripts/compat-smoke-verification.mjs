import { basename } from "node:path";

// A successful RPC is not evidence that the verification child captured a frame.
export function verificationFailure(response, expectedFrame) {
  if (response?.isError) return "verification tool returned an error";
  const envelope = response?.json;
  if (!envelope || envelope.ok === false || !Array.isArray(envelope.results)) return "verification receipt is missing";
  const ops = envelope.results.filter((op) => op?.op === "RunVerification");
  if (ops.length !== 1) return "verification operation receipt is missing or ambiguous";
  const op = ops[0];
  if (op.ok !== true || op.verdict !== "passed") return `verification did not pass (${op.failure_reason ?? op.verdict ?? "missing verdict"})`;
  const result = op.results;
  if (!result || result.finished !== true || !Array.isArray(result.capture_failures) || result.capture_failures.length !== 0) {
    return "verification did not finish with successful captures";
  }
  if (!Array.isArray(result.frames) || !result.frames.includes(expectedFrame) ||
      !Array.isArray(op.frames) || !op.frames.some((frame) => typeof frame === "string" && basename(frame) === expectedFrame) ||
      !Array.isArray(op.captures) || !op.captures.some((capture) => capture?.file === expectedFrame && capture.readbackCompleted === true && capture.kind === "synchronous_native")) {
    return `requested frame ${expectedFrame} is missing or unverified`;
  }
  return null;
}
