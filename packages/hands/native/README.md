# jarhead-hands

Native macOS helper that gives Jarhead its hands: ScreenCaptureKit screenshots, CGEvent
mouse/keyboard synthesis, window and app queries, and Accessibility reads. It is a resident
command-line process that speaks newline-delimited JSON over stdin/stdout. The TypeScript side
(`packages/hands`) spawns it once and keeps it alive. It is background-only: it sets
LSBackgroundOnly in its in-memory Info dictionary before AppKit checks it in, so inside
Jarhead.app it never shows as a second "Jarhead" Dock tile (`smoke.mjs` checks it with `lsappinfo`).

- Swift, macOS 14+, arm64, no dependencies beyond system frameworks (Foundation, AppKit,
  CoreGraphics, ApplicationServices, ScreenCaptureKit, Carbon.HIToolbox for `kVK_*`, IOKit for the
  Input Monitoring read, zlib).
- Source: `packages/hands/native/*.swift`. Entry point and top-level code live in `main.swift`.
- Build: `pnpm build:hands` (runs `scripts/build-hands.ts`), output `build/jarhead-hands`.

```
swiftc -O -swift-version 5 -target arm64-apple-macos14.0 -module-name JarheadHands \
  -o build/jarhead-hands packages/hands/native/*.swift
codesign --force --sign - build/jarhead-hands
```

Smoke test (read-only, safe on a live machine): `node packages/hands/native/smoke.mjs`.
Two headless harnesses compile one source file with their own `main.swift` and post nothing:
`harness/hands-win/check.sh` (the decisions in `HandsWin.swift`) and `harness/run-blocking/check.sh`
(the capture bound in `Protocol.swift`). `pnpm test` runs both
(`packages/hands/src/__tests__/hands-win-native.test.ts`, `run-blocking-native.test.ts`).

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
| `capture_failed` | ScreenCaptureKit failed for a non-permission reason, did not answer within 5 s, or answered -3801 twice while Screen Recording reads as granted |
| `not_found` | display / app / window / AX element does not exist |
| `busy` | Kevin pressed a key, clicked or scrolled within the last 1.5 s: nothing was posted (see *Kevin's hands win*) |
| `focus_moved` | the app in front is not the `expectFront` pid the caller judged against: nothing was posted |
| `internal` | anything else (launch timeouts, unexpected errors) |

The TypeScript client adds three of its own that never come from this process: `unavailable`
(the helper is not built, not running, or exited), `timeout` (no answer within the client's
per-op deadline: 8 s by default, 6 s for `screenshot` and `zoom`, 6 s plus 15 ms a character for
`type`) and `cancelled` (a stop, `cancelPending`, failed the request while it was in flight; a
late answer for it is dropped).

### Kevin's hands win

Two processes run this binary (`HandsPool` in `packages/hands`): `focus` acts and is the only one
that captures; `background` reads, and a `screenshot` or `zoom` asked of it is taken by `focus`
(`CAPTURE_OPS`, `packages/hands/src/native.ts`). Two processes from one executable path that both
capture set ScreenCaptureKit's connections interrupting each other while the screen is locked
(`pnpm jarhead bench`, 2026-10-06: before the fix every quick screenshot ran into the client's 6 s
timeout, n = 4 over three runs; after it, 117 ms median, n = 5). Both are children of the daemon, so they
share its TCC identity and neither carries Jarhead's API keys in its environment. Whatever the lanes
do about sharing the one pointer, the last word is here, on the worker queue, immediately before an
op's first `CGEvent.post`. The decisions are pure code over an injected event clock in
`HandsWin.swift`; `Input.swift` feeds them CGEventSource and AX, and `harness/hands-win/check.sh`
feeds them a clock it moves.

- **`busy`.** Every event this process posts is noted by kind (key down, button down, scroll).
  Before an acting op posts anything, the session (`CGEventSource` on the combined session state,
  which counts our own posts too) is read two ways per kind. By time: a newest event that is not
  within 30 ms of our own last post of that kind is someone else's. By count: whatever the session
  counted beyond our own posts is someone else's, however many of ours came after it, so a later
  post of ours never masks Kevin's key. When that newest foreign key press, click or scroll is
  younger than 1500 ms the op answers `busy` (*"the user used the keyboard/mouse N ms ago; nothing
  was posted"*; the client puts the user's name in) and the client retries it quietly once he has
  been still. Pointer moves are not counted: a resting hand jitters.
- **What is held.** `click`, `mouse_down`, `drag`, `scroll`, `type`, `key`, `hold_key`, `move` (the
  pointer is his too), `focus_app`, `open_app` with `activate` (the default; a launch in the
  background moves nothing of his), `browser_navigate` (it replaces the page he may be typing in),
  and `browser_js` when its browser is the front app, unless `readOnly: true`. The client's probe,
  read and find send `readOnly: true` and only look; its click and type scripts are held. A
  `browser_js` in a browser behind the front app runs. `ownDriver: true` skips the check
  (dictation is Kevin typing, and his keystrokes are no reason to hold his own words back), and
  `mouse_up` skips it (refusing the release of a press already posted would leave a synthetic
  button held down). Both still read the session, so his events are attributed as they come.
- **`expectFront: {pid}`** on the same ops (and `mouse_up`): the pid of the app the caller saw in
  front when it judged the action. If another app is in front now the op answers `focus_moved`
  with nothing posted. The caller's own probe and the post are two serial ops with a gap between
  them; only this process can close it.
- **During a `type`.** Before every grapheme cluster (and before a Return or Tab, an accessibility
  insertion or a ⌘V) the type asks, in order: the client's stop, Kevin's hands, then where the
  keystrokes land. The front app and that app's focused element are re-read at most every 50 ms,
  counted from the end of the last re-read. The focus moving to another window (a sheet, a dialog)
  or out of text entry is `focus_moved`; a new element in the same window that still takes text is
  not (a code box advancing to the next). A focus read with no answer, or slower than 50 ms (Mail
  syncing, Xcode indexing), is a miss, and after two misses in a row the type keeps only the
  front-app check. A stop ends the op with a cancelled result,
  `{characters, total, events, via, attempts, cancelled: true, reason: "stop" | "busy" | "focus_moved", field}`,
  so the rest of the text lands nowhere rather than in the new place. `characters` counts what
  landed as the text counts it (an emoji is one, a Return or Tab pressed is one), by keystrokes,
  accessibility insertion or paste alike. A `busy` stop before anything went out is the guard's
  refusal, the `busy` error, so the runner may retry it and nothing lands twice.
- **`user_idle {}`** → `{keyMs, clickMs, scrollMs, moveMs, foreignMs}`: milliseconds since the
  session's last key press, click, scroll and pointer move, and `foreignMs`, since the last
  key/click/scroll this process did *not* post (Kevin's own input, by time and by count). `1e12`
  when the session has never seen that kind of event. The screen lease polls it before a thread's
  lane takes the pointer, and the runner reads it before `open_url` and before a shell or
  AppleScript line that brings an app forward or posts keys. Per process: a helper that never posts
  (the engine's `background` one) counts every event as foreign, the acting helper's own posts
  included, so the lease reads `user_idle` from the acting helper (`FocusLeaseOptions.userIdle`),
  never from the reader.

`harness/hands-win/main.swift` is compiled with `HandsWin.swift` by `harness/hands-win/check.sh` and
run headless (no CGEvent posted, no AX read, no window): busy by count and by time, an own post
never masking Kevin's, a type stopping with the characters that landed. `pnpm test` runs it
(`hands-win-native.test.ts`, "the hands-win decision harness passes"). Real AX timing in Mail or
Xcode has not been measured headless; that check needs a real desktop.

### Coordinates

Everything is in **global screen points**, origin at the **top-left of the main display**,
**y increasing downward**: the `CGEvent.location` / `CGWindowListCopyWindowInfo` /
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
helper is the app that launched it (the terminal when run from a shell, `pnpm jarhead …` or
`pnpm jarheadd`; `Jarhead.app` when the app's daemon spawns it), not the `jarhead-hands` binary
itself. Grant the permission to that app
in System Settings → Privacy & Security, then relaunch it. Rebuilding/re-signing the helper
does not affect the grant.

- `hello`, `permissions` and `jarhead-hands --permissions` (one JSON line, then exit, before AppKit
  starts) report all four grants a helper can read: `accessibility` (`AXIsProcessTrusted`),
  `screenRecording` (`CGPreflightScreenCaptureAccess`), `inputMonitoring` (`IOHIDCheckAccess`) and
  `fullDiskAccess` (an open of a file only that grant unlocks). None of the four reads shows a
  dialog. The engine runs `--permissions` in a fresh process because a running one may keep the
  answer it got at launch.
- Without Accessibility, posting CGEvents (move/click/scroll/type/key/drag) **silently does
  nothing**: the ops still answer `ok: true`. Callers must check `hello` first; nothing
  detects it after the fact. `focused_text` and `element_at` do return `permission_denied`.
- Without Screen Recording, `screenshot`/`zoom` return `permission_denied`, and window titles
  from `windows`/`frontmost` are empty strings.

## Operations

Optional parameters are marked `?`. Results omit nothing: absent values are `null`.

### Session and permissions

**`hello`** → `{version: "2.0.0", pid, permissions: {accessibility, screenRecording, inputMonitoring, fullDiskAccess}}`

**`permissions {prompt?: bool, which?}`** → the same four. With `prompt: true` it first asks for
one grant, one dialog per call (two at once and the second is dismissed with the first):
`which: "accessibility"` calls `AXIsProcessTrustedWithOptions` with the prompt option,
`"screenRecording"` calls `CGRequestScreenCaptureAccess()`, and `"all"` (the default) asks for the
first of the two still missing. Input Monitoring's prompt belongs to the app, and Full Disk Access
has none.

**`wait {ms}`** → `{}` after sleeping `min(ms, 10000)` ms on the worker.

### Displays and capture

**`displays`** → `{displays: [{id, x, y, w, h, scale, main}]}`: `x,y,w,h` in points from
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
the cache is dropped on display reconfiguration, when an excluded pid is unknown to it (at
most once per second), or after 30 s) → `SCScreenshotManager.captureImage` → PNG.
PNG encoding uses the built-in `FastPNG` encoder (8-bit RGB, "Up" filter, zlib level 1
deflated in parallel strips, ~8 ms for 3.75 Mpx vs ~135 ms for ImageIO, measured 2026-09-10,
n not recorded). Set `JARHEAD_HANDS_PNG=imageio` to force `NSBitmapImageRep` instead.

Measured: on 2026-09-10, on an M-series Mac, a warm full-display screenshot took 48–71 ms end to
end (JSON in → JSON out; n not recorded) and the first capture in a process ~145 ms
(ScreenCaptureKit warm-up). On 2026-10-06, through the runner with `pnpm jarhead bench` (screen
locked, load average 160 to 200), the quick screenshot (2000 px, 1.1 MP) took 117 ms median and
305 ms p95 (n = 5) and the full one 128 ms (n = 1). In Kevin's ledger from 2026-09-12 to 09-28 a
screenshot took 98 ms median and 311 ms p95 (n = 72).

Every capture waits on ScreenCaptureKit for at most 5 s in all (`runBlocking` in `Protocol.swift`),
then answers `capture_failed` and the worker moves on; a callback that never comes would otherwise
hold every op queued behind it. An `SCStreamErrorDomain` -3801 while Screen Recording reads as
granted is tried once more inside the same 5 s, and a second one answers `capture_failed`, never
"not granted": replayd answers -3801 with the grant too, after its connections were interrupted. A
-3803, or a -3801 or any other capture error with the preflight false, is `permission_denied`, with a message telling the user to grant Screen Recording to the launching
app. `harness/run-blocking/check.sh` checks the bound and the retry headless.

### Mouse

Every op below except `cursor` accepts `expectFront?: {pid}` and `ownDriver?: bool`
(see *Kevin's hands win*) and may answer `busy` or `focus_moved` having posted nothing
(`mouse_up` never answers `busy`).

**`cursor`** → `{x, y}` from `CGEvent(source: nil).location`.

**`move {x, y}`** → `{x, y}`. Posts `.mouseMoved` at `.cghidEventTap`. Held like a click while
Kevin's hands are on the machine: the pointer does not jump out from under his hand.

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

All three accept `expectFront?: {pid}` and `ownDriver?: bool` (see *Kevin's hands win*).

**`type {text, delayMs?, strategy?, expectFront?, ownDriver?}`** →
`{characters, events, via, attempts, verified?, field, note?}`, or when it stopped part way
`{characters, total, events, via, attempts, cancelled: true, reason: "stop" | "busy" | "focus_moved", field}`
(see *During a `type`* under *Kevin's hands win*).

Delivery is a strategy chain, like a careful person typing into a field and looking:
`strategy` `"auto"` (default) tries **`ax`** (accessibility insertion into the focused text
field, read back to verify; skipped for Chromium / Electron fields, whose value says nothing),
then **`keystrokes`** (`CGEventKeyboardSetUnicodeString` one grapheme cluster at a time,
≤ 20 UTF-16 units per event, surrogate pairs never split, `delayMs` (default 3, max 1000)
apart, the stop, Kevin's hands and where the keystrokes land checked before each cluster),
then **`paste`**: the text goes
on the general pasteboard marked concealed and transient, ⌘V, and the previous contents are
restored. Three attempts at most; then `internal` with a message that names the field and says
the whole text is on the clipboard for one ⌘V. `"ax"`, `"keystrokes"` or `"paste"` pins one
strategy. `\n` (also `\r\n`, `\r`) is a Return key press and `\t` a Tab press; after each the
focused element is resolved again. A password field is refused (`bad_request`) whatever the
caller asked. `via` is the strategy that delivered, `verified` whether the field read the text
back (absent when nothing was typed), `field` the field's description ("the "Subject" text
field in Mail") or `null`. Any Unicode works, independent of the keyboard layout.

The client's stop is out of band: the helper is serial, so a cancel line would queue behind
the very `type` it means to stop. Instead the client sends `SIGURG` (default action: ignore,
so an older helper shrugs it off) and the keystroke loop stops at the next grapheme with
`cancelled: true, reason: "stop"`. A signal that lands before a queued `type` starts counts as
that op's stop.

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

### Session input

**`user_idle {}`** → `{keyMs, clickMs, scrollMs, moveMs, foreignMs}`: see *Kevin's hands
win*. Never posts anything; safe to poll.

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
and waits up to 30 s for the launch to complete. Unresolvable → `not_found`. With `activate`
true it brings the app over whatever Kevin is typing in, so it is held like a click while his
hands are on the machine and takes `expectFront`; a launch in the background is not held.

**`focus_app {pid?, name?}`** → `{pid, bundleId, app, activated}`. `name` matches localized
name or bundle id of a running app (case-insensitive). Activates with
`NSRunningApplication.activate(options: [.activateAllWindows])`; if that is refused, falls back
to a Launch Services activation of the app's bundle. Not running → `not_found`. Held like a
click while Kevin's hands are on the machine: a switch under his typing would send the rest of his
words to this app.

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
window of the frontmost app (or of the running app named by `app`), walked breadth-first with
one `AXUIElementCopyMultipleAttributeValues` per element (0.3 s messaging timeout each), capped by
`maxNodes` (default 1500), `maxDepth` (14) and a time budget `maxMs` (250; `truncated` says when a
cap cut the walk: breadth-first, so the toolbar and top-level controls survive a cut, and a
desktop full of icons or a long page is what goes). Cached per app: reused while younger than `maxAgeMs`
(default 500) and the same window is up; the engine keeps the frontmost one warm every 500 ms
while awake (`summary: true` returns only the counts). Chromium apps get `AXManualAccessibility`
set so their web content is exposed; a first walk that finds almost nothing is retried once after
120 ms. Measured by hand on 2026-09-11 (n not recorded): Chrome 188 nodes in ~70–100 ms
cold, 2 ms cached; Finder's desktop hits the 250 ms budget at ~400 nodes; Slack (Electron)
exposes 60 nodes. Needs Accessibility.

**`find_element {name, role?, app?, maxAgeMs?, maxMs?, threshold?}`** →
`{app, window, found, unique, candidates, tier: "exact"|"fuzzy"|"none", element?: {…node, app,
score, label, center: {x, y}}, others?: […], cached, treeMs, nodes, truncated, ms}`. The visible,
clickable controls (an `AXPress` action or a clickable role) of that tree whose title,
description or short value matches `name`: exact after lowercasing and dropping punctuation and a
trailing ellipsis, else edit-distance similarity ≥ `threshold` (default 0.85). Candidates whose
frames coincide (a cell and its label) count once. `unique` is what the reflex path needs: two
candidates mean "no reflex": the caller must not guess. 2–14 ms on a cached tree (by hand,
2026-09-11, n not recorded).

### Browser scripting (Apple events, no process spawn)

All four take `app` (a Chrome-family browser or Safari, by localized name) and answer
`not_found` when it is **not running**: nothing here ever launches a browser. Scripts are
`NSAppleScript`s compiled once and reused (the JavaScript rides in as the `run` handler's
argument), sent from the main thread. `permission_denied` when Jarhead may not control the app
(Automation) or when JavaScript from Apple Events is off; the message names the exact menu
(Chrome: View › Developer › Allow JavaScript from Apple Events; Safari: Develop › Allow JavaScript
from Apple Events).

**`browser_js {app, script, readOnly?}`** → `{result, ms}`: the script's result as text (Chrome:
`execute active tab of front window javascript`; Safari:
`do JavaScript … in current tab of front window`). In the browser in front, a page script clicks,
types and moves the focus under Kevin's hands, so it is held like a click while he is using them,
unless `readOnly: true` (the client's probe, read and find, which only look). Behind another app it
touches nothing of his and runs.

**`browser_url {app}`** → `{url, title}` of the active tab; needs no JavaScript permission.

**`browser_tabs {app}`** → `{tabs: [{index, title, url, active}], active}` for the front window,
fetched as two whole lists (75 ms for 80 tabs, 2026-09-11, n not recorded; 94 ms median and
218 ms p95 through `pnpm jarhead bench`, n = 5, 2026-10-06).

**`browser_navigate {app, url}`** → `{ok: true}`; opens a window when the browser has none. It
replaces the page Kevin may be typing in, so it is held like a click while his hands are on the
machine.

## Files

| file | contents |
|---|---|
| `main.swift` | entry point, LSBackgroundOnly, `--permissions`, dispatcher, stdin reader thread, `hello`/`permissions`/`wait` |
| `Protocol.swift` | JSON param parsing, error codes, response writer, small helpers, `runBlocking` (the 5 s capture bound and the -3801 retry) |
| `Screen.swift` | displays, ScreenCaptureKit capture, content cache, `screenshot`/`zoom` |
| `FastPNG.swift` | parallel zlib PNG encoder |
| `HandsWin.swift` | Kevin's hands win, as pure code over an injected clock: the busy ledger (by time and by count), the focus watch, a type's stop and the characters it counts |
| `Input.swift` | mouse and keyboard ops, the type strategy chain, own-post stamps, the session reads that feed `HandsWin.swift`, the busy guard, `user_idle` |
| `Keys.swift` | key-name → `kVK_*` table, combo/modifier parsing |
| `Windows.swift` | `frontmost`, `windows`, `open_app`, `focus_app`, the `expectFront` check |
| `AX.swift` | `focused_text`, `element_at`, shared AX helpers |
| `AXTree.swift` | the cached window tree, `ax_tree`, `find_element` |
| `Browser.swift` | `browser_js`, `browser_url`, `browser_tabs`, `browser_navigate` via NSAppleScript |
| `smoke.mjs` | read-only end-to-end check of the built binary, and that the helper never checks in as a Foreground app |
| `harness/hands-win/` | `main.swift` + `check.sh`: `HandsWin.swift`'s decisions on a moved clock, headless (`hands-win-native.test.ts`) |
| `harness/run-blocking/` | `main.swift` + `check.sh`: `Protocol.swift`'s capture bound and -3801 retry, headless (`run-blocking-native.test.ts`) |
