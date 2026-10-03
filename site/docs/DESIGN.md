# DESIGN · the page as built (2026-10-02)

The landing page in one page. `LANDING.md` is the brief this answers (LoveFrom's restraint and character, OpenAI's
confident playable product pages, Jarhead's own material); `SCRATCH.md` holds everything Kevin has said and still applies
where LANDING.md does not override it. `content/deck.ts` (`COPY.md`) is the only source of words. Where this page and the
code disagree, fix one of them.

## The look

Paper first, one character, one idea per screen. A warm near-white ground (`--jh-ground`), ink type, white sheets on it.
The hero holds almost nothing: `Your Mac, by voice.` on one line in a light serif, two short sentences, the glass Install
(a physical key, `components/site/InstallKey.tsx`: a glass cap on a body of the blob's dithered ramp that lights the glass
and the paper round it, leans to the pointer, sinks under a press and sends its light running out along its foot from
the press point, under the words) and Read the source, and one quiet mono line (`MIT · $0.05 / min, per second`). Its full
stop is the blob. Every section
after it is a large serif h2 in two lines (the second quieter), one short line of Inter, at most two quiet notes on icons,
and a **plate**: a white sheet with one hairline, its section's phase tone ordered-dithered across it in 2 px Bayer cells
(`components/play/Plate.tsx`, `lib/field.ts`), densest in one corner and thinning to a scatter. The plates are the page's
colour and its pictures; the demo is played on the pale part. Nothing on the page is a capture.

## The type

| face | file | where |
|---|---|---|
| Newsreader (Production Type, OFL), instanced to opsz 36 to 72, wght 300 to 420, Latin, 48 KB | `app/fonts/Newsreader-Display.woff2` | the h1 (330, opsz 72), the h2s (340, opsz 60), the Costs figure, the foot's name |
| Newsreader Italic, one static instance (opsz 22, wght 400), 14 KB | `app/fonts/Newsreader-Italic.woff2` | the voice: every line someone says (the chips, the blob's spoken reasons, `"night."`), always inside a `<q>` or set as speech |
| Inter 4.1 (rsms, OFL), cut with fontTools to wght 400 to 600 with the opsz axis, Latin and the page's punctuation and Mac keys, 48 KB | `app/fonts/InterVariable.woff2` | every other word, 400 and 500; 600 on the bar's app name alone |
| JetBrains Mono 2.304 (OFL), subset, 24 KB | `app/fonts/JetBrainsMono-wght.woff2` | values, commands, the island's head and foot, the terminal, the race, the Sleep clock |

Licences sit beside each file. Weight never goes above 500 outside the bar's app name. No text under 12 px outside the
drawn island (checked at 1440, 1280 and 390).

## The character

The real blob (`lib/blob.ts` on `lib/orb.ts`'s material, `components/desk/Character.tsx`) is the one character. It is blue
in every awake phase, quiet titanium asleep, its halo the phase tone (never violet; thinking wears the accent blue), and
its face never under 32 px.

- **The face** (`lib/eyes.ts`): drawn as shapes, never type. Open eyes are ink ovals (the blob's own ink) with one paper
  catchlight toward its gleam, set low, close and round (just above the body's middle, 0.31 R from it each side); the other
  faces are round-capped lines in the same ink: `- -` a soft lid, `^ ^` an arc drawn a touch bolder, `u u` a deep cup,
  `_ _` flat, `x x`, `> <` squeezed shut, `~ ~` a soft ripple. The lids are a spring: a blink squashes the oval shut, the
  body dips with it, and the eye reopens a touch taller before it settles; a happy squint (`^ ^`) comes now and then while
  it listens; the face travels with the look (0.19 R sideways, 0.13 R up and down) and the far eye narrows. Small blobs
  grow their eyes (40 % at a 32 px body) and no line goes under 1.75 px. The stills (`lib/orb.ts` `faceField`) rasterise
  the same geometry: `O O`, `^ ^` and the quiet still's `- -`, their catchlight a touch larger so a small still keeps it;
  the stills' URLs carry the face's version (`Character.tsx`). The island draws the same face as SVG paths
  (`faceMarks`, `components/desk/Island.tsx` `islandFace`, crisp at every island scale): the ink pupils with their paper
  catchlight and the ink lines, each rimmed in the phase-tinted paper so they read on the island's dark; it blinks shut
  for one tick and the far eye narrows as it turns to the pointer.

- **The hero** (`components/site/HeroCharacter.tsx`): the h1's full stop is a dot of ink on arrival; the blob, asleep and
  the size of the dot, takes its place, wakes, turns blue and springs up to stand on the baseline (`SPRING_CHAR`), glances
  about, then follows the pointer. A press steps it through listening, thinking, acting and asleep, and the island follows.
  Under 600 px it springs up to stand over the line at 108 px (a 77 px body) and leaves the stop a stop. Calm: it is simply
  there. Its keyboard twin is a hidden button beside the h1 (`HeroPoke`). The stop's advance and the mark's margin keep a
  0.26 em breath between the e and a round body (never under a sixth of an em through the wobble; the line is 8.88 em, so
  `--h1` caps at 145.5 px). It loves the glass Install (`components/site/glass.ts`): its first look once it stands is at
  the key (which lights in reply), and while the key is hovered, focused or touched it turns its eyes to it, squints with
  joy (not again within 2 s), then gazes with lit eyes (a second catchlight) and a brighter halo, and goes back to the
  pointer when it is let go; a press makes it squint again and hop. Calm: one pose, turned to the key with lit eyes.
- **The glass Install** (`components/site/InstallKey.tsx`): the one glass surface, as a key. The cap is the frosted glass;
  its body, 6 px of the blob's ramp in 1.5 px cells, shows as a lit wall and as a halo on the paper that pools under the
  key and fades in up its sides to the same height on both (its density evened for each colour's contrast). Near the
  pointer the key leans a few px; on it the cap rises level and the light gathers under the finger; focus lights it under
  the mark. A press sinks the cap its full depth with a squash, the Apple mark ducks then hops while its leaf wobbles, and
  the light gathered under the finger runs out both ways along the cap's foot as a crest with the flare behind it,
  spilling a few px at the ends and none toward the terms line; the press point flashes only on bare glass.
  The mark and both lines are masked out of the light with a soft moat, so nothing crosses the words. Springs only while
  something moves; calm cuts between rest, lit and pressed.
- **Install** (`components/site/InstallBlob.tsx`): `Then say jarhead.` ends the same way, its stop the blob, asleep until
  any Copy lands (`COPIED_EVENT`), when it wakes and listens and the island wakes with it.
- **Every demo** has its blob: it hears, thinks, acts, flies to the control the hands press, splits into thread blobs,
  frowns `> <` at a refusal, speaks a reason, falls asleep, looks up at the alarm.
- **Cost**: an engine mounts only when its host comes within a viewport of the screen and is released 4 s after it leaves
  (`Character.tsx`); off screen a blob reads no layout. Until it mounts, and without JS, the host shows its phase's still
  (`app/stills/{awake,happy,quiet}.png`, rendered at build by `lib/still.ts` from the orb engine, the halo read from the
  token sheet).

## The sticky top (`components/site/Top.tsx`, `MenuBar.tsx`, `components/desk/*`, `styles/desk.css`)

- **The bar** (37 px; 44 on the phone) is the paper itself with one hairline: the Apple mark, `Jarhead`, the sections as its
  menus (the one in view marked), the phase dot and word, GitHub with the live star count, the theme, Install, the clock.
  Menus drop last first as the bar narrows; the phone keeps the mark, the name, GitHub and the theme, each a 40 px target.
- **The island** is the app's open island at 1:1 (420 × 184) hung from the notch, scaled as one from its top edge: over the
  hero at `--hero-s`, then its foot rises with the scroll until it docks at `--compact-s` (0.62: 37 + 114 = 151 px). It
  never folds. Every word in it takes `max(its size, 11px / --top-s)`. Once docked a band of the page's ground dissolves in
  one-device-pixel Bayer cells under it, a grain that reads as a fade, so words and ink plates thin out before they reach
  the island and never break into a checkerboard; every section's words start below that band.
- **What it wears** (`lib/live.ts`): each demo **claims** the island for its own section with a `Show` (its kind, the line
  it heard or says, its question, its thread tiles, the foot's figure and meter, the clock), and the hero claims it for the
  hero. A claim shows only while its section is in view (`resolveShow`), so the island never wears another demo's state; a
  section that has claimed nothing wears its own kind with nothing heard. The island's own question (`Slack asks: send "I'm
  running late" to Ben?` with Allow and Deny) appears only when a demo asks for it: Threads at `asks`, Rails when Send is
  sorted into Confirm. Any other spoken line (a reason, `night.`, a reading) is said without buttons.
- **Its motion**: a new kind fades the content out over `--jh-quick`, lands, and the island settles from 0.965 on `SPRING`
  from its top edge (`transform-origin: 50% 0`), so it never leaves the notch. The ink breathes, the head's level trace
  moves, Working counts, the face blinks and turns to the pointer, at 8 fps while the tab is visible. Calm: one pose per
  change and a stepped scale.

## The demos (`components/play/*`, `styles/play.css`)

Every demo works by mouse, touch and keyboard, server-renders a still that explains its idea before anything is pressed
(checked with the bundles blocked), claims the island, and replays (its line again, or the labelled `Replay` pill at the
plate's top right). Threads, Hands, Rails and Sleep play their own route once when the plate first comes into view
(`useFirstView`, a third of it on screen) and rest on the frame the route resolves to, which is also their still. Calm
(reduced motion or `#still`) never autoplays, cuts every move (`CUT`) and keeps each blob to one pose.

| id | what it plays | how a visitor plays it | the still | the island |
|---|---|---|---|---|
| `wake` | asleep; say the word and it hears `O O`; the gate rises with its four ways; hold the round Touch ID pad while its ring draws: granted `^ ^`, the lock opens; let go early: `> <`, denied, one of the three small prints on the Hold line is spent; three misses lock the gate for the deck's minute, counted down on the pad | the `Say "jarhead"` chip (Enter moves focus to the pad), then press and hold the pad (pointer with capture, touch, or a held Space or Enter) | the gate waiting for the press | asleep, `jarhead` heard, awake |
| `say` | two deck lines; `"Click Save"` takes the reflex lane in milliseconds and Save is pressed; the Slack and Spotify line goes to the brain picked in Settings, thinks, and ends with Slack and Spotify working in the hands; the wire taken draws along its length | a chip; the brain rows are a radio group (arrows move and pick) | the router at rest, Codex picked, its wires drawn | the heard line, thinking, acting, the two tiles |
| `threads` | the blob splits: two thread blobs spring out of it (a FLIP from its centre, 60 ms apart) along two wires into their cards, each the app's rail row (mark, `00:06 · screen`, a bar per step, its badge); Spotify finishes in the background; Slack stops at `asks` with its question inside the card, Allow focused, Deny | the line chip; Allow or Deny; `"Stop the Slack one"` | Slack asks, Spotify done | thinking, acting with tiles, then the question |
| `hands` | the h2 lights each sentence as its step plays: a ring draws round the control labelled Save and its tag is read; the blob flies on `SPRING_CHAR` to Save and presses it; the window flashes, its corners close in, and a check says the screenshot only verifies; the blob flies home | the `"Click Save"` chip; on a desk the section also pins its plate (plain CSS sticky, 230 svh) and the scroll steps the three sentences | the three steps at once | acting with `Click Save` |
| `rails` | the table always shows what it holds: Run ends on `"Click Save" runs.`; Confirm lists send, pay, delete, post and purchase and asks every time; Refuse lists NEVER's seven commands. A call in the tray springs into its slot (shared layout), a wire draws down the rail into its row, the row lights, the blob says a second deck line (or frowns at a refusal, its command lit in NEVER) | press a tray chip; press a sorted chip to send it back | Send sorted into Confirm | acting for a run, the question for Send, the reason for the other verbs, listening after a refusal |
| `sleep` | asleep at `$0` with the alarm armed, the plate gone to ink; the night runs on the island's own clock from 12:37 to 07:10 and the alarm rings while it sleeps (the row lights, Snooze 10 or Done; Done leaves it asleep, nothing billed); `"night."` says it back, closes the session and runs the night again | the `"night."` chip; Snooze 10, Done (focused when it rings) | asleep, 12:37, the alarm armed | asleep with the running clock, then the alarm |
| `numbers` | the six latencies race in real time on one honest linear scale; each bar is a `scaleX` of a CSS property written by one rAF that runs only while the plate is on screen; the figure and its n land with the bar | the scale (`8.9 s` shows all six to size, `457 ms` makes the reflex rows race and runs the rest off the edge; a radio group with arrows); `Replay` | the finished race | listening |
| `costs` | the serif figure follows the minutes at five cents a minute to three dollars at the hour; the blob talks while you drag; Asleep makes it `$0` | the native range (drag, tap, arrows); Listening or Asleep (a radio group with arrows) | 7.2 min and $0.36, the island's own reading | the reading on its foot and meter, said while dragging; asleep |
| `install` | the blob at the h2's stop wakes on any Copy | `Copy` on the one-liner or a command | asleep | asleep, then listening |

The wires (`components/play/Wires.tsx`) are measured from the laid-out pieces; Say's and Threads' resting wires are also
kept as a measured set (`AT_REST`, taken at 1440) that the server renders stretched to the stage with a stroke that never
scales, so their stills have wires without JS.

## The motion

One set of tokens, in `app/globals.css` and mirrored in `lib/motion.ts`:

- **Durations**: `--jh-instant` 80, `--jh-quick` 160, `--jh-base` 240, `--jh-slow` 400, `--jh-drift` 600 ms.
- **Eases**: out `(0.16, 1, 0.3, 1)` for what arrives, in-out `(0.65, 0, 0.35, 1)` for what changes in place.
- **Springs**: `SPRING` (visualDuration 0.36, bounce 0.14) for the interface (chips, cards, the island's settle);
  `SPRING_CHAR` (0.52, 0.34) for the blob's own moves (the arrival, the flight to Save, the thread split).
- **Rules**: paths draw along their length (Motion `pathLength`, `slow` in-out); the island crossfades its kinds; chips
  move by shared layout; numbers count (the race, the clock, the cost); each section's h2, words and plate rise once on
  first view, 60 ms apart (three at most); direct manipulation never springs (the Costs range writes its value straight).
  Every loop pauses off screen and on a hidden tab; a section's CSS loops pause while it is off screen (`data-inview`).
- **Calm**: `useCalm()` (reduced motion or `#still`, live through `hashchange`) turns every transition into `CUT`; the boot
  script stamps `html[data-still]` for `#still`, so the CSS loops (a spoken chip's level trace, the working dots, the alarm's
  ring) stop exactly as under reduced motion. Scroll-linked choreography only as plain sticky (Hands), never a hijack.

## The sections, with ids

`hero` · `wake` (split) · `say` (stack) · `threads` (split, plate left) · `hands` (stack, pinned on a desk) · `rails`
(split) · `sleep` (split, plate left) · `numbers` (center) · `costs` (split) · `install` (split, the terminal) · the foot.
`components/site/sections.ts` holds each one's id, deck name, resting island kind and plate tone; the menu bar, the spy
(`SectionSpy.tsx`) and the top read it. A split sets its words in 5.3 : 6.7 beside the plate; a stack sets the words as one
row over a full-width plate; center does the same for the race. Sections are a viewport tall on a desk; at 1280 × 720 every
plate ends inside the viewport under the docked top (short desks tighten the plates and start the words below the dissolve).

## Both themes

`html[data-theme]` is the only switch, stamped before paint by the boot script (`lib/theme.ts` `themeBoot`, its
theme-color read from the token sheet by `lib/tokens.ts`); the visitor's system choice wins until they toggle. Light is
the primary design: warm paper, white plates, the tones in their deeper `-line` steps for anything drawn as a line. Dark
is warm ink with the same restraint: the plates a raised ink, the dither a whisper, the tones themselves. The island and
the terminal are ink screens in both. Every canvas (fields, island ink, meters, blobs, the dissolve) re-inks on a flip.
Tokens only: no raw colour outside `app/globals.css` and `styles/kit.css`.

## The phone (390 × 844)

The bar keeps its four items at 40 px; the island shrinks to fit and docks at 0.6. The hero sets the h1 on one line with
its stop, the blob standing over it at 108 px, and the lead, both calls and the terms line all in the first screen. Every
section stacks words first, then its plate; plates reflow by container query (the router, the cards and the table stack,
their wires drop). Every control is at least 40 px. No sideways scroll.

## Adding a demo

1. Take its words from `content/deck.ts` only, cut with `lib/cut.ts` (`part`, `nth`, `quoted`, `row`, ...), never reworded.
   A control word the deck lacks goes in `UI` (verbs only, six at most; today `Replay` and `Hold`).
2. Add a row to `components/site/sections.ts` (id, deck name, resting island kind, plate tone).
3. Write `components/play/<Name>.tsx` as a client component on a `Plate`: a server-rendered still that explains the idea, a
   `Character` where the blob belongs, `Utter` for anything said, `claim("<id>", …)` for the island, `useSteps` for its beats,
   `useCalm` for cuts, `Replay` to start again, and `useFirstView` if it should play itself once.
4. Put it in `app/page.tsx` inside `<Section meta h2 lead notes layout>`; style it in `styles/play.css` on tokens, with its
   container query for narrow plates and its short-desk rule.
5. Typecheck, build with `--webpack`, and look at it at 1440 × 900, 1280 × 720, 1920 × 1080 and 390 × 844 in both themes,
   with the bundles blocked, under reduced motion, and by keyboard alone.
