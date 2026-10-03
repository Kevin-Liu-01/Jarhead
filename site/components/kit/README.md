# components/kit · the Console kit's web twins the page uses

Each twin mirrors one Swift piece under `apps/mac/Sources/Jarhead/UI/Console/` (`C/` below), reads only `--jh-*` tokens,
and keeps its classes in `styles/kit.css` (imported by `app/layout.tsx`). The rules every piece obeys: a control is a tile
plus a hairline (`C/ConsoleFill.swift:4-9`); radius 6, no shadow, no dither on a control (`C/ConsoleButton.swift:125`); the
accent on the primary fill and the keyboard ring alone (`C/ConsoleTheme.swift:46`); hover in `--jh-instant`, the words and
the icon never move (`C/ConsoleTheme.swift:690-691`). SF Symbols are Apple's and none of their data ships: the kit's icons
are Phosphor Fill (`components/icons/`, `docs/DIAGRAM-STYLE.md` §2), the page's one family. Import each piece from its own file; there is no barrel, so a client component never pulls a server-only
piece (the mark's PNG encoder) into the bundle.

| twin | mirrors | used by | classes |
|---|---|---|---|
| `Button.tsx` | `C/ConsoleButton.swift:4-63, 113-144`; the spent word `C/StreamView.swift:1396-1414` | `components/site/CopyButton.tsx` (primary → spent, ghost → spent, with `hold`; `icon` copy → checkCircle); the demos use its classes for Allow, Deny, Snooze 10 and Done | `.kit-btn`, `--primary --ghost --spent --lg`, `.kit-btn-hold` |
| `AgentMark.tsx` | `C/BrandMarks.swift:3-164` (the vendor's paths, monochrome, the Codex chip); labels `Model/Protocol.swift:303-314` | the Say demo's brain picker | `.kit-agent-mark` |
| `Mark.tsx` (`JarheadMark`) | `C/BrandMarks.swift:438-466` (the faceless orb, the paper highlight, quiet); `UI/Dither.swift:58-78` | the foot (56); server-only | `.kit-mark` |

## Icons

The kit draws no icons of its own any more: `components/icons/Icon.tsx` (`<Icon name size label? />`, Phosphor Fill in
`currentColor`, class `.jh-ico` in `kit.css`) is used by the Button, the island, the demos, the stars, Install and the
section lines. Add one with
`scripts/vendor-icons.mjs`. Brands stay `@thesvg/react` (`mono`).

## Contrast

In light the canon's quiet words fall short of AA at 10 to 12 px, so the word aliases in `app/globals.css` darken them in
light alone (`--jh-fg-3-word` ink .60, `--jh-titanium-word` `#585c64`, `--jh-speaking-word` `#915608`); a toned badge (`.badge` in `styles/play.css`) draws
its word in the alias and its hairline in the tone's canon colour. In dark each alias is the canon token. The word on the
accent follows the fill: paper on `#2f5ce0` in light, ink on `#5b82ff` in dark (the terminal keeps the dark pair in both
themes).
