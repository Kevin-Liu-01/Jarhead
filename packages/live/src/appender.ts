/**
 * Every append channel is capped at 500 tokens. A brain that has just read a
 * whole web page must not try to hand it over in one go — Live rejects it and
 * Kevin hears nothing. Split at sentence boundaries into chunks that fit, and
 * estimate tokens conservatively (chars / 3.2) so we never sit exactly on the cap.
 */

export const APPEND_TOKEN_CAP = 500;
const CHARS_PER_TOKEN = 3.2;
export const APPEND_CHAR_BUDGET = Math.floor(APPEND_TOKEN_CAP * CHARS_PER_TOKEN * 0.9); // ~1440

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function chunkForAppend(text: string, budget = APPEND_CHAR_BUDGET): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= budget) return [clean];

  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > budget) {
      if (current) chunks.push(current.trim());
      current = "";
      for (let i = 0; i < s.length; i += budget) chunks.push(s.slice(i, i + budget).trim());
      continue;
    }
    if ((current + s).length > budget) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
