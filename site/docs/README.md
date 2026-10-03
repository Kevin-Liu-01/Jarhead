# site/docs

The briefs the landing page was designed and built from, kept here because they were written in a scratch folder that
the system cleans out. Read the first two before changing the page.

## Current

- `LANDING.md` · the brief (2026-10-02): LoveFrom's restraint and one character, OpenAI's confident playable product pages,
  Jarhead's own version (the blob, the dither, paper first, the sticky top), the demos, the motion, the copy rule, the never
  list and the judging bar. It overrides SCRATCH.md where they differ.
- `DESIGN.md` · the page as built: the look, the type, the character, the sticky top and its island claims, every demo and
  how it plays, the motion tokens and rules, the sections and their ids, both themes, the phone, and how to add a demo.
- `SCRATCH.md` · everything Kevin has said about the page (2026-10-01), what it must have, the canon and the widths.
- `COPY.md` · the copy deck: the only source of strings on the page (plus the app's own rendered text for the island and
  the rail rows). Short declarative sentences, one idea each, no metaphors, no em dashes.
- `DIAGRAM-STYLE.md` §1 (the fonts) and §2 (the icons) still hold: JetBrains Mono for values, Phosphor Fill for every
  generic icon, brand marks from `@thesvg/react`.

## History (what was tried; never copy a layout from these)

- `DIAGRAMS.md`, `DIAGRAM-STYLE.md` (§3 on) · the brief and the law for the schematic drawings (`components/art/*`), which
  the playable plates in `components/play/*` replaced on 2026-10-02.
- `IMMERSE.md` · the earlier design: the page as the Console window and rails, at the app's density.
- `ITERATE.md` · the seven asks that shaped the earlier build (the glass install, GitHub stars, the one-line headline).
- `CENTER.md`, `ART.md` · the earlier centre column and the first brief for the pictures.
- `SPACE.md` · the Console kit port (`components/kit`) and the spacing scale of that pass.
- `MAILROOM.md` · the reference study of mailroom.kevinliu.studio; its frame was tried and removed.
- `ART-STYLE.md` · the earlier law for the drawings (the 2.5D stack with checker side faces), retired 2026-10-02.

Icons: every brand mark comes from `@thesvg/react` (per-icon import, in the text's colour: the `mono` variant where the
mark has one, `.mono-mark` where it does not); every other icon is Phosphor Fill, vendored as paths in `components/icons/`
(`scripts/vendor-icons.mjs`); never SF Symbols, never Heroicons, never emoji. Agent marks are the app's
(`components/kit/AgentMark.tsx`).
