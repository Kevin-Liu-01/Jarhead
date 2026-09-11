# Jarhead renderer

The visual surface of Jarhead: three Electron windows built from plain HTML,
CSS and ES modules. No build step, no frameworks, no npm packages, nothing
loaded from the network.

```
renderer/
  orb/        the presence — 96×96 canvas orb, expands to a 340×220 capsule
  console/    the control surface — agents · stream · now/settings/ledger
  overlay/    click-through annotations over one display
  shared/     tokens.css, dom.js, bridge.js (store), format.js, icons.js, phase.js
  mock/       fake window.jarhead + preview screenshots (dev only)
```

Types come from `packages/protocol/src/index.ts` and are treated as law.

## What each window needs from the preload

Every window reads the bridge from `window.jarhead`. If it is undefined the
page imports `mock/bridge.js` and installs the fake instead — so the preload
must run before the module script (it does, by construction).

| member | orb | console | overlay | notes |
| --- | :-: | :-: | :-: | --- |
| `window` | ✓ | ✓ | ✓ | `"orb" \| "console" \| "overlay"` |
| `onEvent(listener) → unsubscribe` | ✓ | ✓ | – | must fire once immediately with the current `snapshot`, then on change (≤ 20 Hz); `levels` may be higher frequency |
| `send(command)` | ✓ | ✓ | – | `EngineCommand` |
| `orbDrag(phase, screenX, screenY)` | ✓ | – | – | `"start" \| "move" \| "end"`; start is sent with the original mousedown coordinates once a 4 px threshold is crossed |
| `orbResize(width, height)` | ✓ | – | – | 96×96 collapsed, 340×220 expanded (also used briefly for the context menu and toasts). Keep the top-left anchored. |
| `onOverlay(listener) → unsubscribe` | – | – | ✓ | `OverlayCommand` in global points |
| `overlayBounds() → Promise<{x,y,w,h,scaleFactor}>` | – | – | ✓ | this window's display in global points; re-queried on `resize` |
| `openExternal(url)` | – | ✓ | – | currently unused by the UI (reserved for links) |
| `readLedger(date) → Promise<LedgerRow[]>` | – | ✓ | – | `"2026-09-10"` |
| `ledgerDays() → Promise<string[]>` | – | ✓ | – | newest first is assumed for the default pick |
| `screenshotUrl(path) → string` | – | ✓ | – | turns `DelegationStep.screenshotPath` into an `<img src>` |

Window expectations for main:

- **orb** — frameless, transparent, always-on-top, not resizable by the user.
  The page draws everything; body background is transparent. The page calls
  `orbResize` when it needs more room.
- **console** — normal resizable window, ~1180×760 default. The header bar is
  `-webkit-app-region: drag` (harmless with a native title bar).
- **overlay** — transparent, click-through (`setIgnoreMouseEvents(true)`),
  one per display, sized to that display.

## Preview with the mock

```sh
cd /Users/kevinliu/jarvis && python3 -m http.server 8765 --directory packages/shell/src/renderer
```

- http://localhost:8765/orb/ — add `?expanded=1`, `?phase=speaking` to pin a phase
- http://localhost:8765/console/ — add `?scenario=empty`, `?tab=settings`, `?tab=ledger&day=first`
- http://localhost:8765/overlay/ — add `?hold=1` to freeze the annotations
- http://localhost:8765/mock/orb-gallery.html — every orb phase side by side
- `?speed=3` runs the scripted conversation faster; `?scenario=quiet` skips the delegation.

The mock cycles phases every 4 s, emits levels at 30 Hz, streams a fake
transcript, runs one successful delegation (with a screenshot and a confirm
step) and one failed one, and fires overlay commands on a loop. Commands sent
from the UI are `console.log`ged and applied to the fake world so buttons feel
real.

`mock/preview-*.png` are 2× screenshots of each window in several states,
taken headlessly from these URLs.

## Conventions

- Tokens live in `shared/tokens.css`; phase colours are duplicated as literals
  only in `shared/phase.js` because the orb paints them on a canvas.
- The console stream is keyed: rows are rebuilt only when their signature
  changes, so 20 Hz snapshots are cheap. Everything else re-renders behind a
  signature check.
- Reduced motion is respected everywhere (`prefers-reduced-motion`).
- `renderer/audio/**` belongs to someone else and is never imported here.
