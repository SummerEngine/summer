/** Shared bits for the registry compiler (kept cycle-free). */

export const GENERATED_BANNER = "GENERATED — do not edit; run npm run generate:registry";

/**
 * Root dot-file manifests are build artifacts of integrations/<agent> +
 * library/; their banner names the integration they belong to.
 */
export function manifestBanner(agent: string): string {
  return `GENERATED from integrations/${agent} — do not edit; npm run generate:registry`;
}

/** Deterministic JSON: 2-space indent, insertion key order, trailing newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
