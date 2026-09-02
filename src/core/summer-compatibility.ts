/**
 * Summer CLI compatibility values.
 *
 * Keep the current technical base in one place. The project feature tag is
 * derived from it so `summer create` cannot drift to a different line. The
 * only consumer is src/cli/commands/create.ts; create.test.ts pins the
 * rendered "Technical base <version>" line and config/features tag.
 */
const CURRENT_TECHNICAL_BASE_VERSION = "4.6.1";

function featureTagFor(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) {
    throw new Error(`Invalid Summer Engine technical base version: ${version}`);
  }
  return `${match[1]}.${match[2]}`;
}

export const SUMMER_ENGINE_COMPATIBILITY = Object.freeze({
  currentTechnicalBaseVersion: CURRENT_TECHNICAL_BASE_VERSION,
  projectFeatureTag: featureTagFor(CURRENT_TECHNICAL_BASE_VERSION),
  plannedNextTechnicalBaseVersion: "4.7.1",
  upstreamPolicy: "continuous-upstream",
});
