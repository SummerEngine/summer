/**
 * Blind tool-canary gateway — pure policy core (no I/O).
 *
 * Origin: SummerEngine/SummerEngine branch codex/world-tool-balanced-suite-ready,
 * tools/summer-cli/src/dev/canary-gateway-core.ts (Marcus / frozaken). Ported
 * into evals/canary/ 2026-09-03. The only edits: the two constructors, whose
 * TypeScript parameter properties Node's strip-only mode rejects, now assign
 * explicit fields; this header; and the canary lists below, trimmed
 * 2026-09-03 when summer_frame_camera / summer_camera_visibility were dropped
 * by their author after benchmarks. See README.md in this directory.
 */
import { createHash } from "node:crypto";

export const CANARY_TOOL_NAMES = [
  "summer_starcast",
  "summer_test_placement",
  "summer_snap_to_surface",
  "summer_align_distribute_3d",
  "summer_navigation_probe",
] as const;

// summer_batch is intentionally a raw engine-op escape hatch. Block every
// canary op identifier in every arm so a hidden dedicated tool cannot be
// reconstructed by guessing its underlying op name.
export const CANARY_RAW_OP_NAMES = [
  "Starcast3D",
  "TestPlacement3D",
  "SnapToSurface",
  "AlignDistribute3D",
  "NavigationProbe3D",
] as const;

export type CanaryToolName = (typeof CANARY_TOOL_NAMES)[number];

export interface McpToolRecord {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

export type CatalogPolicy =
  | { mode: "control" }
  | { mode: "treatment"; canary: CanaryToolName };

export interface MediaFile {
  blockIndex: number;
  type: "image" | "audio";
  mimeType: string;
  byteLength: number;
  sha256: string;
  filePath: string;
}

export interface PersistedMedia {
  filePath: string;
}

export type PersistMedia = (media: {
  blockIndex: number;
  type: "image" | "audio";
  mimeType: string;
  bytes: Buffer;
}) => PersistedMedia;

export class GatewayError extends Error {
  // Explicit field (not a TS parameter property): Node's strip-only TypeScript
  // mode refuses parameter properties, and evals/ runs unbuilt under Node.
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

export class CallBudget {
  readonly maxCalls: number;
  private used: number;

  constructor(maxCalls: number, usedCalls = 0) {
    this.maxCalls = maxCalls;
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) {
      throw new GatewayError("invalid_call_budget", "maxCalls must be a positive integer.");
    }
    if (!Number.isSafeInteger(usedCalls) || usedCalls < 0 || usedCalls > maxCalls) {
      throw new GatewayError(
        "invalid_call_budget_state",
        "usedCalls must be an integer between zero and maxCalls."
      );
    }
    this.used = usedCalls;
  }

  get usedCalls(): number {
    return this.used;
  }

  get remainingCalls(): number {
    return this.maxCalls - this.used;
  }

  consume(): number {
    if (this.used >= this.maxCalls) {
      throw new GatewayError(
        "call_budget_exhausted",
        `The fixed call budget of ${this.maxCalls} has been exhausted.`
      );
    }
    this.used += 1;
    return this.used;
  }
}

export function isCanaryToolName(value: string): value is CanaryToolName {
  return (CANARY_TOOL_NAMES as readonly string[]).includes(value);
}

export function filterCatalog(
  upstreamTools: readonly McpToolRecord[],
  policy: CatalogPolicy
): McpToolRecord[] {
  assertUniqueToolNames(upstreamTools);

  if (
    policy.mode === "treatment" &&
    !upstreamTools.some((tool) => tool.name === policy.canary)
  ) {
    throw new GatewayError(
      "canary_not_registered",
      `The actual MCP server did not register treatment canary ${policy.canary}.`
    );
  }

  return upstreamTools.filter(
    (tool) => !isCanaryToolName(tool.name) ||
      (policy.mode === "treatment" && tool.name === policy.canary)
  );
}

export function assertToolVisible(
  toolName: string,
  visibleTools: readonly McpToolRecord[]
): McpToolRecord {
  const tool = visibleTools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new GatewayError(
      "tool_not_visible",
      `Tool ${toolName} is not present in this trial's filtered catalog.`
    );
  }
  return tool;
}

export function assertNoCanaryRawOpEscape(
  toolName: string,
  args: Record<string, unknown>
): void {
  if (toolName !== "summer_batch" || !Array.isArray(args.ops)) return;

  const blockedOps = new Set<string>(CANARY_RAW_OP_NAMES);
  for (const candidate of args.ops) {
    if (!isRecord(candidate) || typeof candidate.op !== "string") continue;
    if (blockedOps.has(candidate.op)) {
      throw new GatewayError(
        "canary_raw_op_denied",
        `Raw prototype op ${candidate.op} is hidden by this trial's canary policy.`
      );
    }
  }
}

export async function gateAndInvoke<T>(options: {
  toolName: string;
  args: Record<string, unknown>;
  visibleTools: readonly McpToolRecord[];
  budget: CallBudget;
  onConsumed?: (callIndex: number) => void | Promise<void>;
  invoke: (toolName: string, args: Record<string, unknown>) => Promise<T>;
}): Promise<{ callIndex: number; result: T }> {
  // Every attempted call consumes budget, including a guessed hidden tool. This
  // prevents a control agent from probing hidden canaries for free.
  const callIndex = options.budget.consume();
  await options.onConsumed?.(callIndex);
  assertToolVisible(options.toolName, options.visibleTools);
  assertNoCanaryRawOpEscape(options.toolName, options.args);
  return {
    callIndex,
    result: await options.invoke(options.toolName, options.args),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function catalogSnapshot(tools: readonly McpToolRecord[]): {
  canonical: string;
  sha256: string;
} {
  assertUniqueToolNames(tools);
  const sortedTools = [...tools].sort((left, right) => left.name.localeCompare(right.name));
  const canonical = canonicalJson({ tools: sortedTools });
  return { canonical, sha256: sha256(canonical) };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function sanitizeMediaBlocks(
  result: unknown,
  persist: PersistMedia
): { result: unknown; mediaFiles: MediaFile[] } {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return { result, mediaFiles: [] };
  }

  const mediaFiles: MediaFile[] = [];
  const content = result.content.map((block, blockIndex) => {
    if (!isRecord(block) || (block.type !== "image" && block.type !== "audio")) {
      return block;
    }
    if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
      throw new GatewayError(
        "invalid_media_block",
        `MCP ${String(block.type)} block ${blockIndex} is missing base64 data or mimeType.`
      );
    }

    const bytes = decodeBase64(block.data, blockIndex);
    const persisted = persist({
      blockIndex,
      type: block.type,
      mimeType: block.mimeType,
      bytes,
    });
    const media: MediaFile = {
      blockIndex,
      type: block.type,
      mimeType: block.mimeType,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      filePath: persisted.filePath,
    };
    mediaFiles.push(media);

    const { data: _data, ...withoutData } = block;
    return {
      ...withoutData,
      filePath: persisted.filePath,
      byteLength: media.byteLength,
      sha256: media.sha256,
    };
  });

  return {
    result: { ...result, content },
    mediaFiles,
  };
}

function assertUniqueToolNames(tools: readonly McpToolRecord[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new GatewayError(
        "duplicate_tool_name",
        `The actual MCP catalog contains duplicate tool name ${tool.name}.`
      );
    }
    names.add(tool.name);
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  throw new GatewayError(
    "non_json_catalog_value",
    `Cannot canonicalize catalog value of type ${typeof value}.`
  );
}

function decodeBase64(value: string, blockIndex: number): Buffer {
  const compact = value.replace(/\s/g, "");
  if (
    compact.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
  ) {
    throw new GatewayError(
      "invalid_media_base64",
      `MCP media block ${blockIndex} did not contain canonical base64.`
    );
  }
  return Buffer.from(compact, "base64");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
