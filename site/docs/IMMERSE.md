# IMMERSE · Kevin (2026-09-28), on the live Mailroom-inspired site: "redesign the website to feel much more like working and looking through jarhead instead of looking so generic and having weird spacing and whatever. also i liked our dither aesthetic and our custom icons and stuff !!!"

The site is `/Users/kevinliu/jarvis/site` at main a8994a5 (read-only for agents; copies under `S/im/`).
What is there now: Mailroom's frame (a bordered rail, 22 px hatch bands with corner crosses, giant two-line
headings with a grey second line, an isometric 01/02/03 triptych, hairline cards, pill chips, a never-line, an
inverted install band) around Jarhead's material, at 160 px section padding. Kevin's verdict: it looks generic
and the spacing is weird. What he liked and wants back in front: the dither aesthetic and our custom icons (the
Console kit's filled glyphs, the blob faces, the JarheadMark orbs, the agent marks), and the feeling of USING
Jarhead.

## The goal in one sentence

The page IS Jarhead's own surfaces: the visitor looks through the notch island, the Console and the blob, on
dithered grounds, with the kit's glyphs, rows, badges and buttons, at the app's own rhythm, and learns what
Jarhead does by seeing it work.

## What "generic" means here (remove)

- Mailroom's devices: the hatch bands and corner crosses, the outer bordered rail as the page's frame, the
  triptych of isometric tiles, the plain hairline cards, the pill chips as the state marker, the inverted
  closing band, the giant two-line marketing headings with a grey second line (a heading may still be two
  lines; it is set at the Console's scale, not a billboard's).
- A landing-page rhythm: hero → features grid → stats → CTA. Sections as billboards with 160 px of air.
- Anything that could be any AI product's site.

## What "working and looking through Jarhead" means (build)

1. **The app's surfaces are the page's surfaces.** The Console window (title bar with traffic lights and the
   phase word, the left rail of conversations and agents with their orbs, the Now stream of utterance and
   tool rows, the composer with the voice chip, the right rail of Session · Audio · Circled · Permissions ·
   Problems) and the notch island (menu bar, notch, the island's four bands, the blob) are drawn in HTML/CSS
   from the kit, at 1:1, holding REAL content: the page's own sections and facts live inside them as
   conversations, tool rows, cards, badges and rail groups. Real captures from `docs/media` sit inside
   drawn frames where a drawing would be a lie (a full Console with its stream, the Setup wizard, the
   overlay shapes), scaled 0.5× at most, never smaller.
2. **Dither is the ground.** The Console ground (`groundStops`, 2 bands, 2 px cells), the island's ink, the
   plates' floors, the meters, the capsule shadow, the loading glyph ramp: `lib/dither.ts` already renders
   them; `components/ui/DitherGround` exists. Every shaded area on the page is dithered; flat text on flat
   fills; no smooth gradient, no blur, no shadow.
3. **The custom icons everywhere.** `components/kit/Glyph` (the filled set), `Mark` (JarheadMark orbs, quiet
   tone for closed items), `AgentMark` (codex, claude, cursor, gemini …), the blob faces in mono (`- -`,
   `O O`, `^ ^`, `> >`, `o o`), the phase dots in the phase colours. Brand marks via thesvg (`ICONS.md`).
   No outline icon, no Heroicon, no emoji.
4. **The app's rhythm, not a billboard's.** Type at the Console's scale (11 / 12 / 13 / 15, one display size
   for the h1 at ≤ 56 px and section heads at ≤ 28 px), rows 28–44 px, groups with 12–16 px between, panes
   with 16–24 px padding, sections separated by the kit's hairlines or a pane boundary, not by 160 px of
   ground. The page should feel dense the way the Console is dense: calm, ordered, glanceable. "Weird
   spacing" = big empty stretches, headings floating far from their content, gutters wider than the
   content. Fix by composition, never by adding boxes.
5. **The live engines carry the feeling.** The blob (`components/desk/Blob`, `lib/blob`) alive and following
   the pointer; the island cycling its kinds (`lib/island`); the composer's Say box typing; the meters
   ticking; the phase word crossfading. Nothing else animates.
6. **Copy stays COPY.md** (verbatim strings; cut freely; never add), now set as the app would set it: an h1,
   one lead, then Console strings (utterance rows, tool rows with glyphs and timings, row titles and values,
   badges, chips) rather than paragraphs. The figures (3 ms, 71, 16, $0.05 / min …) are values in rows and
   meters, with `Tip` for provenance.
7. **Install** is a Console pane too: the one-liner in a composer-like field with a primary `Copy`, the
   four commands as tool rows, the requirements as a Permissions-style rail group with checkCircle glyphs,
   the Setup steps as the wizard's own rail (Welcome · Voice · Brain · Permissions · Wake · Agents · Done).
8. **Both themes**: dark is the Console, light is the Console in light (`console-light.jpg` shows it).
   `html[data-theme]` only.

## Three designers (each from the current site's copy; keep components/kit, components/desk, lib, content/deck.ts)

- **A · THE CONSOLE IS THE SITE.** One Console window fills the page: sticky title bar (traffic lights,
  `Jarhead · <phase>`), a sticky left rail whose "conversations" are the page's sections (Wake · Say · Threads
  · Hands · Rails · Sleep · Numbers · Costs · Install), each with its orb (bright for the one in view, quiet
  for the rest) and agents below (Codex · Claude Code · Cursor with their marks); the Now pane scrolls
  through the sections as a stream (utterance rows, tool rows, cards holding captures, badges); the right
  rail shows Session (phase, meter, cost), Audio (Hears/Speaks), Permissions (16, 7 required), Problems
  (none) and Install (the one-liner + Copy). The notch island with the live blob sits over the top edge,
  peeking, and opens on hover. Phone: the rail becomes the island's kind strip; the panes stack.
- **B · THE DESK, SCROLLED.** The full drawn desk at the top (menu bar, notch, island, blob, the Console
  window at 1:1 with the Wake conversation inside it); each section below is the desk in another state
  (listening: island open with the Say box typing; thinking: the blob's `- -` and the brain rows; acting:
  the Console with three threads and the target ring; speaking; asleep: the island tucked with the alarm
  pill), each state's facts as a dithered plate of kit rows beside the desk; install as the Setup wizard
  drawn from `onboarding-*.png` inside a window frame with the one-liner in front. Spacing at the app's
  density; the page reads as one long desk.
- **C · THE ISLAND'S PAGE.** The island is the page's header and navigation: pinned at the top over the
  notch, its bands are the site's tabs (kinds); the blob lives in it; below, the page is a stack of Console
  panes (group head · rows · one capture in a drawn window), dithered ground behind, the composer as the
  install field at the bottom of every pane's rail (`Say something…` becomes the one-liner with Copy). The
  tightest of the three; the kit everywhere.

## Non-negotiables

- `facts-canon.md` §8 antipatterns (stacked rows are a data dump; Console rows in a pane with a group head
  are the Console: fine); the line law; weight ≤ 500 (the blob faces excepted); Inter; tokens only;
  reduced motion; a11y (landmarks, headings, focus rings, labels, contrast AA both themes); no claim outside
  `facts-product.md`; every string from COPY.md; zero em dashes; no "not X but Y".
- Keep `scripts/install.sh` + copy steps, `/og.png`, icons, manifest, `lib/*`, `components/kit/*`,
  `components/desk/*` (recompose freely), `content/deck.ts` (drop what is unused).
- Never run `pnpm install` in a copy (it rewrote the repo's node_modules symlink once). Dev servers with
  `./node_modules/.bin/next dev --webpack --port <port>`.
- Heights: no budget; density is the point. Phone: readable, no sideways scroll, tap targets ≥ 40 px.

## Judging bar (Kevin's eye)

Put `docs/media/console-jarhead.jpg`, `console-threads.jpg` and `notch-island-working.png` beside each
design's hero and sections. Does the page look like those? Would a visitor say "I am looking at Jarhead" in
two seconds? Is every shaded area dithered? Are the glyphs ours? Is the spacing the app's (no floating
headings, no empty stretches)? A design that still reads as a landing-page template scores under 5.
