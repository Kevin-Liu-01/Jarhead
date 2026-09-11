# jarhead-hands

Native macOS helper that gives Jarhead its hands: ScreenCaptureKit screenshots, CGEvent
mouse/keyboard synthesis, window and app queries, and Accessibility reads. It is a resident
command-line process that speaks newline-delimited JSON over stdin/stdout. The TypeScript side
(`packages/hands`) spawns it once and keeps it alive.

- Swift, macOS 14+, arm64, no dependencies beyond system frameworks (Foundation, AppKit,
  CoreGraphics, ApplicationServices, ScreenCaptureKit, Carbon.HIToolbox for `kVK_*`, zlib).
- Source: `packages/hands/native/*.swift`. Entry point and top-level code live in `main.swift`.
- Build: `pnpm build:hands` (runs `scripts/build-hands.ts`), output `build/jarhead-hands`.

```
swiftc -O -swift-version 5 -target arm64-apple-macos14.0 -module-name JarheadHands \
  -o build/jarhead-hands packages/hands/native/*.swift
codesign --force --sign - build/jarhead-hands
```

Smoke test (read-only, safe on a live machine): `node packages/hands/native/smoke.mjs`.

## Protocol

One JSON object per line on stdin; one JSON line per request on stdout, in arrival order.

```
→ {"id": "1", "op": "cursor"}
← {"id": "1", "ok": true, "result": {"x": 1026.3, "y": -993.05}}
→ {"id": "2", "op": "click", "button": "nope"}
← {"id": "2", "ok": false, "error": {"code": "bad_request", "message": "'button' must be \"left\", \"right\" or \"middle\""}}
```

- `id` is echoed back verbatim (a string; numbers are tolerated). A line that is not a JSON
  object, or has no string `op`, gets a `bad_request` response whose `id` is `null` when it
  could not be read. Blank lines are ignored.
- Requests are processed serially on one worker queue. Async ScreenCaptureKit work is awaited
  before the next request starts, so responses always arrive in request order.
- stdout carries nothing but responses and is flushed after each one. Debug logging (per-op
  timings, capture timings) goes to stderr only when `JARHEAD_HANDS_DEBUG=1`.
- Bad input never crashes the process. Unknown `op` → `bad_request`.
- The helper exits with status 0 when stdin closes, after finishing any queued requests.
  `SIGPIPE` is ignored; if stdout disappears the helper exits 0.

### Error codes

| code | meaning |
|---|---|
| `bad_request` | missing/invalid parameter, unknown op, unparseable line |
| `permission_denied` | Screen Recording or Accessibility is not granted (see TCC below) |
| `capture_failed` | ScreenCaptureKit failed for a non-permission reason |
| `not_found` | display / app / window / AX element does not exist |
| `internal` | anything else (launch timeouts, unexpected errors) |

### Coordinates

Everything is in **global screen points**, origin at the **top-left of the main display**,
**y increasing downward** — the `CGEvent.location` / `CGWindowListCopyWindowInfo` /
`CGDisplayBounds` convention. A display above or left of the main one has negative
coordinates; they are valid everywhere and are never clamped or rejected. Accessibility frames
are returned in the same convention (AX already uses it).

Screenshots and zooms report `points` (the captured region, global points) and `scale`
(image pixels per point, exactly `width / points.w`). Convert an image pixel back with
`points.x + px / scale`, `points.y + py / scale`.

### Numbers

Parameters may arrive as JSON integers or doubles (`3` or `3.0`); integer parameters are
rounded. Booleans must be JSON booleans.

## Permissions (TCC)

macOS keys Screen Recording and Accessibility to the **responsible process**, which for this
helper is the app that launched it — the terminal when run from a shell (`pnpm jarhead …`,
`pnpm jarheadd`), `Jarhead.app` when the app's daemon spawns it — not the `jarhead-hands` binary
itself. Grant the permission to that app
in System Settings → Privacy & Security, then relaunch it. Rebuilding/re-signing the helper
does not affect the grant.

- `hello` / `permissions` report `accessibility` (`AXIsProcessTrusted`) and `screenRecording`
  (`CGPreflightScreenCaptureAccess`).
- Without Accessibility, posting CGEvents (move/click/scroll/type/key/drag) **silently does
  nothing** — the ops still answer `ok: true`. Callers must check `hello` first; nothing
  detects it after the fact. `focused_text` and `element_at` do return `permission_denied`.
- Without Screen Recording, `screenshot`/`zoom` return `permission_denied`, and window titles
  from `windows`/`frontmost` are empty strings.

## Operations

Optional parameters are marked `?`. Results omit nothing: absent values are `null`.

### Session and permissions

**`hello`** → `{version: "2.0.0", pid, permissions: {accessibility, screenRecording}}`

**`permissions {prompt?: bool}`** → `{accessibility, screenRecording}`. With `prompt: true`
it first calls `AXIsProcessTrustedWithOptions` with the prompt option and
`CGRequestScreenCaptureAccess()`, which makes macOS show the system prompts for the
responsible app.

**`wait {ms}`** → `{}` after sleeping `min(ms, 10000)` ms on the worker.

### Displays and capture

**`displays`** → `{displays: [{id, x, y, w, h, scale, main}]}` — `x,y,w,h` in points from
`CGDisplayBounds`; `scale` = native pixels per point (`CGDisplayMode.pixelWidth / w`);
`main` for `CGMainDisplayID()`.

**`screenshot {display?, maxLongEdge?, maxPixels?, excludePids?, showCursor?}`** →
`{displayId, pngBase64, width, height, points: {x,y,w,h}, scale}`

- `display`: a display id, `"main"`, or `"cursor"` (default: the display containing the
  cursor; if the cursor is exactly on an edge, the nearest display).
- Output pixel size = native pixels × `min(1, maxLongEdge / longEdgePx, sqrt(maxPixels / totalPx))`.
  Defaults `maxLongEdge: 2576`, `maxPixels: 3750000`. ScreenCaptureKit scales on the GPU
  (`SCStreamConfiguration.width/height`, `captureResolution = .best`, sRGB).
- `excludePids: number[]`: every window owned by those processes is left out of the image
  (`SCContentFilter(display:excludingApplications:exceptingWindows:)`). This is how Jarhead
  hides its own overlay windows; windows those processes create later are excluded too.
- `showCursor` default `true`.
- `width`/`height` are image pixels; `points` is the display's bounds; `scale = width / points.w`.

**`zoom {x, y, w, h, maxLongEdge?, showCursor?, excludePids?}`** → same shape as `screenshot`.
The region is in global points. The display containing the region's centre is used (else the
display with the largest overlap); the region is clipped to that display and `points` reports
the clipped region actually captured. Output is at native pixel density (`display.scale`),
capped so the long edge is ≤ `maxLongEdge` (default 2576). `showCursor` defaults to `false`.
A region that touches no display → `bad_request`.

Capture pipeline: `SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)`
(cached: it only supplies `SCDisplay` and `SCRunningApplication` objects, which are stable;
the cache is dropped on display reconfiguration, when an excluded pid is unknown to it —
at most once per second — or after 30 s) → `SCScreenshotManager.captureImage` → PNG.
PNG encoding uses the built-in `FastPNG` encoder (8-bit RGB, "Up" filter, zlib level 1
deflated in parallel strips, ~8 ms for 3.75 Mpx vs ~135 ms for ImageIO). Set
`JARHEAD_HANDS_PNG=imageio` to force `NSBitmapImageRep` instead. Measured on an M-series Mac:
warm full-display screenshot 48–71 ms end to end (JSON in → JSON out); the first capture in a
process is ~145 ms (ScreenCaptureKit warm-up).

TCC denial (`SCStreamErrorDomain` −3801/−3803, or preflight false) → `permission_denied` with
a message telling the user to grant Screen Recording to the launching app.

### Mouse

**`cursor`** → `{x, y}` from `CGEvent(source: nil).location`.

**`move {x, y}`** → `{x, y}`. Posts `.mouseMoved` at `.cghidEventTap`.

**`click {x?, y?, button?, count?, modifiers?}`** → `{x, y, button, count}`
- `button`: `"left"` (default) | `"right"` | `"middle"`; `count`: 1 | 2 | 3 (default 1).
- `x`,`y` must be given together; when present a `mouseMoved` is posted first (12 ms settle).
  Otherwise the click happens at the current cursor location.
- Each click is down/up with `mouseEventClickState` = 1..count, ~8 ms between down and up,
  ~60 ms between clicks (a double-click is clickState 1 then 2).
- `modifiers`: array of `cmd|command|super|meta`, `shift`, `alt|option`, `ctrl|control`, `fn`
  (case-insensitive) applied as event flags.

**`mouse_down {button?, modifiers?}`** / **`mouse_up {button?, modifiers?}`** → `{x, y, button}`
at the current cursor location, clickState 1.

**`drag {from: {x,y}, to: {x,y}, button?, modifiers?, durationMs?}`** →
`{from, to, button, durationMs}`. Moves to `from`, mouse down, 30 dragged events eased
(ease-in-out) over `durationMs` (default 300, max 10000), mouse up at `to`.

**`scroll {x?, y?, dx?, dy?, modifiers?}`** → `{dx, dy}` (the integers actually posted).
Pixel units. At least one of `dx`/`dy` is required. Semantics of
`CGEvent(scrollWheelEvent2Source:units:.pixel wheelCount:2 wheel1:dy wheel2:dx wheel3:0)`:
**positive `dy` scrolls content up** (shows earlier content), positive `dx` scrolls content
left. When `x`,`y` are given the cursor is moved there first.

### Keyboard

**`type {text, delayMs?}`** → `{characters, events}`. Text is sent with
`CGEventKeyboardSetUnicodeString` in chunks of ≤ 20 UTF-16 code units (surrogate pairs are
never split), keyDown + keyUp per chunk, `delayMs` (default 8, max 1000) apart. `\n`
(also `\r\n`, `\r`) is sent as a Return key press and `\t` as a Tab key press. Any Unicode
works, independent of the keyboard layout.

**`key {combo, repeat?}`** → `{combo, repeat}`. `combo` is `+`-joined, case-insensitive,
xdotool style: `cmd+shift+p`, `ctrl+c`, `alt+Tab`, `Return`, `a`, `A` (adds shift), `+`,
`cmd++`. Every token but the last must be a modifier: `cmd|command|super|meta|win`,
`ctrl|control`, `alt|option`, `shift`, `fn` (`_L`/`_R` suffixed X11 names accepted).
Key names: `Return|Enter`, `KP_Enter`, `Tab`, `Escape|Esc`, `space`,
`BackSpace|Backspace|Delete` (= backspace), `ForwardDelete|KP_Delete`, `Insert|Help`,
`Up|Down|Left|Right`, `Home|End|Page_Up|PageUp|Prior|Page_Down|PageDown|Next`, `Caps_Lock`,
`F1`..`F20`, `KP_0`..`KP_9` and keypad operators, `minus`, `equal`, `plus`, `underscore`,
`comma`, `period`, `slash`, `backslash`, `semicolon`, `colon`, `apostrophe|quote|quotedbl`,
`grave`, `asciitilde`, `bracketleft|bracketright|braceleft|braceright`, `bar`, `less`,
`greater`, `question`, `exclam`, `at`, `numbersign`, `dollar`, `percent`, `asciicircum`,
`ampersand`, `asterisk`, `parenleft|parenright`, and any single printable character. Keys are
mapped to US-layout `kVK_*` virtual key codes (shifted symbols add the shift flag). A single
character without a key code (e.g. `é`, `→`) falls back to `CGEventKeyboardSetUnicodeString`
with the requested flags. A modifier alone (`cmd`) presses that modifier key. `repeat`
(1..100, default 1) presses the combo that many times ~30 ms apart. Unknown names →
`bad_request`.

**`hold_key {combo, durationMs}`** → `{combo, durationMs}`. keyDown, sleep (max 10000 ms),
keyUp.

### Windows and apps

**`frontmost`** → `{app, bundleId, pid, window: {title, x, y, w, h, windowId} | null}`.
The frontmost app via `NSWorkspace`; its window is the first layer-0 on-screen window owned
by that pid (CGWindowList order is front to back).

**`windows {allLayers?: bool}`** →
`{windows: [{windowId, pid, app, title, x, y, w, h, layer, onScreen: true}]}` from
`CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements])`, front to back.
Layer 0 only unless `allLayers` is true. Tiny helper windows are not filtered out.

**`open_app {name?, bundleId?, path?, activate?: bool}`** → `{pid, bundleId, app, path}`.
Resolution order for `name`: a running app with that localized name; the name as a bundle id;
`<name>.app` (case-insensitive, `.app` suffix optional) in `/Applications`,
`/Applications/Utilities`, `~/Applications`, `/System/Applications`,
`/System/Applications/Utilities`, `/System/Library/CoreServices[/Applications]`; finally
Spotlight (`mdfind`, 3 s budget). Launches via
`NSWorkspace.openApplication(at:configuration:)` with `activates = activate` (default true)
and waits up to 30 s for the launch to complete. Unresolvable → `not_found`.

**`focus_app {pid?, name?}`** → `{pid, bundleId, app, activated}`. `name` matches localized
name or bundle id of a running app (case-insensitive). Activates with
`NSRunningApplication.activate(options: [.activateAllWindows])`; if that is refused, falls back
to a Launch Services activation of the app's bundle. Not running → `not_found`.

### Accessibility

Both ops return `permission_denied` when `AXIsProcessTrusted()` is false. Every AX call has a
2 s messaging timeout so an unresponsive app cannot hang the worker.

**`focused_text`** → `{role, subrole, title, value, selectedText, secure, app, frame | null}`
for `kAXFocusedUIElementAttribute` of the system-wide element. `value` and `selectedText` are
truncated to 4000 characters. `secure` is true for `AXTextField` + `AXSecureTextField`; for
secure fields `value` and `selectedText` are always `null`. No focused element → `not_found`.

**`element_at {x, y}`** → `{role, subrole, title, description, value, frame | null, app}` via
`AXUIElementCopyElementAtPosition`; `value` truncated to 400 characters. Nothing there →
`not_found`.

### Accessibility tree and `find_element` (the reflex path)

**`ax_tree {app?, maxAgeMs?, maxNodes?, maxDepth?, maxMs?, summary?}`** →
`{app, pid, window, count, cached, ageMs, treeMs, truncated, nodes?: [{i, depth, role, subrole?,
title?, description?, value?, x?, y?, w?, h?, pressable?}]}`. The focused (else main, else first)
window of the frontmost app — or of the running app named by `app` — walked breadth-first with
one `AXUIElementCopyMultipleAttributeValues` per element (0.3 s messaging timeout each), capped by
`maxNodes` (default 1500), `maxDepth` (14) and a time budget `maxMs` (250; `truncated` says when a
cap cut the walk — breadth-first, so the toolbar and top-level controls survive a cut, a desktop
full of icons or a long page is what goes). Cached per app: reused while younger than `maxAgeMs`
(default 500) and the same window is up; the engine keeps the frontmost one warm every 500 ms
while awake (`summary: true` returns only the counts). Chromium apps get `AXManualAccessibility`
set so their web content is exposed; a first walk that finds almost nothing is retried once after
120 ms. Measured: Chrome 188 nodes in ~70–100 ms cold, 2 ms cached; Finder's desktop hits the
250 ms budget at ~400 nodes; Slack (Electron) exposes 60 nodes. Needs Accessibility.

**`find_element {name, role?, app?, maxAgeMs?, maxMs?, threshold?}`** →
`{app, window, found, unique, candidates, tier: "exact"|"fuzzy"|"none", element?: {…node, app,
score, label, center: {x, y}}, others?: […], cached, treeMs, nodes, truncated, ms}`. The visible,
clickable controls (an `AXPress` action or a clickable role) of that tree whose title,
description or short value matches `name`: exact after lowercasing and dropping punctuation and a
trailing ellipsis, else edit-distance similarity ≥ `threshold` (default 0.85). Candidates whose
frames coincide (a cell and its label) count once. `unique` is what the reflex path needs: two
candidates mean "no reflex" — the caller must not guess. 2–14 ms on a cached tree.

### Browser scripting (Apple events, no process spawn)

All four take `app` (a Chrome-family browser or Safari, by localized name) and answer
`not_found` when it is **not running** — nothing here ever launches a browser. Scripts are
`NSAppleScript`s compiled once and reused (the JavaScript rides in as the `run` handler's
argument), sent from the main thread. `permission_denied` when Jarhead may not control the app
(Automation) or when JavaScript from Apple Events is off — the message names the exact menu
(Chrome: View › Developer › Allow JavaScript from Apple Events; Safari: Develop › Allow JavaScript
from Apple Events).

**`browser_js {app, script}`** → `{result, ms}` — the script's result as text (Chrome: `execute
active tab of front window javascript`; Safari: `do JavaScript … in current tab of front window`).

**`browser_url {app}`** → `{url, title}` of the active tab; needs no JavaScript permission.

**`browser_tabs {app}`** → `{tabs: [{index, title, url, active}], active}` for the front window,
fetched as two whole lists (75 ms for 80 tabs).

**`browser_navigate {app, url}`** → `{ok: true}`; opens a window when the browser has none.

## Files

| file | contents |
|---|---|
| `main.swift` | entry point, dispatcher, stdin reader thread, `hello`/`permissions`/`wait` |
| `Protocol.swift` | JSON param parsing, error codes, response writer, small helpers |
| `Screen.swift` | displays, ScreenCaptureKit capture, content cache, `screenshot`/`zoom` |
| `FastPNG.swift` | parallel zlib PNG encoder |
| `Input.swift` | mouse and keyboard ops |
| `Keys.swift` | key-name → `kVK_*` table, combo/modifier parsing |
| `Windows.swift` | `frontmost`, `windows`, `open_app`, `focus_app` |
| `AX.swift` | `focused_text`, `element_at`, shared AX helpers |
| `AXTree.swift` | the cached window tree, `ax_tree`, `find_element` |
| `Browser.swift` | `browser_js`, `browser_url`, `browser_tabs`, `browser_navigate` via NSAppleScript |
| `smoke.mjs` | read-only end-to-end check of the built binary |
