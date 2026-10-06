import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * C2-hands-copy: the site's Hands h2 said "Label first. Click second. / Screenshot last." The engine does not keep that
 * order. A delegation usually starts with the eyes' pre-warm screenshot, which gives the brain the screen (engine.ts
 * lookAtScreen; none when the brain is Live's own Responses delegation or cannot take pixels, or the hands are not
 * there; engine brain-select.test.ts:565 pins it), and a click by coordinates aims at the latest screenshot. The hands
 * still find a control by its label before they click it, so the h2 keeps "Label first. Click second." and gives the
 * screenshot no fixed place: "Screenshots when they help." The README's Hands sentence said "screenshot only to verify"
 * for the same reason and is reworded to match. The page lights the h2 in three steps (label, click, shot), each a cut of
 * the deck's words (site/lib/cut.ts), so the cuts must put the h2 back together byte for byte.
 *
 * The engine's behaviour is pinned by the engine's own tests, not here: these checks read only the words and the cuts.
 * The deck and the cuts load at run time by path: site/content/deck.ts imports through the site's `@/` alias, which the
 * root typecheck does not map. Importing deck.ts also runs its own runtime assertion (the install one-liner's runs).
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const load = async (rel: string): Promise<unknown> => import(pathToFileURL(join(ROOT, rel)).href);

interface Story {
  readonly h2: readonly [string, string];
  readonly lead: string;
  readonly lines: readonly string[];
}
type Cut = (text: string, arg: never) => string;

async function hands(): Promise<Story> {
  const deck = (await load("site/content/deck.ts")) as { HANDS: Story };
  return deck.HANDS;
}

/** Whole sentences, cut where site/lib/cut.ts cuts them: a full stop before a space or the end. */
function sentences(text: string): string[] {
  return text.split(/(?<=\.)\s+/).filter((s) => s.length > 0);
}

/** A sentence that puts the screenshot in a fixed place or makes it the only use: last, third, finally, only. */
const FIXED_PLACE = /\b(last|third|finally|only)\b/i;

test("C2: no Hands sentence on the site puts the screenshot last or alone, and the h2 still opens on the label", async () => {
  const HANDS = await hands();
  const said = [...HANDS.h2, HANDS.lead, ...HANDS.lines].flatMap(sentences);
  for (const s of said) {
    if (!/screenshot/i.test(s)) continue;
    assert.doesNotMatch(s, FIXED_PLACE, `a Hands sentence puts the screenshot last or alone: "${s}"`);
  }
  // The idea stays: the label comes first, and the h2 still has a screenshot sentence for the shot step to light.
  assert.equal(sentences(HANDS.h2[0])[0], "Label first.", "the h2 opens on the label");
  assert.match(HANDS.h2[1], /screenshot/i, "the h2's second line is about the screenshot");
});

test("C2: the README's Hands sentence, the deck's source, finds by label and clicks, and puts the screenshot last or alone nowhere", () => {
  const bullet = read("README.md")
    .split("\n")
    .find((l) => l.includes("**Uses the Mac.**"));
  assert.ok(bullet, "README.md has the Uses the Mac bullet");
  const said = sentences(bullet);
  for (const s of said) {
    if (!/screenshot/i.test(s)) continue;
    assert.doesNotMatch(s, FIXED_PLACE, `a README Hands sentence puts the screenshot last or alone: "${s}"`);
  }
  assert.ok(said.some((s) => /screenshot/i.test(s)), "the bullet still says where screenshots come in");
  // The h2's first line comes from here: the hands find a control by its label, then click it.
  assert.ok(said.includes("The hands are AX-first: find a control by label, read the focused text, click the element."), "the hands find by label, then click");
});

test("C2: the Hands h2 follows the deck's rules: short whole sentences, no em dash, no exclamation", async () => {
  const HANDS = await hands();
  for (const line of HANDS.h2) {
    assert.match(line, /\.$/, `an h2 line ends on a full stop: "${line}"`);
    assert.doesNotMatch(line, /[—!()]/, `no em dash, exclamation or parenthesis: "${line}"`);
    assert.ok(line.split(/\s+/).length <= 6, `an h2 line is six words at most: "${line}"`);
  }
});

test("C2: page.tsx's three lit steps are cuts of the Hands h2 that put it back together, in the order the demo plays", async () => {
  const HANDS = await hands();
  const cut = (await load("site/lib/cut.ts")) as Record<"nth" | "first" | "from" | "upTo" | "after" | "part", Cut>;
  const page = read("site/app/page.tsx");
  const m = /const HANDS_STEPS = \[([^\n]*)\] as const;/.exec(page);
  assert.ok(m?.[1], "page.tsx declares HANDS_STEPS on one line");
  const steps = new Function("HANDS", "nth", "first", "from", "upTo", "after", "part", `return [${m[1]}];`)(
    HANDS,
    cut.nth,
    cut.first,
    cut.from,
    cut.upTo,
    cut.after,
    cut.part,
  ) as string[];
  assert.equal(steps.length, 3, "three steps: label, click, shot");
  // The h2's JSX: line 1 is the label step, a space, the click step; line 2 is the shot step.
  assert.equal(`${steps[0]} ${steps[1]}`, HANDS.h2[0], "the label and click steps are the h2's first line");
  assert.equal(steps[2], HANDS.h2[1], "the shot step is the h2's second line");
  const order = [...page.matchAll(/data-n="(\w+)">\s*\{HANDS_STEPS\[(\d)\]\}/g)].map((x) => `${x[1]}:${x[2]}`);
  assert.deepEqual(order, ["label:0", "click:1", "shot:2"], "each step's span shows its own cut");
});
