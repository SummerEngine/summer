/**
 * Narrowing helpers for untyped JSON (engine envelopes, gateway responses,
 * on-disk records). One copy; every surface imports from here.
 */

export type JsonRecord = Record<string, unknown>;

/** A plain object (not null, not an array), or null. */
export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** A non-empty string, or undefined. */
export function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A finite number, or undefined. */
export function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function boolFrom(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
