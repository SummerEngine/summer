/**
 * Thrown-error classes the MCP layer (withEngine) can tell apart from a
 * transport failure. Lives in core so the headless worker facade can tag its
 * own throws without importing the MCP layer.
 *
 * Why: withEngine used to treat EVERY throw inside a tool closure as
 * "transport" — reset the cached client and tell the model the mutation "may
 * have partially applied, don't blind-retry". For an argument-validation
 * throw (nothing was ever sent) that is false and expensive: the agent goes
 * off to inspect the scene for a change that never happened.
 *
 * Tagging is by symbol rather than instanceof so a copy of this module loaded
 * twice (dist + src in tests, or a duplicated dependency) still classifies.
 */

export const THROWN_ERROR_CLASS = Symbol.for("summer.thrownErrorClass");

export type ThrownErrorClass = "input" | "unsupported";

/** Argument validation failed BEFORE anything was sent to the engine. */
export class ToolInputError extends Error {
  readonly [THROWN_ERROR_CLASS]: ThrownErrorClass = "input";
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** The client serving this call cannot perform the operation at all (e.g. the
 *  headless worker facade has no equivalent). Nothing was sent or applied. */
export class UnsupportedOperationError extends Error {
  readonly [THROWN_ERROR_CLASS]: ThrownErrorClass = "unsupported";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOperationError";
  }
}

/** The pre-apply class of a thrown error, or null for anything unclassified
 *  (which withEngine keeps treating as transport). */
export function thrownErrorClass(err: unknown): ThrownErrorClass | null {
  if (!err || typeof err !== "object") return null;
  const tag = (err as Record<PropertyKey, unknown>)[THROWN_ERROR_CLASS];
  return tag === "input" || tag === "unsupported" ? tag : null;
}
