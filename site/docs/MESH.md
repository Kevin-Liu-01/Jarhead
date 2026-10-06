# MESH: the island grows out of the notch

Kevin, 2026-10-05, on a crop of the hero island under the bar (Listening, dark, about 1000 px wide):
"make this window look a lot better and connect/mesh with the top window a lot better".

"This window" is the island (components/desk/Island.tsx, lib/island.ts, styles/desk.css), "the top window" is the
menu bar with the notch cut out of it (components/site/MenuBar.tsx, components/desk/Notch.tsx until it went, styles/site.css), and
components/site/Top.tsx holds them together and scales the island from the hero (about 0.82) to docked (0.62 desktop,
about 0.6 phone) as the page scrolls.

## What is wrong today

The junction:

1. The island is a card hung under the bar. It is 420 wide at 1:1 and the notch is 185, so at the hero scale its top
   edge runs about 80 px past the notch on each side, right under the bar's hairline. Its top corners are convex (18 px),
   so the bar and the card meet at a seam with two visible bites.
2. The notch's concave fillets sit inside the bar band, but the island's shoulders do not. The notch reads as a thin
   column and the island as a separate object.
3. The island's top is a dithered black lip on a grey bar with a hairline, so its top edge reads as a dirty edge, not
   as the notch's black.
4. At about 1000 px the left menus run under the notch ("Cost" is clipped by it). This is a bug in `.bar-l`'s max width.

The window itself:

5. The two meters (the head's 100 x 6 and the foot's 64 x 6) draw as hard white bars, so they read as placeholder blocks.
6. A pale teal highlight smears along the island's left edge, and reads as a defect.
7. While listening, the middle is empty: the eyes and the word sit top left, one meter sits at top centre, then 90 px
   of bare blue.
8. The dither field is busy, the diagonal bands step hard, and the right third goes muddy navy.
9. The phase hairline along the bottom edge reads as a glow line stuck under the island.

## References

The real thing: a MacBook's hardware notch (black, rounded bottom corners, tiny concave ears where it meets the top
bezel). How notch apps open it: NotchNook, Boring Notch and Alcove grow a black panel out of the notch, with its top
flush to the screen's top edge (it covers the menu bar under it while open), concave ears at its top corners and
generous bottom radii. The iPhone's Dynamic Island grows the same way. The site's own canon: Kevin's Prototemplate
tokens, solid icons, terse copy, the Bayer dither in 1.5 CSS px cells, the orb's blue ramp pooling out of black.

## Constraints

- The site depicts the app. Whatever silhouette the island takes must be one the app's
  `NotchInk.shape(column:island:scale:)` (apps/mac/Sources/Jarhead/UI/Orb/NotchInk.swift) can draw as one path from the
  bezel down. Whatever ink it wears must be `NotchInk.render(_:)`'s. Whatever it shows must be something
  NotchPanel.swift draws, or a change that can be ported there. The app's panel already spans from the screen's top
  edge to under the island, at least 460 pt wide (NotchGeometry.panelFrame). On Kevin's 14" the notch is 185 x 32 pt at
  x 771 to 956, under a 33 pt menu bar.
- Kevin asked for the open island's top edges to read rounded (2026-09-11). A concave ear is a rounded top edge too.
  Hard square shoulders are not.
- The face, every word and every control stays legible in every kind (listening, thinking, acting, speaking, asleep on
  the titanium ramp, alarm), at the hero scale and docked, in both themes and on the phone.
- The bar keeps its job: the menus, the phase word, GitHub and stars, the theme, Install and the clock stay reachable
  at every width, and nothing the island covers is something a visitor needs.
- Tokens only, no em dashes, html[data-theme] is the only theme switch, weight 500 or less except the bar's app name,
  no shadow but the one token, and the one glass stays the hero's Install.

## GROWN's first pass (2026-10-05, a candidate, never landed)

The island as the notch grown, one black silhouette from the page's top edge, as notch apps open it. This pass lived in a
copy and never reached the tree; it is kept as the record. Its rim, its segmented meters, its dotted rules and the app's
band went again in the second pass, which won the contest (docs/TWIN.md) and is what landed (the next section).

- **The band** (styles/site.css `.top-band`): the notch widened to the island's width, drawn in the island's own scaled box
  and counter-scaled in height, so it is the bar's height and the body's width at every scale. It covers the bar and its
  hairline across that width, with 10 px concave ears at the top edge (8 on the phone), each run 1 screen px into the
  band (the light-theme seam column is gone). components/desk/Notch.tsx, its column and its fillets are deleted. Row 0,
  the ears and the band-to-body join were measured clean at DPR 1, 1.25, 1.5 and 2 at scroll 0, 12, 24, 37 and 120 in
  both themes; band and body widths agree to under 0.05 px.
- **The body**: square under the band, 30 px bottom corners. A kind change springs its height (176 to 184), never its
  width or a scale.
- **The ink** (lib/island.ts): one value per cell, quantised once (9 levels: black, the deep end at 0.22, the pale end at 1),
  not four stacked dithers. A calm diagonal body, a glow round the eyes (60, 28, σ 22) that fades out 26 px before any
  edge, a soft lip (0.30 of the height under the notch, 0.12 at the ends), an 8 px rim of black up the sides and round the
  bottom, and 2 px of solid black under the band. The teal smear and the vignette are gone.
- **The instruments**: segmented meters (3 cells tall, paper tinted with the kind's tone); listening, the level trace in
  the middle (a dotted rule at rest, one-cell bars on a three-cell pitch, the newest grown in two cells from the end, the
  older half settled to 40 % and thinned through the tile), or under a heard line; acting with no tiles, a working sweep
  under the line. Thinking's Go ring takes the eye's paper tint.
- **The phase rim**: 1 screen px of the phase tone inside the bottom contour, round both corners, fading up the sides
  over two corner radii, so the sides read on the dark page.
- **The bar**: both sides stop short of the band at the hero scale; Top.tsx `fitBar` drops whole menus from the last, then
  the clock, the phase word, GitHub's word and the stars. 0 overlaps and 0 clipped items at 18 widths, 1440 to 320. At
  580 px and under the bar is the band itself (black, the screen's tones), keeping the mark, the name, GitHub with its
  stars and the theme, with the island hung from it at 0.77 (390 × 844) and its ears at the bar's foot.
- **Left out**: the bar's hairline run down the ears (here the ears sit on the page's top edge, and the hairline meets the
  band's straight side as a menu bar's foot meets an open notch panel); the lip's bell pinned to the hardware notch's width
  (no notch is drawn once it has grown, and a bell that changed with the scale would reshape the ink while docking).
- **Still to land in the app** (apps/mac): NotchGeometry.ear and bottomRadius, the band in NotchInk.shape gated by the open
  spring, the single-quantiser render, the segmented drawBar, levelHistory and drawLevelTrace, the working sweep, the rim
  stroke, and the band in hitTest and the pointer's approach rect.


## What landed: better than the app island (2026-10-05)

Three islands were judged side by side (docs/TWIN.md keeps the contest): APP, the island installed on Kevin's Mac; TWIN, the
web rebuilt as the app's copy; and GROWN, this one, on the web and ported to the app. GROWN won on two of the three
judges' scores (the eye 8.2 to APP 7 and TWIN 6.5, the craft 8 to 7 and 6.5; the app judge preferred TWIN's app 8 to 7),
and it was applied to the tree with the judges' grafts (the last list here, "At landing").

Kevin, later the same day, with a screenshot of his installed app's island (asleep, the gate listening, the Full Disk
Access row in the foot): "see this island looks so much better than our web one. but also update the eyes and update our
local app", then "you can continue the web to app redesign though you know, as long as its better", after "dont lie the
light blue bar at bottom and that weird yellow bar on top". So GROWN keeps what it does better than the app (one shape
with the notch, meshed with the bar; the listening trace) and takes what the app does better (the depth of the black
pouring diagonally into the blue, the large light hero line, the calm composition, the foot's problem-row grammar), on
both sides, and loses every bar.

What the app island does well, measured on twin/ref (HEAD 47e861b, which draws his screenshot to 5/255):

- The black pours: under the notch it reaches 0.82 of the height and falls over the 117.5 pt wings to 0.26 at the ends,
  so the blue lies diagonally under a black that came out of the notch. GROWN's lip (0.30 under the notch, 0.12 at the
  ends) was a thin strip, and its body a flat mid blue: a blue card under a black bar.
- One big light line: asleep the hero is the gate's words, 18 pt at 0.72, on the black under the notch.
- Calm: eyes, word, line; air; controls; one foot line. A noun bright, a clause dim, a box at the right.

Where it is weaker, and this candidate is better:

- A phase hairline runs along its bottom edge (cyan, 50 % of the bottom 2 pt in every listening island, `tools/rimcheck.py`):
  the "light blue bar at bottom". Gone (0 %), app and web.
- A 96 × 6 level bar in the head and an 88 × 6 meter bar in the foot. Gone: the head is words, the foot is words, the voice's
  level is the trace in the hero's slot.
- Four stacked dithers (the ramp in 5 bands, the highlight in 6, the black in 5, the vignette in 6) whose step edges cross,
  and a muddy teal where the pale cyan is dimmed at the left end.
- Its island hangs under the bar as a card with convex top corners beside a notch column.

The choices, with their numbers (site/lib/island.ts and NotchInk.swift render(_:), cell for cell):

1. **The silhouette**: on the page the band over the bar, the island's width, 10 px concave ears (8 on the phone), the body
   square under it, 30 px bottom corners (the page's bar is its own drawing; it fits round the band). In the app the open
   island keeps the installed silhouette, the notch's column with concave fillets and rounded top corners hung from the real
   menu bar, because a band there would hide the status items beside the notch and lay a 420 pt black slab over a light or
   transparent bar; it takes the body's 30 pt bottom corners, growing from the notch's 12 as it opens (`NotchInk.openLevel`).
2. **The pour, the app's**: reach 0.76 of the height under the notch's 185 px (the app's 0.82, a touch shallower because the
   band's or the column's black already sits above it), 0.26 at the ends, smoothstep over the wing (half the island past the
   notch's half). The first 2 px under the top edge black outright.
3. **The ramp, the app's diagonal made a touch brighter**: u = 0.16 + 0.84 (0.68 x + 0.32 y) (the app's 0.30 + 0.78), the
   icon's highlight at (2 px, 0.36 h), σ 20, pulling u toward the pale by 0.45 (the app's 0.8 at the very edge, σ 18,
   which read as a smear on the web), a vignette of 0.24 (the app's 0.34).
4. **Two quantities on one threshold**: per 1.5 island px cell (the app's 1.5 pt, whole device pixels on screen, so the grain
   is the same share of the island docked as open), the ramp's band (6 steps) and the light kept (6 steps), colour = band ×
   light, both quantised on the same Bayer threshold and rounding the same way (the light on 1 − t: a cell that steps toward
   the deep end also steps toward the black), so every step edge runs with the pour and the two errors add into one
   crosshatch, the installed ink's grain. The light going (pour ×
   vignette) also walks u toward the deep end (u' = 1 − (1 − u) · light), so the black pools through navy, never through a
   dimmed cyan (no teal). At the app's own numbers (5 bands, no walk) this form gives the app's ink to about 1/255 in mean
   colour. On the page the canvas covers the body to its edges and the body's rounded clip trims it: no frame of black
   between the ink and the page (`tools/framecheck.py`: 0 px; the first candidate's was 3).
5. **One ink for every kind**, asleep included, as the app's. The web's ink is one still image per scale: no breath,
   repainted only when the scale moves.
6. **The face, drawn, one table on both sides** (site/lib/eyes.ts; the app's Eyes.swift, the port of it, through BlobSim and
   NotchView): Kevin asked for the eyes. Asleep, the wake gate's beads (`. .`: a small round pupil with one point of light,
   held still, the installed app's dots drawn); listening `O O`; thinking the lowered lids `- -`, churning to `~ ~` one beat in
   three, looking up and away; acting and ringing `o o`; speaking `^ ^` with its sparkle. Asleep and thinking never share a
   face again. On the page a blink is a compositor squash of the open eyes, so a slow frame never leaves them shut.
7. **The hero, the app's**: asleep, the wake gate's words, `Listening for “jarhead”`, at 0.72, the app's 18 pt SF Pro set as
   17.4 px Inter (where Inter's cap height and widths meet SF's) on the 22 px pitch from 29.5; a question names its
   asker once, in the head (`✋ Slack asks`, its hand the only amber), and the app enforces it (`NotchView.heroQuestion` drops
   a closing ` on Slack`); the island's words never carry an em dash (`NotchView.islandWords`: `Wake word off · microphone not
   granted`). The ring: `07:10` in the mono, ` · Wake up, Kevin` in the sans, a calm second line at 0.72. Balanced wraps.
8. **The foot, the problem row's grammar, one line**: a bright noun and a quieter clause one word space on (the app's 6 pt gap
   after `12:37` is gone). Awake `12:37 · 7.2 min · $0.36` (app: `· today 8.5 min` too). Asleep, on both sides, the app's
   asleep row: `☾ asleep · next Alarm 07:10 · Wake up, Kevin` (the alarm the Sleep night runs to; the name gives way docked);
   with nothing armed the day's figures (app) or, while the page's alarm rings, `· nothing billed`. The meter figure is gone;
   the problem row is unchanged. The head and the foot are the app's 11 pt sans with tabular figures, not mono.
9. **The instruments, the paper only, never a rule**: the listening trace keeps its slot, 40 px tall at most, bars at 0.84
   settling to 0.46; silence draws nothing but a short dotted lead at the newest end (8 ticks fading out), and a lone level
   between two silent ones is silence too, so no stray tick stands between two phrases. Acting with no
   tiles, a swell of ticks runs there and back along a 96 px strip under the line (the first candidate's sweep crossed the
   whole slot over a dotted rule).
10. **Docked, the hierarchy holds**: every word takes `max(its size, a floor / --top-s)` by its role, the hero never under
   13.5 px on screen, the phase word, the buttons and the Say box 10.5, the head, the foot and the tiles 9.5, so the hero
   stays at least 1.4 times the quiet lines (the first candidate floored everything at 11, one size docked). The middle beat
   (Allow · Deny, Snooze · Done, the tiles) sits at the app's 82 until the grown hero needs more, then 8 island px under a
   two-line hero (`--isl-mid`), so it keeps air above and below; docked a tile is its name alone, one row the Say box's
   height (the head already counts the work).
11. **Calmer kinds**: the alarm offers Snooze 10 and Done (the app's 5 / 30 show only while Snooze is hovered); asleep Stop
   rests spent at 0.45; thinking's Go ring takes the eyes' paper tint in the app too. The phase word changes in two steps
   (out, then in), never two words in its slot. A new kind moves in the app's beats: the display and the foot go out over
   0.16 s drifting up, and the new kind's come in over 0.24 s from 6 px below, 30 ms apart, with the body's height spring.
12. **Kevin's other fixes**: no line along any edge (site and NotchPanel, measured), nothing bar-shaped in the head or the
   foot, no meter tinted with the phase or the alarm's amber, no amber words along the top; the hero terms line's OSI keyhole
   in currentColor, its 24-unit box at the mono's cap height (0.73 em) on the baseline, 0.4 em after it.

The app's drawn eyes are the TWIN item 3 port (Eyes.swift, and BlobField.swift's sim feeding it), carried here with the
bead added for the gate's `.`, so the island ships them with the island they belong to.

### At landing: the judges' grafts

Carried, on both sides where both draw it:

- **The ink's grain**: the light's step rounds with the band's (above, item 4). Rounded against each other the two errors
  cancelled: the 2x render lost over a third of its fine grain (high-pass deviation 7.6 against 11.9 now) and streaked into
  vertical hatching (horizontal steps 1.22 times the vertical; 0.99 now). NotchInk.render(_:) and lib/island.ts.
- **The peek, no light blue bar**: the 26 pt peek and the strip under the notch had lifted the ramp to the pale cyan and
  read as a light blue bar. Their ramp now starts at the accent blue (bias 0.3), the highlight is a trace (0.12), the black
  pours down 0.45 of the height under the notch and 0.6 at the ends, and the walk to the deep end runs at every size, so
  the black pools through navy there too, never a teal fringe.
- **The tool glyphs** (web): Phosphor browser for Window, and for Circle, Ask and Console glyphs composed from Phosphor's
  parts after the app's pencil.and.outline, questionmark.bubble.fill and rectangle.3.group.fill (the repairs below).
- **The beats and the hero's set** (web): items 7 and 11 above.
- **The seam** (web): the app's hairline over the foot, y 153.5 at white 0.10, from 14 to 406, one screen px at every
  scale. It is a rule inside the island, not along its edge.
- **The docked middle beat** (web): item 10 above.
- **No lone ticks** in the level trace (item 9), NotchPanel.swift drawLevelTrace and lib/island.ts renderLevelTrace.
- **The rounded corners take no clicks** (app): `NotchView.hitTest` follows the corners as `NotchInk.shape` draws them
  (`roundedInk`: the bottom two and, since the repairs, the convex top two), so a click in the empty corner beside a curve
  reaches what is under the island.
- **The harness says what is drawn**: `previewLipGlow` is "none" again (nothing draws a lip glow) and OrbPreviewApp's
  marks check expects it.

Not carried, and why:

- TWIN's notch column on the page, in place of the band: the band is the mesh Kevin asked for, one silhouette with the
  bar. The light-theme bar and the phone's black bar keep the band's design.
- HEAD's four-dither ink and its 12 pt corners in the app: the rounding fix gives back the grain Kevin praised while
  keeping the pour, the navy and the calm, and the 30 pt corners stay one silhouette with the page's body.
- Keeping the Sleep menu at mid widths: at 1000 to 1200 px the band at the hero scale leaves the left side room for five
  menus; `fitBar` drops whole menus from the last, never a clipped word.

### After landing: the repairs (2026-10-05)

A last review against Kevin's screenshot and the app found these, fixed on both sides where both draw them:

- **The bottom corners are 24, not 30** (desk.css, `NotchGeometry.bottomRadius`): at 30 the foot's Console · Sleep pair
  (right edge 406, bottom 4) came within 1.6 px of the curve, its hairline pinned to the contour; at 24 it keeps 3.4, and the
  strips stay aligned at 406. Read 30 as 24 above.
- **The tool glyphs read as the app's**: pencil-circle read as a circled "A" at 9 to 12 px. Circle is a ring open at its
  upper right with a pencil crossing the gap, Ask Phosphor's chat bubble with question-fill's mark knocked out, Console two
  tiles stacked beside one tall (scripts/vendor-icons.mjs COMPOSED). Asleep, Ask and the spent Sleep draw their glyphs at
  the app's 0.35.
- **Go is the app's ring**: a 40 % black disk under one screen px of the phase tone at 0.9, never a 2 px hollow ring; while
  the alarm rings the island keeps the asleep tone (eyes, ring, the bar's dot), as the app's does: the alarm's amber is the
  head's glyph alone.
- **The boxes are the app's** (black 0.42, hairline 0.26, glyphs 0.78), and the Say placeholder is 0.62 on both sides.
- **The light falls toward the foot** (`FOOT_SHADE`, `NotchInk.footShade`: 0.35 from 90 px above the bottom edge to 20
  above it), so the foot's clause (min 5.35:1, was 2.53) and noun (7.62, was 3.17) and the placeholder (4.95, was 3.75)
  clear 4.5:1; a 12 px fall under the seam read as a dark footer bar and was not taken. The head and the foot carry the
  app's ink shadow on the web too.
- **The bar's clock is the Mac's time**: Sleep's night moves it to 07:10 while the alarm rings (`Show.clock`).
- **The phase word's fade-in plays to its end** (`WordCrossfade`), and a word still fading in is dropped, never flashed.
- **The OSI keyhole** takes a 1.2-unit stroke in its own colour, so its ring reads at the mono's stem.
- **The ring's `o o` flares in the app** (`BlobSim.sparkleFace`): the sparkle steps on the pair drawn, not the sleeping
  sim's beads.
- **The script's scale is the CSS one**: Top.tsx measures its probes with getBoundingClientRect, so hydration never
  resizes the island by a pixel.
