# site

jarhead.kevinliu.studio, the landing page: Next.js (App Router), React, Motion for React, hand-written CSS on the `--jh-*`
tokens in `app/globals.css`. Self-hosted fonts in `app/fonts` with their licences: Newsreader (display and the voice),
Inter 4.1 (cut to the page), JetBrains Mono.

- Run: `pnpm -C site dev` (http://localhost:3939); check: `pnpm -C site typecheck`; ship: `pnpm -C site build`.
- `predev` and `prebuild` copy `scripts/install.sh` to `public/install.sh` (gitignored; the repo's file is the only source).
- The page (`app/page.tsx`) is built from `components/site/*` on `styles/site.css`, the Mac's top edge and the blob from
  `components/desk/*` on `styles/desk.css`, the kit's twins in `components/kit/*`, and one playable demo per feature in
  `components/play/*` on `styles/play.css`; nothing on it is a capture. The brief is `docs/LANDING.md`, the page as built
  `docs/DESIGN.md`.
- The island at the top wears what the demo in view claims (`lib/live.ts`); the blob's engines mount near the viewport and
  its resting stills are rendered at build from `lib/orb.ts` (`app/stills/*.png/route.ts`).
- Server-side colours (the theme-color, the manifest, the OG image, the stills) are read from the token sheet
  (`lib/tokens.ts`); no raw colour lives outside `app/globals.css` and `styles/kit.css`.
- Icons and the OG field are rendered by hand from the repo root, `pnpm exec tsx site/scripts/make-icons.mts` and
  `site/scripts/make-og.mts`; their PNGs under `app/` and `public/` are committed.
- `sh site/scripts/check-install.sh` (from the repo root) checks the installer without running it: syntax, a dry run of the
  four commands, and that the deck never claims a download.
- Generated, never edited: `public/install.sh`, `.next/`.
- The one-liner the page teaches is `curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh`.
