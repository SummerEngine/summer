/**
 * Read a fetch Response body once and try to parse it as JSON.
 *
 * `parsed` is false when the body is empty or not valid JSON; callers decide
 * what that means (a typed error for the creator API, a lenient
 * `{message}` for Studio generation). Tolerates Response doubles that only
 * implement `.json()` (test fakes) by falling back to it.
 */
export async function readJsonResponse(
  res: Response
): Promise<{ text: string; json: unknown; parsed: boolean }> {
  if (typeof res.text !== "function") {
    if (typeof res.json === "function") {
      const json = await res.json().catch(() => undefined);
      return json === undefined
        ? { text: "", json: undefined, parsed: false }
        : { text: JSON.stringify(json), json, parsed: true };
    }
    return { text: "", json: undefined, parsed: false };
  }
  const text = await res.text().catch(() => "");
  if (!text) return { text, json: undefined, parsed: false };
  try {
    return { text, json: JSON.parse(text), parsed: true };
  } catch {
    return { text, json: undefined, parsed: false };
  }
}
