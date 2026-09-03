/**
 * Minimal, strict JSON Schema validator for registry/schemas/.
 *
 * Deliberately supports only the keyword subset those schemas use and THROWS
 * on any unknown keyword, so the schema files stay the single normative
 * source (CONTRACT.md §5) and nothing is ever silently skipped.
 *
 * Supported: $ref (file, #/fragment, file#/fragment), allOf, oneOf, anyOf,
 * const, enum, type, properties, required, additionalProperties (bool or
 * schema), unevaluatedProperties (false), dependentRequired, items, minItems,
 * maxItems, uniqueItems, pattern, minLength, maxLength, minProperties.
 * Ignored metadata: $id, $schema, title, description, comment, $defs.
 *
 * One deliberate extension: a $ref that resolves to a JSON *array* (not a
 * schema object) is a controlled vocabulary — the value must equal one of its
 * members. registry/schemas/domains.json holds these lists so the vocabulary
 * stays a plain, PR-reviewable file rather than an enum duplicated into the
 * schema; the error names the file to grow.
 */

export interface SchemaError {
  path: string;
  message: string;
}

export type JsonSchema = Record<string, unknown>;

export type SchemaStore = Map<string, JsonSchema>;

const METADATA_KEYWORDS = new Set(["$id", "$schema", "title", "description", "comment", "$defs"]);

const SUPPORTED_KEYWORDS = new Set([
  "$ref",
  "allOf",
  "oneOf",
  "anyOf",
  "const",
  "enum",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "dependentRequired",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "minLength",
  "maxLength",
  "minProperties",
]);

interface Ctx {
  store: SchemaStore;
  doc: JsonSchema; // document root for "#/..." fragment refs
}

interface Vocabulary {
  /** schema document the list lives in, e.g. "domains.json" */
  file: string;
  /** singular noun for messages, from the fragment's last segment: domains -> domain */
  term: string;
  values: string[];
}

type RefTarget =
  | { kind: "schema"; schema: JsonSchema; doc: JsonSchema }
  | { kind: "vocabulary"; vocabulary: Vocabulary };

function singular(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

interface Result {
  errors: SchemaError[];
  /** Property names of `data` matched by properties/additionalProperties in
   * this schema or any subschema it composes (for unevaluatedProperties). */
  evaluated: Set<string>;
}

function typeOf(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return "array";
  return typeof data; // object, string, number, boolean
}

function resolveRef(ref: string, ctx: Ctx): RefTarget {
  let doc = ctx.doc;
  let fragment = "";
  let file = ref;
  const hash = ref.indexOf("#");
  if (hash >= 0) {
    file = ref.slice(0, hash);
    fragment = ref.slice(hash + 1);
  }
  if (file !== "") {
    const found = ctx.store.get(file);
    if (!found) throw new Error(`schema $ref to unknown document: ${file}`);
    doc = found;
  }
  let node: unknown = doc;
  const parts = fragment !== "" && fragment !== "/" ? fragment.replace(/^\//, "").split("/") : [];
  for (const part of parts) {
    if (typeOf(node) !== "object") throw new Error(`schema $ref fragment not found: ${ref}`);
    node = (node as Record<string, unknown>)[part];
  }
  if (Array.isArray(node)) {
    // Controlled vocabulary (see header): the list itself is the schema.
    if (!node.every((v) => typeof v === "string")) {
      throw new Error(`schema $ref vocabulary must be an array of strings: ${ref}`);
    }
    return {
      kind: "vocabulary",
      vocabulary: {
        file: file !== "" ? file : String(doc.$id ?? "schema"),
        term: singular(parts[parts.length - 1] ?? "value"),
        values: node as string[],
      },
    };
  }
  if (typeOf(node) !== "object") throw new Error(`schema $ref fragment not found: ${ref}`);
  return { kind: "schema", schema: node as JsonSchema, doc };
}

function stableStringify(value: unknown): string {
  const t = typeOf(value);
  if (t === "array") return `[${(value as unknown[]).map(stableStringify).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function joinPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "" ? key : `${path}.${key}`;
}

function validateNode(data: unknown, schema: JsonSchema, path: string, ctx: Ctx): Result {
  const errors: SchemaError[] = [];
  const evaluated = new Set<string>();

  for (const keyword of Object.keys(schema)) {
    if (!METADATA_KEYWORDS.has(keyword) && !SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported JSON Schema keyword "${keyword}" — extend scripts/validate-library/json-schema.ts or fix the schema`);
    }
  }

  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, ctx);
    if (target.kind === "vocabulary") {
      const { file, term, values } = target.vocabulary;
      if (typeof data !== "string" || !values.includes(data)) {
        errors.push({
          path,
          message: `unknown ${term} ${JSON.stringify(data)}; allowed: ${values.join(", ")} (add it to registry/schemas/${file} by PR)`,
        });
      }
    } else {
      const sub = validateNode(data, target.schema, path, { store: ctx.store, doc: target.doc });
      errors.push(...sub.errors);
      for (const p of sub.evaluated) evaluated.add(p);
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf as JsonSchema[]) {
      const sub = validateNode(data, branch, path, ctx);
      errors.push(...sub.errors);
      for (const p of sub.evaluated) evaluated.add(p);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as JsonSchema[];
    const passing: Result[] = [];
    const failing: { branch: JsonSchema; result: Result }[] = [];
    for (const branch of branches) {
      const sub = validateNode(data, branch, path, ctx);
      if (sub.errors.length === 0) passing.push(sub);
      else failing.push({ branch, result: sub });
    }
    if (passing.length === 1) {
      for (const p of passing[0].evaluated) evaluated.add(p);
    } else if (passing.length === 0) {
      errors.push({ path, message: `matches none of the ${branches.length} allowed shapes (oneOf)` });
      // Surface why each shape failed, so a bad pin reports "commit: must match
      // pattern" instead of only the summary line.
      failing.forEach(({ branch, result }, i) => {
        const title = typeof branch.title === "string" ? branch.title : `shape ${i + 1}`;
        for (const e of result.errors) errors.push({ path: e.path, message: `${e.message} (oneOf: ${title})` });
      });
    } else {
      errors.push({
        path,
        message: `matches ${passing.length} of the allowed shapes (oneOf) — must match exactly one`,
      });
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    const passing = branches
      .map((branch) => validateNode(data, branch, path, ctx))
      .filter((r) => r.errors.length === 0);
    if (passing.length === 0) {
      errors.push({ path, message: `matches none of the ${branches.length} allowed shapes (anyOf)` });
    } else {
      for (const r of passing) for (const p of r.evaluated) evaluated.add(p);
    }
  }

  if ("const" in schema) {
    if (data !== schema.const) {
      errors.push({ path, message: `must be ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}` });
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).includes(data)) {
      errors.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(data)}` });
    }
  }

  if (typeof schema.type === "string") {
    const actual = typeOf(data);
    const expected = schema.type;
    const ok =
      actual === expected ||
      (expected === "integer" && actual === "number" && Number.isInteger(data));
    if (!ok) {
      errors.push({ path, message: `must be of type ${expected}, got ${actual}` });
      return { errors, evaluated }; // type mismatch: skip shape keywords
    }
  }

  const dataType = typeOf(data);

  if (dataType === "string") {
    const str = data as string;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(str)) {
      errors.push({ path, message: `must match pattern ${schema.pattern}, got ${JSON.stringify(str)}` });
    }
    if (typeof schema.minLength === "number" && str.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} character(s), got ${str.length}` });
    }
    if (typeof schema.maxLength === "number" && str.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters, got ${str.length}` });
    }
  }

  if (dataType === "array") {
    const arr = data as unknown[];
    if (typeof schema.minItems === "number" && arr.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} item(s), got ${arr.length}` });
    }
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} item(s), got ${arr.length}` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (let i = 0; i < arr.length; i++) {
        const key = stableStringify(arr[i]);
        if (seen.has(key)) errors.push({ path: joinPath(path, i), message: "duplicate item in array (uniqueItems)" });
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < arr.length; i++) {
        const sub = validateNode(arr[i], schema.items as JsonSchema, joinPath(path, i), ctx);
        errors.push(...sub.errors);
      }
    }
  }

  if (dataType === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      errors.push({ path, message: `must have at least ${schema.minProperties} propert${schema.minProperties === 1 ? "y" : "ies"}, got ${keys.length}` });
    }

    if (Array.isArray(schema.required)) {
      for (const req of schema.required as string[]) {
        if (!(req in obj)) errors.push({ path, message: `missing required field "${req}"` });
      }
    }

    if (schema.dependentRequired && typeOf(schema.dependentRequired) === "object") {
      for (const [trigger, deps] of Object.entries(schema.dependentRequired as Record<string, string[]>)) {
        if (trigger in obj) {
          for (const dep of deps) {
            if (!(dep in obj)) {
              errors.push({ path, message: `field "${trigger}" requires field "${dep}" to also be present` });
            }
          }
        }
      }
    }

    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [name, propSchema] of Object.entries(props)) {
      evaluated.add(name);
      if (name in obj) {
        const sub = validateNode(obj[name], propSchema, joinPath(path, name), ctx);
        errors.push(...sub.errors);
      }
    }

    if (schema.additionalProperties !== undefined) {
      const extra = keys.filter((k) => !(k in props));
      if (schema.additionalProperties === false) {
        for (const k of extra) {
          errors.push({ path: joinPath(path, k), message: "unknown field (additionalProperties: false)" });
        }
      } else if (typeOf(schema.additionalProperties) === "object") {
        for (const k of extra) {
          evaluated.add(k);
          const sub = validateNode(obj[k], schema.additionalProperties as JsonSchema, joinPath(path, k), ctx);
          errors.push(...sub.errors);
        }
      }
    }

    if (schema.unevaluatedProperties === false) {
      for (const k of keys) {
        if (!evaluated.has(k)) {
          errors.push({ path: joinPath(path, k), message: "unknown field (not defined by this kind's schema or the universal resource schema)" });
        }
      }
    }
  }

  return { errors, evaluated };
}

export function validateAgainstSchema(data: unknown, schema: JsonSchema, store: SchemaStore): SchemaError[] {
  return validateNode(data, schema, "", { store, doc: schema }).errors;
}
