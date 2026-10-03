> HISTORY (retired 2026-10-02). The 2.5D stack this file describes is gone from the page; the law for the drawings is
> `DIAGRAM-STYLE.md`. Kept to show what was tried; never draw from it.

# ART-STYLE · THE 2.5D STACK, FILLED, THE BLOB IN IT (the law for the section pictures, 2026-10-01, round two, finished)

The system every section picture is drawn in. All of the page's drawings are finished: `components/art/{Wake,Say,Hands,
Rails,Sleep,Numbers,Costs}.tsx`, from `components/art/parts.tsx`. Threads is not an art drawing: it is the Console window
drawn with the kit (`components/site/ConsoleWindow.tsx`), and Rails shares its frame with the NEVER list in HTML
(`components/site/RailsPicture.tsx`). Wake and Sleep no longer draw the Mac's top edge (§7.7). Where this page and a
picture disagree, this page wins and the picture is fixed; `docs/DESIGN.md` is the page around the pictures. ART.md's non-negotiables, CENTER.md, IMMERSE.md and COPY.md stand under it.

How it got here. Round one (Kevin): competent small diagrams, too much air, nothing memorable. Round two drew three systems;
the judges chose FILL (the stack at a scale that reaches the frame's edges) and grafted into it what the others did better:
the blob drawn as a character in the pictures that are about it (Wake, Threads), the split in Threads drawn as one blob
becoming three along `Flow`s rather than three blobs listed, the notch at the Mac's own proportion, `Ring`, `Flow` and
`Fingerprint` as named parts, the axis at the line law's 1.5, and the element cap enforced by `Art` rather than remembered.
Declined, with the reasons in §11: the five gate orbs back into Wake, a menu bar or an Apple mark in every picture, the
values moved to the bars' heads in Numbers, an orb in Numbers.

## 1 · The idea in one paragraph

A picture is a shallow stack of plates standing on the frame's ground, and the stack FILLS the frame. A plate is a rounded
rect or a disc whose top face is a flat fill with a 1.5-unit stroke; it is offset along the 1:2 diagonal, so at depth 8 its
back copy sits 4 right and 8 down, and the side faces that show are drawn with nothing but a dithered band: the 8×8 Bayer
ranks at 2-unit cells, titanium cells over the plate's own fill. No shadow, no gradient, no blur, no opacity. The section's
phase colour is the lit face: the one thing the section is about wears the accent as a flat top with accent cells down its
sides. The blob is the real orb, `renderOrb` at 2× into a PNG, at 96 as the picture's character and at 64 as a thread of it
at the end of a `Flow`; it is in every picture that is about the blob and absent from a measure. Words are the deck's, six
at most, Inter 13; values are mono 13. Colours are `--jh-*` tokens only, so dark and light come from `html[data-theme]`
with no JS. Whatever is flat (a track, a stratum, a tick, a wave, a flow) is flat on purpose: it is ground, scale, sound or
movement, never a thing that stands. The four FILL rules:

1. **The subject spans the frame.** Within `MARGIN` (16 units) of every edge: the leftmost thing starts by x 16, the
   rightmost reaches x 404, the top by y 16, the foot to y 299 (side bands included). The Mac's top edge runs from 0.
   Less margin is allowed (a side band may run to 408); more is not. Every picture reads `MARGIN` and `W` for its edges.
2. **At most `ELEMENTS` (five) per picture, and `Art` counts them.** An element is one thing the eye counts: a stratum, a
   wave, the blob, a key, a lane, a split, a chart, a terminal. Every part of a picture is written inside an `<El name>`;
   `Art` throws past five and at zero. What does not fit is dropped, never shrunk; what is dropped goes to the section's
   rail rows (the five gate states live in `WakeRail`, which folds into the section under 1240 px, so the phone sees them).
3. **Nothing under the FILL scale.** Orb 96 or 64 (64 only as a thread at the end of a Flow); kit glyphs 28 to 30 on a
   column or at a track's head, 24 in a hole, 32 as a subject; agent marks 24 to 28; brand marks 28; values and words 13;
   tracks 36 deep; bars 34 deep; tiles 70 × 32 or larger; badges 40; holes r 17 to 18; the lip 28 with its face at 18; a
   disc subject r 82 to 100; a wave crest 140 or taller; a ring 8; a flow 10. A part that would have to go under this scale
   to fit is a sign the picture holds too many elements.
4. **No empty quadrant.** Split the frame in four: every quarter holds part of an element. Where the data leaves air
   (short bars on an honest scale) the glyph column, the values and the axis carry that quarter; where the stratum holds the
   top, the body's axis is centred in what is left (Wake's axis at 192).

## 2 · The parts (`components/art/parts.tsx`)

Server-only: the file imports `node:zlib` to deflate the orb PNG. No client component may import it or anything under
`components/art/`. `app/page.tsx` and the sections that hold the pictures (`components/site/Section.tsx`) are server components.

```ts
// the frame and the FILL constants (read by the pictures, not only documented)
export const W = 420; export const H = 315; export const DEPTH = 8;
export const MARGIN = 16;      // the most air between the subject and any edge
export const ELEMENTS = 5;     // the most elements a picture holds; Art throws past it
export const TICK = 3;         // a part under 4 units is a flat TICK; a subject glyph's ridges are TICK wide
export function kit(id: string, accent: `--jh-${string}`): Kit
  // Kit = { id; accent: "var(--jh-…)"; dither(k: Band): string; lit(k: Band): string }   Band = 1 | 2 | 3 | 4
export function Art({ k, label, height = 315, children }): svg
  // viewBox 0 0 420 height (Rails passes 200 to share its frame), width 100 %, role img, aria-label deck cuts that say what it shows (never the h2),
  // or label null: aria-hidden, its words beside it as a visually hidden .art-words list (Numbers); data-art=k.id, data-elements=n;
  // counts the El children (outer ones; arrays, fragments and plain <g> are walked, helper components are not seen through)
export function El({ name, children }): g             // one element the eye counts, <g data-element=name>; write it in the picture's own JSX

// what stands
export function Plate({ k, x, y, w, h, r = 6, d = DEPTH, fill = GROUND, lit?, band?, stroke = STROKE | false, top?: Band, children })
export function Disc({ k, cx, cy, r, d = DEPTH, fill = GROUND, lit?, band?, children })
export function Bar({ k, x, y, w, h, lit?, dissolve? })      // a slab at depth 6 on a track; under 4 units a flat TICK; dissolve = the 12-unit meter head

// what lies flat
export function Track({ x, y, w, h, r = 4 })                 // raised fill, 1 px --jh-hair, no depth: cut into the ground
export function Hole({ cx, cy, r, fill = RAISED })           // a knock-out disc of the face's own ground, so a glyph or mark sits clean over a band, a slab or an orb
export function Ring({ cx, cy, r, w = 8, color })            // a flat ring in one colour: the Touch ID ring on its key plate; never the orb's own
export function Flow({ k, d, w = 10 })                       // the halftone material (GROUND under titanium band 3) along a path d, round caps: a thread leaving the blob, a fork, a join
export function Fingerprint({ cx, cy, size = 70, color = FG, ridge = TICK })   // the Touch ID glyph, 46 × 41 box scaled to size wide, ridges `ridge` units on the page

// the orb
export function Orb({ cx, cy, size: 32 | 64 | 96 | 128, face?: "^^" | "OO" | null, quiet? })   // 96 or 64 in a section picture
// (internal) orbUri(size, face, quiet?): cached per shape; renderOrb at size × 2 px, 2 px cells, clipped to the disc, deflated

// glyphs, marks, words
export type GlyphUnits = 24 | 28 | 30 | 32;
export function G({ name: GlyphName, x, y, size = 28 (GlyphUnits), color = WORD })            // a kit glyph from its 20 box, top-left at (x, y)
export function Mark({ tool: AgentTool, x, y, size = 24 (24 | 28 | 32), quiet? })             // an agent mark, the kit's 24 drawing scaled by the group
export function Brand({ x, y, color = FG, children })        // a @thesvg/react mark at 28 pulled to one ink (site.css .art-brand path { fill: currentColor })
export function Label({ x, y, anchor?, color = WORD, size = 13 (13 | 14), children: string })  // Inter, weight 500, the baseline at y
export function Value({ x, y, anchor?, color = FG, size = 13 (13 | 14), children: string })    // mono, tabular, the baseline at y
export function FaceText({ x, y, size = 18, color = PAPER, children: string })                 // the island's mono 700 face on an ink screen piece

// colour names (all var(--jh-…))
STROKE = fg-3 · GROUND = ground · RAISED = raised · INK = ink · PAPER = paper · FG = fg · WORD = fg-2 · QUIET = fg-3-word · HAIR = hair · ERROR = error
SANS = var(--font-sans) · MONO = var(--font-mono)
// geometry helpers (internal): extrude(x, y, w, h, r, dx, dy) the side-face hull of a rounded rect; extrudeDisc(cx, cy, r, dx, dy)
```

Layer order inside `Plate` and `Disc`: side silhouette (fill, then the pattern, then its stroke) → top face → the dithered
top if `top` → the stroke → `children`. Put what sits on a plate as its children so it lands on the top face. A `Flow` is
drawn before the orbs and plates it joins, its ends tucked 8 under them so no round cap shows.

## 3 · The palette

- The frame is the picture's ground: `--jh-raised` in dark and paper in light, from `.pic` (styles/site.css). A picture never paints a full ground rect.
- A plate's top face is `--jh-ground` (ink in dark, paper in light): the island's black plate, a light card. A track is
  `--jh-raised` in a `--jh-hair` hairline. A piece of the notch (Wake's gate faces) is `--jh-desk-notch` in both themes,
  as the page's own notch is.
- Strokes are `--jh-fg-3` at 1.5 on every top face, around every side silhouette and on an axis. `--jh-plate-hair` at 1
  only on an ink screen piece (the lip). `--jh-hair` at 1 on tracks and strata.
- Dither cells are `--jh-titanium` on every side face, halftone top and flow (one material on ink and on paper); a lit
  plate's cells are the accent.
- Exactly one accent per picture, the section's phase token, named once in `kit(id, token)` and read as `k.accent`:
  `--jh-listening` Wake · Numbers · Costs; `--jh-thinking` Say; `--jh-acting` Threads · Hands; `--jh-speaking` Rails;
  `--jh-asleep` Sleep; `--jh-accent` Made · Install. The accent is worn by one object at most where the section is about a
  choice or a point (Threads' Allow, Numbers' reflex rows), and by the two halves of one idea where the section is about a
  pair (Wake's word and the key's ring). Never on a third thing. The orb's own blue is the orb's and does not count.
- `--jh-error` joins only for refuse, denied and locked, as a 24 glyph in a `Hole` (Rails' refuse row and NEVER row).
  Never on a tile's stroke or a label.
- Words `--jh-fg-2`, values `--jh-fg`, a word on a lit face `--jh-ink`, a quiet value `--jh-fg-3-word`.
- Agent marks keep their brand colour as the kit draws them (`AgentMark`); brand marks from thesvg wear `--jh-fg` through
  `Brand`. A mark is never the picture's accent.
- No hex anywhere in `components/art/`. No `color-mix`, no derived colour, no custom property of the picture's own.

## 4 · Stroke, radius, depth, dither, scale

- Stroke 1.5 on top faces, silhouettes and an axis; 1 on hairlines; `TICK` (3) for a subject-scale glyph's lines (the
  fingerprint's ridges through `Fingerprint`, which divides the stroke by its scale so the page sees 3; a clock's hands);
  the Touch ID ring 8 in the accent through `Ring`; a flow 10 through `Flow`. Nothing else is stroked.
- Radii: 8 on a rail or a window plate, 6 on a plate, tile or badge, 4 on a slab, bar or track, 14 on the lip. A radius
  never exceeds half a side (`Plate` clamps it).
- Depth 8 along (4, 8) for plates, discs and windows; 6 along (3, 6) for tiles, slabs, badges and bars. Never a third depth,
  never two depths nested more than twice. Depth does not grow with the FILL scale: an r 82 disc still stands 8 deep, so
  the stack stays shallow and the faces stay the subject.
- Bands (k of 5, k·20 % of the 64 cells on, 2-unit cells on a 16-unit grid every face shares): band 2 on a plain plate's
  sides; band 3 in the accent on a lit plate's sides; band 1 on a halftone slab's sides with band 3 on its top face; band 3
  on a flow. A top face is dithered only to mean "measured", "settled" or "a thread", never as decoration. The cells stay
  2 units at every scale: the grain is the family's signature, and a bigger face shows more of it, never bigger cells.
- The dissolving head (`Bar dissolve`): three 4-unit steps at bands 3, 2, 1 in the bar's own tone, the app's meter edge
  (lib/dither.ts renderMeter). It means "still filling". A finished bar ends square under a check; a paused bar ends at a
  badge.
- A part under 4 units is a flat `TICK` in its tone, never widened to be seen (Numbers' 3 ms). Honest scale beats a
  visible bar.
- Phone rule: a part under 24 units on a side carries `art-side--sm`; console.css hides its side faces under 396 px of frame.
  At the FILL scale no element in the three pictures is under 24, so nothing changes with width; the rule stays for a
  picture that needs a stub.

## 5 · The orb

The real one (`lib/orb.ts renderOrb`) at `size × 2` px with 2 px cells, the icon's own grain, clipped to the disc like
the kit's mark so it sits on any face, `image-rendering: pixelated`, deflated with node:zlib (a 96 orb is 7.4 KB, a 64 orb
4.5 KB). No picture on the page places the same orb twice.

- **The orb's role per picture kind.** The blob is a character, not a glyph. In a picture about the blob it is the
  character at 96: Wake (the blob that heard the word, between the wave and the key), Threads (the blob the command
  reached), Say (the blob the line leaves), Hands (the blob moving to where the hands act), Sleep (the blob asleep, quiet),
  Made (the Dock icon). A thread of it is the orb at 64 at the end of a `Flow` from the 96 (Threads' three lanes); a 64
  never stands alone. In a measure (Numbers, Costs) the orb is absent: a chart has no character in it, and where the
  picture needs "heard" the kit's `mic` or the lip's face says it. It never appears as a row marker, a state dot or a 32
  tile: where a state needs a mark the kit's glyph says it, and the five gate states are `WakeRail`'s rows. 128 stays in
  the type for a picture that is the blob alone and nothing else; none of the ten is.
- Faces: `"OO"` heard, listening, waiting; `"^^"` granted, done, speaking; `null` faceless (thinking, asleep). `quiet` is
  the titanium ramp for gate, over, denied, locked, asleep.
- A state the face cannot say is a 24 glyph or mark badged in a `Hole` at the orb's lower right, the seat scaling with the
  orb: 64 → r 17 at (cx + 20, cy + 20); 96 → r 17 at (cx + 30, cy + 30); 128 → r 18 at (cx + 40, cy + 40). The brain
  mark for "its own brain", the error glyph for denied and locked. The hole's fill is the ground the orb sits on (a tile's
  `GROUND`, the frame's `RAISED`). A 32 orb is never badged (it is never in a picture).
- The orb never gets a halo, a ring or a stroke of its own. Its state is said by its face, its ramp and its badge. The
  Touch ID `Ring` belongs to the key plate and is drawn around the fingerprint, never around the orb.
- A `Flow` leaves the orb from under its edge (start the path 8 inside the disc) and ends 8 under what it reaches, one
  cubic with both handles at the midpoint x, so three flows from one blob fan like a bracket.

## 6 · Glyphs, marks, type

- `G` draws a kit glyph (`components/kit/Glyph.tsx GLYPHS`) from its 20 box: 24 in a badge or a hole, 28 to 30 on a
  column or at a track's head, 32 only as a picture's own subject. In `WORD` by default; `FG` where it stamps a result
  (a check in a hole); `ERROR` for a refusal. `Fingerprint` is the one glyph the kit lacks and is drawn only in parts.tsx.
- `Mark` draws an agent mark at 24 in a hole or 28 on a tile. A brain that is a key is the kit `key`; a local brain is the
  Apple mark through `Brand`. Never Cursor as a brain (it is an app on this page).
- `Brand` draws a thesvg mark at 28 in one ink: the app a thread works in, the languages in Made. The kit's `ask` list
  glyph stands in for Notes. A brand mark is a nested `<svg>`: count weights nesting-aware (§10).
- No cursor arrow outside Hands (the kit's `summon` is the cursor): a reflex is the bolt `live`, the ear is `mic`.
- Type: `Label` Inter 13 weight 500; `Value` mono 13 tabular; `FaceText` mono 700 at 18 for a blob face on an ink screen
  piece. Nothing else is text, and nothing is under 13.
- Words: at most six, and every word is a string in `content/deck.ts` or a cut of one through `lib/cut.ts` (`part`, `nth`,
  `parts`, `row`, `upTo`); a value is a deck figure. The lip's face counts as a word. Nothing from `rail.ts`,
  `kit/words.ts` or the island's own strings, and no axis unit words: an axis carries marks and the values beside the bars
  carry the units. Where the app would show a word (`asks`, an app name) the picture shows the glyph or the mark instead.
  The three finished pictures carry three words in all (Allow, Deny, the face): at the FILL scale a word is rarely needed,
  because the element is big enough to say it.
- When a subject needs more than six words (Install's seven steps, Rails' seven NEVER items), the tiles carry glyphs and
  the words go to the section's rail rows; the picture may carry at most the six that matter most, or none.

## 7 · Composition

1. One subject, big: the stack reaches within `MARGIN` of every edge (§1.1), and the thing the section is about is the lit
   object or the largest plate, in front or on the axis the eye lands on. The subject covers well over 60 % of the frame.
2. At most five elements (§1.2), each an `El`. Count them before drawing; cut the sixth. A row of five small tiles is five
   elements pretending to be one: it goes to the rail.
3. A story reads left to right on one axis: cause at the left edge, the blob where it happens, the result at the right
   edge (Wake: word → blob → key; Threads: blob → flows → lanes → tracks). A measure reads top to bottom as rows.
4. Pitches at the FILL scale: lanes of 64 orbs at 108 (the column from y 16 to 296); bars 34 deep at 45; tiles 70 × 32 at
   an 82 pitch; a stratum 37 deep with the lip 28 under it; a wave of 12-wide capsules at 20.
5. Progress is a slab on a 36-deep flat track; a pause is a 40 badge plate at the slab's end with the 28 glyph that says
   why, the track running on empty past it (partway); a result is a 28 glyph stamped in an r 18 hole at the slab's end; a
   choice is two 70 × 32 tiles under the track reaching the track's end, the primary lit, the other plain, their words at
   13.
6. Measure honestly: one scale per axis part, a 14-unit break through every bar that crosses it, the break drawn as two
   slanted strokes on the axis, end ticks on both parts, values at the bar's root so every bar starts at one x and glyph,
   value and bar read as one row; the axis runs to x 404 at 1.5. Give the side the section is about the longer part
   (Numbers: 150 units of milliseconds, 110 of seconds).
7. No picture draws the Mac's top edge. The page's own menu bar, notch and island hang above every frame, so a drawn
   stratum repeated them (it read as a grey tab in dark). A face that needs the notch's black sits on a small piece of it
   (Wake's five gate faces, `FaceText` at 17 on a tab with square shoulders and a 10-unit foot radius).
8. A window is a plate with a 1.5 stroke and a title strip of three 9-unit discs; a control is a 48 tile; a terminal is an
   ink plate with one mono 13 prompt row and slab rows. Nothing may reproduce an app screen's text.
9. No arrows, no callout lines, no legend, no numbering, no eyebrow inside a picture.
10. Both themes are checked on the page before a picture lands. A theme-dependent read (a lit plate vanishing on
    paper, an ink plate vanishing on ink) is fixed by changing the fill token, never by adding a stroke.

### Worked example · Wake 01 (listening) · four elements

On one axis at y 112 the h2 read left to right. `El wave`: the word as six flat lit capsules 12 wide at a 20 pitch from the
left edge, heights 32 · 64 · 96 · 128 · 104 · 72. `El blob`: the real orb at 96 at (176, 112) wearing `O O`. `El key`: a
`Disc` r 74 at the right edge, the `Ring` r 60 at 8 lit, the `Fingerprint` 64 wide on its seat. `El faces`: along the foot
the gate's five faces from `WAKE.faces` (gate `. .`, heard `O O`, granted `^ ^`, denied `> <`, locked `- -`), each on a
piece of the notch's black in its phase tone, named under it at 14. Why: the wave's crest and the ring are the same height
so neither half of the h2 wins; the faces say what the gate does without a second notch.

### Worked example · Threads 03 (acting) · the Console window, not an art drawing

The Threads section shows the app's own rows, so its picture is the Console window drawn with the kit at the app's density
(560 × 420, scaled as one to a 4:3 frame by `tan(atan2(100cqw, 560px))`, stacked under 520 cqw): the Threads group (Slack
asks, Spotify and Notes done), Pinned, Today, Yesterday, Older, then Agents with the Claude Code sessions and the Codex and
Cursor folds (`content/rail.ts`). It is real text inside an `aria-hidden` window with one deck alt on its frame.

### Worked example · Numbers 07 (listening) · one element, a chart

`El chart`: the five latencies after the 3 ms the words set big, rows at a 52 pitch from the top margin, each its deck value
(mono 14) and deck label (Inter 13, quiet) on one baseline over a bar 24 deep. The axis is honest: 0 to 500 ms across 180
units, a 14-unit break, 0.5 s to 9 s across the rest to the right edge; every bar past 500 ms is cut by the same gap. The
two reflex rows are lit `Bar`s, the three model rows halftone (the ledger's own split). Under the bars the axis in two parts
at 1.5 with end ticks and the slanted break. No orb: a measure has no character in it.

## 8 · The briefs the other drawings started from (history)

These were the starting briefs. The drawings are finished and the files win where they differ: Say labels its four brains
in a picker (the reflex badge without `3 ms`); Rails is three verdict rails sharing a frame with the NEVER list; Sleep
shows the quiet blob, the clock and what is still armed (`07:10 · Wake up, Kevin`, `Timer 11:56 · pasta`) with no stratum
and no `$0`; Costs is drawn (the awake meter `$0.05` to `$3`, asleep `$0`); Made and an Install drawing are not on the page.

- **Say 02** (thinking, `--jh-thinking`) · three elements. `El blob`: the orb at 96 at (64, 158), faceless (thinking has no
  face in this family), the line leaving it. `El reflex`: a `Flow` from under its right edge up to (192, 48), ending under
  a lit 40 badge at x 200 with the kit `live` (the bolt) at 28, then `Value` `3 ms` (NUMBERS.display.value) at 13 and
  `Label` `"Click Save"` (`part(SAY.lines[0], '"Click Save"')`) at 13 on the same baseline to the right. `El brains`: a
  `Flow` from under its right edge down to (192, 200), ending under a 2 × 2 grid of four 96 tiles at a 108 pitch from
  (200, 96) to x 404 and y 300, each with its brain at 32 centred: `Mark codex` (lit tile, the one in use), `Mark claude`,
  `G key`, the Apple mark through `Brand` (the local brain). Words: `"Click Save"` and the value.
- **Hands 04** (acting, `--jh-acting`) · four elements. `El window`: a plate 388 × 283 from (16, 16) at depth 8 with a
  title strip of three 9 discs at y 32 and three 48 tiles across y 64 at x 48 · 160 · 272; the tile the hands found (the
  third) lit with `Label` `Save` (`part(SAY.lines[0], "Save")`) at 13 in ink, and the circle ring around it: a 2 accent
  circle r 36 dashed as the kit `circle` glyph draws it (`strokeDasharray` 4 3). `El blob`: the orb at 96 at (96, 200)
  wearing `^^`, on the window's floor. `El travel`: a `Flow` from under the blob's upper right to under the lit tile, the
  pointer's path. `El shot`: a 120 × 84 plate at (268, 200) with a 28 check in `--jh-fg` in an r 18 hole at its lower
  right. Read left to right and up: label, travel, screenshot; never numbered. One word.
- **Rails 05** (speaking, `--jh-speaking`) · four elements. `El run`, `El confirm`, `El refuse`: three rail plates 388 × 60
  at an 80 pitch from y 16 (16, 96, 176), each with its verdict glyph at 32 at x 32 in the left column (checkCircle in
  `WORD`, handRaised in `WORD`, xOctagon in `ERROR` in an r 18 hole) and the same four tool-family glyphs at 28 across it
  at x 128 · 196 · 264 · 332: `terminal` (shell), `folder` (files), `send` (messages), `externalLink` (the browser); the
  same four on every rail is the lead's "No tool is special-cased". The confirm rail lit. `El never`: at y 256 a `Track`
  388 × 40 from x 16 with `Label` `NEVER` (RAILS.never.label) at 13 at x 28, baseline 281, then seven xOctagon glyphs at
  24 in `ERROR`, each in an r 17 hole, centres at y 276 and x 100 + 50·i (100 to 400). The seven items are the rail's rows.
  One word.
- **Sleep 06** (asleep, `--jh-asleep`) · five elements. `El stratum`: the top edge as in Wake with the lip wearing `- -`
  (PHASES.asleep.face) at 18. On the axis at y 192: `El blob`: the orb at 96 at (64, 192), quiet and faceless, asleep.
  `El alarms`: a 36-deep `Track` from x 124 to 232 at y 142 with three lit 4-unit ticks (the alarm, the timer, the routine;
  positions only, no times). `El meter`: a 36-deep `Track` from x 124 to 232 at y 206, empty, `Value` `$0`
  (COSTS.figures[2].value) at 13 in `QUIET` at its root. `El clock`: a `Disc` r 82 at (322, 192) with two `TICK` hands in
  `--jh-fg` at 07:10 (the hour hand 44 long, the minute hand 60) and the site's crescent (`ui/Icons` moon) at 24 in an r 17
  hole at its lower right in the accent. Words: the face and the value.
- **Costs 08** (listening, `--jh-listening`) · two elements, no orb (a measure). `El meter`: a plate 388 × 120 from
  (16, 24) holding a 36-deep `Track` from x 40 to 380 at y 56 with a lit `Bar dissolve` filling it to x 380, `Value` `$0.05`
  (COSTS.figures[0].value) at 13 at the root and `$3` (COSTS.figures[1].value) end-anchored at the head, and 60 second
  ticks as 1-unit `--jh-hair` marks 8 tall under the track at y 104. `El asleep`: a plate 388 × 110 from (16, 180) holding
  the same track empty at y 212 with the crescent at 28 in an r 18 hole at its root and `Value` `$0` at 13 in `QUIET`.
  Three values, no words.
- **Made 09** (accent, `--jh-accent`) · four elements. `El icon`: the Dock icon as the orb at 96 at (64, 64) wearing `^^`,
  joined by a `Flow` to the app. `El app`: a plate 276 × 72 at (128, 16) with the Swift mark through `Brand` at 28 at its
  left. `El daemon`: a plate 276 × 72 at (128, 120) with the TypeScript mark at 28, joined to the app by a `Flow` from
  (266, 88) to (266, 120). `El hands`: two tiles 132 × 72 at (128, 224) and (272, 224) with the kit `circle` (the screen
  helper) and `play` (the background helper, Apple events) at 28, each joined to the daemon by a `Flow`. The daemon plate
  lit (the one accent, the thing that runs). No words.
- **Install 10** (accent, `--jh-accent`) · three elements. `El terminal`: an ink plate 236 × 283 from (16, 16) with a
  mono 13 prompt row at y 44 (`Value` `curl -fsSL`, `upTo(INSTALL.code, " https")`) and four rows at a 52 pitch from y 84,
  each a 24 check in `--jh-fg` in an r 17 hole at x 44 and a halftone slab 24 deep from x 72 to 228 (the four commands as
  work done, no text). `El flow`: a `Flow` from the terminal's right edge at (252, 158) to (284, 158). `El setup`: a plate
  120 × 283 from (284, 16) of seven 36 tiles at a 38 pitch from y 24 at x 326, with the wizard's glyphs at 24: Welcome
  `play`, Voice `voice`, Brain `key`, Permissions `lock`, Wake `mic`, Agents `ask`, Done `checkCircle`; the last lit. The
  seven step names are the section's rail rows; the picture carries the prompt's two mono words and nothing else.

## 9 · Landing a picture

1. `const K = kit("<id>", "--jh-<phase>")`; the id is the section's and prefixes every pattern id.
2. Name the elements (five at most) and draw the bounding box of the stack: it must reach within 16 of every edge; read
   `MARGIN` and `W` for the edges rather than typing 16 and 404.
3. Build inside `El`s on the ground with `Track`, then `Flow`s, then plates back to front, then orbs, then glyphs
   and marks, then words.
4. Place it in `app/page.tsx` as the section's `pic`, inside `Pic` (`components/site/Section.tsx`).
5. Typecheck (`./node_modules/.bin/tsc -p tsconfig.json --noEmit`) and build with webpack (`./node_modules/.bin/next build
   --webpack`); look at the section at 1440 × 900 @2× in both themes and at 390; crop the frame at 2× from a viewport shot with
   its `getBoundingClientRect` (the CLI's element screenshot misses a sticky frame).

## 10 · The checks (every picture, before it lands)

- `grep -nE "#[0-9a-fA-F]{3,8}\b" components/art/*.tsx` finds only `url(#` and `href="#`: zero hex.
- `grep -nE "opacity|gradient|filter|blur|shadow|color-mix" components/art/*.tsx` finds only the comment that forbids them.
- Every `<svg>` is `viewBox="0 0 420 315"` (Rails `0 0 420 200`) `width="100%" role="img"` with an `aria-label` of deck cuts that say what it
  shows, never the section's h2 (Numbers is `aria-hidden` with its five pairs beside it in a visually hidden `.art-words` list), and
  `data-elements` between 1 and 5 (`Art` throws otherwise).
- Every visible string is in `content/deck.ts` or a cut of one; `lib/cut.ts` throws at build on anything else. At most six
  words, the lip's face counted; no em dash, no exclamation mark, no "not X but Y".
- Every colour is `var(--jh-…)` and defined in `app/globals.css` or `styles/*.css`; the accent is one token per picture;
  both themes read on the sheet.
- The stack's bounding box reaches within 16 of every edge; no quarter of the frame is empty; no element under the FILL
  scale (§1.3); the orb, where it appears, at 96 or 64, and absent from a measure.
- Weight, measured nesting-aware (a brand mark is a nested `<svg>`, so a non-greedy match to the first `</svg>`
  under-counts): walk the built `/` from each `<svg class="art"` counting `<svg` and `</svg>` to depth zero;
  each picture under 40 KB with every inline PNG under 20 KB. Round two finished: Wake 16.9 KB (one 7.4 KB orb), Threads
  39.3 KB (7.4 + 4.5 + 4.5), Numbers 12.5 KB (no PNG). Threads is the ceiling: a picture with a 96, two 64s and two brand
  marks has no room for a fourth PNG.
- No id appears twice on `/` (pattern ids carry the picture's id).
- Dither only as `<pattern>` from `BAYER8_RANKS`; the orb is the only raster.
- Server components only, no hooks, no canvas, no client import of `components/art/`.
- The top (`components/site/Top.tsx`) stays fixed and open while any section is in view, Sleep included (asleep is the
  island's quiet open kind, then the alarm). Each section pads its own top past the docked island.

## 11 · Declined grafts, and why (so the next round does not re-open them)

- **The five gate orbs in Wake's foot.** Five orbs would crowd a one-line read; the gate is drawn as five faces on pieces of
  the notch's black instead (§7.7), which is what the finished Wake does.
- **A menu bar, or an Apple mark, in the pictures** (the stage system; the visitor judge's one-mark version). The sticky
  top is the Mac and hangs above every frame; a second bar reads as repetition.
- **Values at the bars' heads in Numbers** (the eye judge). The visitor judge read glyph, value and bar faster as one row,
  the builder praised the one root, and a value past the head of a bar that reaches x 404 would force the chart to end
  near x 350, losing the scale the eye judge praised.
- **An orb in Numbers** (the orb system). A measure has no character in it; the 160 ear cost 40 % of the frame and the
  glyph column.
- **An element cap as a dev-only check.** `Art` throws at every render instead: the pages are static, so the cost is one
  tree walk at build and the law cannot be shipped around.
