# Mailroom as a reference for the Jarhead landing page

Read 2026-09-25 from `/Users/kevinliu/repos/mailroom` (read-only) and the captures in
`scratchpad/site/mailroom/` (`hero.png`, `view-0..9.png` at 1440×900 css / 2×, `v-hero.png`, `v-view-0..5.png` at
1400×875 / 1×, `phone.png` at 390×844 / 2×, plus the live `index.html` and compiled `site.css`).

Two facts to hold before anything else:

1. **The live site is commit `25be019` ("Berkeley Mono only")**. The working tree is ahead of it, uncommitted:
   Inter is added for headings and display numbers (`layout.tsx:11-20`, `globals.css:60,71-72`), the labels/cost/trust
   cards get a `.display` class (`page.tsx:84,113,124`), `HeroScene.tsx` is rewritten (open buckets, standing letters,
   letters in flight), `Brand.tsx`, `/privacy`, `/terms` are new. **Every capture shows the live (HEAD) state: Berkeley
   Mono everywhere, including the headings.** Line numbers below are the working tree; where HEAD differs I say so.
2. **The captures rendered in the dark theme** (the capture browser preferred dark). Luminance checks on the PNGs match
   the dark tokens exactly: page 0 (`#000`), panel 10 (`#0a0a0a`), surface 20 (`#141414`), line 43 (`#2b2b2b`),
   ink 244 (`#f4f4f4`). The light palette is `globals.css:4-23`.

Measures are css px at a 1440-wide viewport unless marked (phone = 390). Viewport-derived values at 1440:
`--section-space` = 129.6 (9vw), `--gutter` = 72 (5vw), frame = 1280, content column = 1134 (x 153→1286).

---

## 1. Page anatomy, section by section

Structure (`layout.tsx:45-74`, `page.tsx:28-136`): `header.frame` → `div.frame.hatch` → `main.frame` (sections
separated by `<ReticleSpacer/>` = a hatch band with four corner crosses) → `div.frame.hatch` → `footer.frame`.
Every top-level band shares one 1280px rail with a 1px `--line` border on both sides; nothing is full-bleed.

### 1.0 Global frame (every capture)

| thing | measure | source |
|---|---|---|
| rails | x = 80 and x = 1359 → 1280 wide; phone x = 10 and 379 → 370 wide | `.frame` `globals.css:76-77` |
| header | 68 tall (y 0–67), bottom hairline at y 67, sticky, opaque | `layout.tsx:45` `min-h-[68px]` |
| hatch under header | y 68–89 = **22 tall** incl. both hairlines; 45° 1px stripe every 7px at 9% ink | `.hatch` `globals.css:78` |
| gutter | 72 each side (content x 153→1286); phone 24 | `--gutter` `globals.css:21` |
| section padding | 129.6 top and bottom; phone 72 | `--section-space` `globals.css:20`, `.section` `:88` |
| wordmark | 17px bold, tracking .02em, glyph rows 27–38, blinking ▮ after it | `BrandMark.tsx:17-21`, `.cursor` `globals.css:130` |
| nav links | 12px bold uppercase, tracking .14em, muted, gap 24, hidden below md | `layout.tsx:49-54` |
| theme toggle | 42×42 square button at x 1182–1223 (half-disc glyph) | `ThemeToggle.tsx:21-26` |
| GitHub button | 103×42, mark + label, label hidden below sm | `layout.tsx:57` |
| right cluster inset | 24 from the rail (`px-6`), gap 8 | `layout.tsx:45,55` |

Phone header (`phone.png`): mark 28 + wordmark left; toggle 42×42 at x 267–308 and an icon-only GitHub button
46×42 at 317–362 on the right; nav hidden; hatch still 22 (y 68–89).

### 1.1 Hero — `hero.png`, `v-hero.png`, `phone.png`, `view-0.png` (scrolled)

`page.tsx:30-51`. `section.section.relative.grid.items-center.gap-12.lg:grid-cols-2.lg:gap-16`; a `.dither` dot field
behind (8px dot grid at .14 opacity, masked to an ellipse centred at 70% 50%, `globals.css:90`).

| thing | measure |
|---|---|
| columns | 2 × 536, gap 64 |
| h1 | `clamp(44px,6.4vw,92px)` → 92px, line-height .98, tracking −.04em; three lines "Your / Gmail, / sorted." at glyph rows 235–298 / 321–405 / 411–478 (≈90 pitch). Phone: 44px, two lines, rows 167–206 / 210–242 |
| lede | 21px (`clamp(17px,1.5vw,21px)`), line-height 1.375 (`leading-snug`), muted, `max-w-[640px]`, `mt-5`; three lines at rows 515–535 / 545–564 / 574–588 (29 pitch). Phone 17px, four lines, 23.4 pitch |
| buttons | `mt-8`; row 629–670 = **42 tall**; primary "Connect Gmail" 161 wide (x 153–313), secondary "How it works" 129 wide (326–454); gap 12 (`gap-3`). Phone: both fit on one row (35→336) |
| note | `mt-6` (24); 14px muted; rows 700–713: "Every run previews first and can be undone." Phone wraps to two lines |
| illustration | `<svg viewBox="0 0 640 430">` filling the right column → 536×360; drawn content x 766–1267, y 314–630 (`HeroScene.tsx:118`). Phone: full width under the copy (`gap-12` = 48), 322×216 |
| section height | y 90 → ≈848 (129.6 + ~500 content + 129.6) then the hatch |
| entrance | `.rise` stagger: h1, lede (+.08s), buttons and scene (+.16s), note (+.24s) |

### 1.2 How it works — `view-1.png`, `v-view-1.png`

`page.tsx:55-59` + `RunFlow.tsx`. h2 two lines, lede, then the numbered triptych `mt-12` (48) below the lede.

| thing | measure |
|---|---|
| h2 | `clamp(34px,4.6vw,64px)` → 64px, line-height 1.05, tracking −.03em (`page.tsx:17`); white line glyph rows 156–204 (cap 48), muted second line rows 224–284 (68 pitch) |
| lede | rows 309–357 (2 lines, 29 pitch), `mt-5` |
| cards | top 408, bottom 732 → **324 tall**; x 153–458, 567–872, 981–1286 → **306 wide**; connector columns **108 wide** (`RunFlow.tsx:71` `sm:w-[108px]`) |
| card anatomy | `.card` (24 padding, 1px line, radius 6, panel bg); `01` 11px mono muted at `left-4 top-3` (glyph rows 427–436); art `<svg viewBox="0 0 200 140">` full width (≈258×181); title 16px bold + 17px lucide icon at rows 626–640 (`mt-2`); caption 14px/1.375 muted at rows 654–702, three lines (`RunFlow.tsx:85-90`) |
| connector | a `.wire` + `.signal` dash sliding left→right (96×24 viewBox), 12px medium muted centred label: "Primary mail no rule placed", "answers past your thresholds" (`RunFlow.tsx:67-77`); on phone the wire turns vertical (24×56) |
| hatch after | rows 863–884 (22) |

### 1.3 Search — `view-2.png`, `v-view-2.png`, top of `view-3.png`

`page.tsx:63-67` + `SearchDiagram.tsx`. h2 "Ask in plain words. / Get a Gmail query.", lede, then one full-width
**figure**: `figure.card.card--surface.m-0.overflow-hidden.p-0` (surface bg #141414 dark / #f1f1f1 light), 1134 wide,
top at y 424.

Inside, top to bottom: a padded 16–20px zone with an input row 48 tall (`bg-panel`, 18px search icon, 16px semibold
query, `.kbd` "Enter" at the right) → a `Down` connector (36px vertical wire + 11.5px bold uppercase tracking .12em
muted label "COMPILE") → three `.chip.chip--accent` (24 tall; 163/149/142 wide; icons 13px) → a `pre.mono` query box
13.5px → `Down` "RUN, THEN RERANK WITH JEV" → a `bg-panel` result list (rows ≈64 tall, 16px check tile, 14px
semibold from / 13px muted subject, mono date, 48px `.meter` + mono score) → a footer strip: `.chip` "3 results,
reranked" left, four `.btn.btn-sm` (32 tall) right.

### 1.4 What to trash — `view-3.png`, `view-4.png`, `v-view-3/4.png`

`page.tsx:71-75` + `TrashDiagram.tsx`. h2 "Decide once, / sender by sender.", lede "Jev scores every sender. You click.
It becomes a standing rule.", the same figure frame: header row (`.eyebrow` "Sender scan" left, "Reclaimable **382**
messages" right), four `bg-panel` rows ≈92 tall (mono sender 13.5 bold, 12.5 muted kind, verdict chip at the right,
then a 6px `.meter` with "214 msgs" / "0% read" in 12.5 mono), footer strip: `.btn-primary.btn-sm` "Apply 382 changes",
`.btn.btn-sm` "Undo", `.chip` "becomes a standing rule" pushed right. The one verdict that acts ("Trash after 30
days") is the inverted chip; "Keep, records" sits on surface; "Protect, human" is the plain chip.

### 1.5 Policy — `view-4.png`, `view-5.png`, `v-view-4/5.png`

`page.tsx:79-90`. h2 "Thirteen labels. / Nothing custom." with **no lede before the grid**; a 3-column grid of
`.card.flex.items-center.justify-between.py-5` (gap 12, cards 370×74; label 19px bold live / 21px `.display` in the
working tree, glyph rows 91–108; chip at the right, 24 tall, "protected" 95 wide; the inverted chip only for "skips
inbox"). Then the lede **after** the grid (`mt-5`, rows 420–469): the never-line
"Never sends. Never unsubscribes. Never deletes for good. Never trashes work, people, or money."

### 1.6 Five typed questions — `view-5.png` (bottom), `view-6.png`

`page.tsx:94-100` + `JudgmentCard.tsx`. `section.grid.items-center.gap-12.lg:grid-cols-2`: left column h2 (wraps to
four lines at 64px in a 543 column: "Five typed / questions. / One judgment / per email.") and lede "Metadata only.
Probabilities, not prose. Judged once, cached forever."; right column the JudgmentCard figure, 543 wide (x 744–1286):
header row (16px Stamp icon + bold "One judgment", `.chip--accent` "metadata only") → a `dl` of 13px metadata with
mono keys → "Category (Choice)" block with three meters → "Four Nouls" block with meters that carry a 2px threshold
tick → footer strip of chips and "**1,212** tokens, $0.0001".

### 1.7 Cost — `view-7.png`

`page.tsx:104-118`. h2 "Rules are free. / Judgments cost cents." (rows 108–156 / 177–237), no lede, three
`.card.py-8` (367 wide, gap 16, **150 tall**): figure `clamp(40px,5vw,64px)` live → 64px bold leading-none (glyph rows
312–367; working tree `clamp(44px,5.5vw,72px)` `.display`), caption 16px muted `mt-3` (rows 390–405). Strings: "$0 /
for every rule, every day", "$0.05 / per 1,000 emails judged" (computed: 1000 × 1300 tokens × $0.042/M,
`triage.ts:11,88`), "$0.25 / cap per run, yours to change" (`schema.ts:84`).

### 1.8 Trust — `view-7.png` (bottom), `view-8.png`

`page.tsx:122-131`. h2 "Your mail stays / in Google.", 2×2 grid of `.card.py-7` (559 wide, gap 16; one-line cards
≈85 tall, two-line ≈115) with 26px bold sentences (`clamp(18px,2vw,26px)` live; 28px `.display` in the working tree;
glyph rows 177–201 / 215–228), then the lede caveat after the grid: "Unverified with Google for now: the owner and up to
100 people can connect."

### 1.9 Closing band + footer — `view-8.png` (bottom), `view-9.png`

`ClosingBand.tsx`. A hatch (rows 469–490), then a section whose tokens are swapped so it is the page inverted
(dark theme: `#f4f4f4` plate with `#0a0a0a` text; light theme: ink plate with paper text). In `view-9.png` the band
spans y 225–818 (594 tall = 129.6 + 335 + 129.6), centred: `BrandMark` 56 (rows 353–408) → h2 `mt-6`
`clamp(32px,4.4vw,60px)` semibold, line-height 1.12, tracking −.04em, "Connect Gmail. / Preview the first run." with the
second line muted → lede 17px `max-w-[520px]` (rows 571–614, 27 pitch) → `mt-7` buttons 42 tall (647–688): primary
161 wide, "Read the source ↗" 177 wide, gap 10. Then a hatch (819–840) and the footer (`layout.tsx:71-74`): 12px muted,
`py-5` (text rows 862–877), left `BrandMark 16` + "metadata only · tokens encrypted at rest · every run undoable ·
nothing is ever sent or permanently deleted", right "judgments by TypeSafe Jev · built by Kevin Liu" (working tree adds
"privacy" / "terms" links before it).

---

## 2. Tokens and CSS devices (file:line in `/Users/kevinliu/repos/mailroom`)

All in `src/app/globals.css` unless noted. HEAD (live) line numbers = working tree − 1 for lines 61–71 and − 2 from
`.frame` onward (the working tree inserted `--font-display` at 60 and an `h1` rule at 72).

### Colors — `globals.css:4-41`
```
:root  --page #ffffff  --ink #0a0a0a  --muted #6a6a6a  --line #d6d6d6  --surface #f1f1f1  --panel #ffffff
       --inverse #ffffff  --action-hover #2a2a2a  --accent/--accent-deep/--warn/--danger = #0a0a0a
       --accent-soft/--warn-soft/--danger-soft = #ebebeb
dark   --page #000000  --ink #f4f4f4  --muted #9b9b9b  --line #2b2b2b  --surface #141414  --panel #0a0a0a
       --inverse #000000  --action-hover #d9d9d9  accent/warn/danger = #f4f4f4  *-soft = #1e1e1e
```
No hue anywhere: "accent", "warn", "danger" are all ink; emphasis is weight, fill, inversion and hatching
(comment at `globals.css:3`). Tailwind v4 maps them at `:43-61` (`bg-page`, `text-muted`, `border-line`, …).
Theme is `html[data-theme]`, set before paint by the inline script at `layout.tsx:31,44`, persisted as
`localStorage['mailroom-theme']`.

### Spacing — `globals.css:20-21,76-77,88-89`
- `--section-space: clamp(72px, 9vw, 136px)` — 129.6 at 1440, 126 at 1400, 72 on the phone.
- `--gutter: clamp(24px, 5vw, 72px)` — 72 at 1440, 24 on the phone.
- `.frame { width: min(calc(100% - 48px), 1280px); margin-inline: auto; border-inline: 1px solid var(--line); }`
  and `@media (max-width: 720px) { .frame { width: calc(100% - 20px); } }` — **the rail**.
- `.section { padding: var(--section-space) var(--gutter); }` and `.section + .section { border-top: 1px solid var(--line); }`.
- `html { scroll-padding-top: 96px }` (`:64`) so anchor jumps clear the 68px header + hatch.

### The hatch band with corner crosses — `globals.css:78-87`, `Section.tsx:5-14`
```
.hatch { position: relative; height: 22px; border-block: 1px solid var(--line);
  background: repeating-linear-gradient(45deg, transparent 0 6px, color-mix(in srgb, var(--ink) 9%, transparent) 6px 7px); }
.hatch--tall { height: 40px; }
.reticle { position: absolute; z-index: 5; width: 11px; height: 11px; pointer-events: none; }
.reticle::before, .reticle::after { position: absolute; background: var(--ink); opacity: .55; content: ""; }
.reticle::before { top: 5px; left: 0; width: 11px; height: 1px; }   /* the horizontal arm */
.reticle::after  { top: 0; left: 5px; width: 1px; height: 11px; }   /* the vertical arm  */
.reticle--tl { top: -6px; left: -6px; }  --tr  --bl  --br likewise
```
`ReticleSpacer` = `div.hatch` + four `i.reticle`. The crosses straddle the band's corners at −6px, so each cross
is centred on the intersection of a rail and a hatch hairline. The header/footer hatches (`layout.tsx:68,70`) have no
crosses; only the seams between sections do.

### The card — `globals.css:108-110`
`.card { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 24px; }`,
`.card--surface` (surface bg, used as the figure frame), `.card--ink` (inverted). Page usages: `py-5` (label grid),
`py-7` (trust), `py-8` (cost), `p-0 overflow-hidden` (figures).

### The numbered card — `RunFlow.tsx:79-95`
```
<div class="card relative flex flex-col">
  <span class="mono absolute left-4 top-3 text-[11px] font-semibold text-muted">01</span>
  <svg viewBox="0 0 200 140" class="block w-full"><Patterns prefix="flow-01"/>…iso art…</svg>
  <div class="mt-2 flex items-center gap-2 text-[16px] font-bold"><Icon size=17/>Rules</div>
  <p class="mt-1 text-[14px] leading-snug text-muted">Filters label mail on arrival. A daily pass ages out the noise.</p>
</div>
```
Grid: `sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]`, `Connector` between (`:69-77`).

### The pill badge — `globals.css:111-114`
`.chip { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid var(--line);
border-radius:999px; font-size:11.5px; font-weight:700; letter-spacing:.02em; color:var(--muted);
background:var(--panel); white-space:nowrap; }` → 24 tall. `.chip--accent` inverts (page on ink),
`.chip--warn` ink border, `.chip--danger` hatched fill. Icons inside are 12–13px lucide.

### Buttons — `globals.css:94-102`
`.btn, .btn-primary, .btn-danger { min-height:42px; padding:8px 14px; gap:8px; border:1px solid var(--ink);
border-radius:4px; font-size:13.5px; font-weight:700; letter-spacing:.01em; … }`;
hover `box-shadow: 3px 3px 0 var(--ink); transform: translate(-1px,-1px)` (120ms); `.btn-primary` ink fill;
`.btn-danger` hatched; `.btn-sm` 32 tall / 12.5px. `.input:focus` uses the same hard shadow (`:105`).

### Nav — `layout.tsx:45-67`
`header.frame.sticky.top-0.z-50.flex.min-h-[68px].flex-wrap.items-center.justify-between.gap-3.border-b.border-line.bg-page.px-4.py-2.sm:px-6`;
brand link (`BrandMark 28` + `Wordmark`), `nav.hidden.md:flex.gap-6.text-[12px].font-bold.uppercase.tracking-[.14em].text-muted`
with four anchors, right cluster `ThemeToggle` + `a.btn` GitHub (+ Dashboard / Sign out when signed in).

### Theme toggle — `ThemeToggle.tsx:12-28`
A `.btn` forced to `width: 42, padding: 0`; an 18px SVG: a 7.5-radius circle stroke 1.6 with a half-disc path that
flips side by theme (`M10 2.5a7.5 7.5 0 0 0 0 15z` dark / `…0 0 1 0 15z` light). `useSyncExternalStore` on a custom
window event; writes `documentElement.dataset.theme` and localStorage. `aria-label` "Switch to paper" / "Switch to ink".

### Other devices
- `.dither` hero dot field `globals.css:90`; `.grid-paper` 24px grid `:91` (used by the OG image, not the landing).
- `.meter` 6px bar with 1px line border, ink fill, hatched fill for warn/danger `:122-124`.
- `.kbd` `:117`, `.eyebrow` 12.5px bold muted `:115`, `.mono` `:116`, `.leaders` dotted leaders `:125-127`.
- `.cursor::after` blinking ▮ `:130-131`.
- Motion: `.signal` `:132` (dash 2/12, stroke 1.4, 3.2s linear, `stroke-dashoffset → -42` at `:134`), `.wire` `:133`
  (ink 45%, 1.2, non-scaling), `.rise` `:135-137` (.6s `cubic-bezier(.22,1,.36,1)`, 10px lift, .08s steps),
  `<animateMotion>` letters in `HeroScene.tsx:101-111` (5.2s, begin j×.9s; `.travel` hidden under reduced motion
  `:140`). Everything is off under `prefers-reduced-motion` (`:138,140`). No scroll-triggered motion.
- ClosingBand inversion `ClosingBand.tsx:6-18`: `--ink`/`--page` swapped, `--panel`/`--surface`/`--line`/`--muted`
  re-derived as `color-mix` of the band's paper colour, so chips and buttons keep working inside the band.

---

## 3. Type system

### Files and license
- `src/app/fonts/BerkeleyMono-Regular.woff2` (37,348 B), `BerkeleyMono-Bold.woff2` (38,268 B), plus
  `BerkeleyMono-Regular.ttf` / `BerkeleyMono-Bold.ttf` (used only by `opengraph-image.tsx:12-13` for `next/og`).
  Loaded by `next/font/local` at `layout.tsx:12-19` as `--font-berkeley`, weights 400 and 700, `display: swap`.
- **There is no license file beside them.** `find` over the repo (excluding node_modules) returns no LICENSE/EULA;
  the only comment is `layout.tsx:11` "Licensed copy, self-hosted." The embedded `name` table of both TTFs says:
  - name 0: `© Copyright 2022, Berkeley Graphics LLC. All Rights Reserved.`
  - name 13 (license description): **`Proprietary and Non-transferrable.`**
  - name 14 (license URL): `https://berkeleygraphics.com/typefaces/license`
  - version 1.009, designer Neil Panchal.
  Nothing on disk says the copy may be used on another site, so the verdict for Jarhead is **Inter only** (section 6).
- Inter: the working tree adds `Inter` from `next/font/google` (`layout.tsx:20`, `axes: ["opsz"]`) as `--font-inter`
  → `--font-display` (`globals.css:60`). Not on the live site.

### Roles (working tree; live = Berkeley Mono for all of it)
- `body` `globals.css:65`: `font-family: var(--font-sans)` = Berkeley Mono, **15.5px / 1.6**, `tabular-nums`, antialiased.
- `h1, h2, h3, .display` `:71`: `font-family: var(--font-display)` (Inter), weight 700, tracking −.035em,
  `font-feature-settings: "cv11", "ss03"`, `text-wrap: balance`; `h1` tracking −.045em (`:72`). Live: `letter-spacing:
  -0.01em; font-weight: 700` on Berkeley Mono (HEAD `:70`).
- Everything else (nav, chips, buttons, ledes, captions, meters, footer, SVG stencils) is the mono at 700 or 400.

### Scale (Tailwind arbitrary values on the elements)
| role | size | line-height | tracking | weight | where |
|---|---|---|---|---|---|
| h1 | `clamp(44px,6.4vw,92px)` = 92 @1440, 44 @390 | .98 | −.04em | 700 | `page.tsx:33` |
| h2 | `clamp(34px,4.6vw,64px)` = 64 @1440 | 1.05 | −.03em | 700 | `page.tsx:17` |
| closing h2 | `clamp(32px,4.4vw,60px)` = 60 | 1.12 | −.04em | 600 | `ClosingBand.tsx:25` |
| stat figure | `clamp(44px,5.5vw,72px)` (live 40/5vw/64) | 1 | inherits | 700 | `page.tsx:113` |
| trust sentence | `clamp(20px,2.2vw,28px)` (live 18/2vw/26) | 1.25 | | 700 | `page.tsx:124` |
| label card | 21 (live 19) | 1.25 | | 700 | `page.tsx:84` |
| lede | `clamp(17px,1.5vw,21px)` = 21, `max-w-[640px]` | 1.375 | | 400 | `page.tsx:18` |
| closing lede | 17, `max-w-[520px]` | 1.6 | | 400 | `ClosingBand.tsx:30` |
| note under buttons | 14 | 1.6 | | 400 muted | `page.tsx:46` |
| card title | 16 + 17px icon | | | 700 | `RunFlow.tsx:88` |
| card caption | 14 | 1.375 | | 400 muted | `RunFlow.tsx:89` |
| connector label | 12 | 1.375 | | 500 muted | `RunFlow.tsx:74` |
| figure step label | 11.5 uppercase | | .12em | 700 muted | `SearchDiagram.tsx:15` |
| nav | 12 uppercase | | .14em | 700 muted | `layout.tsx:49` |
| chip | 11.5 | | .02em | 700 | `globals.css:111` |
| button | 13.5 (sm 12.5) | | .01em | 700 | `globals.css:94,102` |
| card number | 11 mono | | | 600 muted | `RunFlow.tsx:86` |
| footer | 12 muted | 1.6 | | 400 | `layout.tsx:71` |
| SVG stencils | 9.5 / 7 / 11.5 uppercase, letter-spacing 1.2–2 | | | 700 | `iso.tsx:51`, `HeroScene.tsx:86-90` |

### The two-line heading with the muted second line
Every h2 on the page is literally `<h2>{line one}<br /><span className="text-muted">{line two}</span></h2>`
(`page.tsx:56,64,72,80,96,105,123`, `ClosingBand.tsx:25-29`). Line one is the claim, line two the consequence or
qualifier, both end in a period, 2–4 words each; the muted colour is `--muted` (#9b9b9b dark / #6a6a6a light), the
same token as the lede, so heading line two and the lede share one grey. `SectionHeading` in `Section.tsx:16-30` is a
second, unused-on-landing shape: eyebrow 12.5px + the same two-line h2 at `clamp(30px,3.7vw,52px)` + the lede in a
right column (`lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)]`, `items-end`).

---

## 4. Illustration system

### Construction — `src/components/landing/iso.tsx`
- Points live in (u, v, z): `iso(u, v, z) = [(u − v)·COS, (u + v)·SIN − z]` with `COS = .866`, `SIN = .5`
  (`:8-14`) — true 30° isometric, u runs down-right on screen, v down-left, z up. `plane(u, v, z)` (`:19-22`) is an
  SVG `matrix()` that maps local x/y onto the horizontal plane so text and flaps can be drawn "on" a face.
- `IsoBox` (`:76-89`) draws a box as its three visible faces (left = +v face, right = +u face, top), each a
  `<polygon>` with `strokeWidth 1`, `vectorEffect: non-scaling-stroke`, `strokeLinejoin: round`; optional drop shadow
  polygon offset (+5,+5)…(+11,+11) at 7% ink. Children render on top of the box (used for stamps, belt slats, vents).
- **Fills are all `color-mix` of theme tokens** (`:24-45`): `tones.plain` top = panel 94% over page, left = ink 9%
  over panel, right = ink 15%; `tones.accent` uses `--accent-soft`; `tones.dark` = ink 84/92/97% (the sorter). Strokes
  are ink at 26–34% (plain) or 100% (dark). So one drawing renders in both themes with no second palette.
- Emphasis fills are SVG patterns, one `<defs>` per SVG with a unique prefix (`Patterns`, `:54-65`): 45° hatch
  (6px cell, 1.2 stroke at 60% ink) and a dot screen (5px cell, r .9).
- Vocabulary: `Wire` (`:107-114`) = a static 1.2 `.wire` at 45% ink plus an animated `.signal` dash on the same
  path; `Port` (`:92-96`) = a 5px accent hexagon where a wire meets a face; `Hex` (`:99-104`) = a floating 9px packet,
  outlined or filled; `Envelope` (`:117-125`) = a 30×20×3 box with a flap path on its top; `Stamp` (`:128-138`) = a
  60×44 dashed "JEV / SORTER" tape drawn with `plane()` on a top face; `svgText` (`:51`) = uppercase, letter-spaced,
  bold mono for every label inside a drawing.
- `HeroScene.tsx` (working tree): 640×430 viewBox, origin (190, 262); five `Bucket`s of half-footprint 27, wall 50,
  rim 4, spaced 62 along u, each with an interior floor and two inner walls at 78/62/48% ink, standing letters inside,
  a stencil on the front-left face via a shear matrix (`faceLeft`, `:42-45`), the Trash bucket hatched with a "30 DAYS"
  inverted tag; a dark sorter 104×104×70 with a slot, three vent ellipses and the stamp; a belt 36×74×8 with slats and
  a signal wire; a stack of four envelopes; wires from staggered sorter ports along the ground and up into each mouth;
  `FlyingLetter`s on `<animateMotion>`. Live (HEAD): the same vocabulary, the bins stacked "down the screen along (1,1)"
  as closed boxes with hatched/dotted lids and labels to their left (what `hero.png` shows).
- `RunFlow.tsx:6-58`: three 200×140 tiles — three stacked sieve trays (`RulesTile`), the sorter at `size .64` with two
  output ports (`JudgeTile`), a slab with a perforated receipt and an undo arrow (`ReceiptTile`). Icons inside tiles are
  hand-drawn paths, not lucide.

### How drawings sit
- The hero drawing is bare in the grid's right column over the `.dither` field: no card, no frame.
- The triptych tiles sit **inside** `.card` at the top, full width, above the title (`RunFlow.tsx:87`).
- The other three "diagrams" are not drawings at all: `SearchDiagram`, `TrashDiagram`, `JudgmentCard` are HTML
  **figures** — `.card.card--surface.p-0.overflow-hidden` with `bg-panel` rows, chips, meters, `.btn-sm` strips and
  vertical `Wire`s as step connectors. The product is shown as the product, framed and labelled.

### For Jarhead: draw, or frame the dither?
- Jarhead already has a drawn Mac: `site/components/desk/{Desk,Notch,Island,Blob,ConsoleWindow,MenuBar,TargetRing}.tsx`.
  That desk is Jarhead's equivalent of the sorter and should stay the hero object.
- The **notch** and the **island** are good isometric subjects: a MacBook lid is an `IsoBox` with a slot cut in the
  top face (`fillRule="evenodd"` rim like `Bucket`), the island is a pill drawn with `plane()` on the top face, wires
  from the lid to labelled bins ("threads", "hands", "brains") would read exactly like the bucket rack. If any new
  line work is drawn, use `iso.tsx`'s rules: 1px non-scaling strokes, `color-mix` fills of the `--jh-*` tokens, hatch
  and dot patterns for emphasis, one signal dash per wire, uppercase mono stencils.
- The **blob** and the **Console** should not be redrawn as line work. The blob is organic, dithered material with a
  blue ramp — a 1px isometric outline throws away what it is; the Console is a real window whose information is the
  point. Keep the dither stills and the Console captures and place them inside Mailroom's **figure frame** (section
  2 "The card" + 1.3): surface card, `p-0`, an inner panel, a chip row on top ("metadata only" → "on-device", "$0"),
  a `.btn-sm` strip below, a vertical wire with an 11.5px caps label between stages. That gives the captures the same
  frame grammar as the drawings without pretending they are drawings.
- Triptych tiles (200×140) are the one place small new drawings pay off: a lid with the notch lit (Wake), a hex packet
  leaving a mouth (Say), a cursor and a key (Hands) — three tiles, `iso.tsx` construction.

---

## 5. Copy pattern

Shapes:
- **Headings**: two sentences, 2–4 words each, both end in a period, the second one grey. Forms used: ordinal triad
  ("first / second / last"), imperative + result, "Decide once, / sender by sender.", number + negation, cost pair.
- **Ledes**: two or three fragments, 60–95 characters total, no "we", the verb in front, the concrete noun last.
- **Card copy**: a one-word title with an icon; a two-sentence caption of 55–70 characters; on stat cards a figure and
  a five-word caption; on trust cards a four-to-six-word sentence and nothing else.
- **Chips**: one or two lowercase words naming a state ("skips inbox", "protected", "not important", "stays",
  "metadata only", "no flag").
- **Connector labels**: lowercase fragments, no period ("Primary mail no rule placed", "answers past your thresholds").
- **The note under the buttons**: one 14px muted sentence that removes the fear of clicking.
- **The never-line**: a lede-sized paragraph of four "Never …" sentences, placed after the label grid, the last one
  naming what is protected.
- **Footer**: facts joined by " · ", lowercase, no sentence.

Ten strings, verbatim:
1. `Your Gmail, / sorted.` — h1 (`page.tsx:34-36`)
2. `Rules first. Jev second. / Receipt last.` — h2 (`page.tsx:56`)
3. `Ask in plain words. / Get a Gmail query.` — h2 (`page.tsx:64`)
4. `Decide once, / sender by sender.` — h2 (`page.tsx:72`)
5. `Thirteen labels. / Nothing custom.` — h2 (`page.tsx:80`)
6. `Rules you can read. Typed AI judgments for pennies. A straight answer to what to trash.` — hero lede, 86 chars (`page.tsx:38`)
7. `Every run previews first and can be undone.` — the note under the buttons (`page.tsx:46`)
8. `Never sends. Never unsubscribes. Never deletes for good. Never trashes work, people, or money.` — the never-line (`page.tsx:89`)
9. `Filters label mail on arrival. A daily pass ages out the noise.` — card caption, 63 chars (`RunFlow.tsx:63`)
10. `Nothing changes until you press Apply. Every change after that has a receipt and an undo.` — closing lede (`ClosingBand.tsx:30`)

Also worth holding: `Metadata only. Probabilities, not prose. Judged once, cached forever.` (lede), `Bodies never leave
Google.` / `Disconnect deletes everything.` (trust cards), `$0 · for every rule, every day` (stat), `becomes a standing
rule` (chip), `metadata only · tokens encrypted at rest · every run undoable · nothing is ever sent or permanently
deleted` (footer).

---

## 6. What to take for Jarhead, and what not

Jarhead's site already has a rail (`.jh-rail` 1170 with an outer pair at ±11, `site/app/globals.css:102-103`), a
42px hatch (`.jh-hatch` `:110-111`, `components/ui/Hatch.tsx`), crosses (`.jh-cross` `:104-105`), a section head
(`.sec-head` / `.sec-h2` clamp(34px,3.2vw,46px) weight 500 / `.sec-lead` 16px, `styles/sections.css:10-15`), plates
(`.sec-plate`, `.is-ink`), a never panel (`NeverPanel.tsx`, `.sec-never*` `sections.css:70-73`), 36px buttons and a
32px theme tile. The takes below are what Mailroom does that Jarhead does not, or does more loosely.

### Take (13 rules)
1. **One rail for everything.** Put the nav and the footer inside the same bordered rail as `main` (Mailroom
   `header.frame`, `footer.frame`), so the two hairlines run unbroken from the top of the page to the bottom.
2. **Crosses on every seam.** Add the four 11×11 corner crosses to every between-section hatch band, centred on the
   rail × hairline intersections (−6px offsets, `.reticle--tl/tr/bl/br`); none on the header and footer hatches.
3. **More air, thinner seams.** Section padding `clamp(72px, 9vw, 136px)` top *and* bottom (Jarhead: 56 top, 0
   bottom) and a 22px hatch; the generosity of the space is what makes the thin band read as a seam, not a stripe.
4. **The two-line h2 with the grey second line**, both lines period-terminated, 2–4 words each, at a larger scale
   than `.sec-h2` today: `clamp(34px, 4.6vw, 64px)`, line-height 1.05, tracking −.03em, weight 500 (Kevin's cap).
   Line two in `--jh-fg-2`, the same grey as the lead.
5. **Hero composition**: left column h1 in three short lines (`clamp(44px,6.4vw,92px)`, .98), a lead ≤ 640px in
   three lines, two buttons, then **one 14px muted note** under them ("Pause and Stop close the paid session. Asleep,
   nothing is billed."); right column the drawn desk, bare, on Jarhead's own dither ground; staggered `.rise` entrance.
6. **The numbered how-it-works triptych**: three cards with an 11px mono `01 02 03` at top-left, a 200×140 tile,
   a 16px title with a 17px icon, a two-sentence 14px caption; 108px connector columns carrying a signal-dash wire and
   a lowercase 12px label. For Jarhead: Wake · Say · Hands, with "Touch ID, once" / "run, confirm or refuse" on the wires.
7. **Pill chips as the only state marker**: 11.5px, 2×8 padding, radius 999, hairline border, muted text; invert
   exactly one per group (the state that acts), hatch the dangerous one. Use them at the right of label cards and at
   the top-right of every figure ("on-device", "$0.05 / min", "asks first").
8. **The figure frame for captures**: `card--surface p-0 overflow-hidden` → an inner panel, list rows on hairlines,
   a top row (eyebrow left, fact right), a bottom strip of `btn-sm` actions plus one chip, vertical wires with 11.5px
   caps labels between stages. Put the Console shots, the notch strip and the blob stills inside it.
9. **Label grid + the never-line**: a 3-column grid of `py-5` cards (word left, chip right, gap 12) for the 71 tools
   by class or the six brains, then the never-list as **one lede-sized paragraph of "Never …" sentences after the grid**,
   not only as the panel it is today.
10. **Stat cards**: three across, `py-8`, figure `clamp(44px,5.5vw,72px)` leading-none, 16px muted five-word caption:
    `$0.05 / per minute, per second`, `1.11 s / to the first word back`, `$0 / asleep, listening on-device`.
11. **Trust cards**: 2×2, `py-7`, one 26–28px sentence each, then a muted caveat lead after the grid.
12. **The closing band**: invert the page by swapping tokens (not by a second palette), centre the mark at 56, a
    two-line h2 with a muted second line, a 17px lead ≤ 520, the same two buttons; hatch above and below; the 12px
    footer of " · "-joined facts under it. Jarhead's Install can end inside this band.
13. **Copy discipline**: ledes ≤ 95 characters in 2–3 fragments; captions two sentences ≤ 70; chips one or two
    lowercase words; connector labels lowercase fragments; every heading line ends with a period.

### Do not take
- **Berkeley Mono.** No license file sits beside the fonts; the fonts' own `name` table says
  `Proprietary and Non-transferrable.` (name ID 13) and points to `https://berkeleygraphics.com/typefaces/license`.
  Nothing on disk permits use on another site, so it is **Inter only** for Jarhead: headings, figures, badges and
  body all in the self-hosted Inter Variable (`site/app/fonts/InterVariable.woff2`, OFL 1.1 per
  `site/app/fonts/LICENSE-Inter.txt`), code and figures in the existing `--font-mono` ui-monospace stack
  (`site/app/globals.css:45`). If Kevin's own Berkeley Mono license covers a second domain he can overrule this; the
  reader cannot.
- **Mono body text and 700 weight.** Jarhead body stays Inter 15px/1.5, weight cap 500 (`globals.css:76-84`).
- **"No color."** Jarhead keeps `--jh-accent` (#2f5ce0 / #5b82ff), the blue orb ramp and the phase colours; Mailroom's
  all-ink accent/warn/danger is its identity, not Jarhead's.
- **Mailroom's token names.** Keep `--jh-*`; map, do not rename: `--page`→`--jh-ground`, `--ink`→`--jh-fg`,
  `--muted`→`--jh-fg-2`, `--line`→`--jh-hair`, `--surface`→`--jh-lift`, `--panel`→`--jh-lift-raised`/`--jh-ground`,
  `--section-space`→ a new `--jh-sec-space`, `--gutter`→`--jh-gut`.
- **Hard-shadow hover and 1px ink borders on every button** (`3px 3px 0 var(--ink)`, `border: 1px solid var(--ink)`).
  Jarhead's kit says ink on a border only as a state; keep `.jh-btn-tile` / `.jh-btn-solid`.
- **The isometric line system for the blob and the Console.** Keep the dither pictures and the Console captures;
  frame them (rule 8). Line work only for the three triptych tiles and, if wanted, the lid/notch/island.
- **The `.dither` radial dot field.** Jarhead has its own ground (`site/lib/dither.ts`, `components/ui/DitherGround.tsx`).
- **The Google-coloured sign-in glyph** and the blinking wordmark cursor (a Mailroom joke; optional at best).
- **The 68px nav and 12px caps links.** Keep 58px and 13.5px; take only the toggle-as-tile and GitHub-as-button
  (already there).

---

## 7. Where to copy code from (absolute paths, `/Users/kevinliu/repos/mailroom`)

Fonts (reference only, not for Jarhead per section 6):
- `src/app/fonts/BerkeleyMono-Regular.woff2`, `src/app/fonts/BerkeleyMono-Bold.woff2`,
  `src/app/fonts/BerkeleyMono-Regular.ttf`, `src/app/fonts/BerkeleyMono-Bold.ttf` — no license file in the directory.
- Font wiring: `src/app/layout.tsx:11-20`; token mapping `src/app/globals.css:58-60`.

CSS blocks (`src/app/globals.css`, working tree lines; HEAD = −2 from `.frame` onward):
- tokens light/dark `4-41`; Tailwind theme map `43-61`; base `63-73`
- rail `.frame` `76-77`; hatch `.hatch` `78-79`; crosses `.reticle*` `80-87`; `.section` `88-89`; `.dither` `90`
- buttons `94-102`; `.input` `103-105`; `.card*` `108-110`; `.chip*` `111-114`; `.eyebrow/.mono/.kbd` `115-117`
- `.meter` `122-124`; `.cursor` `130-131`; `.signal/.wire` `132-134`; `.rise*` `135-137`; reduced motion `138,140`

Components (`src/components/…`):
- `landing/Section.tsx:5-14` `ReticleSpacer` (hatch + crosses); `:16-30` `SectionHeading` (eyebrow + two-line h2 + right lead)
- `landing/RunFlow.tsx:60-95` numbered triptych + `Connector`; `:6-58` the three tiles
- `landing/iso.tsx` whole file — isometric helpers, tones, patterns, `IsoBox`, `Port`, `Hex`, `Wire`, `Envelope`, `Stamp`
- `landing/HeroScene.tsx` whole file (working tree; `git show HEAD:src/components/landing/HeroScene.tsx` for the live one)
- `landing/SearchDiagram.tsx`, `landing/TrashDiagram.tsx`, `landing/JudgmentCard.tsx` — the three figure frames
- `landing/ClosingBand.tsx:6-18` token-swap inversion, `:20-37` the band
- `landing/Brand.tsx` (untracked) — Simple Icons marks in currentColor
- `ThemeToggle.tsx:12-28` half-disc toggle; `BrandMark.tsx:5-21` mark + wordmark with cursor; `SignInButton.tsx`
- Page and shell: `src/app/page.tsx:17-18` (h2/lede class strings), `:30-51` hero, `:55-135` sections;
  `src/app/layout.tsx:31` theme-init script, `:45-67` header, `:68-74` hatches + footer
- Data behind the copy: `src/lib/policy/schema.ts:4-19` the thirteen labels, `:38-44,84` defaults;
  `src/lib/ai/triage.ts:11,88` the price constants; `src/app/opengraph-image.tsx` the OG card.

Captures: `scratchpad/site/mailroom/{hero,view-0..9,phone,v-hero,v-view-0..5}.png`, `index.html` (live DOM,
deployment `dpl_28KMMQYUBUtcLnjvhfHmdbxW1KuP`), `site.css` (compiled live CSS).
