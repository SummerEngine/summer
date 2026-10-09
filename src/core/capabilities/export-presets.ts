import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BuildToolError } from "./summer-bundle.js";

/**
 * Store targets for summer_export_game, and the export presets that make them.
 *
 * The Summer Games store has two intakes (summer-platform):
 * - build-publications takes ONE summer.bundle.v1 .zip per Build. Summer runs
 *   its client.pck on its own client templates (the Summer Games iOS and
 *   Android apps, the Summer desktop app on macOS and Windows), so the creator
 *   needs no export template and signs nothing. A target only picks the
 *   platforms the bundle declares and the texture formats the pack carries
 *   (the summer.games preset option platforms/<id>).
 * - store versions take a web build (a static HTML5 .zip played in an iframe)
 *   and native desktop downloads (macos-universal, windows-x64). These are
 *   ordinary exports and need the matching export template.
 *
 * Presets are kept in export_presets.cfg under fixed names, so the creator
 * sees them in the Export dialog: "summer.games ios", "summer.games
 * ios+android", "Summer download Web", ... Only the options listed here are
 * ever rewritten; every other preset and setting stays byte-for-byte. The
 * engine adds its default "summer.games" preset only while the file has no
 * summer.games preset, so the default is written alongside the first named
 * one.
 */

export const STORE_TARGETS = ["macos", "windows", "ios", "android", "web"] as const;
export type StoreTarget = (typeof STORE_TARGETS)[number];
/** Targets a summer.games bundle can declare (the engine's CLIENT_PLATFORMS). */
export const BUNDLE_TARGETS: readonly StoreTarget[] = ["macos", "windows", "ios", "android"];
/** Targets the store takes as a download or web build (store versions). */
export const DOWNLOAD_TARGETS: readonly StoreTarget[] = ["macos", "windows", "web"];

/** Engine summer.games platform and default preset name (summer_games_export_platform.h PLATFORM_NAME). */
export const SUMMER_GAMES_PLATFORM = "summer.games";
export const SUMMER_GAMES_PRESET = "summer.games";
/** summer_games_export_platform.h CLIENT_FEATURE; create_preset sets it, the file must keep it. */
const SUMMER_CLIENT_FEATURE = "summer_client";
const PRESETS_FILE = "export_presets.cfg";

/** Canonical order, without repeats. */
export function normalizeTargets(targets: readonly string[]): StoreTarget[] {
  const unknown = targets.filter((target) => !(STORE_TARGETS as readonly string[]).includes(target));
  if (unknown.length) {
    throw new BuildToolError(
      "target_unknown",
      `Unknown export target ${unknown.join(", ")}.`,
      `Recovery: use targets from ${STORE_TARGETS.join(", ")}.`
    );
  }
  const chosen = STORE_TARGETS.filter((target) => targets.includes(target));
  if (!chosen.length) {
    throw new BuildToolError("target_unknown", "No export target was given.", `Recovery: pass targets from ${STORE_TARGETS.join(", ")}.`);
  }
  return chosen;
}

/** A preset the MCP owns: its name, export platform and the options it sets (Godot variant text). */
export interface PresetSpec {
  name: string;
  platform: string;
  customFeatures?: string;
  options: Record<string, string>;
}

/** Variant text for a String option. */
export function variantString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function bundlePresetSpec(targets: readonly StoreTarget[]): PresetSpec {
  return {
    name: `${SUMMER_GAMES_PRESET} ${targets.join("+")}`,
    platform: SUMMER_GAMES_PLATFORM,
    customFeatures: SUMMER_CLIENT_FEATURE,
    // Every engine platform is written, so a platform added by a newer engine
    // never turns on by default in a preset made for other targets.
    options: Object.fromEntries(STORE_TARGETS.map((target) => [`platforms/${target}`, String(targets.includes(target))])),
  };
}

interface Section {
  header: string;
  /** Raw lines after the header, up to the next header. */
  lines: string[];
}

function parseSections(text: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) sections.push({ header: header[1], lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
    else preamble.push(line);
  }
  return { preamble, sections };
}

function stringValue(section: Section, key: string): string | null {
  const prefix = `${key}=`;
  for (const line of section.lines) {
    if (!line.startsWith(prefix)) continue;
    const match = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(line.slice(prefix.length));
    if (match) return match[1].replace(/\\(["\\])/g, "$1");
  }
  return null;
}

function presetLines(spec: PresetSpec): string[] {
  return [
    "",
    `name=${variantString(spec.name)}`,
    `platform=${variantString(spec.platform)}`,
    "runnable=false",
    "dedicated_server=false",
    ...(spec.customFeatures !== undefined ? [`custom_features=${variantString(spec.customFeatures)}`] : []),
    'export_filter="all_resources"',
    'include_filter=""',
    'exclude_filter=""',
    'export_path=""',
    "",
  ];
}

function optionLines(options: Record<string, string>): string[] {
  return ["", ...Object.entries(options).map(([key, value]) => `${key}=${value}`), ""];
}

export interface EnsuredPreset {
  name: string;
  /** "created", "updated" (owned options rewritten) or "unchanged". */
  change: "created" | "updated" | "unchanged";
}

/** Make sure export_presets.cfg has this preset with these option values. */
export async function ensurePreset(project: string, spec: PresetSpec): Promise<EnsuredPreset> {
  const file = join(project, PRESETS_FILE);
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  const { preamble, sections } = parseSections(text);

  const presets = sections
    .map((section) => ({ section, index: /^preset\.(\d+)$/.exec(section.header)?.[1] }))
    .filter((item): item is { section: Section; index: string } => item.index !== undefined);
  const ours = presets.find(({ section }) => stringValue(section, "name") === spec.name);

  if (ours) {
    if (stringValue(ours.section, "platform") !== spec.platform) {
      throw new BuildToolError(
        "export_preset_conflict",
        `export_presets.cfg already has a preset named "${spec.name}" for another platform.`,
        "Recovery: rename or delete that preset in Project > Export, then export again."
      );
    }
    const optionsHeader = `preset.${ours.index}.options`;
    let options = sections.find((section) => section.header === optionsHeader);
    const wanted = new Map(Object.entries(spec.options));
    let changed = false;
    if (!options) {
      options = { header: optionsHeader, lines: optionLines(spec.options) };
      sections.splice(sections.indexOf(ours.section) + 1, 0, options);
      changed = true;
    } else {
      const seen = new Set<string>();
      options.lines = options.lines.map((line) => {
        const at = line.indexOf("=");
        const key = at > 0 ? line.slice(0, at) : "";
        if (!wanted.has(key)) return line;
        seen.add(key);
        if (line.slice(at + 1).trim() === wanted.get(key)) return line;
        changed = true;
        return `${key}=${wanted.get(key)}`;
      });
      const missing = [...wanted].filter(([key]) => !seen.has(key)).map(([key, value]) => `${key}=${value}`);
      if (missing.length) {
        const end = options.lines.length && options.lines[options.lines.length - 1] === "" ? options.lines.length - 1 : options.lines.length;
        options.lines.splice(end, 0, ...missing);
        changed = true;
      }
    }
    if (!changed) return { name: spec.name, change: "unchanged" };
    await writeFile(file, render(preamble, sections));
    return { name: spec.name, change: "updated" };
  }

  let next = presets.reduce((max, { index }) => Math.max(max, Number(index) + 1), 0);
  const added: Section[] = [];
  const hasSummerGames = presets.some(({ section }) => stringValue(section, "platform") === SUMMER_GAMES_PLATFORM);
  if (spec.platform === SUMMER_GAMES_PLATFORM && !hasSummerGames) {
    // Keep the engine's default "summer.games" preset: it leaves the editor
    // once the file holds any summer.games preset. No options section, so the
    // engine fills in its own defaults.
    added.push({
      header: `preset.${next}`,
      lines: presetLines({ name: SUMMER_GAMES_PRESET, platform: SUMMER_GAMES_PLATFORM, customFeatures: SUMMER_CLIENT_FEATURE, options: {} }),
    });
    next += 1;
  }
  added.push({ header: `preset.${next}`, lines: presetLines(spec) });
  added.push({ header: `preset.${next}.options`, lines: optionLines(spec.options) });
  await writeFile(file, render(preamble, [...sections, ...added]));
  return { name: spec.name, change: "created" };
}

function render(preamble: string[], sections: Section[]): string {
  const body = sections.map((section) => [`[${section.header}]`, ...section.lines].join("\n")).join("\n");
  const head = preamble.join("\n");
  const joined = head.trim() ? `${head.replace(/\n*$/, "\n")}\n${body}` : body;
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}
