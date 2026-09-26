/**
 * Cuts, never rewrites: every string on the page is a deck string from content/* or a cut of one,
 * checked here at build. `upTo` keeps the text before `marker`; `after` keeps the text after it;
 * `sentence` keeps the prefix and restores the deck's own full stop when the cut lands mid-sentence;
 * `head` keeps the text before the first of the deck's own joiners (the whole string when none);
 * `join` sets two cuts with the deck's ` · `. A marker that is not in the deck string is a build error.
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

export function sentence(text: string, marker: string): string {
  const head = upTo(text, marker);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

export function head(text: string, markers: readonly string[] = [" · ", ", "]): string {
  const cuts = markers.map((m) => text.indexOf(m)).filter((i) => i >= 0);
  return cuts.length ? text.slice(0, Math.min(...cuts)) : text;
}

export function join(a: string, b: string): string {
  return `${a} · ${b}`;
}

/** One deck row by index; the deck is data, so a missing row is a build error, never an empty line. */
export function row<T>(rows: readonly T[], i: number): T {
  const r = rows[i];
  if (r === undefined) throw new Error(`deck row ${i} missing`);
  return r;
}

/** A deck string that the layout needs; an optional field that is absent is a build error, never an empty tip. */
export function need(text: string | undefined): string {
  if (text === undefined) throw new Error("deck string missing");
  return text;
}

/**
 * Whole-sentence cuts (the copy editor's rule: a cut drops whole sentences from the front or the back and keeps
 * the rest byte for byte). A sentence ends at a full stop followed by a space or the end; a full stop inside a
 * figure (2.0.0, $0.05) or before a closing quote ("night.") does not end one.
 */
export function sentences(text: string): string[] {
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

/** The first `n` sentences. */
export function first(text: string, n: number): string {
  const s = sentences(text);
  if (s.length < n) throw new Error(`fewer than ${n} sentences: ${text}`);
  return s.slice(0, n).join(" ");
}

/** The sentences from `index` on (a suffix cut). */
export function from(text: string, index: number): string {
  const s = sentences(text);
  if (s.length <= index) throw new Error(`no sentence ${index}: ${text}`);
  return s.slice(index).join(" ");
}

/** One sentence by index. */
export function nth(text: string, index: number): string {
  const s = sentences(text)[index];
  if (s === undefined) throw new Error(`no sentence ${index}: ${text}`);
  return s;
}
