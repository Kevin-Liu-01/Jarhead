#!/bin/bash
# make-cards.sh · the share pictures, captured from the dev-only /card route (app/card: frames in app/card/frames.ts) with
# the page's own blob engine, glass Install, dither and fonts, in a headless agent-browser session (never --headed).
#
#   pnpm -C site dev                                   # or ./node_modules/.bin/next dev --webpack --port 3939
#   site/scripts/make-cards.sh [base] [media]          # base http://localhost:3939, media <repo>/docs/media
#
# Writes site/public/og.png (the Open Graph card, 1200 x 630; when it changes, bump OG_VERSION in lib/metadata.ts, since
# feeds cache the picture by its URL) and, in <media>, social-preview.png (1280 x 640, for the
# repository's settings), banner-light.png and banner-dark.png (1280 x 480, stored at 2x as 2560 x 960 and shown by the
# README's <img width="1280">, so a Retina screen keeps the cells sharp) and hero.gif and hero-dark.gif (798 x 315), the
# README's pictures with their corners rounded, so each reads as a plate on GitHub's white and on its dark.
#   ONLY="og-light banner-dark"   those stills alone (og-dark, the card's dark twin, is made only when named here)
#   GIF=0                         no GIF; GIF=only the GIF alone
#   GIFS="dark"                   the GIF's themes (default "light dark": hero.gif and hero-dark.gif)
#   Q="&fs=50&disc=140"           a query added to every capture, to try numbers (app/card/frames.ts `tuned`)
#
# Needs python3 with Pillow (scripts/cards.py). Each still is laid out at half its size, captured at 4x and halved (BOX),
# so the blob's 1.5 px cells are a crisp 3 px (the banners keep the whole 4x capture: 6 px cells at 2x); the GIF is laid
# out at two thirds and captured at 1.5x (whole 2 px cells, nothing resampled). The scene runs on the card's own clock
# (app/card/clock.ts, seeded), so every run gives the same pictures.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SITE=$(cd "$HERE/.." && pwd)
BASE=${1:-http://localhost:3939}
MEDIA=${2:-$(cd "$SITE/.." && pwd)/docs/media}
SESSION=${CARDS_SESSION:-jh-cards}
ONLY=${ONLY:-og-light social banner-light banner-dark}
GIF=${GIF:-1}
GIFS=${GIFS:-light dark}
Q=${Q:-}
TMP=$(mktemp -d)
mkdir -p "$MEDIA"
ab() { agent-browser --session "$SESSION" "$@"; }
trap 'ab close >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

# A fresh browser takes the device scale only once a page is open: open a blank one first.
ab open about:blank >/dev/null

# frame -> picture, its size, its theme, its corner radius, 2x (the whole 4x capture, for a Retina screen) or 1x
frame() {
  case $1 in
    og-light) echo "$SITE/public/og.png 1200 630 light 0 1x" ;;
    og-dark) echo "$MEDIA/og-dark.png 1200 630 dark 0 1x" ;;
    social) echo "$MEDIA/social-preview.png 1280 640 light 0 1x" ;;
    banner-light) echo "$MEDIA/banner-light.png 1280 480 light 12 2x" ;;
    banner-dark) echo "$MEDIA/banner-dark.png 1280 480 dark 12 2x" ;;
    *) echo "unknown frame: $1" >&2; exit 2 ;;
  esac
}

still() { # still <frame>
  local out w h theme corner scale
  read -r out w h theme corner scale < <(frame "$1")
  ab set viewport 900 600 4 >/dev/null
  ab set media "$theme" >/dev/null
  ab open "$BASE/card?f=$1$Q" >/dev/null
  ab wait "html[data-card=ready]" >/dev/null
  ab screenshot "#card" "$TMP/$1.png" >/dev/null
  python3 "$HERE/cards.py" still "$TMP/$1.png" "$out" "$w" "$h" "$corner" "$scale"
}

if [ "$GIF" != only ]; then
  for f in $ONLY; do still "$f"; done
fi
[ "$GIF" = 0 ] && exit 0

# The GIF: the blob over the two-line key, no line (the banner over it in the README is the line). 100 frames, one every
# 50 ms of the card's clock (5 s). The scene warms up (the pointer comes onto the key at
# 1 s: it lights, the blob turns to it with a squint of joy), then the key is pressed and the first frame taken: the key
# sinks and its light runs out along its foot, the blob squints and hops. It is let go at RELEASE; the pointer leaves at
# LEAVE (the key dims, the blob looks away) and comes back at BACK (the key lights, the blob turns to it, squints with joy,
# stars pop round its head) and the loop ends on the gaze before the next press, so the cut back reads as the press
# itself. The GIF starts at POSTER (the same loop, begun there; SHEET=<png> writes a sheet of every fifth capture to choose
# it by, one per theme, named <png> with -light or -dark before .png): lit eyes just after the squint of joy, two stars round the head, a still that stands alone for a reader with
# animated images off. One loop per theme (GIFS): the light one is hero.gif, the dark one hero-dark.gif (frame gif-dark),
# which the README swaps in with <picture> as it does the banners.
MS=50; N=100; RELEASE=4; LEAVE=52; BACK=66; POSTER=${POSTER:-77}
loop() { # loop <light|dark>
  local id=gif out=hero.gif
  [ "$1" = dark ] && { id=gif-dark; out=hero-dark.gif; }
  rm -f "$TMP"/g*.png
  ab set viewport 700 400 1.5 >/dev/null
  ab set media "$1" >/dev/null
  ab open "$BASE/card?f=$id&gif$Q" >/dev/null
  ab wait "html[data-card=ready]" >/dev/null
  ab eval "devicePixelRatio === 1.5 || (() => { throw new Error('the 1.5x scale did not take') })()" >/dev/null
  ab eval "window.__cardDo('press'); window.__cardStep($MS)" >/dev/null
  python3 - "$TMP" "$N" "$MS" "$RELEASE" "$LEAVE" "$BACK" > "$TMP/batch.json" <<'PY'
import json, sys
tmp, n, ms, release, leave, back = sys.argv[1], *map(int, sys.argv[2:])
beats = {release: "release", leave: "leave", back: "hover"}
cmds = []
for i in range(n):
    if i in beats:
        cmds.append(["eval", f"window.__cardDo('{beats[i]}')"])
    cmds.append(["screenshot", "#card", f"{tmp}/g{i:03d}.png"])
    cmds.append(["eval", f"window.__cardStep({ms})"])
print(json.dumps(cmds))
PY
  ab batch --bail < "$TMP/batch.json" >/dev/null
  [ -n "${SHEET:-}" ] && python3 "$HERE/cards.py" sheet "$TMP" "$N" "${SHEET%.png}-$1.png"
  python3 "$HERE/cards.py" gif "$TMP" "$N" "$MS" "$POSTER" "$MEDIA/$out" 8
}
for t in $GIFS; do loop "$t"; done
