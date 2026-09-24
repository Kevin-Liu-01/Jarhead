# site

jarhead.kevinliu.studio — the landing page. Next.js (App Router), React, Tailwind 4 for utilities,
hand-written CSS on the `--jh-*` tokens in `app/globals.css` (the Console's palette), Inter 4.1
self-hosted from `app/fonts` (OFL, see `LICENSE-Inter.txt`).

```bash
pnpm -C site dev        # http://localhost:3939
pnpm -C site build
pnpm -C site typecheck
```

`public/install.sh` is copied from `scripts/install.sh` at build time (see `package.json`); the page
tells people to run `curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh`.
