# components/kit · the Console kit's web twins the page uses

Each twin mirrors one Swift piece under `apps/mac/Sources/Jarhead/UI/Console/` (`C/` below), reads only `--jh-*` tokens,
and keeps its classes in `styles/kit.css` (imported by `app/layout.tsx`). The rules every piece obeys: a control is a tile
plus a hairline (`C/ConsoleFill.swift:4-9`); radius 6, no shadow, no dither on a control (`C/ConsoleButton.swift:125`); the
accent on the primary fill and the keyboard ring alone (`C/ConsoleTheme.swift:46`); hover in `--jh-instant`, the words and
the glyph never move (`C/ConsoleTheme.swift:690-691`). SF Symbols are Apple's and none of their data ships: every glyph here
is drawn by hand. Import each piece from its own file; there is no barrel, so a client component never pulls a server-only
piece (the mark's PNG encoder) into the bundle.

| twin | mirrors | used by | classes |
|---|---|---|---|
| `Glyph.tsx` | `C/ConsoleGlyph.swift:3-90`; the status symbols `C/ConsoleTheme.swift:149-229` | the island, the section lines, the stars, Install, the Console window, the drawings (`components/art/parts.tsx G`) | `.kit-glyph` |
| `Button.tsx` | `C/ConsoleButton.swift:4-63, 113-144`; the spent word `C/StreamView.swift:1396-1414` | `components/site/CopyButton.tsx` (primary → spent, ghost → spent, with `hold`) | `.kit-btn`, `--primary --ghost --spent --lg`, `.kit-btn-hold` |
| `Badge.tsx` | `C/ConsoleBadge.swift:3-7, 86-126` | the Console window's `asks` and `×1` | `.kit-badge`, `[data-tone="speaking"]` |
| `AgentMark.tsx` | `C/BrandMarks.swift:3-164` (the vendor's paths, monochrome, the Codex chip); labels `Model/Protocol.swift:303-314` | the Console window, the Say drawing | `.kit-agent-mark` |
| `Mark.tsx` (`JarheadMark`) | `C/BrandMarks.swift:438-466` (the faceless orb, the paper highlight, quiet); `UI/Dither.swift:58-78` | the Console window (14), the foot (56); server-only | `.kit-mark` |

`kit.css` also carries the live dot, `.kit-dot` / `.is-live` (`C/ConsoleTheme.swift:764-803`, its ring off under reduced
motion), used by the Console window's phase and working rows.

## The glyph set

Verbs, filled: `send externalLink folder live quit ask voice stop play pause mic`. Chrome, lines: `chevron checkmark
scopeMark circle`. Status: `checkCircle xOctagon questionCircle handRaised hourglass stopCircle slashCircle lock key
terminal dot`. The site's own: `copy` (the Copy buttons), `star` (the GitHub count). Every path is generated at module load
from a few primitives (a disc, a rounded rect, an annular sector, a mitred outline, a rotated plus), so the knock-outs
inside a disc are evenodd sub-paths that touch and never overlap. Add a glyph by drawing it here and naming it in
`GlyphName`; brands stay `@thesvg/react` (`mono`).

## Contrast

In light the canon's quiet words fall short of AA at 10 to 12 px, so the word aliases in `app/globals.css` darken them in
light alone (`--jh-fg-3-word` ink .60, `--jh-titanium-word` `#585c64`, `--jh-speaking-word` `#915608`); a toned badge draws
its word in the alias and its hairline in the tone's canon colour. In dark each alias is the canon token. The word on the
accent follows the fill: paper on `#2f5ce0` in light, ink on `#5b82ff` in dark (the terminal keeps the dark pair in both
themes).
