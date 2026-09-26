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
