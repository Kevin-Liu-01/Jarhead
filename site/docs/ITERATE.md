# ITERATE · Kevin (2026-09-29), on the live Console site (main bafb888): seven concrete asks

Verbatim: "make the install button be bigger and have the icon system requirements and stuff in that button, like
it is on other sites that ask u to install, and make it glassmorphic like actual apple. make the github have stars
and show star count. make your mac, by voice one line. finally make the jarhead attached to an actual dock
representation, and make the states a lot better, and make each section far more understandable and have side by
side layouts with good space" and then "make the threads thing in left show actual threads and show a bunch of
agent conversations in the agents section".

The site is `/Users/kevinliu/jarvis/site` at main bafb888 (read-only for agents; copies under `S/it/`). It is the
Console design of IMMERSE.md: title bar, the island peeking over the top edge, the left rail of sections and
agents, the Now stream, the right rail that follows, the composer. Keep all of that; change what follows.

## 1 · The install button: big, with the mark and the requirements inside, Apple glass

The hero's primary call becomes a large two-line button, the way download buttons on install pages look:
- Left: the Apple mark (thesvg `apple`, mono, 20 px) or the kit's own Dock-icon mark (the dithered orb at 24);
  the eye judge decides which reads as "install on a Mac". Then two lines: line 1 `Install` (deck `HERO.install`)
  at 17 px/500; line 2 the requirements at 12 px `--jh-fg-2`: `macOS 14+ · Apple silicon · source only` (from the
  deck's figures line and INSTALL.label; the deck's `v2.0.0` may lead the line). Height 56–60 px, padding 14 × 20,
  radius 14, min-width 300 at 1440; full width on the phone.
- Material: Apple's glass, deliberately (Kevin's ask overrides facts-canon §8.5 for THIS ONE SURFACE): `backdrop-
  filter: blur(24px) saturate(180%)`, a translucent fill (dark: rgba(255,255,255,.10); light: rgba(255,255,255,.55)),
  a 1 px hairline at rgba(255,255,255,.18) / rgba(0,0,0,.10), an inner top highlight (`inset 0 1px 0 rgba(255,255,255,.22)`),
  hover lifts the fill by .04, active presses it, focus ring the kit's. It sits over the dithered ground so the
  blur shows the dither through it. Nothing else on the page is glass.
- Behaviour: scrolls to `#install` (no download exists: source only); the composer's Copy stays the copy action.
  The title bar keeps its small kit `Install`.

## 2 · GitHub with stars

Both GitHub buttons (title bar, hero `Read the source`) show a star glyph and the live star count:
- A kit-style filled star glyph (draw it in `components/kit/Glyph.tsx` as `star`, 20-unit box, the family's weight).
- The count from `https://api.github.com/repos/Kevin-Liu-01/Jarhead` (`stargazers_count`, no token): fetched in a
  server component with `fetch(url, { next: { revalidate: 3600 } })`, formatted (`6`, `1.2k`), with a client-side
  refresh from the same endpoint on mount (cache in sessionStorage; silent on failure) and a graceful fallback (the
  glyph alone) when the fetch fails at build. Layout: `[github mark] GitHub  ★ 6` in the title bar tile;
  `[github mark] Read the source · ★ 6` in the hero.

## 3 · The headline on one line

`Your Mac, by voice.` on ONE line at 1440 (the stream column is ~850 px: 48–52 px Inter 500 fits); the deck's two
h1 strings join with a space. On the phone it may wrap to two lines.

## 4 · The blob attached to the dock (Kevin's "dock" = the notch island; memory kevin-vocabulary-dock-means-notch)

Today the island peeks over the title bar and the blob floats beside the h1, disconnected. Make them one thing,
as in the app: the notch and the island drawn at 1:1 at the top of the stream's first conversation (under the
title bar, centred), the blob TUCKED INTO / HANGING FROM the notch in the docked state (the app's tucked lip with
the face, `notch-tucked.png`, `notch-peek.png`), and when a kind is active the island opens under the notch
(420 × 184) with the blob in its anchor band (`notch-island-working.png`, `notch-island-alarm.png`,
`notch-island-marks.png`). The free-floating hero blob goes. The blob's flight into the notch when it sleeps
(the desk engine has it) is the one motion beyond the kinds.

## 5 · The states, a lot better

Each kind renders the island as the app renders it (NotchPanel.swift's four bands: anchor with face + word,
display line, control row, foot; see facts-media.md §3 and the PNGs), richer and exact:
- listening: the Say box typing the utterance, the meter running, `O O`;
- thinking: `- -`, the ASCII glyph ramp ticking in the display line, "Thinking";
- acting: `> >` looking along the travel, the thread tiles `Slack · working · 0:08` and `Spotify · working · 0:08`
  with their Stop squares, the target ring, "Working · 0:08";
- speaking: `^ ^`, the caption line (`Slack asks: send "I'm running late" to Ben?`), the Allow / Deny tiles;
- asleep: the tucked lip with `- -` and the pill `☾ asleep · next Timer 11:56 · pasta` (the app's own text);
- alarm: `07:10 · Wake up, Kevin · weekdays`, `Monday · standup notes at 9`, `Snooze 10 · Done · 5 · 30`, the
  chime dot, the hairline in the alarm tone.
The Segments phase control (six cells, face + word) drives the island; the timeline cycles when idle; the
right rail's Session card and the phase word in the title bar follow. Island strings are the app's own rendered
text (design.md §4.4; the COPY.md note); no new claims.

## 6 · Sections side by side, understandable, with good space

Inside the Now stream every section becomes a two-column frame: one column of words (the h2 on one or two
lines at 26 px, the lead at 15 px ≤ 52ch, then the three glyph rows) and one column holding the section's ONE
picture in a drawn frame (a capture at 0.5×, an island state strip, a blob pose, the Setup window) with a
one-line caption under it from the deck's alt list. Columns 1fr / 1fr at ≥ 1240 with a 40 px gutter, the
picture side alternating or fixed (the eye judge decides), 40 px between rows, 56 px between sections (the
section rule stays). Under 1240 the columns stack, picture first. The right rail's group for the section stays
beside it. No empty stretches: the words column's rows sit at the top; the picture column fills its frame.
"Far more understandable": every section answers one question in its h2 and shows the thing in its picture;
the three rows are facts, each a glyph + one line.

## 7 · The left rail: real threads and a bunch of agent conversations

Mirror the app's rail (console-jarhead.jpg, console-threads.jpg; the app's own strings are allowed):
- Under the sections, a `Threads 3 · 1 asks` group: `Slack · asks · 00:06 · screen · 4 steps`, `Spotify · done
  · 00:06 · background · 2 steps`, `Notes · done · 00:03 · background · 3 steps`, each with its dot in the lane
  tone and a Stop square; `Pinned 1 · Auth branch triage · 11:20`; `Today 1 · Pull up my ses… · +1 · 14:15`;
  `Yesterday 2 · 4.2 min`; `Older 3 · since Sep 9`; `Archived 2 · 2 · 15 min`; `Trash 2 · 3 days · 129 MB`
  (quiet orbs for closed ones).
- `Agents 7`: `Claude Code 5` open with `gt · api auth · asks · gt · 6m`, `brain · working · ~ · 5s`,
  `jarhead · console · working · mac · 2m`, `kevin-wiki · idle · 31m`; `Ended 1 · 7m`; `Codex 4 · ended · 40m`;
  `Cursor 1 · idle`, with the agent marks (kit AgentMark) and status badges. The rail scrolls if taller than
  the window (the app's does). On the phone the rail strip keeps the sections; threads and agents fold into the
  Threads and Hands sections' right-rail groups.

## Non-negotiables

IMMERSE.md's rules stand (Jarhead's surfaces, dithered grounds, the kit's glyphs, the app's density, COPY.md
strings or the app's own rendered text, both themes, a11y, no claim outside facts-product.md). The one
exception is §1's glass. Never `pnpm install` in a copy; dev servers with `./node_modules/.bin/next dev
--webpack --port <port>`. Ports: designers 3981–3983; judges 3991–3993; the review on the winner's port.

## Judging bar

Each of the seven asks scored 1–10 by Kevin's eye against the app's captures and Apple's own install buttons
(a glass button as on apple.com: frosted, hairline, a mark and two lines); the visitor for understandability
(each section's question answered, install obvious); the copy editor for strings. A design missing any of
the seven asks scores under 5.
