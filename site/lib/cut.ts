/**
 * Cuts, never rewrites: every string on the page is a deck string from content/deck.ts or a cut of one,
 * checked here at build. `upTo` keeps the text before `marker`; `after` keeps the text after it; `first`, `from`
 * and `nth` cut whole sentences.
 * A marker that is not in the deck string is a build error.
 */
export function upTo(text: string, marker: string): string {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`cut marker not in deck string: ${marker}`);
  return text.slice(0, i);
}

export function after(text: string, marker: string): string {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`cut marker not in deck string: ${marker}`);
  return text.slice(i + marker.length);
}

/** A substring the deck string contains, byte for byte; anything else is a build error. */
export function part(text: string, piece: string): string {
  if (!text.includes(piece)) throw new Error(`not a cut of the deck string: ${piece}`);
  return piece;
}

/** The ` · `-joined parts of a figures line. */
export function parts(text: string): string[] {
  return text.split(" · ");
}

/** One deck row by index; the deck is data, so a missing row is a build error, never an empty line. */
export function row<T>(rows: readonly T[], i: number): T {
  const r = rows[i];
  if (r === undefined) throw new Error(`deck row ${i} missing`);
  return r;
}

/**
 * Whole-sentence cuts: a sentence ends at a full stop followed by a space or the end; a full stop inside a
 * figure (2.0.0, $0.05) or before a closing quote ("night.") does not end one.
 */
function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "." && (i === text.length - 1 || text[i + 1] === " ")) {
      out.push(text.slice(start, i + 1));
      start = i + 2;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

export function first(text: string, n: number): string {
  const s = sentences(text);
  if (s.length < n) throw new Error(`fewer than ${n} sentences: ${text}`);
  return s.slice(0, n).join(" ");
}

export function from(text: string, index: number): string {
  const s = sentences(text);
  if (s.length <= index) throw new Error(`no sentence ${index}: ${text}`);
  return s.slice(index).join(" ");
}

export function nth(text: string, index: number): string {
  const s = sentences(text)[index];
  if (s === undefined) throw new Error(`no sentence ${index}: ${text}`);
  return s;
}
