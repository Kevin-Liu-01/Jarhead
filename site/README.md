# site

jarhead.kevinliu.studio, the landing page: Next.js (App Router), React, hand-written CSS on the `--jh-*` tokens in `app/globals.css` (the Console's palette), Inter 4.1 self-hosted from `app/fonts` (OFL, see `LICENSE-Inter.txt`).

- Run: `pnpm -C site dev` (http://localhost:3939); check: `pnpm -C site typecheck`; ship: `pnpm -C site build`.
- `predev` and `prebuild` copy `scripts/install.sh` to `public/install.sh` (gitignored; the repo's file is the only source).
- The page (`app/page.tsx`) is built from `components/site/*` on `styles/site.css`, with the Mac's top edge from `components/desk/*` on `styles/desk.css` and the kit's twins in `components/kit/*`; the pictures are drawings (`components/art/*`, `components/site/ConsoleWindow.tsx`, `components/site/RailsPicture.tsx`), never captures. The design is `docs/DESIGN.md`; the brief is `docs/SCRATCH.md`.
- Icons and the OG field are rendered by hand from the repo root, `pnpm exec tsx site/scripts/make-icons.mts` and `site/scripts/make-og.mts`; their PNGs under `app/` and `public/` are committed. `site/scripts/make-blob-still.mts` renders `public/blob-still.png` the same way.
- `sh site/scripts/check-install.sh` (from the repo root) checks the installer without running it: syntax, a dry run of the four commands, and that the deck never claims a download.
- Generated, never edited: `public/install.sh`, `.next/`.
- The one-liner the page teaches is `curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh`.
