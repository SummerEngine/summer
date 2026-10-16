/**
 * A small JSON Schema checker for the Summer Router registry schemas
 * (schemas.character, schemas.settings). It covers the keywords the
 * registry uses: type, enum, const, required, properties,
 * additionalProperties, propertyNames, min/maxProperties, items,
 * maxItems, uniqueItems, minLength, maxLength, pattern, minimum, maximum
 * and anyOf. Other keywords are ignored: the platform validates every
 * document again on push and is the final word.
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaIssue {
  /** JSON Pointer to the value, "" for the document itself. */
  path: string;
  message: string;
}

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
};

const pointer = (base: string, key: string | number) =>
  `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

const show = (value: unknown) => JSON.stringify(value);

export function validateSchema(value: unknown, schema: JsonSchema, path = ""): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const fail = (message: string, at = path) => issues.push({ path: at, message });

  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf as JsonSchema[];
    if (!options.some((option) => validateSchema(value, option, path).length === 0)) {
      fail("does not match any allowed shape");
    }
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    fail(`must be ${show(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    fail(`must be one of ${schema.enum.map(show).join(", ")}`);
  }
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) {
    fail(`must be ${schema.type === "integer" ? "a whole number" : `a${/^[aeiou]/.test(schema.type) ? "n" : ""} ${schema.type}`}`);
    return issues;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      fail(schema.minLength === 1 ? "must not be empty" : `must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      fail(`must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      fail(`must match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`must be ${schema.minimum} or more`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`must be ${schema.maximum} or less`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      fail("must not repeat an item");
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => issues.push(...validateSchema(item, schema.items as JsonSchema, pointer(path, index))));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) fail(`is required`, pointer(path, key));
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      fail(`must have at most ${schema.maxProperties} entries`);
    }
    for (const key of keys) {
      const at = pointer(path, key);
      if (schema.propertyNames && typeof schema.propertyNames === "object") {
        for (const issue of validateSchema(key, schema.propertyNames as JsonSchema, at)) {
          fail(`name ${show(key)} ${issue.message}`, at);
        }
      }
      if (key in properties) {
        issues.push(...validateSchema(object[key], properties[key], at));
      } else if (schema.additionalProperties === false) {
        fail(`is not a known field`, at);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        issues.push(...validateSchema(object[key], schema.additionalProperties as JsonSchema, at));
      }
    }
  }

  return issues;
}
