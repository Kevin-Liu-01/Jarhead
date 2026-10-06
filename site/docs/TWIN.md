# TWIN: the web island becomes the app's island

Kevin, 2026-10-05, with a screenshot of his installed app's island (the Sep 21 build, asleep: the notch's black
pouring diagonally into the blue dither, "Listening for "jarhead"" set large and light, the dot eyes over "Asleep",
Go · Stop · Mute, the "Asleep · press Go" field, the three tool buttons, the foot's problem row with Fix):

> see this island looks so much better than our web one. but also update the eyes and update our local app. and fix the
> issue where it opens up multiple dock apps and instances of itself when it should just be one instance

Earlier the same day, on the web island:

> make this window look a lot better and connect/mesh with the top window a lot better

> dont lie the light blue bar at bottom and that weird yellow bar on top. have you redesigned yet?

> can replace this with the actual MIT thesvg.org logo!!! (the word MIT in the hero's terms line)

## What that means

1. **The app is the reference.** The web island (components/desk/Island.tsx, lib/island.ts, styles/desk.css,
   components/site/Top.tsx) becomes a faithful twin of the app's open island as NotchPanel.swift and NotchInk.swift draw it
   at HEAD. That covers the silhouette, the ink, the type, the layout per kind, the controls, the foot and the asleep
   state. The one exception is the eyes, which go the other way (item 3). The web's old ink pooled as a trapezoid because
   its wing was a short 40 px. The app's wing is the island's half width minus the notch's half, which is what makes
   the diagonal pour Kevin likes.
2. **Two bars go, in both.** There is no light blue line along the island's bottom, corners or sides. There is nothing
   bar-shaped in the head or under the notch, and no meter is tinted with the phase or the alarm's amber (that was the
   "weird yellow bar"). A meter that stays is paper only and sits in its line like a figure. These are Kevin's words;
   where the app draws one of these bars today, the app loses it too.
3. **The eyes.** The app's island draws its face as glyphs (the dot eyes in the screenshot), and its blob does too. Both
   take the web's drawn eyes (lib/eyes.ts drawFace: ink pupils with the star catchlight, happy arcs, sleepy smiles, the
   lid-squash blink, the gaze, and the sparkle's breath, flare and pop), drawn in CoreGraphics.
4. **It meshes with the bar** the way the app's island meets the real menu bar: hung from the bar's bottom edge under the
   notch, with the notch's fillets and the island's rounded top corners, and no hairline across the island's span. The
   bar's items never run under the notch or the island at any width.
5. **The licence.** thesvg.org has no MIT logo (checked: @thesvg/react 3.3.12's 22,287 files and thesvg.org's sitemap),
   and MIT's bars are the university's, not the licence's. The hero's terms line uses thesvg's Open Source Initiative
   keyhole, mono, in the line's colour, before the word MIT.
6. **One Jarhead.** Exactly one instance of the app and one Dock tile, ever. The app hands off to a running instance and
   quits. Nothing we build or run (the probes, the harnesses, the build-only stages) ever shows another Jarhead in the
   Dock.

## Constraints

- The site depicts the app, so after this pass the site shows nothing the app does not draw, and the reverse.
- Tokens only on the site, no em dashes, html[data-theme] is the only theme switch, and the one glass stays the hero's
  Install.
- Never open a window on Kevin's screen. The app is rendered offscreen (the harness under
  scratchpad/mesh/app-render/panel uses `.prohibited`). Never `open -n` an app bundle. Never launch Jarhead.app; Kevin's
  checks and the relaunch are the integrator's.

## The contest (2026-10-05)

Kevin, after the twin pass: "you can continue the web to app redesign though you know, as long as its better". Three
islands were put side by side, every kind, dark and light, at one scale, with the eyes left out of it (both sides take the
drawn eyes), and judged against his rules (no light blue line along the bottom or sides, nothing bar-shaped on top, no
meter tinted with the phase or the alarm's amber, the island meshes with the bar):

- **APP**, the island installed on his Mac (HEAD 47e861b draws his screenshot), the bar to beat.
- **TWIN**, this document's pass: the web rebuilt as the app's copy, and the app keeping its island with the drawn eyes
  and without its two bars.
- **GROWN**, docs/MESH.md: the island grown out of the notch on the web (one black band over the bar with concave ears),
  with the app's pour, its large light hero and its calm folded in, and ported to the app.

Three judges scored them (APP / TWIN / GROWN): the eye 7 / 6.5 / 8.2, the craft 7 / 6.5 / 8, the app 7 / 8 / 7. GROWN
won, and it is what the tree draws now, on the site and in the app, with the judges' grafts (MESH.md "At landing").

What that changes here:

1. **Item 1 is superseded.** The web is no longer a copy of HEAD's island; site and app both draw GROWN. They differ in one
   place, on purpose: on the page the island hangs from a band as wide as itself over the page's own bar, while the app's
   open island keeps the notch's column with concave fillets under the real menu bar, whose status items are the user's.
2. **Items 2 to 6 stand**, and GROWN keeps them: no line along any edge, nothing bar-shaped in the head or the foot (the foot
   is one line of words), the drawn eyes on both sides, the band meshing with the bar, the OSI keyhole, one Jarhead. (The
   gate's beads that stood in for the installed dots are gone since 2026-10-06: see "The eyes, dithered" below.)
3. **The constraints stand**, with the one silhouette difference above as the exception to "the site shows nothing the app
   does not draw".

## The eyes, dithered (2026-10-06)

Kevin, on the eyes: "what if we included the dither over jarhead's eyes, as in just make the eyes dithered too", and "the
eyez in the little tab like for asleep, are SUPER creepy it should be same eyes".

1. **The eyes are dithered, on both sides.** lib/eyes.ts `faceCells` and Eyes.swift `faceCells` are one rasteriser, cell
   for cell (a parity check runs every face the product draws through both): every shape on the cells of the world it
   sits on (the island's ink cells, the blob's 1.5 px field, NotchInk's 1.5 pt grid), the Bayer tile at its edges, the
   star's glow scattered on the pupil round it, the rim ramping from the tinted paper to a foot of the phase's tone on the
   island and the peek, a flare bursting into a star of cells at its tip. On the island the face is painted into the ink
   canvas itself, so it is the ink's own pixels.
2. **The bead goes, everywhere.** Asleep the island, the app's peek and its lip show the blob's own sleeping lids (`- -`,
   `~ ~` at the top of a breath) whether or not the wake gate listens; Touch ID asking opens the eyes and glances them to
   the key and back, blinking (in the 12 pt lip drawn `o o`, whole). `. .` is no glyph any more (EyeKind, BlobSim's low
   glyphs, the island's faces).
3. **Nothing crawls.** Each eye is dithered in its own space and the pair snapped as one, held on its cell through a
   wobble, so drift and gaze move whole cells and re-draw none; only a change of shape (a blink, a flare, the breath)
   changes cells.
