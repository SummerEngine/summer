#!/usr/bin/env node
/**
 * Compile the engine's class-reference XML (doc/classes/*.xml plus every
 * modules/<mod>/doc_classes/*.xml) into one compact gzipped JSON asset the
 * summer_api_docs MCP tool serves offline: assets/api-docs.json.gz.
 *
 * Reads the engine checkout named by argv[1] or SUMMER_ENGINE_ROOT (default: a
 * sibling ../summerengine); the generated asset is committed and ships with the
 * npm package.
 * Long descriptions are stripped to the first sentence on purpose — the tool
 * is a signature/property lookup, not a manual mirror.
 *
 * Usage: node scripts/build-api-docs.mjs [/path/to/summerengine]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = resolve(
  process.argv[2] ?? process.env.SUMMER_ENGINE_ROOT ?? resolve(packageRoot, "..", "summerengine")
);
const outPath = join(packageRoot, "assets", "api-docs.json.gz");

function xmlDirs() {
  const dirs = [join(engineRoot, "doc", "classes")];
  const modulesRoot = join(engineRoot, "modules");
  if (existsSync(modulesRoot)) {
    for (const mod of readdirSync(modulesRoot)) {
      const docDir = join(modulesRoot, mod, "doc_classes");
      if (existsSync(docDir)) dirs.push(docDir);
    }
  }
  return dirs.filter(existsSync);
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip the class-reference bbcode down to plain text. */
function cleanText(text) {
  return decodeEntities(text)
    .replace(/\[codeblocks?\][\s\S]*?\[\/codeblocks?\]/g, "")
    .replace(/\[gdscript\][\s\S]*?\[\/gdscript\]/g, "")
    .replace(/\[csharp\][\s\S]*?\[\/csharp\]/g, "")
    .replace(/\[code(?:\s[^\]]*)?\]([\s\S]*?)\[\/code\]/g, "$1")
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/g, "$1")
    .replace(/\[(?:member|method|constant|signal|param|enum|annotation|theme_item|constructor|operator)\s+([^\]]+)\]/g, "$1")
    .replace(/\[\/?(?:b|i|u|s|kbd|center|br|lb|rb|code)\]/g, "")
    .replace(/\[([A-Za-z_@][A-Za-z0-9_.]*)\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** First sentence, capped — the tool is a lookup, not the manual. */
function oneLine(text, cap = 220) {
  const clean = cleanText(text);
  if (!clean) return "";
  const match = clean.match(/^.*?[.!?](?=\s|$)/);
  const sentence = match ? match[0] : clean;
  return sentence.length > cap ? sentence.slice(0, cap - 1).trimEnd() + "…" : sentence;
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : undefined;
}

/** All <tag ...>...</tag> (or self-closing) blocks inside a section. */
function blocks(section, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, "g");
  let match;
  while ((match = re.exec(section)) !== null) {
    out.push({ attrs: match[1], body: match[3] ?? "" });
  }
  return out;
}

function sectionOf(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : "";
}

function descriptionOf(body) {
  const match = body.match(/<description>([\s\S]*?)<\/description>/);
  return match ? oneLine(match[1]) : "";
}

function paramsOf(body) {
  const params = [];
  const re = /<param\s+([^>]*?)\/>/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const name = attr(match[1], "name") ?? "arg";
    const type = attr(match[1], "type") ?? "Variant";
    const def = attr(match[1], "default");
    params[Number(attr(match[1], "index") ?? params.length)] =
      `${name}: ${type}` + (def !== undefined ? ` = ${def}` : "");
  }
  return params.filter(Boolean);
}

function parseClass(xml) {
  const header = xml.match(/<class\b[^>]*>/);
  if (!header) return null;
  const name = attr(header[0], "name");
  if (!name) return null;

  const entry = { inherits: attr(header[0], "inherits") ?? null };
  const briefMatch = xml.match(/<brief_description>([\s\S]*?)<\/brief_description>/);
  entry.brief = briefMatch ? oneLine(briefMatch[1]) : "";

  const properties = blocks(sectionOf(xml, "members"), "member")
    .map(({ attrs, body }) => {
      const prop = {
        name: attr(attrs, "name"),
        type: attr(attrs, "type") ?? "Variant",
      };
      const def = attr(attrs, "default");
      if (def !== undefined) prop.default = def;
      const desc = oneLine(body);
      if (desc) prop.desc = desc;
      return prop;
    })
    .filter((prop) => prop.name);
  if (properties.length) entry.properties = properties;

  const methods = blocks(sectionOf(xml, "methods"), "method")
    .map(({ attrs, body }) => {
      const name = attr(attrs, "name");
      if (!name) return null;
      const ret = body.match(/<return\s+type="([^"]*)"/);
      const qualifiers = attr(attrs, "qualifiers");
      const method = {
        sig:
          `${name}(${paramsOf(body).join(", ")}) -> ${ret ? decodeEntities(ret[1]) : "void"}` +
          (qualifiers ? ` [${qualifiers}]` : ""),
      };
      const desc = descriptionOf(body);
      if (desc) method.desc = desc;
      return method;
    })
    .filter(Boolean);
  if (methods.length) entry.methods = methods;

  const signals = blocks(sectionOf(xml, "signals"), "signal")
    .map(({ attrs, body }) => {
      const name = attr(attrs, "name");
      if (!name) return null;
      const signal = { sig: `${name}(${paramsOf(body).join(", ")})` };
      const desc = descriptionOf(body);
      if (desc) signal.desc = desc;
      return signal;
    })
    .filter(Boolean);
  if (signals.length) entry.signals = signals;

  const constants = blocks(sectionOf(xml, "constants"), "constant")
    .map(({ attrs }) => {
      const name = attr(attrs, "name");
      if (!name) return null;
      const constant = { name, value: attr(attrs, "value") ?? "" };
      const enumName = attr(attrs, "enum");
      if (enumName) constant.enum = enumName;
      return constant;
    })
    .filter(Boolean);
  if (constants.length) entry.constants = constants;

  return { name, entry };
}

const classes = {};
let files = 0;
for (const dir of xmlDirs()) {
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".xml")) continue;
    const parsed = parseClass(readFileSync(join(dir, file), "utf8"));
    if (!parsed) continue;
    classes[parsed.name] = parsed.entry;
    files += 1;
  }
}

if (files === 0) {
  console.error(`No class XML found under ${engineRoot} — pass the engine checkout path or set SUMMER_ENGINE_ROOT.`);
  process.exit(1);
}

// Stamp the asset with the engine technical base it was generated from
// (repository compatibility contract) so summer_api_docs can name its source
// version instead of leaving "which engine is this reference for?" implicit.
function technicalBase() {
  const manifestPath = join(engineRoot, "compatibility", "summer-engine.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = manifest?.upstreamBase?.current?.version;
  if (typeof version !== "string" || version.length === 0) {
    console.error(`No upstreamBase.current.version in ${manifestPath}.`);
    process.exit(1);
  }
  return version;
}

const json = JSON.stringify({
  generated_from: `${files} class reference files`,
  technical_base: technicalBase(),
  classes,
});
mkdirSync(dirname(outPath), { recursive: true });
const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
writeFileSync(outPath, gz);
console.log(
  `api-docs: ${files} classes -> ${outPath} (${(json.length / 1024 / 1024).toFixed(2)}MB json, ${(gz.length / 1024).toFixed(0)}KB gz)`
);
