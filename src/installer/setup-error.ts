/**
 * An error `summer setup` reports with a stable code, so a caller reading
 * `--json` (the Summer desktop installer) can branch on the code instead of
 * the message. The message stays the human sentence it always was.
 */
export class SetupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SetupError";
  }
}

/** File-system errno codes that mean "this file cannot be written here". */
const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS", "EISDIR", "ENOTDIR"]);

/**
 * The code for any error a setup step throws: a SetupError's own code, a
 * file-system failure by kind, else `fallback` (the step's generic code).
 */
export function setupErrorCode(error: unknown, fallback: string): string {
  if (error instanceof SetupError) return error.code;
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string") {
    if (NOT_WRITABLE.has(errno)) return "config_not_writable";
    if (errno === "ENOSPC") return "disk_full";
  }
  return fallback;
}

export interface SetupStepError {
  code: string;
  message: string;
}

export function toStepError(error: unknown, fallback: string): SetupStepError {
  return { code: setupErrorCode(error, fallback), message: error instanceof Error ? error.message : String(error) };
}
