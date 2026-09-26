# site

jarhead.kevinliu.studio, the landing page: Next.js (App Router), React, Tailwind 4 for layout utilities only, hand-written CSS on the `--jh-*` tokens in `app/globals.css` (the Console's palette), Inter 4.1 self-hosted from `app/fonts` (OFL, see `LICENSE-Inter.txt`).

- Run: `pnpm -C site dev` (http://localhost:3939); check: `pnpm -C site typecheck`; ship: `pnpm -C site build`.
- `predev` and `prebuild` copy `scripts/install.sh` to `public/install.sh` and `docs/media/*` to `public/media/`; both are gitignored, the repo's files are the only source.
- Icons and the OG field are rendered by hand from the repo root, `pnpm exec tsx site/scripts/make-icons.mts` and `site/scripts/make-og.mts`; their PNGs under `app/` and `public/` are committed. `site/scripts/make-blob-still.mts` renders `public/blob-still.png` the same way.
- Generated, never edited: `public/install.sh`, `public/media/`, `.next/`.
- The one-liner the page teaches is `curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh`.
