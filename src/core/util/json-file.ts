/**
 * Reading JSON files people edit. Windows PowerShell 5 (`Set-Content
 * -Encoding utf8`, `Out-File -Encoding utf8`) and several Windows editors
 * start a UTF-8 file with a byte order mark, which JSON.parse rejects.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** JSON.parse for the text of a file: a leading byte order mark is not an error. */
export function parseJsonText(text: string): unknown {
  return JSON.parse(stripBom(text));
}
