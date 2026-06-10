const WINDOWS_RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com0",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "com¹",
  "com²",
  "com³",
  "lpt0",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
  "lpt¹",
  "lpt²",
  "lpt³",
]);

/** Spec section 9: full key at most 1024 bytes, each segment at most 255. */
const MAX_KEY_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;

/**
 * Unicode case folding approximation without ICU: lower, upper, lower. The
 * round trip folds one-to-many mappings that plain toLowerCase misses
 * (eszett to ss, long s to s, final sigma to sigma).
 */
export function casefoldKey(path: string): string {
  return path.normalize("NFC").toLowerCase().toUpperCase().toLowerCase();
}

export function validateCloudPath(path: string): { ok: true } | { ok: false; reason: string } {
  if (!path || path !== path.normalize("NFC")) return { ok: false, reason: "Path must be non-empty and NFC-normalized" };
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return { ok: false, reason: "Path must be relative" };
  if (path.includes("\\") || path.includes("//") || path.endsWith("/") || /[\u0000-\u001f]/.test(path)) {
    return { ok: false, reason: "Path contains invalid characters" };
  }
  if (Buffer.byteLength(path, "utf8") > MAX_KEY_BYTES) return { ok: false, reason: `Path exceeds ${MAX_KEY_BYTES} bytes` };
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..") return { ok: false, reason: "Path contains dot or empty segment" };
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) return { ok: false, reason: `Path segment exceeds ${MAX_SEGMENT_BYTES} bytes` };
    if (segment.endsWith(".") || segment.endsWith(" ")) return { ok: false, reason: "Path segment ends with dot or space" };
    if (/[<>:"|?*]/.test(segment)) return { ok: false, reason: "Path segment contains a reserved character" };
    if (WINDOWS_RESERVED_BASENAMES.has(casefoldKey(segment.split(".")[0] || ""))) {
      return { ok: false, reason: "Path segment uses a Windows device name" };
    }
  }
  return { ok: true };
}

export interface PathCollision {
  kind: "casefold" | "nfc" | "prefix";
  a: string;
  b: string;
}

/**
 * Pairwise key collision checks (spec section 9): two keys equal after NFC,
 * two keys equal under casefold(NFC(key)), or one key being a directory
 * prefix of another (file vs directory collision).
 */
export function findPathCollisions(keys: readonly string[]): PathCollision[] {
  const collisions: PathCollision[] = [];
  const byNfc = new Map<string, string>();
  const byFold = new Map<string, string>();
  for (const key of keys) {
    const nfc = key.normalize("NFC");
    const priorNfc = byNfc.get(nfc);
    if (priorNfc !== undefined && priorNfc !== key) {
      collisions.push({ kind: "nfc", a: priorNfc, b: key });
    } else {
      byNfc.set(nfc, key);
    }
    const folded = casefoldKey(key);
    const priorFold = byFold.get(folded);
    if (priorFold !== undefined && priorFold !== key) {
      collisions.push({ kind: "casefold", a: priorFold, b: key });
    } else {
      byFold.set(folded, key);
    }
  }
  const sorted = [...keys].sort();
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    if (sorted[i + 1].startsWith(`${sorted[i]}/`)) {
      collisions.push({ kind: "prefix", a: sorted[i], b: sorted[i + 1] });
    }
  }
  return collisions;
}
