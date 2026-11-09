import { BATCH_EDIT_TOOLS, SINGLE_EDIT_TOOLS } from "./tool-surface.js";
import { signInKindForCode, signInLinkText, type SignInKind } from "../core/sign-in-link.js";

type Content = { type?: string; text?: unknown };

/** Pretty-printed JSON text as compact JSON; anything else unchanged. */
export function compactJsonText(text: string): string {
  const first = text[0];
  if ((first !== "{" && first !== "[") || !text.includes("\n")) return text;
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/** The library read's last line (the feedback footer) survives a cut. */
const KEEP_LAST_LINE = /\n(— entry_id: [^\n]*)\s*$/;

/** Cut text blocks to maxCharacters in total, with one note saying how to get the rest. */
export function capText(content: Content[], maxCharacters: number): Content[] {
  const total = content.reduce((sum, part) => sum + (part.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0);
  if (total <= maxCharacters) return content;
  const note = `\n\n[Truncated: ${maxCharacters} of ${total} characters shown. Call again with maxCharacters: ${total} for all of it, or narrow the request.]`;
  let budget = maxCharacters;
  let cut = false;
  const out: Content[] = [];
  for (const part of content) {
    if (part.type !== "text" || typeof part.text !== "string") {
      out.push(part);
      continue;
    }
    if (cut) continue;
    if (part.text.length <= budget) {
      budget -= part.text.length;
      out.push(part);
      continue;
    }
    const footer = part.text.match(KEEP_LAST_LINE)?.[1];
    out.push({ ...part, text: part.text.slice(0, budget) + note + (footer ? `\n\n${footer}` : "") });
    cut = true;
  }
  return out;
}

/**
 * The text an agent gets: compact JSON, cut at maxCharacters when the tool
 * is capped, plus an optional hint line. Images and error flags are kept.
 */
export function shapeToolResult(
  result: unknown,
  options: { maxCharacters?: number; hint?: string | null }
): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return result;
  const original = result as { content: Content[] };
  let content = original.content.map((part) =>
    part && part.type === "text" && typeof part.text === "string" ? { ...part, text: compactJsonText(part.text) } : part
  );
  if (options.maxCharacters !== undefined) content = capText(content, options.maxCharacters);
  if (options.hint) content = [...content, { type: "text", text: options.hint }];
  return { ...original, content };
}

/** The first single edit in a row that gets the hint, and how often it repeats after that. */
export const SINGLE_EDIT_HINT_AT = 4;
const SINGLE_EDIT_HINT_EVERY = 6;

/**
 * Counts successful single scene edits since the last batched edit
 * (summer_run_script, summer_batch, summer_run_editor_script). Reads in
 * between do not break the run. Returns the hint on the 4th edit in a row,
 * then every 6th.
 */
export function singleEditCounter(): (tool: string, isError: boolean) => string | null {
  let run = 0;
  return (tool, isError) => {
    if (BATCH_EDIT_TOOLS.has(tool)) {
      run = 0;
      return null;
    }
    if (isError || !SINGLE_EDIT_TOOLS.has(tool)) return null;
    run += 1;
    if (run < SINGLE_EDIT_HINT_AT || (run - SINGLE_EDIT_HINT_AT) % SINGLE_EDIT_HINT_EVERY !== 0) return null;
    return `Tip: ${run} single scene edits in a row. More than 3 edits: write one summer_run_script instead (snapshot, script, diff, screenshot).`;
  };
}

/** The store sign-ins a v4 answer names in error.details.was (core/ops/cloud.ts hostedCallFailure). */
const STORE_SIGN_IN_WAS = new Set(["store_login_required", "store_login_expired"]);

/**
 * A v4 cloud answer `not_signed_in` whose cause is the store sign-in (the
 * hosted server's OAuth grant), not the Summer account: the Summer app, for
 * one, is signed in to the account, so only the store approval link helps.
 */
function storeSignInAnswer(result: { content: Content[] }): boolean {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return false;
  try {
    const parsed = JSON.parse(first.text) as { error?: { code?: unknown; details?: { was?: unknown } } } | null;
    const error = parsed?.error;
    return error?.code === "not_signed_in" && typeof error.details?.was === "string" && STORE_SIGN_IN_WAS.has(error.details.was);
  } catch {
    return false;
  }
}

/**
 * A `not_signed_in` / `store_login_required` answer gets one more text block:
 * the sign-in link for the person (core/sign-in-link.ts). Anything else, or
 * no link, leaves the result as it is. Never throws.
 */
export async function withSignInLink(
  result: unknown,
  code: string | null,
  links: { link: (kind: SignInKind) => Promise<string | null> }
): Promise<unknown> {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return result;
  const kind = storeSignInAnswer(result as { content: Content[] }) ? "store" : signInKindForCode(code);
  if (!kind) return result;
  try {
    const url = await links.link(kind);
    if (!url) return result;
    const original = result as { content: Content[] };
    const text = signInLinkText(kind, url);
    // A JSON answer gets the link inside it (signInUrl, and recovery says what
    // to do), so a caller that parses it (the v4 operation layer runs 3.x
    // tools and reads their JSON) keeps the code and passes the link on.
    const first = original.content[0];
    if (first && first.type === "text" && typeof first.text === "string") {
      try {
        const parsed: unknown = JSON.parse(first.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const answer = parsed as Record<string, unknown>;
          const nested = answer.error && typeof answer.error === "object" ? (answer.error as Record<string, unknown>) : null;
          const target = nested && typeof nested.code === "string" ? nested : answer;
          target.signInUrl = url;
          target.recovery = text;
          return { ...original, content: [{ ...first, text: JSON.stringify(answer) }, ...original.content.slice(1)] };
        }
      } catch {
        // plain text: the link goes in its own block below
      }
    }
    return { ...original, content: [...original.content, { type: "text", text }] };
  } catch {
    return result;
  }
}
