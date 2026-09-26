# components/kit · the Console kit's web twins

The site's controls, rows, badges, tooltips, fields and glyphs are the Console's kit, ported (SPACE.md §2). Each
twin mirrors one Swift piece under `apps/mac/Sources/Jarhead/UI/Console/` (`C/` below) and reads only `--jh-*`
tokens; every class lives in `styles/kit.css` (imported by `app/layout.tsx`). The rules every piece obeys are
facts-kit.md §0: a control is a tile plus a hairline (`C/ConsoleFill.swift:4-9`); three lines, each drawn once
(`C/ConsoleTheme.swift:21-33`); the accent on the primary fill, the keyboard ring and the 2 px selection bar alone
(`:46`); radius 6, no shadow, no dither on a control (`C/ConsoleButton.swift:125`; `AGENTS.md:814`); hover in
`--jh-instant`, the words and the glyph never move (`C/ConsoleTheme.swift:690-691`); the ring is the keyboard's
(`:focus-visible`); Return is never a yes; a float never takes a click. SF Symbols are Apple's and none of their
data ships: every glyph here is drawn by hand.

Surfaces: a control reads its tile from `--kit-lift`; an ancestor with `.kit-raised` (a plate, a popup, a hovered or
selected row) lifts it from `--jh-lift` to `--jh-lift-raised` (`C/ConsoleFill.swift:14-22`). Six tokens were added to
`app/globals.css` for the kit: `--jh-seam: 2px` (`C/ConsoleTheme.swift:44`), `--jh-mark-chip` (`C/BrandMarks.swift:22`) and the
four word aliases `--jh-fg-3-word`, `--jh-titanium-word`, `--jh-speaking-word`, `--jh-error-word` (the Contrast section below).
Forced states for pictures and harnesses: `.is-hover` and `.is-active` mirror `:hover` and `:active`.

| twin | mirrors | props | classes |
|---|---|---|---|
| `Glyph.tsx` | `C/ConsoleGlyph.swift:3-90` (the rule, the verbs `:15-44`, the kept lines `:46-73`, `check-kit` `:84-90`); `C/ConsoleTheme.swift:805-822` (the 20 column, 13 medium, titanium, the crossfade); the status symbols `:149-229` and `Model/ProblemGlyphs.swift:8-26` | `name: GlyphName`, `size: 14 \| 16 \| 20` (16), `label?` (→ `role="img"`, else `aria-hidden`), `className?` | `.kit-glyph`, `.kit-icon` (the column), `.kit-glyph-swap` |
| `Button.tsx` | `C/ConsoleButton.swift:4-10` (the five kinds), `:17` (height), `:28-63` (fills per kind × state), `:65-71, 121, 127` (disabled), `:113-144` (lit, the two layers), `:118-125` (label 12/11, padding 10/8, square icon-only, radius 6); the spent Stop `C/StreamView.swift:1396-1414` | `kind: ghost \| plain \| primary \| danger \| spent`, `size: 32 \| 28 \| 26 \| 24 \| 22 \| 20 \| 18` (28; ≤ 26 is small), `glyph?`, `icon?` (a brand mark from `@thesvg/react` in the glyph slot, 16 px, currentColor), `hold?` (the other word, one width), `href?` (→ `<a rel=noopener>`), `onClick?`, `disabled?`, `pressed?` (→ `aria-pressed`), `ariaLabel?` (required icon-only), `id?`, `title?`, aria attributes | `.kit-btn`, `--ghost --plain --primary --danger --spent`, `--sm`, `--icon`, `.kit-btn-label`, `.kit-btn-hold` |
| `Badge.tsx` | `C/ConsoleBadge.swift:3-7` (a word in a box), `:52-57` (widths 62 · 46 · 30), `:86-100` (tones), `:120-126` (16 tall, padding 5, hairline, label) | `word?`, `figure?` (mono), `tone: rest \| speaking \| error`, `width?: 62 \| 46 \| 30` | `.kit-badge`, `--figure`, `[data-tone]`, `[data-width]` |
| `Chip.tsx` | `C/ConsoleBadge.swift:130-158` (22 tall, radius 6, hairline; on = inverted; hover; count mono 11); the flow `C/MemoryRailView.swift:435` | `word`, `count?`, `on?`, `onToggle?` (→ `<button aria-pressed>`, else `<span>`) | `.kit-chip`, `.kit-chip-count`, `.kit-flow` |
| `KeyCap.tsx` | `C/ConsoleBadge.swift:160-175` (mono 10, 16 tall, min 16, padding 4, hairline, radius 6); used last in a tip `C/ConsoleTip.swift:422, 465` | `children: string` | `.kit-key` (`<kbd>`) |
| `Tip.tsx` | `C/ConsoleTip.swift:3-9` (the three tiers), `:49-64` (350 ms delay, 400 ms warm), `:202-213` (hide rules, a11y), `:268-292` (the keyboard ring), `:294-323` (`?` pins, Esc lets go), `:326-351` (raised, hair, the seam, arrival over quick), `:414-471` (line 28 tall · card 240-320); `C/ConsoleFloatPlacement.swift:9-71` (gap 4, margin 8, flip, the arrow ≥ 10 from a corner); `C/ConsoleFloat.swift:178-211` (never hit-tested) | `line?` + `keyCap?`, or `card?: { title, status?, badge?, lines?, foot?, last?, key? }`, `side: below \| above`, `pinned?` (inline, for pictures), `tap?` (a touch tap holds it: covers and figures, never a control that acts), `children` (the trigger; `aria-describedby` is wired after mount) | `.kit-tip`, `--line --card`, `[data-side]`, `.is-in`, `.is-pinned`, `.kit-tip-title -status -lines -foot -k -v -last`, `.kit-tip-anchor` |
| `Row.tsx` (`Row`, `Group`) | `C/ConsoleRow.swift:4-5` (28 · 40), `:188-216` (the overlay, verbWidth 60, raised under the controls), `:200` (padding 12), `:238-323` (the anatomy: icon column · title · badge · value · chevron · meta · meter), `:360-385` (selected = active + the 2 pt bar inset 4, hover), `:218` (.45 / .62), `:505-514` (the ring); `C/ConsoleFill.swift:12-13` | `icon?`, `title`, `mono?`, `size: 12 \| 13`, `badge?`, `value?`, `meta?`, `trailing?`, `chevron?`, `href?` or `act?` (the acting cover), `selected?`, `hover?`, `open?`, `disabled?`, `sitsBack?`, `describedBy?`, `as: li \| div`; `Group`: `head?`, `raised?` | `.kit-group`, `.kit-rows`, `.kit-row`, `-icon -main -line -title(.is-mono) -badge -value -meta -trailing -verb -chevron -act`, `.is-acting .is-selected .is-hover .is-open .sits-back`, `[aria-disabled]` |
| `GroupHead.tsx` | `C/ConsoleRow.swift:389-440` (22 tall, sans 11 medium titanium, count and figure mono 11, one badge, padding 12, paints its surface, sticky) | `title`, `count?`, `figure?`, `badge?`, `trailing?`, `rule?`, `sticky?` | `.kit-group-head`, `--rule`, `.is-sticky`, `.kit-group-count -figure -trailing` |
| `Meter.tsx` | `C/ConsoleRow.swift:316-319` (24 × 6, fill fg2, track active); `UI/Dither.swift:942-982` (the 8-cell Bayer edge); the site's `lib/dither.ts renderMeter` | `fraction`, `width` (24), `height` (6), `label?` | `.kit-meter` |
| `Disclosure.tsx` | `C/ConsoleDisclosure.swift:4-9` (the head is the summary), `:62-95` (remembered per id), `:99-100` (section 28 · group 24), `:102-110, 258-277` (summary items), `:121-122, 231` (the control while open), `:164-174` (body air, appear), `:183-184, 227-230` (a11y), `:225-226, 236` (→ ←), `:244-246` (the chevron 0 → 90) | `id`, `kind: section \| group`, `title`, `count?`, `summary?: (string \| {figure} \| {badge})[]`, `control?`, `defaultOpen?`, `inset?`, `remember?` (localStorage `kit.fold.<id>`) | `.kit-fold`, `--section --group --inset`, `.kit-fold-bar -head -chevron -title -count -summary(.is-figure) -sep -control -body(.is-in)` |
| `Segments.tsx` | `C/ConsoleSegments.swift:4-9` (pressed tiles, on inverted, the ring, ← → Space), `:20-38, 91-97` (the flag), `:42, 63-66, 88` (the thumb glides), `:51, 60-61, 116, 141` (shared or fitted cells), `:123-148` (rail 28 · row 26 · toggle 22; box, dividers, ring), `:158-181` (a11y, keys) | `value`, `options: { id, title, flag?, face?, glyph? }[]`, `onPick`, `size: rail \| row \| toggle`, `ariaLabel`, `fit?` | `.kit-segments`, `--rail --row --toggle --fit`, `.has-thumb`, `.kit-seg`, `.kit-seg-thumb`, `.kit-seg-flag`, `.kit-seg-face` |
| `Toggle.tsx` | `C/ConsoleSegments.swift:10-11, 184-211` (`On \| Off`, 60 × 22, the hint ≤ 4 words, a switch) | `on`, `onChange`, `hint?`, `ariaLabel` | `.kit-toggle`, `.kit-toggle-hint` (+ the segments classes, `[data-checked]`) |
| `Field.tsx` | `C/ConsoleField.swift:4-9` (one tile, one ring, the commit rule), `:32, 100-111` (22 · 24 · 26 · 32, sans 13/12, mono 12), `:116` (the lead glyph), `:177-201` (ring hair → accent → error with a shake), `:204-231` (trailing: ×, a count, a verb), `:415-435` (the hint); `C/ConsoleTheme.swift:928-941` (the shake) | `size: edit \| filter \| row \| composer`, `lead?: GlyphName`, `mono?`, `count?`, `trailing?`, `error?`, `hint?`, `label` (the accessible name), input attributes | `.kit-field`, `--edit --filter --row --composer`, `.is-mono .is-error`, `.kit-field-lead -input -count`, `.kit-hint` |
| `Mark.tsx` (`JarheadMark`) | `C/BrandMarks.swift:438-465` (the faceless orb, 14 in the column, the paper highlight, quiet); `UI/Dither.swift:58-78` (the two ramps); reuses `components/Mark.tsx` (which now takes 14) | `size: 14 \| 20 \| 24`, `quiet?`, `label?` ("Jarhead" · "Jarhead, over") | `.kit-mark` |
| `AgentMark.tsx` | `C/BrandMarks.swift:3-13` (the vendor's paths, monochrome, 14 on 20), `:15-38` (colours), `:26` (order), `:46-64` (BrandMark, quiet, a11y), `:20-23, 73-84` (the Codex chip), `:95-109` (monograms), `:119-164` (BrandLogos, verbatim), `:184-206` (fit and centre); labels `Model/Protocol.swift:303-314` | `tool: claude \| codex \| cursor \| gemini \| opencode \| amp \| pi \| droid \| hermes \| other`, `size: 14 \| 16 \| 20 \| 24`, `quiet?` | `.kit-agent-mark` |
| `words.ts` | `UI/HelpCopy.swift:9-23` (the shape), `:27-97` (the entries borrowed), `:114-125` (`violations`), `:136-138` (resting lowercase); `C/ConsoleBadge.swift:10-29, 86-91` (the words); `C/ConsoleTheme.swift:120-131` (the phases) | `TIPS`, `BADGE_WORDS`, `PHASE_WORDS`, `missing(n)`, `asking(n)`, `violations()` | (none) |

Small shared pieces in `kit.css` alone (`C/ConsoleTheme.swift`): `.kit-head` (+ `-count -trailing`; the 28 pt section head
`:890-919`), `.kit-hair` / `.kit-hair--row` (`:1009-1026`), `.kit-dot` / `.is-live` (`:764-803`, none under reduced
motion), `.kit-empty` / `.kit-empty-action` (`:943-961`), `.kit-glyphs` (the ASCII ramp `:990-1007`, stepped by
`lib/dither.ts ditherGlyphs`), `.kit-flow` (`:1044-1086`).

## The glyph set

Verbs, filled (`C/ConsoleGlyph.swift:15-44`): `send reload undo search dismiss externalLink folder live quit ask voice
switchVoice stop play pause mic muted`. Chrome, lines (`:46-73`): `cross magnifier ellipsis chevron chevronLeft picker
checkmark scopeMark plus minus circle summon reloadLine earlierLine newestLine undoLine`. Status
(`C/ConsoleTheme.swift:149-229`): `checkCircle xOctagon exclamationCircle questionCircle handRaised hourglass stopCircle
slashCircle lock key terminal dot`. The site's own: `copy` (the Copy buttons). Every path is generated at module load
from a few primitives (a disc, a rounded rect, an annular sector, a mitred outline, a rotated plus, a clipped capsule) so
the knock-outs inside a disc are evenodd sub-paths that touch and never overlap. Brands stay `@thesvg/react` (ICONS.md);
the agent marks are the app's own (`AgentMark`).

## Departures from the app, on purpose

- Weights above 500 (`.semibold` chevrons, ×, ⋯, ±; the rounded semibold monograms) become stroke widths or 500: the chrome
  lines that stand alone in a column (chevron, chevronLeft, picker, cross, plus, minus, checkmark) stroke 1.75 units on the
  20 box, the arrows and the magnifier 1.5.
- In light, a word in the quiet step, in titanium or in a tone wears an ink-weight step of the same hue (the word aliases);
  the app draws the canon values in its aqua appearance.
- Em dashes in the app's tips are joined with ` · ` (`words.ts`), and `violations()` refuses one.
- Springs (`Motion.snappy`) become `--jh-quick` on `--jh-ease-out`; a 1.5 pt cell becomes whole device pixels.
- Under 720 px an acting control grows to 40 px, an acting row to 40; a fact row keeps the app's 28 (SPACE.md, tap targets).
- A pinned tip (`pinned`) sits inline under its trigger instead of on the float layer: pictures and harnesses only.
- The app has no touch. A touch never hovers, so a tip with `tap` (a row's cover, a display figure) opens on a completed
  tap and holds until the next tap anywhere, a scroll or Esc; a tap on a control that acts (Copy) opens nothing.
- The primary's press dims the whole button to .8 (the app dims the fill).
- In dark the primary's word is ink on the lifted accent (`--jh-on-accent` remaps; the app draws white at 3.45:1).
- The toggle's two cells are 29 inside the 1 px hairline, so the box is the app's 60 × 22 (the app's stroke sits inside its 60).
- A row's hairline sits inside the 28 pitch (1 + 3 + 20 + 4) and a meta row is 40; the icon and the words of an acting row pass the pointer to the cover, the trailing controls keep theirs.

## Contrast (kit/verify, both themes, 1x)

The canon's light values fall short of AA for the kit's 10 to 12 px words (`--jh-fg-3` 3.55:1 on paper, titanium 3.25, the amber
1.76, the red 2.99; dark passes: 4.96 · 6.2 · 11.42 · 6.75). The word aliases in `app/globals.css` fix that in light alone,
leaving dots, glyph tints, hairlines and the blob at the canon: `--jh-fg-3-word` ink .60 (5.4 on paper, 4.8 on a raised
plate's lift tile), `--jh-titanium-word` `#585c64` (6.7 · 4.8), `--jh-speaking-word` `#915608` (5.9 on paper, 4.7 on a
selected row of a raised plate), `--jh-error-word` `#bb1b2b` (6.4 · 4.5 on the lift-raised tile). A toned badge draws its
word in the alias and its hairline in the tone's canon colour. In dark each alias is the canon token. Consumers:
`.kit-badge` and its tones, `.kit-btn--spent`, `.kit-key`, `.kit-chip-count`, `.kit-tip-status -k -last`, `.kit-toggle-hint`,
`.kit-group-head -count -figure`, `.kit-row-value -meta`, `.kit-fold-head -count -summary -sep`, `.kit-field-count`, the
placeholder, `.kit-hint` (+ `.is-error`), `.kit-head`, `.kit-glyphs`. The site's own quiet lines (`.jh-fig`, `.sec-fig`,
`.desk-caption`, the footer note, all `--jh-fg-3` at 11.5 to 12.5 px) are the designers' to move onto `--jh-fg-3-word`.

The primary's white word reads 5.63:1 on `#2f5ce0` in light and **3.45:1 on `#5b82ff` in dark** (12 px 500; a 32-tall label
does not reach 4.5 either), so in dark `--jh-on-accent` remaps to ink (`app/globals.css`; 5.83:1 on the lifted accent; the app draws
white there, Kevin's call to keep or revert). The danger's white word reads **2.99:1 on `#ff5d6c`** in light (ink in dark, 6.75:1),
so the site never gives `danger` a word: the never-list rows carry the error tone on the
`xOctagon` glyph and a badge, and a danger button, if any, is icon-only at 24 or more (`aria-label` names it). In dark the
canon's quiet words also fall short on one tile only, the raised plate's lift tile (`--jh-lift-raised` on `--jh-raised`): a
spent word there reads 4.1:1 and a field's count 3.7:1; every other ground passes. The phase colours as glyph tints
(`checkCircle` in acting, `exclamationCircle` in speaking) are non-text and read 1.5 to 1.8:1 in light, as in the app.

## What replaces what on the site

`components/ui/Button.tsx` + `.jh-btn-*` → `Button`; `components/ui/Icons.tsx` (controls) → `Glyph` (the Apple mark stays
thesvg); `components/install/CopyButton.tsx` → `Button` primary → spent with `hold`; `components/install/CommandRows.tsx`
→ `Row` inside `Disclosure`; `components/install/Requirements.tsx` → `Group` of rows with `Tip` cards;
`components/desk/PhaseButtons.tsx` → `Segments` at rail with `face`; the figures lines (`.jh-fig`, `.sec-fig`) → `Row` +
`Badge` with a card tip for provenance; `components/sections/NeverPanel.tsx` → rows with `xOctagon` in the error tone;
the tool-family chips → `Chip` as spans, or dropped.

The private gallery is `app/kit/page.tsx` (+ `live.tsx`, `kit-gallery.css`): every piece in every state, both themes;
the integrator drops `app/kit` before shipping. The app's own sheet for the same purpose is `console-preview.sh buttons`.
