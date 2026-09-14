import AppKit
import SwiftUI

// Throwaway preview harness: builds an AppState full of realistic fake data and
// shows the Console window. Not part of the package; compiled only by
// Scripts/console-preview.sh.
//   PREVIEW_SCENARIO=live|confirm|empty|settings|wake-locked|ledger|light|conversation|conversation-codex|jarhead|jarhead-log|paused|switch
//                    |cleanup|cleanup-select|cleanup-rename|cleanup-undo|search|problems|cleared|loading|wipe|timing|memory|durability
//                    |threads|thread-pane|thread-answer|typed-row|agent-pending
//     threads      = Jarhead's threads (Snapshot.threads → AppState.threads): the main thread idle between
//                    turns, Spotify acting in the background lane, Slack waiting on Kevin in the screen lane
//                    with its question, Notes done a moment ago and lingering. The rail's Threads section
//                    (waiting-kevin → busy → idle main → finished; status glyph · name · status word;
//                    `00:12 · screen · 7 steps`), the right rail's Threads section (Stop per live row), the
//                    parent card's thread chips. Its default action runs `check-threads` (the pure words of
//                    this pass: the rail order, the glyphs, ThreadStore's cap / patching / paging, the event
//                    and snapshot merges, the pending echo, the key table — run.log `check:` lines).
//     thread-pane  = Slack's pane: its brief as the card's request, its own steps and screenshot, the
//                    confirm step with Allow / Deny, the question strip over the composer, Stop hot, "‹ Now".
//     thread-answer = the pane, then Allow the way the strip sends it at 1.0 s: run.log's `send:` line must be
//                    {"type":"thread.answer","threadId":"t_sl4ck00","yes":true} — never say-text, never stop —
//                    and `check:` pins that Return is never a yes (ConsoleConfirm.returnIsAYes false).
//     typed-row    = live data with a line Kevin typed in the composer (TranscriptItem.source "typed"): its
//                    row draws keyboard.fill where a spoken line draws person.fill; the composer says
//                    "Type to Jarhead… (asleep: press Go)" while asleep (PREVIEW_PHASE=asleep).
//     agent-pending = the blocked Claude session stepped into, a line sent to it at 0.5 s (the pending echo:
//                    0.6 opacity, clock.fill, "Sending…"), snapped at 1.0 s (-mid.png), then the real user
//                    turn lands at 1.6 s and the echo is gone: `probe-pending` prints the counts.
//     thread-history = the main thread's pane over a PAGED record (61 entries; the newest page of 60 held,
//                    `complete: false`): a page boundary split a card from its steps, so the steps stand as
//                    four orphan rows at the top. Scrolled up (unstuck), "Load earlier" pressed the way the
//                    button does (`send:` thread.history before: 2), then the engine's older page lands
//                    (`thread-history:main` → prepend): the card takes its orphans in, no row doubles,
//                    `complete` flips true, and `geometry` before / after says the row Kevin was reading
//                    stayed put (the keepOffset hold on the non-lazy feed).
//     memory       = the durable memory of Kevin: asleep, the Settings tab scrolled to its Memory section —
//                    the Remember toggle, Matching, the counts with "learned … ago", Learn now, the budget
//                    hint, and the rail under them (search, Live | Forgotten | Archived, ≤ 30 rows with
//                    Edit / Forget / Restore behind ⋯ and the context menu, the Forget hint). The rows come
//                    from FakeData.memoryItems through the same handlers the app installs. Its default action
//                    runs `check-durability` (the pure words of this pass, run.log `check:` lines).
//     durability   = long-horizon durability (was `threads` before the Threads pass took the name): the ended
//                    Codex thread (no process; its last tool call `interrupted`, settled grey, never a pulse;
//                    no live dot — `isLive` is derived from status + connection, never latched) stepped into
//                    with a 1 200-message transcript the feed caps at 400 (LazyVStack; "Load earlier" offers
//                    the rest). Then a daemon reconnect at 1.0 s (the pane must re-send ONE agent.open naming
//                    its viewer — the same token as its first), the window hidden at 1.4 s (agent.close, same
//                    viewer) and shown at 1.8 s (agent.open again): run.log's `send:` lines are the check.
//                    PREVIEW_CONNECTED=0 on `live` is the caret gate's control: a non-final item sits still
//                    while disconnected.
//     timing       = the pane switch at REAL speed (no PREVIEW_WIPE_SECONDS), traced: live data (with the
//                    agents' transcripts and marks, so the conversation pane has rows), then four switches
//                    — into the Jarhead chain, back to Now, into the blocked Claude session, back — the
//                    right rail's tab to Settings and back, and a ledger day picked and left, each between a
//                    `trace:<label>` and a `trace-stop`: the main thread's turns of 4 ms or more print as
//                    `frame: …` (the switch's own turn and every turn in the 0.6 s after it, stamped
//                    "+ms" from the switch; any turn over 50 ms; a few idle ones before), and the stop prints
//                    `timing: <label> …`: the switch turn (the frame the switch is made in), the wipe's frames
//                    (0.29 s) and their longest, then everything after the switch (count, longest, over 50 ms,
//                    the busy sum). The curtain's budget: no wipe frame over 50 ms at 0.24 s. PREVIEW_SETTLE=12.
//     loading      = the dither pass's loading states: live data, then at 0.3 s the ledger day
//                    2026-09-10 is picked and at 0.6 s (the fake ledger has answered by then) the
//                    read is pinned in flight again and a search ("vercel": no fake title carries
//                    it, so the indicator shows, not title matches) is pinned in flight — the
//                    stream's "Reading…" under 16×2 dither glyphs, the rail's "Reading" row (8×1),
//                    the Jarhead section's "Searching…" (8×1). Its default action runs `check-dither`.
//     wipe         = the dither curtain: live data, the Jarhead chain stepped into at 1.2 s and snapped
//                    mid-wipe (<PREVIEW_OUT_DIR>/preview-console-wipe-mid.png: the arriving pane emerging
//                    through the crosshatch from a sheet of ground-coloured cells — the leaving pane is
//                    gone under it), `probe` at 4.0 s with the pane open and the curtain spent (the same
//                    open/loaded/entries line `switch` prints there — the state survived the switch),
//                    Now shown again at 4.2 s and snapped mid-wipe-back (-wipe-back.png), `probe` again.
//                    The `ledger` and `jarhead-log` scenarios carry a `sleep` row (the moon, "asleep · idle" /
//                    "asleep · said “that's all for now”") before the close it explains.
//     cleanup      = the rail with a pinned chain above the days, "Archived (2)" folded and
//                    "Trash (2)" open with Restore on each row and the folder on its head; the
//                    Agents section with "Hidden (1)" open; the trash figures in Settings › Retention
//     cleanup-select = the same with two chains ⌘-picked: the strip under the head (Archive ·
//                    Move to Trash · Restore) and the check marks on the rows
//     cleanup-rename = the pinned chain's title as the inline field
//     cleanup-undo = a chain moved to the Trash at 0.5 s: the toast "Moved to Trash · Undo" under
//                    the header and the row in the open Trash group
//     cleanup-log  = the pinned chain's Log view: its renamed and pinned rows as terse lines
//     search       = the head as the search box with "codex" typed: hits from the fake ledger
//                    grouped by conversation, the title match first
//     search-hit   = "codex did while" searched, then its one hit opened the way the row would: the
//                    paused → resumed chain's Conversation view scrolled to the delegation card, lit;
//                    `probe` prints what landed (entries, scroll target, the entry id it resolves to)
//     cleanup-undo-toast = cleanup-undo, then the toast's Undo at 1.2 s, ⌘Z at 1.8 s (must find nothing
//                    to undo), ⇧⌘Z at 2.4 s (re-trashes): the undo manager's stacks after a toast Undo
//     problems     = the Now tab with typed problems: a solid symbol per kind and a remedy button each
//     cleared      = Now cleared at 0.5 s: the feed's "Cleared · Undo", the toast
//     jarhead      = live data with a past Jarhead conversation stepped into — the paused → resumed
//                    chain (two sessions folded into one row, "resumed ×1"), read-only, Conversation view
//     jarhead-log  = the same conversation as its ledger log (time · type · text)
//     paused       = the live session paused: the rail's Now row says "paused · meter stopped"
//     switch       = the motion pass's scenario: live data, then (PREVIEW_ACTION's default for it)
//                    the Jarhead chain is stepped into at 1.2 s and shot mid-crossfade at 1.36 s
//                    (<PREVIEW_OUT_DIR>/preview-console-switch-mid.png: both panes half there, the
//                    rail's highlight between rows), Now is shown again at 2.6 s, the stream's
//                    scroll geometry is printed, two transcript lines are appended, and the
//                    geometry is printed again: `distance` must still be 0 (the bottom stays
//                    pinned — rows fade in on their own ink, the document never animates). The
//                    script's own shot at PREVIEW_SETTLE (5.2 s) is the settled second moment.
//     settings     = asleep, Settings tab, the wake gate listening (heard "hey jarhead")
//     wake-locked  = asleep, Settings tab, the gate locked out, no passphrase, Anthropic API brain without its key
//     conversation = live data with the blocked Claude Code session (gt · api auth) stepped into:
//                    its transcript with tool calls and folded reasoning, a permission question
//                    with Allow / Deny, two circled regions in the Now panel
//     conversation-codex = the finished Codex session (gt · api hotfix) stepped into
//     local        = the Local brain: asleep, the Settings tab, Backend → Local model with Ollama
//                    0.34.0 up (six models, the engine's best fit qwen3.5:27b, brainModel ""): the
//                    Model row a menu ("best fit · qwen3.5:27b"), no Server row, no Key row, the
//                    Status line `Local · …`, memory local, and the "Leaves the Mac" section under
//                    Brain (voice cloud · brain mac · memory mac · web cloud). Runs `check-local`.
//     local-empty  = the Now tab with Ollama up but nothing on it that can call tools: the amber
//                    `brain.local` row with Retry and Copy (`ollama pull qwen3.5:27b`, copied, never
//                    run), the Ready row naming the fallback `openai-responses`. Runs `check-local`.
//     menu-voice   = Settings › Audio › Voice open on the float layer (`menuOpen:settings.voice`): the
//                    popup under the field, Default / Also / All voices, the 2 pt bar on the pick, the
//                    filter strip `Filter 22 voices` with the count `22`. `menu-voice-filter` types `ma`
//                    (`2 of 22`, Marin and Meridian), snaps, then ↓ Return: run.log's `send:` carries
//                    Meridian. `menu-model` is the `local` fixture with `qwen3:8b` saved and unlisted:
//                    the Model popup's `size · fit` columns, `tight` amber, `too big` red on a dim row,
//                    `no tools` at 0.45, `Saved, not listed`, the foot following ↑. `menu-backend` opens
//                    Backend (rows 40 with `needs` on line 2; ↓ moves the foot). `toggle` focuses the
//                    Wake word `On | Off` (`focus:settings.wakeWord`) and presses Space: `send:` carries
//                    wakeEnabled=false. The Settings sites answer once Builder D passes the ids
//                    (`settings.voice` · `settings.backend` · `settings.wakeWord`); `settings.model` is
//                    LocalModelMenu's own. `check-kit` prints the pure placement / menu model / words /
//                    tip / badge / copy pins. The kit's other scenarios (tip-* … agents-groups) are named
//     memory-chips = the kit's memory rail (Builder C): the filter with `2 of 7`, the kind chips with
//                    counts, `chip:fact` → the two fact rows (badge · meter · ⋯ at rest); Settings tab, tall.
//     list-keys    = the kit's search with ↑↓: `search:codex`, three ↓ (`list-focus:` lines name the
//                    ring's row — the third hit), Return opens it (`probe:` says which conversation).
//     agents-groups = the kit's agents per tool as folds: Codex folded (`fold:agents.codex:closed`) with
//                    `[1 asks] · 1 done` as its head; two Claude Code rows open above it.
//     list-verbs   = the kit's ⌘↓ float (Builder E): `highlight:chain:<id>` rings yesterday's row and gives
//                    the list the keys, `keyDown:cmd-down` floats its verbs (Rename · Pin · Archive · Move to
//                    Trash) as ConsoleMenuRows under the row; `probe-floats:` names `rail.chain.<id>.verbs`.
//                    in console-preview.sh and render today's UI until their builder lands.
//   PREVIEW_APPEARANCE=dark|light   (default dark; the `light` scenario is live data in aqua)
//   PREVIEW_STATE_DIR               where screenshot paths resolve
//   PREVIEW_SHOT_PNG                the screenshot step's file inside that dir
//   PREVIEW_WINDOW_SIZE=WxH         window frame (default 1180x760; clamped to the minimum)
//   PREVIEW_BRAIN=<BrainKind raw>   swap the brain (openai-compatible shows the Server row)
//   PREVIEW_GATE=off|awake          the gate switched off, or resting because the engine is awake
//   PREVIEW_REDUCE_MOTION=1         pin Motion.reduced on (Motion.reducedOverride): plain fades, halved
//                                   durations, no rise/slide, still two-tone dither glyphs — the Reduce Motion path for real
//   PREVIEW_SLOW_THUMBS=1           hold every screenshot thumbnail for a minute before it decodes
//                                   (Thumbnails.holdForPreview), so the dithered skeletons are shot
//   PREVIEW_WIPE_SECONDS=2          stretch Motion.wipe to that long (Motion.wipeSecondsOverride; the
//                                   `wipe` scenario's default), so a `snap:` mid-wipe is a reproducible frame
//   PREVIEW_NO_LEVELS=1             no fake 20 Hz audio levels (the meters hold still) — the `timing`
//                                   scenario's control for what the meters' animation costs
//   PREVIEW_CONNECTED=0             the daemon client disconnected (AppState.connected): the header's dot
//                                   grey, no streaming caret, no live dot on a conversation
//   PREVIEW_ACTION=scroll-up,append drive the feed after it settles (use PREVIEW_SETTLE>=3)
//     scroll-top,history   in a conversation: scroll to the top, then prepend an older page of 4
//                          (the feed must keep the row on screen where it was)
//     load-earlier:<n>     "Load earlier" the way agent.history answers: n older rows, mode `prepend`,
//                          before the first row shown; the action line says held/shown/loaded before →
//                          after (shown must grow by n — the model's cap and the pane's ceiling both
//                          move by what Kevin loaded) and `complete`; pair with `geometry` either side
//     memory-forget:<id> / memory-restore:<id> / memory-edit:<id>=<text> / memory-segment:<state>
//                          the Memory rail's verbs through the row's own closures (Settings tab): the
//                          `send:` line is the command (memory.forget / .restore / .edit with no kind),
//                          the `memory-rail:` line what the list holds after (the row leaves at once)
//     drop-open,restore-agents   take the open session off the rail, then put the rail
//                          back: the stream must stay (one agent.close in the log, no
//                          second agent.open — the root forgets an orphaned id)
//     open-jarhead / show-now / open-agent:<id> / tab:now|settings|ledger / pick-day:<yyyy-mm-dd>
//                          step around the Console the way clicks would (each inside
//                          withAnimation, so the transitions run)
//     geometry             print the stream's scroll geometry (minY, viewport, content, distance)
//     shot:<name>          screenshot the window now → <PREVIEW_OUT_DIR>/<name>.png (a moment
//                          mid-transition, where the script's own shot comes too late); via
//                          screencapture, so the frame lands 0.1–0.3 s after the scheduled instant
//     snap:<name>          the same picture from the window's own pixels (CGWindowListCreateImage),
//                          written in-process — the frame on screen at the scheduled instant
//     snap-wipe:<name>     arm Motion.wipeMidHook: the next pane switch's DitherCurtain reports its first
//                          frame at 0.4 or more of the ranks (the log says which) and the snap (as above)
//                          follows 0.05 s later — the `wipe` scenario's mid pictures, pinned to the wipe's
//                          own frames rather than a timer's; on a loaded machine that first frame can
//                          already be far along, so read the progress in the snap line
//     search:<query>       open the rail's search box with the query (hits from the fake ledger)
//     trash-open / archived-open / hidden-open   unfold the rail's folded groups
//     select:<id>+<id>     ⌘-pick chains (the strip shows from two); rename:<id> opens the inline field
//     trash:<id>           move a chain to the Trash the way the menu would (the toast with Undo)
//     clear-now            clear the Now stream (the feed's "Cleared · Undo")
//     hit-first            open the first search hit the way its row would (the conversation,
//                          scrolled to the row and lit); hit:<sessionId>:<atMs> names one outright
//     probe                print the open conversation's state (open / loaded / entries / scroll
//                          target / the entry it resolves to) so a landed hit is checked, not reasoned
//     trace:<label> / trace-stop   trace the main thread between the two (MainThreadTrace): a pair of
//                          run-loop observers — `.afterWaiting` first marks a turn's start, `.beforeWaiting`
//                          last (after Core Animation's commit, where SwiftUI's layers draw) its end — so a
//                          turn's cost is everything the main thread did between two sleeps. Turns of 4 ms
//                          or more print as `frame: t=<s> cost=<ms>`; the stop prints `timing: <label> …`
//     check-dither         print the dither arithmetic as `check: ok|FAIL` lines: bayer8Ranks a permutation
//                          of 0…63; wipe tile k has k·cell² opaque px and tile k ∪ inverted k covers every px;
//                          glyphLine differs frame to frame and the still frame is two-tone; the bar's cells
//                          and the ground's 64 pt rounding; Tiles.hasWipe after prewarm
//     probe-ground         CGWindowListCreateImage of the window: the distinct colours of a 32×32 px block
//                          on bare ground at three places — the stream's top-left (want one: #070707), the
//                          window's bottom-right (want two: the raised step #101010 and the whisper #161e35)
//                          and the stream's bottom-middle, just above the composer (want two: #0a0a0a and
//                          #101010, the field's first steps); run it on `empty` — the stream is bare there
//     check-sleep          print the sleep word checks (close reasons, tombstones, remedy decoding, the
//                          stream from ledger rows end to end) as `check: ok|FAIL …` lines
//     check-durability     print this pass's pure words as `check: ok|FAIL` lines: isLive / typing from
//                          status + connection (never the tail flag alone), the caret gate, the feed's 400
//                          cap, the rail's live-first order and hint word, the voice labels and accents,
//                          Switch now's rule, the memory rail's formatting, and that every memory symbol exists
//     reconnect            the daemon came back (ConsoleSession.reconnectCount += 1): the open pane must re-send
//                          agent.open as the same viewer; hide-window / show-window flip windowVisible (the
//                          tail closes and reopens — one agent.close, one agent.open, the same viewer)
//     thread-open:<id>     step into a thread's pane the way its rail row would (ConsoleSession.openThread;
//                          the pane sends thread.open as its viewer); thread-answer:<id>:yes|no answers its
//                          question the way the pane's Allow / Deny do (`send:` must be thread.answer);
//                          thread-step:<±1> is ⌘⇧] / ⌘⇧[; thread-end:<id> lands an `ended` thread.event
//                          (the row settles, the pane's Stop goes); check-threads prints this pass's pins
//     agent-echo:<id>:<text>   the pending echo EngineClient.send adds for an agent.send (a row at once);
//                          agent-land:<id>:<text> lands the real user turn the tool's file would (the echo
//                          drops); probe-pending prints how many pending rows the open conversation holds
//     rail-scroll:<pt>     scroll the right rail down by that many points (the Settings tab is taller than
//                          the window; the Memory section sits under Session)
//     key:<char>           send ⌘<char> to the window (key:f must open the search); undo runs the
//                          window's undo manager once (the last cleanup's inverse must be sent);
//                          undo-toast presses the toast's Undo (AppState.undoCleanup(id:)); redo
//                          runs the manager's redo once — the toast-then-⌘Z sequence must not
//                          re-perform the action (undo after undo-toast: canUndo=false, nothing sent)
//     keyDown:<name>       post a real key-down (and up) through window.sendEvent — the responder chain's
//                          path to a focused SwiftUI view (a popup, a list), where `key:` reaches only
//                          performKeyEquivalent. Names: escape up down left right return space tab ? a…z;
//                          several joined with `+` land 40 ms apart (keyDown:m+a, keyDown:down+return)
//     click:(x,y)          a left click at that point of the content view (points from its top-left),
//                          down and up through sendEvent; prints the first responder before and after
//     focus:<id> · menuOpen:<id> · tipOpen:<id> · chip:<kind> · highlight:<id> · fold:<id>:<open|closed>
//                          the kit's previewNotification keys (ConsolePreviewKey): the control with that
//                          id takes focus / opens its menu / pins its tip / the chip is picked / the row
//                          is highlighted / the disclosure folds or opens
//     hover:<id> · leave:<id>  the pointer entering / leaving a tip's trigger: the real delay runs (with
//                          ConsoleTip.delayOverride nil, `tip-warm`); the tip's trail prints as `tip:` lines
//     check-tips           the timing pins from the `tip:` trail: the cold tip waited ≥ 300 ms, the warm one
//                          (within 400 ms of the last hide) showed within 120 ms (a run-loop hop under load)
//     check-floats:<none|id[+id]>  what the layer holds right now must be exactly that (`none` = nothing
//                          open) — and the first responder is not the composer's text
//     probe-floats         print the rect of every float the layer has placed (ConsoleFloatSlot.placed)
//     check-kit            the kit's pure pins as `check:` lines: placement (below · flips · clamps · trailing
//                          · arrow ≥ r + 4 · max list height · size == .zero), ConsoleTip.delay, every badge
//                          word and tone, check-copy over HelpCopy — ends `check: all ok (kit)`
//     Every action may carry `@<seconds>` (from launch): "open-jarhead@1.2,shot:mid@1.36";
//     without it the old cadence holds (the first at 1.2 s, then one every 0.8 s). The list splits
//     on commas outside parentheses, so `click:(300,300)` is one action.

@main
struct ConsolePreviewMain {
    static func main() {
        // Line-buffered, so the `send:` / `action:` trail survives the screenshot script's kill.
        setlinebuf(stdout)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // never a Dock tile: previews are throwaway
        let delegate = PreviewDelegate()
        app.delegate = delegate
        app.run()
    }
}

@MainActor
final class PreviewDelegate: NSObject, NSApplicationDelegate {
    var state = AppState()
    var console: ConsoleWindowController?
    var timer: Timer?
    /// The fixtures, kept for scripted actions that put a rail back together.
    var fake: FakeData?
    /// When the harness came up; the action trail is stamped against it.
    let launchedAt = Date()
    /// How many `append` actions have run (they alternate Kevin / Jarhead).
    var appended = 0
    /// Every `probe-floats` result, in order.
    var floatProbes: [[String: CGRect]] = []
    /// The tips' trail (`tip:` lines: armed · shown after n ms · hidden · pinned), read by `check-tips`.
    var tipLog: [String] = []
    /// The main thread's turns between `trace:<label>` and `trace-stop` (the `timing` scenario).
    lazy var trace = MainThreadTrace(launchedAt: launchedAt)
    /// The conversation scenarios' pane, opened once the app is active (`openPendingAgentAfterActivation`).
    var pendingAgentOpen: String?
    var activationToken: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The dither tiles first, so a 2 s shot never catches the fade fallback `Motion.wipe` takes
        // before `Dither.Tiles` has landed. (The app must do the same in AppDelegate — a seam
        // outside UI/**; without it the tiles land lazily on the first wipe, which is a fade.)
        Dither.prewarm(scale: NSScreen.main?.backingScaleFactor ?? 2)
        let env = ProcessInfo.processInfo.environment
        let scenario = env["PREVIEW_SCENARIO"] ?? "live"
        let shot = env["PREVIEW_SHOT_PNG"] ?? "preview-orb-expanded.png"
        // Screenshots must be deterministic whatever the Mac is set to, so the
        // harness pins the appearance; the real window follows the system.
        let appearance = env["PREVIEW_APPEARANCE"] ?? (scenario == "light" ? "light" : "dark")
        NSApp.appearance = NSAppearance(named: appearance == "light" ? .aqua : .darkAqua)
        // PREVIEW_WIPE_SECONDS=2: stretch Motion.wipe so a mid-wipe snap is a reproducible frame.
        if let secs = Double(env["PREVIEW_WIPE_SECONDS"] ?? ""), secs > 0 { Motion.wipeSecondsOverride = secs }
        // PREVIEW_REDUCE_MOTION=1: the Reduce Motion path for real, whatever the Mac is set to.
        if env["PREVIEW_REDUCE_MOTION"] == "1" {
            Motion.reducedOverride = true
            print("reduce motion: pinned on")
        }
        // PREVIEW_SLOW_THUMBS=1: thumbnails never land during the shot, so the skeletons show.
        if env["PREVIEW_SLOW_THUMBS"] == "1" {
            Thumbnails.holdForPreview = true
            print("thumbnails: held for preview")
        }

        state.stateDir = URL(fileURLWithPath: env["PREVIEW_STATE_DIR"] ?? FileManager.default.currentDirectoryPath)
        // PREVIEW_CONNECTED=0: the daemon client is down — the caret gate's and the live dot's control.
        state.connected = env["PREVIEW_CONNECTED"] != "0"
        state.daemonDetail = state.connected ? "engine · pid 48213" : "reconnecting"
        state.sendHandler = { cmd in print("send:", cmd.json) }
        // The memory rail's verbs, driven by `memory-forget:` / `memory-edit:` / `memory-restore:`
        // through the row's own closures; the rail reports what it holds after (`memory-rail:` lines).
        MemoryRailList.previewReport = { line in print("memory-rail: \(line)") }
        let fake = FakeData(shot: shot)
        self.fake = fake
        // The memory store, as `memory.list` / `memory.search` would answer (the rail reads through
        // the same AppState handlers the app installs from EngineClient).
        state.memoryListHandler = { st, limit in fake.memoryList(state: st, limit: limit) }
        state.memorySearchHandler = { query, limit in fake.memorySearch(query, limit: limit) }
        state.ledgerDaysHandler = { ["2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07"] }
        state.ledgerReadHandler = { day in day == "2026-09-10" ? fake.ledgerRows() : [] }
        // `ledger-months` (Builder D): forty days from `Scripts/fixtures/ledger-days.json` (September 1–10,
        // August 2–31), every one readable — the month heads sum the days the harness picks before the shot.
        if scenario == "ledger-months", let days = Self.fixtureDays(state.stateDir) {
            state.ledgerDaysHandler = { days }
            state.ledgerReadHandler = { day in days.contains(day) ? fake.ledgerRows() : [] }
        }
        // Jarhead's own sessions, as `ledger.sessions` / `ledger.session` would answer:
        // the list is set outright so the rail has it before the window opens.
        state.jarheadSessions = fake.jarheadSessions()
        state.jarheadSessionsHandler = { fake.jarheadSessions() }
        state.jarheadSessionRowsHandler = { id in fake.jarheadRows(for: id) }
        // The rail's search, as `ledger.search` would answer: a scan of the fake rows.
        state.ledgerSearchHandler = { query, limit in Array(fake.searchHits(query).prefix(limit)) }

        // The kit's floats: the tip delay pinned to 0 in every shot but `tip-warm`; floats held while
        // the window is inactive (a shot behind the lock screen).
        ConsoleTip.delayOverride = scenario == "tip-warm" ? nil : 0
        ConsoleFloatLayer.holdWhileInactive = true
        // The folds live in memory alone here (a previous run's UserDefaults never leak into a shot);
        // every list's focus move is a `list-focus:` line.
        ConsoleFoldStore.persists = false
        // Settings is an index of seven closed heads (Builder D); every scenario but `settings-index`
        // opens them all, so the shots that drive a control inside a section still see it.
        if scenario != "settings-index" { for id in SettingsWords.folds { ConsoleFoldStore.set(id, true) } }
        ConsoleListFocus.report = { line in print("list-focus: \(line)") }
        ConsoleTip.report = { [weak self] line in
            self?.tipLog.append(line)
            print("tip: \(line)")
        }

        switch scenario {
        case "empty": state.snapshot = fake.empty()
        case "cleanup", "cleanup-select", "cleanup-rename", "cleanup-undo", "cleanup-undo-toast", "cleanup-log", "search", "search-hit", "cleared", "list-keys", "list-verbs", "agents-groups":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.snapshot.trash = fake.trash
            state.snapshot.hiddenAgents = ["sessions:codex:thread-9"]
            // The kit's `agents-groups`: two Claude Code rows and the Codex group, one of whose sessions
            // asks — so the folded Codex head reads `[1 asks] · 1 done` above the fold.
            if scenario == "agents-groups" {
                let keep: Set<String> = ["sessions:cc:1", "sessions:claude:w1p2", "sessions:codex:1", FakeData.endedId, "sessions:codex:w2p2", "sessions:codex:thread-9"]
                state.snapshot.agents = fake.agents().filter { keep.contains($0.id) }
                if let i = state.snapshot.agents.firstIndex(where: { $0.id == "sessions:codex:w2p2" }) {
                    state.snapshot.agents[i].status = .blocked
                    state.snapshot.agents[i].hint = "blocked"
                }
            }
            // Fewer sessions in the `cleanup` shot, so the Agents section's "Hidden (1)" is on screen.
            if scenario == "cleanup" {
                let keep: Set<String> = ["sessions:cc:1", "sessions:codex:thread-9"]
                state.snapshot.agents = fake.agents().filter { keep.contains($0.id) }
            }
        case "problems", "problems-groups":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.snapshot.trash = fake.trash
            state.snapshot.problems = fake.problems()
        case "permissions-groups":
            // Screen Recording not asked, Accessibility denied: `Senses 5 of 6` and `Hands 2 of 3 · [1 missing]`.
            state.snapshot = fake.live()
            state.snapshot.permissions = fake.permissions(microphone: .granted, screenRecording: .unknown, accessibility: .denied)
        case "paused":
            state.snapshot = fake.live()
            state.snapshot.phase = .paused
            state.snapshot.pause = PauseInfo(at: fake.ago(40), sessionId: fake.session().id, usageSeconds: 758, sleepsAt: fake.now + 9 * 60 * 1000)
            state.snapshot.session = nil
            state.snapshot.problems = []
        case "confirm": state.snapshot = fake.confirm()
        case "settings", "menu-voice", "menu-voice-filter", "menu-backend", "menu-escape", "menu-outside", "toggle", "tip-key", "settings-index":
            state.snapshot = fake.asleep()
            // The gate is listening and has just heard the phrase: the "does it hear me?" readout.
            state.wakeGate = .listening
            state.wakeHeard = "hey jarhead"
            state.wakePassphraseSet = true
        case "wake-locked":
            state.snapshot = fake.asleep()
            state.snapshot.settings.brain = .anthropicApi
            state.snapshot.settings.brainModel = "claude-opus-5"
            state.snapshot.setup = SetupStatus(openaiKey: .ok, brain: .unavailable, brainDetail: "ANTHROPIC_API_KEY is not set", brainResolved: nil,
                                               liveModel: "gpt-live-1", secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false),
                                               local: fake.noServer(), dataPaths: [])
            state.wakeGate = .lockedOut(until: Date().addingTimeInterval(47))
            state.wakeHeard = ""
            state.wakePassphraseSet = false
        case "conversation", "conversation-codex", "timing":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            // The transcripts the engine would have sent for the two sessions we step into.
            state.transcripts = fake.transcripts()
        case "memory", "memory-chips":
            // Asleep (the extractor runs only then), the Settings tab, its Memory section in view.
            state.snapshot = fake.asleep()
            state.snapshot.memory = fake.memorySummary()
        case "local", "menu-model":
            // Backend → Local model, Ollama up, the engine's best fit; the Settings tab. `menu-model`
            // saves an id the server no longer lists, so the popup's `Saved, not listed` head shows.
            state.snapshot = fake.localSnapshot()
            if scenario == "menu-model" { state.snapshot.settings.brainModel = "qwen3:8b" }
            state.wakeGate = .listening
            state.wakeHeard = "hey jarhead"
            state.wakePassphraseSet = true
        case "local-empty":
            // Ollama up, nothing tool-capable on it: the amber row and the loud fallback; the Now tab.
            state.snapshot = fake.localEmptySnapshot()
        case "durability":
            // The ended Codex thread, with its long transcript (1 200 messages, the last call interrupted).
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.transcripts = fake.transcripts()
            // Through the model, the way the engine's `replace` page lands: AppState trims to its 400
            // and says `complete: false`, so "Load earlier" offers the rest and a `load-earlier:` action
            // prepends into the same cap the app has (the view's own ceiling is the pure check).
            state.applyTranscript(fake.longTranscript(agentId: FakeData.endedId, count: 1_200), mode: "replace")
        case "threads", "thread-pane", "thread-answer", "tip-thread", "tip-thumb":
            // Jarhead's threads under one running delegation: the snapshot's summaries land the way
            // EngineClient publishes them (applySnapshotThreads), each thread's conversation the way
            // its `thread.open` page would (applyThreadTranscript replace).
            var snap = fake.live()
            snap.marks = fake.marks()
            snap.phase = .listening
            snap.problems = []
            let split = fake.threadsDelegation()
            snap.delegations.append(split)
            snap.transcript += fake.threadsTranscript(from: split.createdAt)
            snap.threads = fake.threads()
            state.snapshot = snap
            state.applySnapshotThreads(snap.threads)
            for t in fake.threads() { state.applyThreadTranscript(fake.threadTranscript(t.id), mode: "replace") }
        case "thread-history":
            // The same threads; main's conversation is the newest page of a longer record, the way
            // `thread.open` answers for a thread with more behind it (complete false; a card's steps
            // on this page, the card itself on the one before).
            var snap = fake.live()
            snap.marks = fake.marks()
            snap.phase = .listening
            snap.problems = []
            let split = fake.threadsDelegation()
            snap.delegations.append(split)
            snap.transcript += fake.threadsTranscript(from: split.createdAt)
            snap.threads = fake.threads()
            state.snapshot = snap
            state.applySnapshotThreads(snap.threads)
            for t in fake.threads() where t.id != "main" { state.applyThreadTranscript(fake.threadTranscript(t.id), mode: "replace") }
            state.applyThreadTranscript(fake.pagedMain().newest, mode: "replace")
        case "typed-row":
            // A line Kevin typed in the composer, on the record beside the spoken ones.
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.snapshot.transcript += fake.typedTranscript()
            if env["PREVIEW_PHASE"] == "asleep" {
                state.snapshot.phase = .asleep
                state.snapshot.session = nil
            }
        case "agent-pending":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.transcripts = fake.transcripts()
        default:
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
        }

        // PREVIEW_BRAIN=openai-compatible (or any BrainKind raw value) swaps the
        // brain so the Settings panel's conditional rows can be checked.
        if let raw = env["PREVIEW_BRAIN"], let kind = BrainKind(rawValue: raw) {
            state.snapshot.settings.brain = kind
            if kind == .openaiCompatible {
                state.snapshot.settings.brainModel = "qwen3-coder"
                state.snapshot.settings.brainBaseUrl = "http://localhost:11434/v1"
            }
        }

        // PREVIEW_GATE=off|awake overrides the wake gate on the Settings tab:
        //   off   = the Wake word switch is off, the gate reports "wake word off"
        //   awake = the engine is up (live snapshot), so the gate rests
        switch env["PREVIEW_GATE"] {
        case "off":
            state.snapshot.settings.wake.enabled = false
            state.wakeGate = .off(reason: "wake word off")
            state.wakeHeard = ""
        case "awake":
            state.snapshot.phase = .listening
            state.snapshot.session = fake.session()
            state.wakeGate = .off(reason: "awake")
            state.wakeHeard = ""
        default: break
        }

        let console = ConsoleWindowController(state: state)
        self.console = console
        console.show()

        // The window autosaves its frame, so a previous run's size would leak into
        // this shot: always set the frame. PREVIEW_WINDOW_SIZE=WxH (default
        // 1180x760) is the frame size, clamped by minSize like a user drag would be.
        if let window = NSApp.windows.first(where: { $0.title == "Jarhead" }) {
            let parts = (env["PREVIEW_WINDOW_SIZE"] ?? "1180x760").lowercased().split(separator: "x").compactMap { Double($0) }
            let wanted = parts.count == 2 ? NSSize(width: parts[0], height: parts[1]) : NSSize(width: 1180, height: 760)
            var frame = window.frame
            frame.size = NSSize(width: max(wanted.width, window.minSize.width), height: max(wanted.height, window.minSize.height))
            window.setFrame(frame, display: true)
            window.center()
            // The app's own install (ConsoleRootView.onAppear) reads NSApp.keyWindow at each click; an
            // accessory harness behind the Terminal is rarely key, so the `undo` / `undo-toast` /
            // `redo` probes would find an empty manager. Name this window's outright, a turn after
            // the root's install so it wins.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self, weak window] in
                self?.state.cleanupUndoManager = { window?.undoManager }
            }
        }

        switch scenario {
        case "settings", "wake-locked", "memory", "memory-chips", "local", "menu-voice", "menu-voice-filter", "menu-model", "menu-backend",
             "menu-escape", "menu-outside", "toggle", "tip-key", "settings-index": console.selectTab(.settings)
        case "ledger": console.pickLedgerDay("2026-09-10")
        case "durability":
            pendingAgentOpen = FakeData.endedId
            openPendingAgentAfterActivation()
        case "agent-pending":
            pendingAgentOpen = "sessions:claude:w1p2"
            openPendingAgentAfterActivation()
        case "confirm":
            state.toast("Waiting for your confirmation", tone: .warn)
        case "conversation", "conversation-codex":
            // Not here: stepping into the pane in the same turn as `show()`, before the app's
            // activation had settled, left the window INACTIVE in the shot (grey traffic lights —
            // the pane's composer took first responder while the activation was still in flight,
            // and the window never became key). Open it once the app is active, then make the
            // window key again, so the shot needs no re-keying workaround.
            pendingAgentOpen = scenario == "conversation" ? "sessions:claude:w1p2" : "sessions:codex:1"
            openPendingAgentAfterActivation()
        case "jarhead", "jarhead-log", "cleanup-log":
            // The root view listens for this once it is on screen; a turn later is enough.
            // `cleanup-log` is the pinned chain's log: its renamed and pinned rows as terse lines.
            let view = scenario == "jarhead" ? "conversation" : "log"
            let sessionId = scenario == "cleanup-log" ? FakeData.pinnedId : FakeData.chainResumedId
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                NotificationCenter.default.post(name: ConsoleSession.openJarheadSessionNotification, object: nil,
                                                userInfo: ["sessionId": sessionId, "view": view])
            }
        case "live", "light": state.toast("Delegation failed: Codex session refused input", tone: .error)
        case "loading":
            // The day is picked the way a click would; the fake ledger answers within a turn, so
            // the `pin-loading` action (0.6 s) puts the read — and a search — back in flight.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.console?.pickLedgerDay("2026-09-10") }
        default: break
        }

        // PREVIEW_ACTION=scroll-up,append,… drives the feed after it has settled
        // (one action every 0.8 s from t=1.2 s, or at the `@seconds` each carries) so
        // the sticky auto-scroll, the jump pill and the transitions can be checked from
        // a screenshot: `scroll-up` scrolls the stream 300pt toward older rows like a
        // trackpad would; `append` adds a transcript line to the snapshot. Use
        // PREVIEW_SETTLE=3 or more. The `switch` scenario has its own default script.
        let defaultActions: String?
        switch scenario {
        case "switch": defaultActions = "open-jarhead@1.2,shot:preview-console-switch-mid@1.36,show-now@2.6,geometry@3.4,append@3.6,append@3.9,geometry@4.7"
        // The mid pictures are pinned to the wipe itself (`snap-wipe:` arms Motion.wipeMidHook; the
        // curtain fires it on its first frame at 0.4 of the ranks, the snap follows 0.05 s later) —
        // a frame of the wipe, not whatever a timer finds. The wipe is stretched to 2 s
        // (PREVIEW_WIPE_SECONDS, the script's default here) so the mid picture is a mid picture.
        case "wipe": defaultActions = "snap-wipe:preview-console-wipe-mid@1.1,open-jarhead@1.2,probe@4.0,snap-wipe:preview-console-wipe-back@4.2,show-now@4.2,probe@6.6"
        case "loading": defaultActions = "pin-loading@0.6,check-dither@0.5"
        // Real speed, traced: the four pane switches, the rail's tab both ways, a ledger day in and out.
        // A second between a switch and its stop: the 0.24 s wipe, then the settle (the Jarhead pane's
        // entries landing, a conversation's tail opening) — the quiet turns after are the 20 Hz meters.
        case "timing": defaultActions = "trace:open-jarhead@1.0,open-jarhead@1.2,trace-stop@2.2,"
            + "trace:show-now@2.4,show-now@2.6,trace-stop@3.6,"
            + "trace:open-agent@3.8,open-agent:sessions:claude:w1p2@4.0,trace-stop@5.0,"
            + "trace:show-now-2@5.2,show-now@5.4,trace-stop@6.4,"
            + "trace:tab-settings@6.6,tab:settings@6.8,trace-stop@7.6,"
            + "trace:tab-now@7.8,tab:now@8.0,trace-stop@8.8,"
            + "trace:pick-day@9.0,pick-day:2026-09-10@9.2,trace-stop@10.2,"
            + "trace:show-now-3@10.4,show-now@10.6,trace-stop@11.4"
        case "cleanup": defaultActions = "check-kit@0.3,trash-open@0.4,hidden-open@0.4"
        // A chain's id is its root session's (the paused one), not the resumed session's.
        case "cleanup-select": defaultActions = "trash-open@0.4,select:\(FakeData.chainPausedId)+\(FakeData.yesterdayId)@0.6"
        case "cleanup-rename": defaultActions = "rename:\(FakeData.pinnedId)@0.5"
        case "cleanup-undo": defaultActions = "trash-open@0.3,trash:\(FakeData.yesterdayId)@0.5"
        case "cleanup-undo-toast": defaultActions = "trash-open@0.3,trash:\(FakeData.yesterdayId)@0.5,undo-toast@1.2,undo@1.8,redo@2.4"
        case "search": defaultActions = "search:codex@0.4"
        // One hit only (the resumed session's delegation request), in a past chain: the hit path proper.
        case "search-hit": defaultActions = "search:codex did while@0.4,hit-first@1.2,probe@2.2"
        case "cleared": defaultActions = "clear-now@0.5"
        // The pure words of the durability / memory / voice pass, the rail scrolled to Memory, then the
        // verbs through the rail's own rows: Forget a live row (`send: memory.forget`, the row leaves at
        // once), Edit one (`send: memory.edit` with no kind), Forgotten's Restore (`send: memory.restore`),
        // back to Live for the shot. The `memory-rail:` lines say what the list held after each.
        case "memory": defaultActions = "check-durability@0.3,rail-scroll:540@0.6,memory-forget:m_dark@1.0,"
            + "memory-edit:m_kev=Kevin goes by Kev; never Kevin.@1.3,memory-segment:forgotten@1.6,memory-restore:m_light@2.0,memory-segment:live@2.3"
        // The re-open on reconnect, the close on hide, the open on show: three `send:` lines, one viewer.
        // Then "Load earlier" on the lazy feed: 60 older rows prepended above the 400 while the bottom is
        // pinned — `geometry` before and after (distance stays 0, the content grows), the action line
        // says held/shown/loaded (shown must grow by the page, or it sat above the fold unseen).
        case "durability": defaultActions = "check-durability@0.3,reconnect@1.0,hide-window@1.4,show-window@1.8,geometry@2.2,load-earlier:60@2.4,geometry@3.0"
        // The Local brain pass: the pure words (the rows' visibility, the Ready detail, the Copy chip,
        // the four data-path rows, the menu's titles) as `check:` lines — the package has no test target.
        case "local", "local-empty": defaultActions = "check-local@0.3"
        // The Threads pass: the pins into run.log (the thread words, then the sleep words — the package has
        // no test target), then Spotify ends by an `ended` event at 1.6 s (its row settles to the checkmark
        // and drops to the finished group; the chips and the right rail follow).
        case "threads": defaultActions = "check-threads@0.3,check-sleep@0.4,thread-end:\(FakeData.spotifyId)@1.6"
        case "thread-pane": defaultActions = "thread-open:\(FakeData.slackId)@0.3"
        // Allow the way the strip sends it: the `send:` line must be thread.answer, never say-text or stop.
        case "thread-answer": defaultActions = "thread-open:\(FakeData.slackId)@0.3,thread-answer:\(FakeData.slackId):yes@1.0,check-threads@1.2"
        case "typed-row": defaultActions = "check-threads@0.3"
        // The paged main pane: scrolled up off the bottom, "Load earlier" pressed (the button's own path:
        // `send:` thread.history), the engine's page landing, geometry before and after (the row stays).
        case "thread-history": defaultActions = "thread-open:main@0.3,scroll-up@0.9,geometry@1.0,load-earlier-thread@1.1,thread-history:main@1.3,geometry@2.3"
        // The echo at once, a mid picture with it up, the real turn landing, the count after.
        // (No comma in the text: "," separates the actions.)
        case "agent-pending": defaultActions = "probe-pending@0.4,agent-echo:sessions:claude:w1p2:yes please run it@0.5,probe-pending@0.6,"
            + "snap:preview-console-agent-pending-mid@1.0,agent-land:sessions:claude:w1p2:yes please run it@1.6,probe-pending@1.8"
        // The kit's tips (Builder A): a thread's card on the stream's chip (the same ConsoleTipCard.thread the rails
        // draw), `?` pinning the composer's Stop after `focus:`, the warm re-show timed from the trail, the pane
        // Retargeted (Builder D): the card beside the right rail's Slack row; `?` on the Brain section's Check.
        case "tip-thread": defaultActions = "check-kit@0.3,tipOpen:\(NowWords.threadTip(FakeData.slackId))@0.8,probe-floats@1.3"
        case "tip-key": defaultActions = "check-kit@0.3,focus:\(SettingsWords.check)@0.8,keyDown:?@1.0,probe-floats@1.4"
        // The right rail (Builder D): Settings as seven folded heads with Memory opened by its id; the Now rail's
        // Permissions areas (Senses open) and Problems kinds (Engine folded); the Ledger's forty days by month —
        // two August days read first so the folded head sums them, then Sep 10 picked, the list given the
        // keyboard and ↓ ⏎ picking the next day (`list-focus:` lines say which).
        case "settings-index": defaultActions = "check-kit@0.3,snap:preview-console-settings-index-closed@0.7,fold:\(SettingsWords.memoryFold):open@0.9"
        case "permissions-groups": defaultActions = "check-kit@0.3,fold:\(NowWords.permissionsFold):open@0.5,fold:\(NowWords.sensesFold):open@0.8,rail-scroll:460@1.2"
        case "problems": defaultActions = "fold:\(NowWords.problemsFold):open@0.4,rail-scroll:520@0.8"
        case "problems-groups": defaultActions = "check-kit@0.3,fold:\(NowWords.problemsFold):open@0.5,fold:\(NowWords.engineFold):closed@0.8,rail-scroll:520@1.2"
        case "ledger-months": defaultActions = "check-kit@0.3,pick-day:2026-08-31@0.4,pick-day:2026-08-28@0.6,pick-day:2026-09-10@0.9,"
            + "focus:\(LedgerWords.listId)@1.4,keyDown:down+return@1.7,probe@2.4"
        case "tip-warm": defaultActions = "check-kit@0.3,hover:stream.go@0.5,leave:stream.go@1.2,hover:stream.mute@1.3,probe-floats@1.5,check-tips@1.6"
        case "tip-thumb": defaultActions = "check-kit@0.3,thread-open:\(FakeData.slackId)@0.3,tipOpen:thread.shot.\(FakeData.slackId)@1.0,probe-floats@1.6"
        // The kit's dropdowns (Builder B): the pure pins, then the popup opened by its id on the layer.
        case "menu-voice": defaultActions = "check-kit@0.3,menuOpen:settings.voice@0.6,probe-floats@1.4"
        // `ma` typed into the filter (2 of 22: Marin, Meridian), a snap with the filter up, then ↓ Return
        // picks Meridian — run.log's `send:` line must carry "meridian".
        case "menu-voice-filter": defaultActions = "check-kit@0.3,menuOpen:settings.voice@0.6,keyDown:m+a@1.0,"
            + "snap:preview-console-menu-voice-filter-typed@1.6,keyDown:down+return@2.0,probe-floats@2.6"
        // The saved row is highlighted on open (the bottom); ↑↑ lands on gpt-oss:120b, whose foot says why it is tight.
        case "menu-model": defaultActions = "check-kit@0.3,menuOpen:settings.model@0.6,keyDown:up+up@1.2,probe-floats@2.0,check-floats:settings.model@2.1"
        // ↓ moves the highlight and the foot to the next kind's `needs` sentence.
        case "menu-backend": defaultActions = "check-kit@0.3,menuOpen:settings.backend@0.6,keyDown:down@1.2,probe-floats@2.0"
        // Esc closes unchanged; an outside click closes and does not focus the composer.
        case "menu-escape": defaultActions = "check-kit@0.3,menuOpen:settings.voice@0.6,probe-floats@1.2,keyDown:escape@1.4,probe-floats@1.8"
        case "menu-outside": defaultActions = "check-kit@0.3,menuOpen:settings.voice@0.6,probe-floats@1.2,click:(300,300)@1.4,probe-floats@1.8"
        // The Wake word toggle focused, Space flips it: `send:` carries wakeEnabled=false; the words read On | Off.
        case "toggle": defaultActions = "check-kit@0.3,rail-scroll:1500@0.6,focus:settings.wakeWord@1.0,snap:preview-console-toggle-focused@1.4,keyDown:space@1.6"
        // The kit (Builder C): the memory rail's kind chips (`chip:fact` → 2 rows) and a row's card;
        // the left rail's search with ↑↓ (the third hit takes the ring, Return opens it — `probe` says
        // which); the agents grouped per tool with Codex folded (`1 asks`); `cleanup` re-shot with the folds.
        case "memory-chips": defaultActions = "check-kit@0.3,rail-scroll:540@0.6,chip:fact@0.9,tipOpen:memory.m_kev@1.2"
        case "list-keys": defaultActions = "check-kit@0.3,search:codex@0.4,keyDown:down+down+down@1.2,probe@1.6,keyDown:return@1.8,probe@2.4"
        case "agents-groups": defaultActions = "check-kit@0.3,fold:agents.codex:closed@0.6"
        case "list-verbs": defaultActions = "check-kit@0.3,highlight:chain:\(FakeData.yesterdayId)@0.6,keyDown:cmd-down@1.0,probe-floats@1.6,check-floats:rail.chain.\(FakeData.yesterdayId).verbs@1.7"
        default: defaultActions = nil
        }
        if let actions = env["PREVIEW_ACTION"] ?? defaultActions {
            for (index, spec) in Self.splitActions(actions).enumerated() {
                let parts = spec.split(separator: "@", maxSplits: 1).map(String.init)
                let action = parts[0]
                let at = parts.count == 2 ? (Double(parts[1]) ?? 0) : 1.2 + 0.8 * Double(index)
                DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                    self?.perform(action)
                }
            }
        }

        // Fake audio levels at 20 Hz so the meters move. PREVIEW_NO_LEVELS=1 leaves them silent
        // (the `timing` scenario's control: the meters' animation is the live Console's idle load).
        var t = 0.0
        if env["PREVIEW_NO_LEVELS"] == "1" { print("levels: off (PREVIEW_NO_LEVELS)") }
        timer = env["PREVIEW_NO_LEVELS"] == "1" ? nil : Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            t += 0.05
            let inL = scenario == "empty" ? 0 : abs(sin(t * 3.1)) * 0.35
            let outL = (scenario == "live" || scenario == "light") ? abs(sin(t * 5.3)) * 0.9 : 0
            Task { @MainActor in self?.state.levels = AudioLevels(input: inL, output: outL) }
        }

        if let n = console.windowNumber {
            print("WINDOW_NUMBER=\(n)")
            fflush(stdout)
        }
    }

    /// The conversation scenarios' pane, opened once the app is active (a turn after `show()`'s
    /// `NSApp.activate` has landed): at once if it already is, else on `didBecomeActive` — or
    /// after a second regardless, since a harness launched behind the lock screen never
    /// activates and the shot must still happen. Then the window is made key again.
    private func openPendingAgentAfterActivation() {
        if NSApp.isActive {
            DispatchQueue.main.async { [weak self] in self?.openPendingAgent() }
            return
        }
        activationToken = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.async { self?.openPendingAgent() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.openPendingAgent() }
    }

    private func openPendingAgent() {
        guard let id = pendingAgentOpen else { return }
        pendingAgentOpen = nil
        if let token = activationToken { NotificationCenter.default.removeObserver(token); activationToken = nil }
        console?.openAgent(id)
        NSApp.windows.first(where: { $0.title == "Jarhead" })?.makeKeyAndOrderFront(nil)
        print("opened \(id) after activation at \(String(format: "%.2f", Date().timeIntervalSince(launchedAt)))s (active=\(NSApp.isActive), key=\(NSApp.keyWindow?.title ?? "none"))")
    }

    private func perform(_ action: String) {
        let stamp = String(format: "%.2f", Date().timeIntervalSince(launchedAt))
        // A traced switch: the trace notes the moment, so the turn this action runs in is named.
        if !action.hasPrefix("trace") { trace.mark() }
        switch action {
        case "scroll-up":
            guard let window = NSApp.windows.first(where: { $0.title == "Jarhead" }),
                  let scroll = Self.widestScrollView(in: window.contentView) else { return }
            let clip = scroll.contentView
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: max(0, clip.bounds.origin.y - 300)))
            scroll.reflectScrolledClipView(clip)
        case "append":
            var snap = state.snapshot
            let now = Date().timeIntervalSince1970 * 1000
            appended += 1
            snap.transcript.append(TranscriptItem(id: "u-appended-\(Int(now))", speaker: appended % 2 == 1 ? .kevin : .jarhead,
                                                  text: appended % 2 == 1 ? "Appended after the window opened." : "And a second line, appended a moment later — the bottom stays pinned.",
                                                  startMs: 0, endMs: 900, at: now, final: true))
            state.snapshot = snap
            print("action: append #\(appended) at \(stamp)s")
        case "open-jarhead":
            // The root view listens for this; it opens the paused → resumed chain.
            withAnimation(Motion.snappy) {
                NotificationCenter.default.post(name: ConsoleSession.openJarheadSessionNotification, object: nil,
                                                userInfo: ["sessionId": FakeData.chainResumedId, "view": "conversation"])
            }
            print("action: open-jarhead at \(stamp)s")
        case "show-now":
            withAnimation(Motion.wipeAnimation) { console?.showNow() }
            print("action: show-now at \(stamp)s → openAgentId=\(console?.openAgentIdForPreview ?? "nil") openJarheadId=\(console?.openJarheadIdForPreview ?? "nil")")
        case "geometry":
            guard let window = NSApp.windows.first(where: { $0.title == "Jarhead" }),
                  let scroll = Self.widestScrollView(in: window.contentView), let doc = scroll.documentView else {
                print("action: geometry at \(stamp)s → no stream scroll view")
                return
            }
            let clip = scroll.contentView
            let distance = doc.frame.height - (clip.bounds.minY + clip.bounds.height)
            print(String(format: "action: geometry at %@s → minY=%.1f viewport=%.1f content=%.1f distance=%.1f", stamp, clip.bounds.minY, clip.bounds.height, doc.frame.height, distance))
        default:
            if action.hasPrefix("open-agent:") {
                let id = String(action.dropFirst("open-agent:".count))
                withAnimation(Motion.wipeAnimation) { console?.openAgent(id) }
                print("action: open-agent \(id) at \(stamp)s")
            } else if action.hasPrefix("tab:") {
                let raw = String(action.dropFirst("tab:".count))
                if let tab = ConsoleSession.Tab.allCases.first(where: { $0.rawValue.lowercased() == raw.lowercased() }) {
                    withAnimation(Motion.snappy) { console?.selectTab(tab) }
                    print("action: tab \(tab.rawValue) at \(stamp)s")
                }
            } else if action.hasPrefix("pick-day:") {
                let day = String(action.dropFirst("pick-day:".count))
                withAnimation(Motion.snappy) { console?.pickLedgerDay(day) }
                print("action: pick-day \(day) at \(stamp)s")
            } else if action.hasPrefix("snap-wipe:") {
                // Arm the wipe's own mid-frame report: the next arriving pane at half its ranks snaps.
                let name = String(action.dropFirst("snap-wipe:".count))
                let dir = ProcessInfo.processInfo.environment["PREVIEW_OUT_DIR"] ?? FileManager.default.currentDirectoryPath
                let path = (dir as NSString).appendingPathComponent(name.hasSuffix(".png") ? name : name + ".png")
                // The screen lags the evaluation by a frame, so the snap follows the hook by a
                // little (0.05 s; with the curtain a frame is cheap — the 0.25 s the masked wipe
                // needed landed 0.4–0.8 s late behind the arriving pane's content-build frame and
                // caught the last few cells). The stamp says which frame the hook saw.
                Motion.armWipeMid { [weak self] progress in
                    guard let self else { return }
                    let hookAt = String(format: "%.2f", Date().timeIntervalSince(self.launchedAt))
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                        guard let self else { return }
                        self.snap(to: path, stamp: String(format: "%.2f", Date().timeIntervalSince(self.launchedAt))
                                  + String(format: " (the wipe's frame at %.2f, %@ s, + 0.05)", progress, hookAt))
                    }
                }
                print("action: snap-wipe armed for \(name) at \(stamp)s")
            } else if action.hasPrefix("shot:") || action.hasPrefix("snap:") {
                let inProcess = action.hasPrefix("snap:")
                let name = String(action.dropFirst((inProcess ? "snap:" : "shot:").count))
                let dir = ProcessInfo.processInfo.environment["PREVIEW_OUT_DIR"] ?? FileManager.default.currentDirectoryPath
                let path = (dir as NSString).appendingPathComponent(name.hasSuffix(".png") ? name : name + ".png")
                if inProcess { snap(to: path, stamp: stamp) } else { shoot(to: path, stamp: stamp) }
            } else if action.hasPrefix("trace:") {
                trace.start(label: String(action.dropFirst("trace:".count)), stamp: stamp)
            } else if action == "trace-stop" {
                trace.stop(stamp: stamp)
            } else if keyAction(action) {
                // printed by keyAction
            } else if action == "check-sleep" {
                checkSleepWords(stamp: stamp)
            } else if action == "check-dither" {
                checkDither(stamp: stamp)
            } else if action == "check-durability" {
                checkDurabilityWords(stamp: stamp)
            } else if action == "check-threads" {
                checkThreadWords(stamp: stamp)
            } else if action == "check-local" {
                checkLocalWords(stamp: stamp)
            } else if action.hasPrefix("thread-open:") {
                let id = String(action.dropFirst("thread-open:".count))
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: ["threadOpen": id])
                print("action: thread-open \(id) at \(stamp)s → openThreadId=\(console?.openThreadIdForPreview ?? "nil") (the pane sends thread.open as its viewer)")
            } else if action.hasPrefix("thread-answer:") {
                // <id>:yes|no — the pane's Allow / Deny path (`send:` must be thread.answer).
                let parts = action.dropFirst("thread-answer:".count).split(separator: ":", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { print("action: thread-answer needs <id>:yes|no"); return }
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil,
                                                userInfo: ["threadAnswer": ["threadId": parts[0], "yes": parts[1] == "yes"] as [String: Any]])
                print("action: thread-answer \(parts[0]) \(parts[1]) at \(stamp)s (the line above must be thread.answer — never say-text, never stop)")
            } else if action.hasPrefix("thread-step:") {
                let delta = Int(action.dropFirst("thread-step:".count)) ?? 1
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: ["threadStep": delta])
                print("action: thread-step \(delta) at \(stamp)s → openThreadId=\(console?.openThreadIdForPreview ?? "nil")")
            } else if action == "load-earlier-thread" {
                // The pane's "Load earlier" the way the button does it (StreamFeed): the `send:` line must be
                // thread.history before the first held seq; the engine's answer is `thread-history:<id>`.
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: ["loadEarlier": true])
                let store = console?.openThreadIdForPreview.flatMap { state.threadStores[$0] }
                print("action: load-earlier-thread at \(stamp)s → pane=\(console?.openThreadIdForPreview ?? "nil") startSeq=\(store?.startSeq ?? -1) held=\(store?.entries.count ?? -1) remaining=\(store?.remaining ?? -1) (the line above must be thread.history)")
            } else if action.hasPrefix("thread-history:") {
                // The engine's older page for `thread.history` (mode prepend): the entries before the first
                // held seq, ≤ 60, `complete` when it reaches the record's first. Counts before and after —
                // the orphan step / status rows must fold into the card the page brings and not double.
                let id = String(action.dropFirst("thread-history:".count))
                guard let before = state.threadStores[id], let start = before.startSeq else { print("action: thread-history \(id) at \(stamp)s → nothing held"); return }
                let orphans = { (s: ThreadStore) in ThreadEntries.build(s).filter { if case .system(let sys) = $0 { return sys.id.hasPrefix("tstep:") || sys.id.hasPrefix("tstat:") } else { return false } }.count }
                let page = (self.fake ?? FakeData(shot: "preview.png")).pagedMain().older(before: start)
                state.applyThreadTranscript(page, mode: "prepend")
                let after = state.threadStores[id]
                let card = after?.entries.first?.delegation
                print("action: thread-history \(id) at \(stamp)s → page \(page.entries.count) before seq \(start) · held \(before.entries.count)→\(after?.entries.count ?? -1)"
                      + " orphans \(orphans(before))→\(after.map(orphans) ?? -1) folded \(before.foldedCount)→\(after?.foldedCount ?? -1) remaining \(before.remaining)→\(after?.remaining ?? -1)"
                      + " complete \(before.complete)→\(after?.complete ?? false) first card steps=\(card?.steps.count ?? -1) status=\(card?.status.rawValue ?? "nil")"
                      + ((after.map(orphans) ?? -1) == 0 && after?.complete == true ? "" : " (FAIL: orphans left or the page did not complete)"))
            } else if action.hasPrefix("thread-end:") {
                // An `ended` thread.event the way EngineClient lands one: the row settles, the pane's Stop goes.
                let id = String(action.dropFirst("thread-end:".count))
                let seq = (state.threads[id]?.steps ?? 0) + 1_000
                let e = ThreadEvent(seq: seq, at: Date().timeIntervalSince1970 * 1000, threadId: id, kind: "ended", status: .done, summary: "playing Focus")
                state.applyThreadEvent(e)
                print("action: thread-end \(id) at \(stamp)s → status=\(state.threads[id]?.status.rawValue ?? "nil") order=\(state.orderedThreads.map(\.id).joined(separator: ","))")
            } else if action.hasPrefix("agent-echo:") || action.hasPrefix("agent-land:") {
                // <id>:<text>. echo = the pending row EngineClient.send adds; land = the real user turn from the tool's file.
                let echo = action.hasPrefix("agent-echo:")
                let rest = action.dropFirst((echo ? "agent-echo:" : "agent-land:").count)
                // The id holds colons (sessions:claude:w1p2): the text starts after the third.
                let pieces = rest.split(separator: ":", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
                guard pieces.count == 4 else { print("action: \(echo ? "agent-echo" : "agent-land") needs <a:b:c>:<text>"); return }
                let id = pieces[0...2].joined(separator: ":"), text = pieces[3]
                let at = Date().timeIntervalSince1970 * 1000
                if echo {
                    state.echoPendingSend(agentId: id, text: text, at: at)
                } else {
                    let real = AgentMessage(id: "u-landed-\(Int(at))", role: .user, text: text, at: at, tool: nil, thinking: nil)
                    let current = state.transcripts[id]
                    state.applyTranscript(AgentTranscript(agentId: id, messages: [real], total: (current?.total ?? 0) + 1, complete: current?.complete ?? false, live: current?.live ?? true), mode: "append")
                }
                let pending = state.transcripts[id]?.messages.filter { $0.pending == true }.count ?? -1
                print("action: \(echo ? "agent-echo" : "agent-land") \(id) at \(stamp)s → pending rows \(pending), held \(state.transcripts[id]?.messages.count ?? -1)")
            } else if action == "probe-pending" {
                let id = console?.openAgentIdForPreview ?? "sessions:claude:w1p2"
                let messages = state.transcripts[id]?.messages ?? []
                let pending = messages.filter { $0.pending == true }
                print("probe-pending: \(id) at \(stamp)s → held \(messages.count) pending \(pending.count) last='\(messages.last?.text ?? "")' lastPending=\(messages.last?.pending == true)")
            } else if action == "reconnect" {
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: ["reconnect": true])
                print("action: reconnect at \(stamp)s (the pane must re-send agent.open as its viewer)")
            } else if action == "hide-window" || action == "show-window" {
                let visible = action == "show-window"
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: ["windowVisible": visible])
                print("action: \(action) at \(stamp)s (\(visible ? "agent.open" : "agent.close") as the same viewer)")
            } else if action.hasPrefix("rail-scroll:") {
                let points = Double(action.dropFirst("rail-scroll:".count)) ?? 0
                guard let window = NSApp.windows.first(where: { $0.title == "Jarhead" }),
                      let scroll = Self.railScrollView(in: window.contentView) else {
                    print("action: rail-scroll at \(stamp)s → no rail scroll view")
                    return
                }
                let clip = scroll.contentView
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: max(0, clip.bounds.origin.y + points)))
                scroll.reflectScrolledClipView(clip)
                print(String(format: "action: rail-scroll %.0f at %@s → minY=%.1f content=%.1f", points, stamp, clip.bounds.minY, scroll.documentView?.frame.height ?? 0))
            } else if action == "probe-ground" {
                probeGround(stamp: stamp)
            } else if action.hasPrefix("load-earlier:") || action == "history" {
                loadEarlier(action, stamp: stamp)
            } else if let info = kitAction(action) {
                // The kit's keys (ConsolePreviewKey): the trigger with that id answers.
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: info)
                print("action: \(action) at \(stamp)s")
            } else if action.hasPrefix("keyDown:") {
                keyDown(String(action.dropFirst("keyDown:".count)), stamp: stamp)
            } else if action.hasPrefix("click:") {
                click(String(action.dropFirst("click:".count)), stamp: stamp)
            } else if action == "probe-floats" {
                probeFloats(stamp: stamp)
            } else if action == "check-kit" {
                checkKit(stamp: stamp)
            } else if action == "check-tips" {
                checkTips(stamp: stamp)
            } else if action.hasPrefix("check-floats:") {
                checkFloats(String(action.dropFirst("check-floats:".count)), stamp: stamp)
            } else if let info = memoryAction(action) {
                // The memory rail's verbs, through the row's own closures (MemoryRailList.preview): the
                // `send:` line is the command, the `memory-rail:` line what the list holds after.
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: info)
                print("action: \(action) at \(stamp)s")
            } else if let info = cleanupAction(action) {
                // The rail's cleanup state (ConsoleSession.previewNotification; the root view applies it).
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: info)
                print("action: \(action) at \(stamp)s")
            } else {
                performFeed(action)
            }
        }
    }

    /// `memory-forget:<id>` / `memory-restore:<id>` / `memory-edit:<id>=<text>` / `memory-segment:<state>`
    /// as the rail's preview notification (MemoryRailList.preview runs the row's own verb closures).
    private func memoryAction(_ action: String) -> [String: Any]? {
        if action.hasPrefix("memory-segment:") { return ["memorySegment": String(action.dropFirst("memory-segment:".count))] }
        for verb in ["forget", "restore", "edit"] where action.hasPrefix("memory-\(verb):") {
            let rest = String(action.dropFirst("memory-\(verb):".count))
            var info: [String: Any] = ["memoryVerb": verb]
            if verb == "edit", let eq = rest.firstIndex(of: "=") {
                info["memoryId"] = String(rest[..<eq])
                info["memoryText"] = String(rest[rest.index(after: eq)...])
            } else {
                info["memoryId"] = rest
            }
            return info
        }
        return nil
    }

    /// `load-earlier:<n>` (`history` = 4): an older page for the open conversation the way
    /// `agent.history` answers — mode `prepend`, n rows before the first the feed shows. The model
    /// holds the page whole and raises its cap by it (AppState.prependedCount); the pane's ceiling
    /// follows (ConversationPane.shown(loaded:)), so `shown` must grow by n — held to a flat 400 the
    /// page sat above the fold, unseen. `geometry` before and after says the bottom stayed pinned.
    private func loadEarlier(_ action: String, stamp: String) {
        let n = action == "history" ? 4 : max(1, Int(action.dropFirst("load-earlier:".count)) ?? 60)
        guard let agentId = console?.openAgentIdForPreview, let current = state.transcripts[agentId] else {
            print("action: load-earlier at \(stamp)s → no open conversation")
            return
        }
        let loadedBefore = state.prependedCount[agentId] ?? 0
        let shownBefore = ConversationPane.shown(current.messages, loaded: loadedBefore)
        guard let first = shownBefore.first else {
            print("action: load-earlier at \(stamp)s → nothing shown yet")
            return
        }
        var older: [AgentMessage] = []
        for i in stride(from: n, through: 1, by: -1) {
            older.append(AgentMessage(id: "\(agentId)-older-\(loadedBefore + i)", role: i % 2 == 0 ? .assistant : .user,
                                      text: "Earlier message \(loadedBefore + i) of this session, loaded on request.",
                                      at: first.at - Double(i) * 60_000, tool: nil, thinking: nil))
        }
        // `complete: false`: more remains before this page (the fixture never reaches the first row).
        let page = AgentTranscript(agentId: agentId, messages: older, total: current.total, complete: false, live: current.live)
        state.applyTranscript(page, mode: "prepend")
        let after = state.transcripts[agentId]
        let loadedAfter = state.prependedCount[agentId] ?? 0
        let shownAfter = ConversationPane.shown(after?.messages ?? [], loaded: loadedAfter)
        print("action: load-earlier \(n) at \(stamp)s → held \(current.messages.count)→\(after?.messages.count ?? -1)"
              + " shown \(shownBefore.count)→\(shownAfter.count) loaded \(loadedBefore)→\(loadedAfter)"
              + " first \(first.id)→\(shownAfter.first?.id ?? "nil") last \(shownAfter.last?.id ?? "nil") complete \(after?.complete ?? false)"
              + (shownAfter.count == shownBefore.count + n ? "" : " (FAIL: the page is above the fold)"))
    }

    /// `check-sleep`: the pure words behind the sleep rows, each named and compared (run.log:
    /// `check: ok` / `check: FAIL`) — the Swift package has no test target, so this is where the
    /// behaviour is pinned. A close after a `sleep` row reads "asleep · why"; a pressed Stop's
    /// sleep stays "stopped" (its stop row is the record); the engine's own "sleep:<cause>" label
    /// reads the same; a server word that is not a requested close is kept; the sleep tombstone
    /// is the moon with the cue quoted; the remedy decoder yields `sleep {cause}`. Then the stream
    /// built from ledger rows end to end (the sleep row's close, a pressed Stop's silent sleep row,
    /// no leak across sessions) and a `worker` row from a day file before 2026-09-13: decoded,
    /// no tombstone, no stream line — skipped, never a crash.
    private func checkSleepWords(stamp: String) {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        func row(_ type: String) -> LedgerRow {
            LedgerRow(at: 0, type: type, item: nil, delegation: nil, delegationId: nil, step: nil, status: nil, summary: nil, text: nil, sessionId: nil, reason: nil, usageSeconds: nil, agent: nil)
        }
        expect("close after sleep:said", ConsoleFormat.closeReason("close_requested", after: "sleep:said"), "asleep · said")
        expect("forced close after sleep:dock", ConsoleFormat.closeReason("client_closed", after: "sleep:dock"), "asleep · dropped in the dock")
        expect("close after sleep:pause-decayed", ConsoleFormat.closeReason("close_requested", after: "sleep:pause-decayed"), "asleep · pause decayed")
        expect("close after sleep:stop stays stopped", ConsoleFormat.closeReason("close_requested", after: "sleep:stop"), "stopped")
        expect("close after pause", ConsoleFormat.closeReason("close_requested", after: "pause"), "paused")
        expect("close with no transport", ConsoleFormat.closeReason("close_requested"), "closed")
        expect("engine label as the reason", ConsoleFormat.closeReason("sleep:idle"), "asleep · idle")
        expect("bare sleep label is the command", ConsoleFormat.closeReason("sleep"), "asleep · sleep command")
        expect("server word kept", ConsoleFormat.closeReason("connection_lost", after: "sleep:said"), "connection_lost")
        expect("unknown cause kept as recorded", SleepCauseFormat.words("solar-flare"), "solar-flare")
        expect("shutdown reads quit", SleepCauseFormat.line("shutdown"), "asleep · quit")

        var slept = row("sleep"); slept.sessionId = "live_u7_abcdefgh1234"; slept.cause = "said"; slept.phrase = "go to sleep"; slept.farewell = true
        let sleepLine = ConsoleFormat.tombstone(slept)
        expect("sleep tombstone symbol", sleepLine?.symbol ?? "", "moon.zzz.fill")
        expect("sleep tombstone text", sleepLine?.text ?? "", "asleep · said")
        expect("sleep tombstone session", sleepLine?.mono ?? "", "abcdefgh")
        expect("sleep tombstone cue quoted", sleepLine?.trailing ?? "", "“go to sleep”")
        var quiet = row("sleep"); quiet.cause = "idle"
        expect("idle sleep has no cue", ConsoleFormat.tombstone(quiet)?.trailing ?? "nil", "nil")
        var old = row("sleep")
        expect("a sleep row without a cause is the command", ConsoleFormat.tombstone(old)?.text ?? "", "asleep · sleep command")
        old.cause = ""
        expect("an empty cause is the command too", old.sleepCause ?? "nil", "command")
        expect("sleepCause of a non-sleep row", row("pause").sleepCause ?? "nil", "nil")

        expect("remedy sleep with a cause", EngineCommand(remedyJSON: ["type": .string("sleep"), "cause": .string("dock")]) == .sleepCause("dock") ? "sleepCause(dock)" : "other", "sleepCause(dock)")
        expect("remedy bare sleep", EngineCommand(remedyJSON: ["type": .string("sleep")]) == .sleep ? "sleep" : "other", "sleep")
        expect("sleep cause on the wire", (EngineCommand.sleepCause("dock").json["type"] as? String ?? "") + " " + (EngineCommand.sleepCause("dock").json["cause"] as? String ?? ""), "sleep dock")

        // The stream from the ledger, end to end. A `sleep` row threads the close reason and a
        // `session.started` after a close-less sleep resets it; a pressed Stop's sleep row is
        // silent (its stop row is the record).
        func at(_ ms: Double, _ type: String) -> LedgerRow { var r = row(type); r.at = ms; return r }
        func systemLines(_ rows: [LedgerRow]) -> [SystemEntry] {
            StreamBuilder.fromLedger(rows).compactMap { if case .system(let s) = $0 { return s }; return nil }
        }
        func texts(_ rows: [LedgerRow]) -> String { systemLines(rows).map(\.text).joined(separator: " | ") }
        var started = at(1_000, "session.started"); started.sessionId = "live_u7_abcdefgh1234"
        var farewell = at(2_000, "sleep"); farewell.sessionId = started.sessionId; farewell.cause = "said"; farewell.phrase = "that's all for now"; farewell.farewell = true
        var closed = at(3_000, "session.closed"); closed.sessionId = started.sessionId; closed.reason = "close_requested"; closed.usageSeconds = 140
        expect("fromLedger: the sleep row, then the close it explains", texts([started, farewell, closed]), "Session started | Asleep · said | Session closed · asleep · said")
        expect("fromLedger: the cue rides the sleep line", systemLines([started, farewell, closed]).first { $0.symbol == "moon.zzz.fill" }?.trailing ?? "nil", "“that's all for now”")
        var decayed = at(1_000, "sleep"); decayed.cause = "pause-decayed"
        var next = at(2_000, "session.started"); next.sessionId = "live_u7_next"
        var nextClosed = at(3_000, "session.closed"); nextClosed.sessionId = next.sessionId; nextClosed.reason = "close_requested"
        expect("fromLedger: a close-less sleep never leaks into the next session", texts([decayed, next, nextClosed]), "Asleep · pause decayed | Session started | Session closed")
        var pressed = at(1_000, "stop"); pressed.how = "pressed"
        var stopSleep = at(2_000, "sleep"); stopSleep.cause = "stop"
        var stopClosed = at(3_000, "session.closed"); stopClosed.reason = "close_requested"
        expect("fromLedger: a pressed Stop's sleep row is silent, the close says stopped", texts([pressed, stopSleep, stopClosed]), "Stopped (pressed) | Session closed · stopped")
        // A row type this Console does not know, as day files before 2026-09-13 hold them: it decodes
        // as a loose row, yields no tombstone and no stream line — skipped, never a crash.
        let oldRow = #"{"at":1000,"type":"worker","worker":{"id":"w_old","name":"Spotify","delegationId":"dlg_old","task":"play Focus","lane":"background","status":"working","startedAt":900,"steps":1}}"# // a row from before 2026-09-13
        let decodedOld = try? jarheadJSONDecoder.decode(LedgerRow.self, from: Data(oldRow.utf8))
        expect("a row type from before 2026-09-13 decodes", decodedOld.map { $0.type } ?? "nil", "worker") // before 2026-09-13
        expect("a row type from before 2026-09-13 has no tombstone", decodedOld.flatMap { ConsoleFormat.tombstone($0) } == nil ? "nil" : "some", "nil")
        expect("a row type from before 2026-09-13 yields no stream line", String(systemLines(decodedOld.map { [$0] } ?? []).count), "0")
        print("check: \(failed == 0 ? "all ok" : "\(failed) FAILED") at \(stamp)s")
    }

    /// `check-local`: the Local brain pass's pure words as `check: ok|FAIL` lines. The Settings
    /// rows' visibility (Model a menu, the Server row only when nothing was found or a root is
    /// pinned, no Key row), the Ready row's detail (the id, the best-fit pick, the loud fallback's
    /// kind), the Problems row's Copy (only from `remedy.copy`), the four data-path rows and their
    /// glyphs, the menu's titles and options, the status note, the wizard's nudge and Done line,
    /// the memory Matching words — and that every new SF Symbol exists.
    private func checkLocalWords(stamp: String) {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        guard let fake else { print("check: FAIL no fixtures at \(stamp)s"); return }
        let up = fake.ollamaUp()
        let empty = fake.ollamaEmpty()
        let none = fake.noServer()
        let ready = fake.localSnapshot()
        let fallback = fake.localEmptySnapshot()

        // Settings › Brain: which rows a kind draws.
        expect("model row is a menu for local", String(SettingsPanel.modelRowIsMenu(.local)), "true")
        expect("model row is a field for the compatible kind", String(SettingsPanel.modelRowIsMenu(.openaiCompatible)), "false")
        expect("compatible placeholder asks for a model", SettingsPanel.modelPlaceholder(.openaiCompatible), "pick a model")
        expect("codex placeholder is the backend default", SettingsPanel.modelPlaceholder(.codex), "backend default")
        expect("server row hidden: found, no pin", String(SettingsPanel.serverRowShown(kind: .local, local: up, pin: "")), "false")
        expect("server row shown: pinned", String(SettingsPanel.serverRowShown(kind: .local, local: up, pin: "http://10.0.0.7:11434")), "true")
        expect("server row shown: nothing found", String(SettingsPanel.serverRowShown(kind: .local, local: none, pin: "")), "true")
        expect("no local server row for codex", String(SettingsPanel.serverRowShown(kind: .codex, local: none, pin: "")), "false")
        expect("no key row for local", String(SettingsPanel.keyRowShown(.local)), "false")
        expect("local wants no secret", BrainKind.local.secretKey ?? "nil", "nil")
        expect("key row for the compatible kind", String(SettingsPanel.keyRowShown(.openaiCompatible)), "true")
        expect("no key row for openai (the voice key)", String(SettingsPanel.keyRowShown(.openaiResponses)), "false")
        expect("short labels", [BrainKind.local, .openaiCompatible, .codex].map(\.shortLabel).joined(separator: "/"), "Local/OpenAI-compatible/Codex")
        expect("brains list ends with local", ConsoleTheme.brains.last?.rawValue ?? "nil", "local")
        expect("default model for local is empty (best fit)", ConsoleTheme.defaultBrainModel(.local), "")

        // Now › Ready: the brain's detail.
        expect("ready detail: local best fit names the pick", NowPanel.readyBrainDetail(brain: .local, brainModel: "", setup: ready.setup), "qwen3.5:27b")
        expect("ready detail: local explicit id", NowPanel.readyBrainDetail(brain: .local, brainModel: "qwen3.5:9b", setup: ready.setup), "qwen3.5:9b")
        expect("ready detail: the fallback names its kind", NowPanel.readyBrainDetail(brain: .local, brainModel: "", setup: fallback.setup), "openai-responses")
        var unresolved = fallback.setup; unresolved.brainResolved = nil
        expect("ready detail: local unresolved", NowPanel.readyBrainDetail(brain: .local, brainModel: "", setup: unresolved), "local")
        expect("ready detail: other kinds name themselves", NowPanel.readyBrainDetail(brain: .codex, brainModel: "", setup: ready.setup), "codex")

        // Problems: the Copy chip only from remedy.copy.
        expect("problems row has Copy", NowPanel.problemCopy(fake.localProblem) ?? "nil", "ollama pull qwen3.5:27b")
        expect("no Copy without remedy.copy", NowPanel.problemCopy(fake.accessibilityProblem) ?? "nil", "nil")
        expect("brain.local is amber", ConsoleTheme.problem("brain.local").tint == ConsoleTheme.speaking ? "speaking" : "error", "speaking")
        expect("brain.local glyph", ConsoleTheme.problem("brain.local").symbol, "brain.fill")
        expect("local-empty carries the one problem", fallback.problems.map(\.kind).joined(separator: ","), "brain.local")

        // Leaves the Mac: four rows, their glyphs.
        expect("four data-path rows", String(ready.setup.dataPaths.count), "4")
        expect("data paths in order", ready.setup.dataPaths.map(\.what).joined(separator: ","), "voice,brain,memory,web")
        expect("data paths where (local)", ready.setup.dataPaths.map(\.where).joined(separator: ","), "cloud,mac,mac,cloud")
        expect("data paths where (fallback)", fallback.setup.dataPaths.map(\.where).joined(separator: ","), "cloud,cloud,mac,cloud")
        expect("data path symbols", ["voice", "brain", "memory", "web"].map(ConsoleTheme.dataPathSymbol).joined(separator: ","), "waveform,brain.fill,tray.full.fill,globe")
        expect("data path where symbols", ["cloud", "mac", "lan", "off"].map(ConsoleTheme.dataPathWhereSymbol).joined(separator: ","), "icloud.fill,laptopcomputer,network,minus.circle")
        expect("data path names", ["voice", "brain", "memory", "web"].map(ConsoleTheme.dataPathName).joined(separator: ","), "Voice,Brain,Memory,Web")
        expect("mac is the acting green", ConsoleTheme.dataPathTint("mac") == ConsoleTheme.acting ? "acting" : "other", "acting")

        // The Model menu's words.
        expect("collapsed: best fit", LocalBrainWords.collapsedTitle(saved: "", status: up), "best fit · qwen3.5:27b")
        expect("collapsed: nothing pickable", LocalBrainWords.collapsedTitle(saved: "", status: empty), "pick a model")
        expect("collapsed: saved id", LocalBrainWords.collapsedTitle(saved: "qwen3.5:9b", status: up), "qwen3.5:9b")
        expect("options: best fit first, tool-capable only", LocalBrainWords.modelOptions(saved: "", status: up).joined(separator: ","), ",qwen3.5:27b,qwen3.5:9b,gpt-oss:120b,llama3.3:70b,deepseek-v3.1:671b")
        expect("options: a saved id off the server is appended", LocalBrainWords.modelOptions(saved: "qwen3:8b", status: up).last ?? "nil", "qwen3:8b")
        // The way back from a pin: "" (best fit) stays the first row after an explicit pick, so
        // the Console can send brainModel "" again — the setting's own default — from the menu.
        expect("options: best fit row survives a listed pick", LocalBrainWords.modelOptions(saved: "qwen3.5:9b", status: up).joined(separator: ","), ",qwen3.5:27b,qwen3.5:9b,gpt-oss:120b,llama3.3:70b,deepseek-v3.1:671b")
        expect("options: best fit row survives an unlisted pick", LocalBrainWords.modelOptions(saved: "qwen3:8b", status: up).first ?? "nil", "")
        expect("options: a saved listed id adds nothing but the best fit row", String(LocalBrainWords.modelOptions(saved: "qwen3.5:9b", status: up).count), "6")
        expect("row title after a pick still names the engine's pick", LocalBrainWords.modelTitle("", status: up), "best fit · qwen3.5:27b")
        expect("row title", LocalBrainWords.modelTitle("qwen3.5:27b", status: up), "qwen3.5:27b  ·  17 GB · fits")
        expect("row title: tight", LocalBrainWords.modelTitle("gpt-oss:120b", status: up), "gpt-oss:120b  ·  65 GB · tight fit")
        expect("row title: best fit names the pick", LocalBrainWords.modelTitle("", status: up), "best fit · qwen3.5:27b")
        expect("row title: off the server", LocalBrainWords.modelTitle("qwen3:8b", status: up), "qwen3:8b · not on Ollama 0.34.0")
        expect("too big rows are dim", String(LocalBrainWords.isDim("deepseek-v3.1:671b", status: up)), "true")
        expect("fitting rows are not dim", String(LocalBrainWords.isDim("qwen3.5:27b", status: up)), "false")
        expect("gigabytes", LocalBrainWords.gigabytes(17e9) + "/" + LocalBrainWords.gigabytes(6.6e9), "17 GB/6.6 GB")
        expect("server placeholder: found", LocalBrainWords.serverPlaceholder(up), "127.0.0.1:11434 · Ollama 0.34.0")
        expect("server placeholder: nothing", LocalBrainWords.serverPlaceholder(none), "nothing found — 11434, 1234, 8080")
        expect("status line: up", LocalBrainWords.statusLine(up), "Ollama 0.34.0 · 4 models fit this Mac")
        expect("status line: nothing tool-capable", LocalBrainWords.statusLine(empty), "Nothing here can call tools.")
        expect("status line: no server", LocalBrainWords.statusLine(none), "No local server. Open Ollama, then Check.")
        expect("auto nudge: up", LocalBrainWords.autoNudge(up) ?? "nil", "Ollama 0.34.0 is running with 4 models that fit. Pick Local model to keep the brain on this Mac.")
        expect("auto nudge: nothing", LocalBrainWords.autoNudge(none) ?? "nil", "nil")
        expect("pickable excludes tools-less models", up.pickable.map(\.id).contains("gemma4:31b") ? "listed" : "greyed out", "greyed out")

        // The Matching row (the wizard's Done line is pinned by OnboardingBench: the harness here
        // compiles without UI/Onboarding).
        expect("matching: local", ConsoleTheme.memoryMatching(fake.memorySummaryLocal()), "local · embeddinggemma · 768 dims")
        expect("matching: openai", ConsoleTheme.memoryMatching(fake.memorySummary()), "OpenAI · 512 dims")
        expect("matching: nothing yet", ConsoleTheme.memoryMatching(nil), "—")
        expect("matching help: local names the model", SettingsPanel.matchingHelp(fake.memorySummaryLocal()), "Item text goes to embeddinggemma on this Mac; nothing leaves for memory")

        // Every new symbol exists on this macOS.
        let symbols = ["waveform", "brain.fill", "tray.full.fill", "globe", "icloud.fill", "laptopcomputer", "network", "minus.circle", "questionmark.circle.fill", "arrow.up.right.square.fill"]
        let missing = symbols.filter { NSImage(systemSymbolName: $0, accessibilityDescription: nil) == nil }
        expect("every data-path symbol exists", missing.joined(separator: ","), "")
        print("check: \(failed == 0 ? "all ok" : "\(failed) FAILED") at \(stamp)s")
    }

    /// `check-dither`: the dither arithmetic, each named and compared (run.log: `check: ok` /
    /// `check: FAIL`) — the package has no test target, so this is where the Bayer ranks, the
    /// wipe tiles, the glyph lines, the bar's cell arithmetic and the ground's rounding are pinned.
    private func checkDither(stamp: String) {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        /// The alpha bytes of a premultiplied RGBA image, row-major.
        func alphas(_ img: CGImage) -> [UInt8] {
            guard let data = img.dataProvider?.data as Data? else { return [] }
            let bpr = img.bytesPerRow
            var out: [UInt8] = []
            out.reserveCapacity(img.width * img.height)
            for y in 0..<img.height {
                for x in 0..<img.width { out.append(data[y * bpr + x * 4 + 3]) }
            }
            return out
        }
        expect("bayer8Ranks is a permutation of 0…63", String(Dither.bayer8Ranks.count == 64 && Set(Dither.bayer8Ranks) == Set(0..<64)), "true")
        expect("bayer8 thresholds are (rank + 0.5) / 64", String(zip(Dither.bayer8, Dither.bayer8Ranks).allSatisfy { abs($0 - (Float($1) + 0.5) / 64) < 1e-6 }), "true")
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let cell = Dither.cellPixels(scale: scale, points: 2)
        expect("Tiles.hasWipe after prewarm", String(Dither.Tiles.shared.hasWipe), "true")
        for k in [0, 1, 32, 63, 64] {
            guard let t = Dither.Tiles.shared.wipe(step: k, cell: cell, inverted: false),
                  let ti = Dither.Tiles.shared.wipe(step: k, cell: cell, inverted: true) else {
                expect("wipe tile \(k) exists", "nil", "tile")
                continue
            }
            let a = alphas(t), ai = alphas(ti)
            expect("wipe tile \(k) is 8·cell square", "\(t.width)×\(t.height)", "\(8 * cell)×\(8 * cell)")
            expect("wipe tile \(k) opaque px", String(a.filter { $0 == 255 }.count), String(k * cell * cell))
            expect("wipe tile \(k) is 0 or 255 everywhere", String(a.allSatisfy { $0 == 0 || $0 == 255 }), "true")
            expect("wipe tile \(k) ∪ inverted \(k) covers every px", String(a.count == ai.count && zip(a, ai).allSatisfy { ($0 | $1) == 255 && !($0 == 255 && $1 == 255) }), "true")
        }
        let edgeCell = Dither.cellPixels(scale: scale, points: Dither.cellPoints)
        if let e = Dither.Tiles.shared.edge(cell: edgeCell, rows: 4) {
            expect("edge tile is 8×4 cells", "\(e.width)×\(e.height)", "\(8 * edgeCell)×\(4 * edgeCell)")
            // Coverage falls left → right: the first cell column is denser than the last.
            let a = alphas(e)
            func column(_ i: Int) -> Int { (0..<e.height).reduce(0) { $0 + (a[$1 * e.width + i * edgeCell] == 255 ? 1 : 0) } }
            expect("edge tile falls left → right", String(column(0) >= column(7) && column(0) > 0), "true")
        } else {
            expect("edge tile rows 4 exists", "nil", "tile")
        }
        expect("edge tile rows 2 exists", String(Dither.Tiles.shared.edge(cell: edgeCell, rows: 2) != nil), "true")
        let lines = (0..<8).map { Dither.glyphLine(frame: $0, row: 0, cols: 8) }
        expect("glyphLine is cols long", String(lines[0].count), "8")
        expect("glyphLine differs between consecutive frames", String(zip(lines, lines.dropFirst()).allSatisfy { $0 != $1 } && lines[7] != lines[0]), "true")
        expect("glyphLine draws from the ramp", String(lines.joined().allSatisfy { Dither.glyphRamp.contains($0) }), "true")
        let still = Dither.glyphLine(frame: -1, row: 3, cols: 16)
        expect("glyphLine still frame is two-tone", String(still.allSatisfy { $0 == "." || $0 == "#" } && still.contains(".") && still.contains("#")), "true")
        expect("glyphLine still frame follows the ranks", still, String((0..<16).map { Dither.bayer8Ranks[3 * 8 + ($0 % 8)] < 32 ? "." : "#" }))
        expect("DitheredBar.fillCells(0.5, 200, 1.5)", String(DitheredBar.fillCells(fraction: 0.5, width: 200, cell: 1.5)), "66")
        expect("DitheredBar.fillCells clamps", "\(DitheredBar.fillCells(fraction: -1, width: 200, cell: 1.5)),\(DitheredBar.fillCells(fraction: 2, width: 200, cell: 1.5))", "0,133")
        let widths: [CGFloat] = [CGFloat(DitheredBar.totalCells(width: 200, cell: 1.5)) * 1.5, CGFloat(DitheredBar.fillCells(fraction: 0.5, width: 200, cell: 1.5) - 8) * 1.5, 8 * 1.5]
        expect("DitheredBar widths are multiples of 1.5", String(widths.allSatisfy { ($0 / 1.5).rounded() * 1.5 == $0 }), "true")
        let r = DitheredGradient.rounded(CGSize(width: 1180, height: 760), step: 64)
        expect("DitheredGradient.rounded(1180×760, 64)", "\(Int(r.width))×\(Int(r.height))", "1216×768")
        expect("DitheredGradient.rounded(step 0) is exact", String(DitheredGradient.rounded(CGSize(width: 1180, height: 760), step: 0) == CGSize(width: 1180, height: 760)), "true")
        let lut = Dither.lut(stops: Dither.groundStops, bands: Dither.groundBands)
        expect("ground LUT", lut.map { String(format: "%02x%02x%02x", Int($0.x.rounded()), Int($0.y.rounded()), Int($0.z.rounded())) }.joined(separator: ","), "070707,070707,0a0a0a,101010,161e35")
        print("check: \(failed == 0 ? "all ok" : "\(failed) FAILED") (dither) at \(stamp)s")
    }

    /// `probe-ground`: the window's own pixels (CGWindowListCreateImage): the distinct colours of a
    /// 32×32 px block at three bare places on the ground — the stream's top-left (one colour: ink),
    /// the window's bottom-right (two: the raised step and the whisper), the stream's bottom-middle
    /// above the composer (two: the field's first steps). Positions are in points × the backing scale.
    private func probeGround(stamp: String) {
        guard let img = windowImage() else {
            print("ground: no window image (Screen Recording grant?)")
            return
        }
        let W = img.width, H = img.height
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let _ = { ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H)); return ctx.data }() else {
            print("ground: could not read pixels")
            return
        }
        let px = ctx.data!.assumingMemoryBound(to: UInt8.self)
        func block(_ x0: Int, _ y0: Int, _ label: String) {
            var colours: [String: Int] = [:]
            for y in y0..<min(H, y0 + 32) {
                for x in x0..<min(W, x0 + 32) {
                    let i = (y * W + x) * 4
                    colours[String(format: "#%02x%02x%02x", px[i], px[i + 1], px[i + 2]), default: 0] += 1
                }
            }
            let sorted = colours.sorted { $0.value > $1.value }.map { "\($0.key)×\($0.value)" }.joined(separator: " ")
            print("ground: \(label) at (\(x0), \(y0)) px → \(colours.count) distinct: \(sorted)")
        }
        print("ground: window image \(W)×\(H) px at \(stamp)s (the shot's origin is the window's top-left)")
        let s = Int((NSScreen.main?.backingScaleFactor ?? 2).rounded())
        // The stream spans the agents rail's width to the right rail's; the header is 44 pt, the composer 48.
        let streamLeft = Int(ConsoleLayout.agentsRailWidth + ConsoleHairline.sidebarEdge) * s
        let streamRight = W - Int(ConsoleLayout.rightRailWidth + ConsoleHairline.sidebarEdge) * s
        block(streamLeft + 40 * s, 60 * s, "stream top-left")
        block(W - 40 * s - 32, H - 40 * s - 32, "window bottom-right")
        block((streamLeft + streamRight) / 2 - 16, H - 48 * s - 8 * s - 32, "stream bottom-middle")
    }

    /// `key:<char>` sends ⌘<char> to the window the way the keyboard would (⌘F must open the
    /// rail's search); `undo` runs the window's undo manager once (Edit › Undo's path: the
    /// last cleanup action's inverse must go out). Both print what happened.
    private func keyAction(_ action: String) -> Bool {
        guard let window = NSApp.windows.first(where: { $0.title == "Jarhead" }) else { return false }
        if action.hasPrefix("key:") {
            let char = String(action.dropFirst("key:".count))
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, characters: char, charactersIgnoringModifiers: char,
                                               isARepeat: false, keyCode: 0) else { return true }
            window.makeKeyAndOrderFront(nil)
            let handled = window.performKeyEquivalent(with: event)
            print("action: ⌘\(char) → \(handled ? "handled" : "not handled") (shoot the window to see what it did)")
            return true
        }
        if action == "undo" {
            let um = window.undoManager
            print("action: undo → canUndo=\(um?.canUndo ?? false) \(um?.undoActionName ?? "")")
            um?.undo()
            return true
        }
        if action == "redo" {
            let um = window.undoManager
            print("action: redo → canRedo=\(um?.canRedo ?? false) \(um?.redoActionName ?? "")")
            um?.redo()
            return true
        }
        if action == "undo-toast" {
            // The toast's Undo button: AppState.undoCleanup(id:) for the toast on screen.
            let um = window.undoManager
            guard let toast = state.cleanupToast else { print("action: undo-toast → no toast on screen"); return true }
            print("action: undo-toast '\(toast.text)' → before: canUndo=\(um?.canUndo ?? false) \(um?.undoActionName ?? "")")
            state.undoCleanup(id: toast.id)
            print("action: undo-toast → after: canUndo=\(um?.canUndo ?? false) '\(um?.undoActionName ?? "")' canRedo=\(um?.canRedo ?? false) '\(um?.redoActionName ?? "")' appUndo=\(state.cleanupUndoStack.count) appRedo=\(state.cleanupRedoStack.count) toast=\(state.cleanupToast?.text ?? "nil")")
            return true
        }
        return false
    }

    /// The cleanup grammar → the preview notification's userInfo; nil for any other action.
    private func cleanupAction(_ action: String) -> [String: Any]? {
        if action.hasPrefix("search:") { return ["search": String(action.dropFirst("search:".count))] }
        if action == "trash-open" { return ["trashOpen": true] }
        if action == "archived-open" { return ["archivedOpen": true] }
        if action == "hidden-open" { return ["hiddenOpen": true] }
        if action.hasPrefix("select:") { return ["select": action.dropFirst("select:".count).split(separator: "+").map(String.init)] }
        if action.hasPrefix("rename:") { return ["rename": String(action.dropFirst("rename:".count))] }
        if action.hasPrefix("trash:") { return ["trash": String(action.dropFirst("trash:".count))] }
        if action == "clear-now" { return ["clearNow": true] }
        if action == "hit-first" { return ["hitFirst": true] }
        if action == "probe" { return ["probe": true] }
        if action == "pin-loading" { return ["pinLoading": true] }
        if action.hasPrefix("hit:") {
            // hit:<sessionId>:<atMs>
            let parts = action.dropFirst("hit:".count).split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2, let at = Double(parts[1]) else { return nil }
            return ["hit": ["sessionId": parts[0], "at": at] as [String: Any]]
        }
        return nil
    }

    /// The window's own pixels right now (CGWindowListCreateImage, at the backing scale), for
    /// `probe-ground` and `snap:`. Needs the Screen Recording grant of whatever launched us.
    private func windowImage() -> CGImage? {
        guard let win = console?.windowNumber else { return nil }
        return CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(win), [.boundsIgnoreFraming, .bestResolution])
    }

    /// `snap:<name>`: the frame on screen at this instant, written in-process as a PNG. Unlike
    /// `shoot` there is no process to spawn, so a mid-wipe picture is the scheduled frame, not
    /// one 0.1–0.3 s later.
    private func snap(to path: String, stamp: String) {
        guard let img = windowImage() else { print("snap: no window image (Screen Recording grant?)"); return }
        // The capture is the instant; the encode (~0.1 s for a 2360×1520 PNG) happens off main so
        // it delays neither the wipe's frames nor the next scheduled action.
        DispatchQueue.global(qos: .utility).async {
            guard let data = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) else {
                print("snap: could not encode \(path)")
                return
            }
            do {
                try data.write(to: URL(fileURLWithPath: path))
                print("snap: \(path) at \(stamp)s (\(img.width)×\(img.height) px)")
            } catch {
                print("snap failed: \(error)")
            }
            fflush(stdout)
        }
    }

    /// A window-only screenshot of the Console right now (`screencapture -l`), for a
    /// moment mid-transition. Needs the Screen Recording grant of whatever launched us,
    /// like the script's own shot.
    private func shoot(to path: String, stamp: String) {
        guard let win = console?.windowNumber else { print("shot: no window"); return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-l", String(win), path]
        do {
            try p.run()
            p.waitUntilExit()
            print("shot: \(path) at \(stamp)s (status \(p.terminationStatus))")
        } catch {
            print("shot failed: \(error)")
        }
    }

    private func performFeed(_ action: String) {
        switch action {
        case "scroll-top":
            guard let window = NSApp.windows.first(where: { $0.title == "Jarhead" }),
                  let scroll = Self.widestScrollView(in: window.contentView) else { return }
            let clip = scroll.contentView
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
            scroll.reflectScrolledClipView(clip)
        case "drop-open":
            // The open session leaves the rail (its file went away, the connector
            // dropped it): the pane must close and the root forget the id.
            guard let openId = console?.openAgentIdForPreview else { return }
            state.snapshot.agents.removeAll { $0.id == openId }
            print("action: drop-open \(openId) → openAgentId=\(console?.openAgentIdForPreview ?? "nil")")
        case "restore-agents":
            // The same id is back on the rail; without a click the stream must stay.
            if let fake { state.snapshot.agents = fake.agents() }
            print("action: restore-agents → openAgentId=\(console?.openAgentIdForPreview ?? "nil")")
        default:
            break
        }
    }

    /// `check-durability`: the pure words behind this pass, each named and compared (run.log:
    /// `check: ok` / `check: FAIL`) — the package has no test target, so this is where they are
    /// pinned. The live dot and the typing face derive from status + connection (a stale tail
    /// flag alone lights nothing); the caret gate; the feed's 400 cap keeps the newest; the rail
    /// orders live sessions first and speaks the hint word only when it adds to the glyph; the
    /// voice labels, accents and Switch now's rule; the memory rail's lines; every symbol exists.
    private func checkDurabilityWords(stamp: String) {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        func agent(_ status: AgentStatus, hint: String? = nil, at: Double = 0) -> AgentInfo {
            AgentInfo(id: "a", kind: .sessions, tool: .codex, name: "a", status: status, detail: nil, cwd: "/Users/kevinliu/gt/apps/api", updatedAt: at, messageCount: 42, hint: hint)
        }
        let tail = AgentTranscript(agentId: "a", messages: [], total: 0, complete: true, live: true)
        let closed = AgentTranscript(agentId: "a", messages: [], total: 0, complete: true, live: false)
        func live(_ t: AgentTranscript?, _ s: AgentStatus, _ connected: Bool) -> String {
            "\(ConversationPane.isLive(transcript: t, agent: agent(s), connected: connected) ? 1 : 0)\(ConversationPane.typing(transcript: t, agent: agent(s), connected: connected) ? 1 : 0)"
        }
        // isLive / typing: [live, typing] per case.
        expect("isLive: tail + connected + working → live, typing", live(tail, .working, true), "11")
        expect("isLive: tail + connected + idle → live, not typing", live(tail, .idle, true), "10")
        expect("isLive: tail + connected + blocked → live, not typing", live(tail, .blocked, true), "10")
        expect("isLive: tail + connected + ended → neither (the flag is stale)", live(tail, .ended, true), "00")
        expect("isLive: tail + connected + done → neither", live(tail, .done, true), "00")
        expect("isLive: tail + connected + unknown → neither", live(tail, .unknown, true), "00")
        expect("isLive: tail + DISCONNECTED + working → neither", live(tail, .working, false), "00")
        expect("isLive: no tail + working → neither", live(closed, .working, true), "00")
        expect("isLive: no transcript → neither", live(nil, .working, true), "00")
        // The caret gate.
        expect("caretsOn: live feed, session, connected", String(StreamPane.caretsOn(ledgerDay: nil, hasSession: true, connected: true)), "true")
        expect("caretsOn: a ledger day never", String(StreamPane.caretsOn(ledgerDay: "2026-09-10", hasSession: true, connected: true)), "false")
        expect("caretsOn: no session never", String(StreamPane.caretsOn(ledgerDay: nil, hasSession: false, connected: true)), "false")
        expect("caretsOn: disconnected never", String(StreamPane.caretsOn(ledgerDay: nil, hasSession: true, connected: false)), "false")
        expect("showsCaret: non-final behind a closed gate sits still", String(UtteranceRow.showsCaret(final: false, gate: false)), "false")
        expect("showsCaret: non-final behind an open gate blinks", String(UtteranceRow.showsCaret(final: false, gate: true)), "true")
        expect("showsCaret: a final item never", String(UtteranceRow.showsCaret(final: true, gate: true)), "false")
        let fake = self.fake ?? FakeData(shot: "preview.png")
        let entries = StreamBuilder.fromSnapshot(transcript: fake.live().transcript, delegations: fake.live().delegations, clearedAt: nil)
        expect("caretId: the newest utterance, not a card", StreamFeed.caretId(entries) ?? "nil", "u8")
        expect("caretId: nothing without utterances", StreamFeed.caretId([StreamEntry.delegation(fake.doneDelegation())]) ?? "nil", "nil")
        // The feed's cap keeps the newest 400.
        let long = fake.longTranscript(agentId: FakeData.endedId, count: 1_200)
        let shown = ConversationPane.shown(long.messages)
        expect("feed cap: 1200 → 400", String(shown.count), "400")
        expect("feed cap: keeps the newest (the last id)", shown.last?.id ?? "nil", long.messages.last?.id ?? "?")
        expect("feed cap: drops the oldest (the first id moves)", shown.first?.id ?? "nil", long.messages[long.messages.count - 400].id)
        expect("feed cap: under the cap is untouched", String(ConversationPane.shown(fake.transcripts()["sessions:codex:1"]!.messages).count), "10")
        // "Load earlier" raised the model's cap by the page (AppState.prependedCount): the view's follows.
        expect("feed cap: grows by what Kevin loaded (400 + 60)", String(ConversationPane.shown(long.messages, loaded: 60).count), "460")
        expect("feed cap: the loaded rows are the oldest shown", ConversationPane.shown(long.messages, loaded: 60).first?.id ?? "nil", long.messages[long.messages.count - 460].id)
        expect("feed cap: a negative loaded count is a flat 400", String(ConversationPane.shown(long.messages, loaded: -5).count), "400")
        expect("long transcript ends interrupted", long.messages.last?.tool?.status.rawValue ?? "nil", "interrupted")
        // The rail: live sessions first, then the rest, each by when they last wrote; the hint word.
        let rows = [agent(.ended, hint: "ended", at: 900), agent(.idle, hint: "quiet", at: 100), agent(.working, hint: "running", at: 500), agent(.done, hint: "archived", at: 950), agent(.blocked, hint: "blocked", at: 300)]
        expect("rail order: live (working, blocked, idle by time) then over (done, ended by time)", AgentsRail.ordered(rows).map { "\($0.status.rawValue)@\(Int($0.updatedAt))" }.joined(separator: ","), "working@500,blocked@300,idle@100,done@950,ended@900")
        expect("hint word: ended on ended says nothing", ConsoleFormat.hintWord(agent(.ended, hint: "ended")) ?? "nil", "nil")
        expect("hint word: running on working says nothing", ConsoleFormat.hintWord(agent(.working, hint: "running")) ?? "nil", "nil")
        expect("hint word: quiet on idle says nothing (the dot does)", ConsoleFormat.hintWord(agent(.idle, hint: "quiet")) ?? "nil", "nil")
        expect("hint word: unseen on unknown", ConsoleFormat.hintWord(agent(.unknown, hint: "unseen")) ?? "nil", "unseen")
        expect("hint word: archived on done", ConsoleFormat.hintWord(agent(.done, hint: "archived")) ?? "nil", "archived")
        expect("hint word: resumed on a run", ConsoleFormat.hintWord(agent(.working, hint: "resumed")) ?? "nil", "resumed")
        expect("hint word: none when the connector said nothing", ConsoleFormat.hintWord(agent(.idle)) ?? "nil", "nil")
        let nowMs = 10 * 60_000.0
        expect("agent meta: project · msgs · age (client-side) · hint", ConsoleFormat.agentMeta(agent(.unknown, hint: "unseen", at: nowMs - 2 * 60_000), now: nowMs), "api · 42 msgs · 2m · unseen")
        expect("agent meta: no hint word on ended", ConsoleFormat.agentMeta(agent(.ended, hint: "ended", at: nowMs - 3 * 3_600_000), now: nowMs), "api · 42 msgs · 3h")
        // Voice: the labels, the roster, the accents, the one language.
        expect("voices: 22", String(ConsoleTheme.voices.count), "22")
        expect("voices: ballad first, then cedar and marin", ConsoleTheme.voices.prefix(3).joined(separator: ","), "ballad,cedar,marin")
        expect("voices: no repeats", String(Set(ConsoleTheme.voices).count), "22")
        expect("voiceLabel(cedar)", ConsoleTheme.voiceLabel("cedar"), "Cedar · English")
        expect("voiceLabel(unknown id) keeps the id", ConsoleTheme.voiceLabel("zephyr-x"), "zephyr-x · English")
        expect("languageLabel(en)", ConsoleTheme.languageLabel("en"), "English")
        expect("languageLabel(en-GB) is English", ConsoleTheme.languageLabel("en-GB"), "English")
        expect("languageLabel(xx) falls back to English", ConsoleTheme.languageLabel("xx"), "English")
        expect("accents: american, british, none", ConsoleTheme.accents.map { "\($0.id)=\($0.label)" }.joined(separator: ","), "american=American,british=British,none=None")
        expect("accentLabel(unknown) is the word capitalised", ConsoleTheme.accentLabel("scottish"), "Scottish")
        expect("the language hint", ConsoleTheme.languageHint, "English at all times. A change is heard at the next wake.")
        // Switch now: awake and the pick differs from what the session said it opened on; never paused,
        // connecting or asleep — and never when the session did not say (that daemon has no voice.reopen).
        var settings = fake.settings
        settings.accent = "american"
        var session = fake.session()
        session.voice = "cedar"; session.accent = "american"
        expect("needsSwitch: same voice and accent → no", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .listening)), "false")
        settings.voice = "marin"
        expect("needsSwitch: a new voice while awake → yes", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .listening)), "true")
        settings.voice = "cedar"; settings.accent = "british"
        expect("needsSwitch: a new accent while awake → yes", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .speaking)), "true")
        expect("needsSwitch: paused → no", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .paused)), "false")
        expect("needsSwitch: connecting → no", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .connecting)), "false")
        expect("needsSwitch: asleep (no session) → no", String(SettingsPanel.needsSwitch(settings: settings, session: nil, phase: .asleep)), "false")
        session.voice = nil; session.accent = nil
        expect("needsSwitch: a session that did not say its voice → no", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .listening)), "false")
        session.voice = "cedar"
        expect("needsSwitch: voice said, accent not → the settings accent is assumed (no)", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .listening)), "false")
        // Memory: the rail's words.
        let items = fake.memoryItems()
        let pref = items.first { $0.id == "m_dark" }!
        expect("memory meta: seen · age · by Kevin", MemoryFormat.meta(pref, now: fake.now), "seen 3× · 2d · by Kevin")
        let extracted = items.first { $0.id == "m_kev" }!
        expect("memory meta: extracted says nothing of its origin", MemoryFormat.meta(extracted, now: fake.now), "seen 5× · 12h")
        expect("memory tooltip: kind, scores, the sources", MemoryFormat.tooltip(pref).components(separatedBy: "\n").first ?? "", "preference · importance 0.9 · confidence 0.9")
        expect("memory empty: live", MemoryFormat.emptyLine(state: .live, query: ""), "Nothing remembered yet.")
        expect("memory empty: forgotten", MemoryFormat.emptyLine(state: .forgotten, query: ""), "Nothing forgotten.")
        expect("memory empty: a query", MemoryFormat.emptyLine(state: .live, query: " dentist "), "No memory matches “dentist”.")
        expect("memory rows: only the segment's state, newest seen first, capped", MemoryFormat.rows(items, state: .live, query: "", cap: 3).map(\.id).joined(separator: ","), "m_kev,m_short,m_dark")
        expect("memory rows (list branch): a query filters text and subjects", MemoryFormat.rows(items, state: .live, query: "dentist", cap: 30).map(\.id).joined(separator: ","), "m_dentist")
        expect("memory rows (list branch): subjects match whatever the case", MemoryFormat.rows(items, state: .live, query: "Brevity", cap: 30).map(\.id).joined(separator: ","), "m_short")
        expect("memory rows: forgotten lists the tombstoned", MemoryFormat.rows(items, state: .forgotten, query: "", cap: 30).map(\.id).joined(separator: ","), "m_light")
        // The search branch keeps the daemon's ranking: a semantic hit lacks the words and still lists, first.
        let office = items.first { $0.id == "m_office" }!, light = items.first { $0.id == "m_light" }!
        expect("memory hits: the daemon's order kept, not re-sorted by recency", MemoryFormat.hits([office, extracted], state: .live, cap: 30).map(\.id).joined(separator: ","), "m_office,m_kev")
        expect("memory hits: only the segment's state", MemoryFormat.hits([office, light, extracted], state: .live, cap: 30).map(\.id).joined(separator: ","), "m_office,m_kev")
        expect("memory hits: capped from the top", MemoryFormat.hits([office, extracted, pref], state: .live, cap: 2).map(\.id).joined(separator: ","), "m_office,m_kev")
        let theme = fake.memorySearch("theme", limit: 60) ?? []
        expect("memory search → rail: a hit without the query's words survives", MemoryFormat.hits(theme, state: .live, cap: 30).map(\.id).joined(separator: ","), "m_dark")
        expect("memory search → rail: that hit's text lacks the query", theme.first.map { $0.text.lowercased().contains("theme") || $0.subjects.contains { $0.contains("theme") } ? "carries it" : "lacks it" } ?? "nil", "lacks it")
        // "work": the office (a meaning, no words in common; seen 6 d ago) ranks above gt (a substring
        // hit in its subjects; seen 4 d ago) — a recency re-sort would flip them, a grep would drop the first.
        let work = fake.memorySearch("work", limit: 60) ?? []
        expect("memory search → rail: ranking first, then substring hits, none re-sorted", MemoryFormat.hits(work, state: .live, cap: 30).map(\.id).joined(separator: ","), "m_office,m_gt")
        expect("memory used: the ids in the brain's order, unknown skipped", MemoryFormat.used(["m_short", "m_nope", "m_kev"], in: items).map(\.id).joined(separator: ","), "m_short,m_kev")
        expect("memory list handler: live, capped", String(fake.memoryList(state: "live", limit: 2)?.count ?? -1), "2")
        expect("memory list handler: all", String(fake.memoryList(state: "all", limit: 50)?.count ?? -1), String(items.count))
        expect("memory search handler: live only", fake.memorySearch("mode", limit: 30)?.map(\.id).joined(separator: ",") ?? "nil", "m_dark")
        // Now › Memory · used this turn: hidden when memory is off, whatever ids the summary still names.
        var off = fake.memorySummary(); off.enabled = false
        expect("used this turn: memory on lists the ids", NowPanel.usedIds(fake.memorySummary()).joined(separator: ","), "m_short,m_kev,m_diff")
        expect("used this turn: memory off hides them", NowPanel.usedIds(off).joined(separator: ","), "")
        expect("used this turn: no summary, nothing", NowPanel.usedIds(nil).joined(separator: ","), "")
        let summary = fake.memorySummary()
        expect("memory counts", ConsoleTheme.memoryCounts(summary), "7 live · 1 forgotten · 1 archived")
        expect("memory matching: openai", ConsoleTheme.memoryMatching(summary), "OpenAI · 512 dims")
        var keyword = summary; keyword.embeddings = "keyword"
        expect("memory matching: keyword", ConsoleTheme.memoryMatching(keyword), "keyword · nothing leaves")
        expect("learned line: ago", SettingsPanel.learnedLine(summary, now: fake.now), "learned 12m ago")
        var fresh = summary; fresh.lastRunAt = nil; fresh.pending = 0
        expect("learned line: not yet", SettingsPanel.learnedLine(fresh, now: fake.now), "not learned yet")
        expect("hidden counts line", SettingsPanel.hiddenCountsLine(summary), "1 forgotten · 1 archived")
        fresh.pending = 2
        expect("pending line", SettingsPanel.pendingLine(fresh), "2 waiting")
        expect("last run line", summary.lastRun.map(SettingsPanel.lastRunLine) ?? "nil", "responses · +3 · ~1 · 4 same · 1 refused · 1.8 s")
        expect("memory state words", [MemoryState.live, .forgotten, .merged, .archived].map(ConsoleTheme.memoryStateLabel).joined(separator: ","), "Live,Forgotten,Merged,Archived")
        // Never the verb: the hint says "nothing is deleted" on purpose; no control offers "Delete".
        expect("no Console string offers the verb Delete", [ConsoleTheme.memoryForgetHint, ConsoleTheme.memoryBudgetHint, ConsoleTheme.languageHint].contains { $0.contains("Delete") } ? "offers it" : "never", "never")
        expect("the forget hint says nothing is deleted", ConsoleTheme.memoryForgetHint.contains("nothing is deleted") ? "says so" : "silent", "says so")
        expect("the forget hint", ConsoleTheme.memoryForgetHint, "Forget hides it from Jarhead; Jarhead's own record keeps it (nothing is deleted).")
        // Every symbol this pass draws exists on this macOS.
        let symbols = MemoryKind.allCases.map(ConsoleTheme.memorySymbol) + ["stop.circle.fill", "magnifyingglass", "ellipsis"]
        let missing = symbols.filter { NSImage(systemSymbolName: $0, accessibilityDescription: nil) == nil }
        expect("SF symbols exist", missing.isEmpty ? "all \(symbols.count)" : "missing \(missing.joined(separator: ","))", "all \(symbols.count)")
        expect("memory kinds have distinct symbols", String(Set(MemoryKind.allCases.map(ConsoleTheme.memorySymbol)).count), String(MemoryKind.allCases.count))
        // The status table: ended settles grey with the stop symbol, never live.
        let ended = ConsoleTheme.status(.ended)
        expect("status(.ended): stop symbol, not live", "\(ended.symbol ?? "dot") \(ended.live)", "stop.circle.fill false")
        // The wire: opens and closes name the viewer.
        let open = EngineCommand.agentOpenAs(agentId: "sessions:codex:1", viewer: "pane-1").json
        expect("agent.open names its viewer", "\(open["type"] as? String ?? "") \(open["viewer"] as? String ?? "")", "agent.open pane-1")
        expect("voice.reopen on the wire", EngineCommand.voiceReopen.json["type"] as? String ?? "", "voice.reopen")
        expect("memory.forget on the wire", "\(EngineCommand.memoryForget(id: "m_1").json["type"] as? String ?? "") \(EngineCommand.memoryForget(id: "m_1").json["id"] as? String ?? "")", "memory.forget m_1")
        let edit = EngineCommand.memoryEdit(id: "m_1", text: "Kevin prefers tea", kind: nil).json
        expect("memory.edit without a kind sends none", edit["kind"] == nil ? "no kind" : "kind", "no kind")
        expect("settings patch carries memory/accent/language", SettingsPatch(language: "en", accent: "british", memory: false).json.keys.sorted().joined(separator: ","), "accent,language,memory")
        print("check: \(failed == 0 ? "all ok" : "\(failed) FAILED") (durability) at \(stamp)s")
    }

    /// `check-threads`: the pure words behind the Threads pass, each named and compared (run.log:
    /// `check: ok` / `check: FAIL`) — the package has no test target, so this is where they are
    /// pinned. The rail's order and glyphs; ThreadStore's paging (a step patches its card, a re-send
    /// upserts, a trimmed seq is skipped, 450 appends keep 400, a prepend raises the cap by its page);
    /// AppState's event and snapshot merges (a stale seq dropped, an unknown thread dropped, a fresher
    /// local record kept, a live thread the snapshot forgot settles failed, the linger prune); the
    /// pending echo (added once, dropped by the real turn); the typed glyph; the composer's words and
    /// kept text while asleep; the key table; the wire shape of the thread commands; that Return is
    /// never a yes; the ledger's thread rows; every symbol exists.
    private func checkThreadWords(stamp: String) {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        let fake = self.fake ?? FakeData(shot: "preview.png")
        let t0 = fake.splitAt

        // The rail's order: waiting on Kevin, then the busy ones, then the idle main, then the finished.
        let all = fake.threads()
        expect("rail order: waiting-kevin → busy → idle main → finished", AppState.railOrder(all).map(\.id).joined(separator: ","), "\(FakeData.slackId),\(FakeData.spotifyId),main,\(FakeData.notesId)")
        expect("rail order: two busy by startedAt, newest first",
               AppState.railOrder([fake.thread(FakeData.spotifyId, status: .acting, startedAt: t0 + 100), fake.thread("t_b", status: .thinking, startedAt: t0 + 900)]).map(\.id).joined(separator: ","), "t_b,\(FakeData.spotifyId)")
        expect("rail rank: paused and queued are busy", "\(AppState.railRank(.paused))\(AppState.railRank(.queued))\(AppState.railRank(.waitingScreen))", "111")
        let statuses: [ThreadStatus] = [.idle, .queued, .starting, .thinking, .acting, .waitingScreen, .waitingKevin, .paused, .done, .failed, .stopped]
        expect("status words", statuses.map(\.words).joined(separator: ", "), "idle, queued, starting, thinking, acting, waiting for the screen, waiting for Kevin, paused, done, failed, stopped")
        expect("isLive", statuses.map { $0.isLive ? "1" : "0" }.joined(), "11111111000")
        expect("isBusy (idle is live, not busy)", statuses.map { $0.isBusy ? "1" : "0" }.joined(), "01111111000")
        expect("glyphs: dots while idle/queued/starting/thinking/acting, symbols for the waits, paused and the ends",
               statuses.map { ConsoleTheme.thread($0).dot ? ($0 == .idle || $0 == .queued ? "dot" : "pulse") : ConsoleTheme.thread($0).symbol }.joined(separator: ","),
               "dot,dot,pulse,pulse,pulse,hourglass.tophalf.filled,hand.raised.fill,pause.fill,checkmark.circle.fill,xmark.octagon.fill,slash.circle.fill")
        let slack = all.first { $0.id == FakeData.slackId }!
        expect("thread meta ticks", ConsoleFormat.threadMeta(slack, now: slack.startedAt + 12_400), "00:12 · screen · 4 steps")
        var main = all.first { $0.id == "main" }!
        expect("main idle meta has no step count", ConsoleFormat.threadMeta(main, now: main.startedAt + 12_000), "00:12 · voice")
        main.steps = 1
        expect("one step is singular", ConsoleFormat.threadMeta(main, now: main.startedAt + 1_000), "00:01 · voice · 1 step")
        let notes = all.first { $0.id == FakeData.notesId }!
        expect("finished meta frozen at doneAt", ConsoleFormat.threadMeta(notes, now: 9_999_999_999_999), "00:03 · background · 3 steps")
        expect("threads head count", ConsoleFormat.threadsCount(total: 4, busy: 2), "4 · 2 running")
        expect("threads head count, none busy", ConsoleFormat.threadsCount(total: 1, busy: 0), "1")

        // ThreadStore: a page, then the deltas.
        var store = ThreadStore(page: fake.threadTranscript(FakeData.slackId))
        let cardBefore = store.entries.first { $0.kind == "delegation" }?.delegation
        // Five entries on the page; the step and the status fold into the card: three rows held.
        expect("store: page held, its step and status folded into the card", "\(store.entries.count) total=\(store.total) complete=\(store.complete) live=\(store.live)", "3 total=5 complete=true live=true")
        expect("store: the confirm step is the card's last (patched in from the page)", cardBefore?.steps.last?.kind.rawValue ?? "nil", "confirm")
        expect("store: card status from the page's status entry", cardBefore?.status.rawValue ?? "nil", "awaiting-confirmation")
        let delId = cardBefore?.id ?? "?"
        let stepEntry = ThreadEntry(kind: "step", seq: 9, delegationId: delId, step: DelegationStep(id: "sl-new", at: t0 + 9_000, kind: .note, text: "Kevin allowed · typed", tool: nil, screenshotPath: nil))
        store.append(ThreadTranscript(threadId: FakeData.slackId, entries: [stepEntry], total: 5, complete: true, live: true, cursor: ThreadTranscript.Cursor(startSeq: 9, endSeq: 9)))
        let cardAfter = store.entries.first { $0.kind == "delegation" }?.delegation
        expect("store: a step patches its card, adds no row", "\(store.entries.count) steps=\(cardAfter?.steps.count ?? -1) last=\(cardAfter?.steps.last?.id ?? "nil")", "3 steps=\(cardBefore!.steps.count + 1) last=sl-new")
        expect("store: cursor widened by the append", "\(store.cursor?.startSeq ?? -1)…\(store.cursor?.endSeq ?? -1)", "1…9")
        store.append(ThreadTranscript(threadId: FakeData.slackId, entries: [stepEntry], total: 5, complete: true, live: true))
        expect("store: the same step re-sent upserts, does not double", String(store.entries.first { $0.kind == "delegation" }?.delegation?.steps.count ?? -1), String(cardBefore!.steps.count + 1))
        let statusEntry = ThreadEntry(kind: "status", seq: 10, delegationId: delId, status: .done, summary: "sent to Ben", timings: cardBefore!.timings)
        store.append(ThreadTranscript(threadId: FakeData.slackId, entries: [statusEntry], total: 6, complete: true, live: true))
        expect("store: a status patches the card's end", "\(store.entries.first { $0.kind == "delegation" }?.delegation?.status.rawValue ?? "nil") · \(store.entries.first { $0.kind == "delegation" }?.delegation?.summary ?? "nil")", "done · sent to Ben")
        let orphan = ThreadEntry(kind: "step", seq: 11, delegationId: "del_unknown", step: DelegationStep(id: "o1", at: t0, kind: .tool, text: nil, tool: ToolStep(name: "applescript", input: nil, output: nil, ok: true, ms: 12), screenshotPath: nil))
        store.append(ThreadTranscript(threadId: FakeData.slackId, entries: [orphan], total: 7, complete: true, live: true))
        expect("store: a step whose card is not held stays a row", "\(store.entries.count) last=\(store.entries.last?.kind ?? "nil")", "4 last=step")
        expect("entries: the orphan reads as one quiet line", ThreadEntries.build(store).last.map { if case .system(let s) = $0 { return "\(s.id) \(s.symbol) \(s.text)" } else { return "other" } } ?? "nil", "tstep:11 terminal.fill applescript · ok · 12 ms")
        expect("entries: kinds map to rows", ThreadEntries.build(store).map { switch $0 { case .utterance: return "u"; case .delegation: return "d"; case .system: return "s" } }.joined(), "sdus")
        // The cap: 450 appended rows keep the newest 400, the oldest seqs are remembered as trimmed.
        var big = ThreadStore(page: ThreadTranscript(threadId: "t_big", entries: [], total: 0, complete: true, live: true))
        for i in 1...450 {
            big.append(ThreadTranscript(threadId: "t_big", entries: [ThreadEntry(kind: "utterance", seq: i, item: TranscriptItem(id: "u\(i)", speaker: .jarhead, text: "line \(i)", startMs: 0, endMs: 0, at: Double(i), final: true))], total: i, complete: false, live: true))
        }
        expect("store: 450 appends keep 400", "\(big.entries.count) first=\(big.startSeq ?? -1) last=\(big.endSeq ?? -1) complete=\(big.complete)", "400 first=51 last=450 complete=false")
        big.append(ThreadTranscript(threadId: "t_big", entries: [ThreadEntry(kind: "utterance", seq: 3, item: TranscriptItem(id: "u3", speaker: .jarhead, text: "edited", startMs: 0, endMs: 0, at: 3, final: true))], total: 450, complete: false, live: true))
        expect("store: a trimmed seq re-sent is skipped, not the newest row", "\(big.entries.count) last=\(big.endSeq ?? -1)", "400 last=450")
        expect("store: position(of:) for a held seq and a trimmed one", "\(big.position(of: 51) ?? -1),\(big.position(of: 450) ?? -1),\(big.position(of: 3) ?? -1)", "0,399,-1")
        let older = (41...50).map { ThreadEntry(kind: "utterance", seq: $0, item: TranscriptItem(id: "u\($0)", speaker: .jarhead, text: "line \($0)", startMs: 0, endMs: 0, at: Double($0), final: true)) }
        big.prepend(ThreadTranscript(threadId: "t_big", entries: older + [older[0]], total: 450, complete: false, live: true, cursor: ThreadTranscript.Cursor(startSeq: 41, endSeq: 50)))
        expect("store: a prepend adds what is not held, once, in front, and raises the cap", "\(big.entries.count) first=\(big.startSeq ?? -1) loaded=\(big.prependedCount) pos41=\(big.position(of: 41) ?? -1) pos51=\(big.position(of: 51) ?? -1)", "410 first=41 loaded=10 pos41=0 pos51=10")
        big.append(ThreadTranscript(threadId: "t_big", entries: [ThreadEntry(kind: "utterance", seq: 451, item: TranscriptItem(id: "u451", speaker: .jarhead, text: "line 451", startMs: 0, endMs: 0, at: 451, final: true))], total: 451, complete: false, live: true))
        expect("store: past the raised cap the window slides one from the front", "\(big.entries.count) first=\(big.startSeq ?? -1) last=\(big.endSeq ?? -1)", "410 first=42 last=451")
        // A trimmed card's steps no longer patch anything (the map forgot it).
        var cards = ThreadStore(page: ThreadTranscript(threadId: "t_cards", entries: [], total: 0, complete: true, live: true))
        for i in 1...401 {
            let d = Delegation(id: "d\(i)", liveId: "l", createdAt: Double(i), offsetMs: 0, request: "r\(i)", status: .running, steps: [], summary: nil, timings: DelegationTimings(delegatedAt: Double(i)))
            cards.append(ThreadTranscript(threadId: "t_cards", entries: [ThreadEntry(kind: "delegation", seq: i, delegation: d)], total: i, complete: false, live: true))
        }
        expect("store: a trimmed card leaves the delegation map", "\(cards.position(ofDelegation: "d1") ?? -1),\(cards.position(ofDelegation: "d2") ?? -1),\(cards.position(ofDelegation: "d401") ?? -1)", "-1,0,399")

        // AppState: events and the snapshot.
        let st = AppState()
        let sp = fake.thread(FakeData.spotifyId, status: .acting, startedAt: t0)
        st.applyThreadEvent(ThreadEvent(seq: 1, at: t0, threadId: sp.id, kind: "started", thread: sp))
        expect("event started: held and ordered", "\(st.threads[sp.id]?.name ?? "nil") \(st.threadOrder.joined(separator: ","))", "Spotify \(sp.id)")
        st.applyThreadEvent(ThreadEvent(seq: 2, at: t0 + 100, threadId: sp.id, kind: "step", steps: 3, tool: "applescript", ok: true))
        expect("event step: steps and detail", "\(st.threads[sp.id]?.steps ?? -1) \(st.threads[sp.id]?.detail ?? "nil")", "3 applescript")
        st.applyThreadEvent(ThreadEvent(seq: 3, at: t0 + 200, threadId: sp.id, kind: "question", question: "send it?"))
        expect("event question: waiting-kevin with the question", "\(st.threads[sp.id]?.status.rawValue ?? "nil") \(st.threads[sp.id]?.question ?? "nil")", "waiting-kevin send it?")
        st.applyThreadEvent(ThreadEvent(seq: 2, at: t0 + 300, threadId: sp.id, kind: "status", status: .thinking))
        expect("event with a stale seq is dropped", st.threads[sp.id]?.status.rawValue ?? "nil", "waiting-kevin")
        st.applyThreadEvent(ThreadEvent(seq: 4, at: t0 + 400, threadId: sp.id, kind: "status", status: .acting))
        expect("event status clears the question when not waiting", "\(st.threads[sp.id]?.status.rawValue ?? "nil") q=\(st.threads[sp.id]?.question ?? "nil")", "acting q=nil")
        st.applyThreadEvent(ThreadEvent(seq: 5, at: t0 + 500, threadId: "t_ghost", kind: "status", status: .acting))
        expect("event for an unknown thread is dropped", String(st.threads.count), "1")
        st.applyThreadEvent(ThreadEvent(seq: 6, at: t0 + 600, threadId: sp.id, kind: "at", x: 100, y: 200, app: "Spotify"))
        expect("event at: the point and the app", "\(Int(st.threads[sp.id]?.at?.x ?? -1)),\(Int(st.threads[sp.id]?.at?.y ?? -1)) \(st.threads[sp.id]?.app ?? "nil") \(st.threads[sp.id]?.apps.joined(separator: "+") ?? "")", "100,200 Spotify Spotify")
        st.applyThreadEvent(ThreadEvent(seq: 7, at: t0 + 700, threadId: sp.id, kind: "ended", status: .done, summary: "playing Focus"))
        expect("event ended: settled, no say / stop", "\(st.threads[sp.id]?.status.rawValue ?? "nil") done=\(st.threads[sp.id]?.doneAt == t0 + 700) canSay=\(st.threads[sp.id]?.canSay ?? true) canStop=\(st.threads[sp.id]?.canStop ?? true) detail=\(st.threads[sp.id]?.detail ?? "")", "done done=true canSay=false canStop=false detail=playing Focus")
        let fresher = fake.thread(FakeData.slackId, status: .waitingKevin, startedAt: t0)
        st.applyThreadEvent(ThreadEvent(seq: 8, at: t0 + 800, threadId: fresher.id, kind: "started", thread: fresher))
        st.applyThreadEvent(ThreadEvent(seq: 9, at: t0 + 5_000, threadId: fresher.id, kind: "status", status: .acting, detail: "typing"))
        var staleSlack = fresher; staleSlack.updatedAt = t0 + 900
        let live = fake.thread("t_live", status: .thinking, startedAt: t0 + 50)
        st.applyThreadEvent(ThreadEvent(seq: 10, at: t0 + 1_000, threadId: live.id, kind: "started", thread: live))
        // The snapshot's copy of Spotify as the table would carry it after the `ended` event: done,
        // with that event's clock (a snapshot never lists an older state with a newer updatedAt).
        var spDone = sp; spDone.status = .done; spDone.doneAt = t0 + 700; spDone.updatedAt = t0 + 700; spDone.canSay = false; spDone.canStop = false
        // A snapshot lists t_live once (a thread snapshots know), then the next has dropped it while live.
        st.applySnapshotThreads([staleSlack, spDone, live])
        expect("snapshot: a thread known only from its event stays as it was until a snapshot lists it", "\(st.threads[live.id]?.status.rawValue ?? "nil")", "thinking")
        st.applySnapshotThreads([staleSlack, spDone])
        expect("snapshot: a fresher local record is kept", "\(st.threads[fresher.id]?.status.rawValue ?? "nil") \(st.threads[fresher.id]?.detail ?? "nil")", "acting typing")
        expect("snapshot: a live thread it listed and then forgot settles failed, its clock untouched",
               "\(st.threads[live.id]?.status.rawValue ?? "nil") \(st.threads[live.id]?.detail ?? "nil") clock=\(st.threads[live.id]?.updatedAt == live.updatedAt) canStop=\(st.threads[live.id]?.canStop ?? true)", "failed gone from the engine clock=true canStop=false")
        expect("snapshot: a finished thread it no longer lists stays for the linger", String(st.threads[sp.id] != nil), "true")
        expect("orderedThreads", st.orderedThreads.map(\.id).joined(separator: ","), "\(fresher.id),\(live.id),\(sp.id)")

        // The spawn race (the reviewer's probe): EngineClient parks a snapshot up to 33 ms while a
        // `started` event lands at once, so a snapshot built BEFORE the spawn is applied AFTER it.
        let race = AppState()
        var mainRec = fake.thread("main", status: .acting, startedAt: t0 - 60_000); mainRec.updatedAt = t0
        race.applySnapshotThreads([mainRec])
        var spawned = fake.thread(FakeData.spotifyId, status: .starting, startedAt: t0 + 10); spawned.updatedAt = t0 + 10
        race.applyThreadEvent(ThreadEvent(seq: 7, at: t0 + 10, threadId: spawned.id, kind: "started", thread: spawned))
        race.applySnapshotThreads([mainRec])
        expect("spawn race: a snapshot that predates the thread leaves it live and stoppable",
               "\(race.threads[spawned.id]?.status.rawValue ?? "nil") canStop=\(race.threads[spawned.id]?.canStop ?? false) detail=\(race.threads[spawned.id]?.detail ?? "nil")", "starting canStop=true detail=applescript")
        var spawnedLive = spawned; spawnedLive.status = .acting; spawnedLive.updatedAt = t0 + 400
        race.applySnapshotThreads([mainRec, spawnedLive])
        expect("spawn race: the next snapshot lists it live", "\(race.threads[spawned.id]?.status.rawValue ?? "nil") canStop=\(race.threads[spawned.id]?.canStop ?? false)", "acting canStop=true")
        race.applySnapshotThreads([mainRec])
        expect("gone: listed once, then dropped while live → failed, clock kept",
               "\(race.threads[spawned.id]?.status.rawValue ?? "nil") \(race.threads[spawned.id]?.detail ?? "nil") clock=\(race.threads[spawned.id]?.updatedAt == t0 + 400)", "failed gone from the engine clock=true")
        race.applySnapshotThreads([mainRec, spawnedLive])
        expect("gone heals: a listing wins over our guess whatever its clock", "\(race.threads[spawned.id]?.status.rawValue ?? "nil") canStop=\(race.threads[spawned.id]?.canStop ?? false) detail=\(race.threads[spawned.id]?.detail ?? "nil")", "acting canStop=true detail=applescript")
        race.applyThreadEvent(ThreadEvent(seq: 8, at: t0 + 400, threadId: spawned.id, kind: "ended", status: .done, summary: "playing Focus"))
        race.applySnapshotThreads([mainRec, spawnedLive])
        expect("an end never un-ends: a parked snapshot on the same clock leaves the ended record", "\(race.threads[spawned.id]?.status.rawValue ?? "nil") canStop=\(race.threads[spawned.id]?.canStop ?? true)", "done canStop=false")
        // A daemon restart: the new process numbers its events from 1; main keeps its id with a new startedAt.
        race.applyThreadEvent(ThreadEvent(seq: 5_000, at: t0 + 500, threadId: "main", kind: "status", status: .thinking))
        var mainAgain = mainRec; mainAgain.startedAt = t0 + 10_000; mainAgain.updatedAt = t0 + 10_000; mainAgain.status = .idle
        race.applySnapshotThreads([mainAgain])
        race.applyThreadEvent(ThreadEvent(seq: 3, at: t0 + 10_500, threadId: "main", kind: "question", question: "send it?"))
        expect("restart: a record with a new startedAt resets the seq guard, so main's low-seq event lands", "\(race.threads["main"]?.question ?? "nil") \(race.threads["main"]?.status.rawValue ?? "nil")", "send it? waiting-kevin")
        race.applyThreadEvent(ThreadEvent(seq: 900, at: t0 + 11_000, threadId: "main", kind: "status", status: .acting))
        race.noteDaemonHello()
        race.applyThreadEvent(ThreadEvent(seq: 1, at: t0 + 11_100, threadId: "main", kind: "status", status: .thinking, detail: "after hello"))
        expect("hello: the seq guard starts over with the daemon", "\(race.threads["main"]?.status.rawValue ?? "nil") \(race.threads["main"]?.detail ?? "nil")", "thinking after hello")
        race.applyThreadEvent(ThreadEvent(seq: 1, at: t0 + 11_200, threadId: "main", kind: "status", status: .acting))
        expect("hello: after it the guard holds again", race.threads["main"]?.status.rawValue ?? "nil", "thinking")
        st.pruneThreads(now: t0 + 700 + AppState.threadLingerMs - 1)
        expect("prune: inside the linger, kept", String(st.threads[sp.id] != nil), "true")
        st.heldThreadIds = [sp.id]
        st.pruneThreads(now: t0 + 700 + AppState.threadLingerMs + 1)
        expect("prune: past the linger but held (on screen), kept", String(st.threads[sp.id] != nil), "true")
        st.heldThreadIds = []
        st.pruneThreads(now: t0 + 700 + AppState.threadLingerMs + 1)
        expect("prune: past the linger, gone from threads and the order", "\(st.threads[sp.id] == nil) \(st.threadOrder.contains(sp.id))", "true false")
        st.applyThreadTranscript(fake.threadTranscript(FakeData.slackId), mode: "replace")
        st.applyThreadTranscript(ThreadTranscript(threadId: FakeData.slackId, entries: [stepEntry], total: 5, complete: true, live: true), mode: "append")
        expect("applyThreadTranscript append patches the held card", String(st.threadStores[FakeData.slackId]?.entries.first { $0.kind == "delegation" }?.delegation?.steps.last?.id ?? "nil"), "sl-new")
        st.applyThreadTranscript(ThreadTranscript(threadId: "t_x", entries: [], total: 0, complete: true, live: false), mode: "append")
        expect("applyThreadTranscript append with nothing held is a page", String(st.threadStores["t_x"] != nil), "true")
        for i in 0..<10 { st.applyThreadTranscript(ThreadTranscript(threadId: "t_lru\(i)", entries: [], total: 0, complete: true, live: false), mode: "replace") }
        st.evictThreadStores(keep: [FakeData.slackId])
        expect("evict: the kept one and the newest 8 opened stay", "\(st.threadStores[FakeData.slackId] != nil) \(st.threadStores["t_lru9"] != nil) \(st.threadStores["t_lru1"] != nil) \(st.threadStores["t_x"] != nil)", "true true false false")

        // The pending echo.
        let echoState = AppState()
        let agentId = "sessions:claude:w1p2"
        echoState.applyTranscript(fake.transcripts()[agentId]!, mode: "replace")
        let heldBefore = echoState.transcripts[agentId]?.messages.count ?? -1
        echoState.echoPendingSend(agentId: agentId, text: "yes please", at: t0)
        echoState.echoPendingSend(agentId: agentId, text: "yes please ", at: t0 + 1)
        expect("echo: one pending row for two sends of the same words", "\(echoState.transcripts[agentId]?.messages.count ?? -1) pending=\(echoState.transcripts[agentId]?.messages.filter { $0.pending == true }.count ?? -1)", "\(heldBefore + 1) pending=1")
        expect("echo: the row is Kevin's, pending, indexed", "\(echoState.transcripts[agentId]?.messages.last?.role.rawValue ?? "nil") \(echoState.transcripts[agentId]?.messages.last?.pending == true) \(echoState.messageIndex(agentId: agentId, id: echoState.transcripts[agentId]?.messages.last?.id ?? "") ?? -1)", "user true \(heldBefore)")
        echoState.applyTranscript(AgentTranscript(agentId: agentId, messages: [AgentMessage(id: "pending:engine-1", role: .user, text: "yes please", at: t0 + 2, tool: nil, thinking: nil, pending: true)], total: 0, complete: false, live: true), mode: "append")
        expect("echo: the engine's own echo with the same words folds in", String(echoState.transcripts[agentId]?.messages.filter { $0.pending == true }.count ?? -1), "1")
        echoState.applyTranscript(AgentTranscript(agentId: agentId, messages: [AgentMessage(id: "c10", role: .user, text: "yes please", at: t0 + 3, tool: nil, thinking: nil)], total: 63, complete: false, live: true), mode: "append")
        expect("echo: the real user turn drops it", "\(echoState.transcripts[agentId]?.messages.count ?? -1) pending=\(echoState.transcripts[agentId]?.messages.filter { $0.pending == true }.count ?? -1) last=\(echoState.transcripts[agentId]?.messages.last?.id ?? "nil")", "\(heldBefore + 1) pending=0 last=c10")
        expect("echo: the index follows the drop", String(echoState.messageIndex(agentId: agentId, id: "c10") ?? -1), String(heldBefore))
        echoState.echoPendingSend(agentId: agentId, text: "and the other thing", at: t0 + 4)
        echoState.applyTranscript(AgentTranscript(agentId: agentId, messages: [AgentMessage(id: "c11", role: .user, text: "something else", at: t0 + 5, tool: nil, thinking: nil)], total: 64, complete: false, live: true), mode: "append")
        expect("echo: a different real turn leaves the echo pending", String(echoState.transcripts[agentId]?.messages.filter { $0.pending == true }.count ?? -1), "1")
        echoState.echoPendingSend(agentId: "sessions:nobody", text: "hi", at: t0)
        expect("echo: no conversation held, nothing to show", String(echoState.transcripts["sessions:nobody"] == nil), "true")
        expect("echo: stale after 20 s", String(AppState.pendingEchoStaleMs), "20000.0")

        // The typed row, the composer, the confirm rule, the keys.
        let typed = fake.typedTranscript()[0]
        expect("typed row draws keyboard.fill", UtteranceRow.symbol(for: typed), "keyboard.fill")
        expect("spoken row draws person.fill", UtteranceRow.symbol(for: fake.transcript()[0]), "person.fill")
        expect("Jarhead's row draws the waveform", UtteranceRow.symbol(for: fake.transcript()[1]), "waveform")
        expect("composer asleep, typed wakes off", ComposerBar.placeholder(phase: .asleep, typedWakes: false), "Type to Jarhead… (asleep: press Go)")
        expect("composer asleep, typed wakes on (Kevin's word)", ComposerBar.placeholder(phase: .asleep, typedWakes: true), "Type to wake Jarhead…")
        expect("composer in session", ComposerBar.placeholder(phase: .listening, typedWakes: false), "Say something…")
        expect("composer paused", ComposerBar.placeholder(phase: .paused, typedWakes: false), "Paused — press Go or type to resume")
        expect("composer keeps the words while asleep (the engine refuses)", "\(ComposerBar.keepsText(phase: .asleep, typedWakes: false))\(ComposerBar.keepsText(phase: .error, typedWakes: false))\(ComposerBar.keepsText(phase: .asleep, typedWakes: true))\(ComposerBar.keepsText(phase: .listening, typedWakes: false))", "truetruefalsefalse")
        expect("Return is never a yes (ConsoleConfirm)", String(ConsoleConfirm.returnIsAYes), "false")
        expect("key ⌘0 → Now", String(ConsoleWindow.command(flags: .command, chars: "0") == .showNow), "true")
        expect("key ⌘⇧] (both spellings) → next thread", "\(ConsoleWindow.command(flags: [.command, .shift], chars: "}") == .nextThread) \(ConsoleWindow.command(flags: [.command, .shift], chars: "]") == .nextThread)", "true true")
        expect("key ⌘⇧[ → previous thread", "\(ConsoleWindow.command(flags: [.command, .shift], chars: "{") == .prevThread) \(ConsoleWindow.command(flags: [.command, .shift], chars: "[") == .prevThread)", "true true")
        expect("key ⌥⌘. → stop this thread", String(ConsoleWindow.command(flags: [.command, .option], chars: ".") == .stopThread), "true")
        expect("key ⌘. stays Stop everything", String(ConsoleWindow.command(flags: .command, chars: ".") == .stop), "true")
        expect("key ⌘⇧. is nothing", String(ConsoleWindow.command(flags: [.command, .shift], chars: ".") == nil), "true")
        let walk = ConsoleSession()
        let order = ["a", "b", "c"]
        walk.stepThread(by: 1, order: order); let s1 = walk.openThreadId ?? "now"
        walk.stepThread(by: 1, order: order); let s2 = walk.openThreadId ?? "now"
        walk.stepThread(by: 1, order: order); walk.stepThread(by: 1, order: order); let s4 = walk.openThreadId ?? "now"
        walk.stepThread(by: -1, order: order); let s5 = walk.openThreadId ?? "now"
        walk.stepThread(by: -1, order: order); walk.stepThread(by: -1, order: order); walk.stepThread(by: -1, order: order); let s8 = walk.openThreadId ?? "now"
        expect("⌘⇧] walks Now → a → b → c → Now; ⌘⇧[ from Now is the last", "\(s1) \(s2) \(s4) \(s5) \(s8)", "a b now c now")
        walk.openAgentId = "x"
        expect("an agent opening clears the thread", "\(walk.openThreadId ?? "nil") \(walk.openAgentId ?? "nil")", "nil x")
        walk.openThread("a")
        expect("a thread opening clears the agent, showsNow false", "\(walk.openAgentId ?? "nil") \(walk.openThreadId ?? "nil") \(walk.showsNow)", "nil a false")
        walk.showNow()
        expect("showNow clears the thread", "\(walk.openThreadId ?? "nil") \(walk.showsNow)", "nil true")

        // The wire.
        let answer = EngineCommand.threadAnswer(threadId: FakeData.slackId, yes: true).json
        expect("thread.answer on the wire", "\(answer["type"] as? String ?? "") \(answer["threadId"] as? String ?? "") \(answer["yes"] as? Bool ?? false)", "thread.answer \(FakeData.slackId) true")
        let open = EngineCommand.threadOpen(threadId: "main", viewer: "pane-1").json
        expect("thread.open names its viewer", "\(open["type"] as? String ?? "") \(open["threadId"] as? String ?? "") \(open["viewer"] as? String ?? "")", "thread.open main pane-1")
        let history = EngineCommand.threadHistory(threadId: "main", before: 41).json
        expect("thread.history before a seq", "\(history["type"] as? String ?? "") \(history["before"] as? Int ?? -1)", "thread.history 41")
        let say = EngineCommand.threadSay(threadId: FakeData.spotifyId, text: "skip this song").json
        expect("thread.say on the wire", "\(say["type"] as? String ?? "") \(say["text"] as? String ?? "")", "thread.say skip this song")
        expect("thread.stop / pause / resume", [EngineCommand.threadStop(threadId: "a"), .threadPause(threadId: "a"), .threadResume(threadId: "a")].map { $0.json["type"] as? String ?? "" }.joined(separator: ","), "thread.stop,thread.pause,thread.resume")
        expect("remedy thread.stop decodes", String(EngineCommand(remedyJSON: ["type": .string("thread.stop"), "threadId": .string("t_1")]) == .threadStop(threadId: "t_1")), "true")
        expect("remedy thread.stop without an id is nil", String(EngineCommand(remedyJSON: ["type": .string("thread.stop")]) == nil), "true")
        let flags = ConsoleWindow.command(flags: [.command, .option], chars: ".")
        expect("stopThread is not the transport's stop", String(flags != .stop), "true")

        // The ledger's thread rows.
        func row(_ at: Double, _ type: String) -> LedgerRow {
            LedgerRow(at: at, type: type, item: nil, delegation: nil, delegationId: nil, step: nil, status: nil, summary: nil, text: nil, sessionId: nil, reason: nil, usageSeconds: nil, agent: nil)
        }
        var started = row(1_000, "thread.started"); started.thread = fake.thread(FakeData.spotifyId, status: .starting, startedAt: 1_000)
        var status = row(2_000, "thread.status"); status.threadId = FakeData.spotifyId
        var said = row(3_000, "thread.said"); said.threadId = FakeData.spotifyId; said.text = "playing Focus."
        var ended = row(4_000, "thread.ended"); ended.threadId = FakeData.spotifyId; ended.status = .done; ended.steps = 3; ended.seconds = 9; ended.summary = "playing Focus"
        let lines = StreamBuilder.fromLedger([started, status, said, ended]).compactMap { if case .system(let s) = $0 { return "\(s.symbol)|\(s.text)|\(s.mono ?? "-")|\(s.trailing ?? "-")" } else { return nil } }
        expect("fromLedger: a thread's start, its spoken line, its end (the status rows are the log's)", lines.joined(separator: " ; "),
               "square.stack.fill|Spotify · started|background|play the playlist Focus in Spotify ; waveform|Spotify: playing Focus.|-|- ; checkmark.circle.fill|Spotify · done|3 steps · 00:09|playing Focus")
        expect("JarheadLog lists every thread row", JarheadLog.lines([started, status, said, ended]).filter { $0.kind == "thread" }.map(\.text).joined(separator: " ; "),
               "Spotify · started · background · play the playlist Focus in Spotify ; Spotify · status ; Spotify: playing Focus. ; Spotify · done · 3 steps · 00:09 · playing Focus")
        // The wire's "stopped" is no DelegationStatus: the loose row decodes it as the default (running) and the words read stopped.
        var stopped = ended; stopped.status = .running
        expect("thread.ended stopped (decoded as the default) reads stopped", ConsoleFormat.tombstone(stopped)?.text ?? "nil", "%NAME% · stopped")
        expect("threadEndWords", [DelegationStatus.done, .failed, .cancelled, .running].map(ConsoleFormat.threadEndWords).joined(separator: ","), "done,failed,stopped,stopped")
        // The chips: a card is handed its own threads, in the rail's order.
        let card = StreamEntry.delegation(fake.threadsDelegation())
        expect("a card is handed the threads it started, ordered", card.threads(from: all).map(\.name).joined(separator: ","), "Slack,Spotify,Notes")
        expect("another card is handed none", String(StreamEntry.delegation(fake.doneDelegation()).threads(from: all).count), "0")
        // Every symbol this pass draws exists on this macOS.
        let symbols = statuses.map { ConsoleTheme.thread($0).symbol } + [ConsoleTheme.threadsSymbol, "keyboard.fill", "clock.fill", "square.stack.fill"]
        let missing = symbols.filter { NSImage(systemSymbolName: $0, accessibilityDescription: nil) == nil }
        expect("SF symbols exist", missing.isEmpty ? "all \(symbols.count)" : "missing \(missing.joined(separator: ","))", "all \(symbols.count)")
        expect("no thread string offers the verb Delete", (statuses.map(\.words) + ["Load earlier", "Allow", "Deny", "Stop", "Pause", "Resume"]).contains { $0.contains("Delete") } ? "offers it" : "never", "never")

        // The tombstone's symbol follows its word: a stopped thread never wears the checkmark.
        expect("thread.ended symbols by word", ["done", "failed", "stopped"].map(ConsoleFormat.threadEndSymbol).joined(separator: ","), "checkmark.circle.fill,xmark.octagon.fill,slash.circle.fill")
        expect("a stopped thread's ledger line wears the slash", ConsoleFormat.tombstone(stopped)?.symbol ?? "nil", "slash.circle.fill")
        var failedRow = ended; failedRow.status = .failed
        expect("a failed thread's ledger line wears the octagon", "\(ConsoleFormat.tombstone(failedRow)?.symbol ?? "nil") \(ConsoleFormat.tombstone(failedRow)?.text ?? "nil")", "xmark.octagon.fill %NAME% · failed")

        // ⌥⌘. stops THIS thread: the pane's, main on Now, nothing over an agent or a past conversation.
        expect("⌥⌘. target", [ConsoleWindowController.stopTarget(openThreadId: "t_a", showsNow: false),
                              ConsoleWindowController.stopTarget(openThreadId: nil, showsNow: true),
                              ConsoleWindowController.stopTarget(openThreadId: nil, showsNow: false)].map { $0 ?? "nil" }.joined(separator: ","), "t_a,main,nil")
        // The sidebar and ⌘⇧] leave main to the Now row (the Now row IS the main conversation).
        expect("walk / sidebar order: the spawned threads, never main", ConsoleRootView.walkOrder(["t_a", "main", "t_b"]).joined(separator: ","), "t_a,t_b")
        // A parent card draws each spawned thread as ONE chip (its one strip, ThreadStrip).
        let chipNames = card.threads(from: all).map(\.name)
        expect("one chip per spawned thread under the parent card", "\(chipNames.count) chips, \(Set(chipNames).count) threads", "3 chips, 3 threads")
        expect("voices: 22", String(ConsoleTheme.voices.count), "22")
        expect("voices: ballad first", ConsoleTheme.voices.first ?? "nil", "ballad")
        expect("voices: no repeats", String(Set(ConsoleTheme.voices).count), "22")

        // A page boundary between a card and its steps: the newest page holds the steps as orphan
        // rows; the older page brings the card, which takes them in — once — and the rows leave.
        func orphanRows(_ s: ThreadStore) -> Int {
            ThreadEntries.build(s).filter { if case .system(let sys) = $0 { return sys.id.hasPrefix("tstep:") || sys.id.hasPrefix("tstat:") } else { return false } }.count
        }
        let paged = fake.pagedMain()
        var pagedStore = ThreadStore(page: paged.newest)
        expect("paged: the newest page holds the split card's steps and status as orphan rows",
               "\(pagedStore.entries.count) first=\(pagedStore.startSeq ?? -1) orphans=\(orphanRows(pagedStore)) remaining=\(pagedStore.remaining) complete=\(pagedStore.complete)", "60 first=2 orphans=4 remaining=1 complete=false")
        let olderPage = paged.older(before: pagedStore.startSeq ?? 0)
        expect("paged: the page before seq 2 is the card alone and completes the record", "\(olderPage.entries.count) \(olderPage.entries.first?.kind ?? "nil") complete=\(olderPage.complete)", "1 delegation complete=true")
        pagedStore.prepend(olderPage)
        let pagedCard = pagedStore.entries.first?.delegation
        expect("paged: the card takes its orphans in and the rows leave",
               "\(pagedStore.entries.count) orphans=\(orphanRows(pagedStore)) steps=\(pagedCard?.steps.map(\.id).joined(separator: "+") ?? "nil") status=\(pagedCard?.status.rawValue ?? "nil") summary=\(pagedCard?.summary ?? "nil") folded=\(pagedStore.foldedCount) remaining=\(pagedStore.remaining) complete=\(pagedStore.complete)",
               "57 orphans=0 steps=pg-1+pg-2+pg-3 status=done summary=opened the PR folded=4 remaining=0 complete=true")
        expect("paged: positions renumbered after the fold", "\(pagedStore.position(of: 1) ?? -1),\(pagedStore.position(of: 6) ?? -1),\(pagedStore.position(of: 61) ?? -1),card=\(pagedStore.position(ofDelegation: "del_pag3d") ?? -1),gone=\(pagedStore.position(of: 3) ?? -1)", "0,1,56,card=0,gone=-1")
        pagedStore.prepend(paged.older(before: 2))
        expect("paged: the same page again changes nothing", "\(pagedStore.entries.count) steps=\(pagedStore.entries.first?.delegation?.steps.count ?? -1) folded=\(pagedStore.foldedCount)", "57 steps=3 folded=4")
        // A later delta for that card patches it where it now sits.
        pagedStore.append(ThreadTranscript(threadId: "main", entries: [ThreadEntry(kind: "step", seq: 62, delegationId: "del_pag3d", step: DelegationStep(id: "pg-4", at: t0, kind: .note, text: "late note", tool: nil, screenshotPath: nil))], total: 62, complete: true, live: true))
        expect("paged: a delta after the fold patches the moved card", "\(pagedStore.entries.count) steps=\(pagedStore.entries.first?.delegation?.steps.count ?? -1) remaining=\(pagedStore.remaining)", "57 steps=4 remaining=0")

        // The bytes B2's ThreadLog emits for one page (thread-page-fixture.ts, no ledger), decoded the
        // way EngineClient decodes a `thread.transcript` frame and run through the store.
        struct Frame: Decodable { let type: String; let mode: String; let transcript: ThreadTranscript }
        if let frame = try? JSONDecoder().decode(Frame.self, from: Data(FakeData.engineThreadPageJSON.utf8)) {
            expect("engine page decodes", "\(frame.type) \(frame.mode) \(frame.transcript.entries.count) total=\(frame.transcript.total) complete=\(frame.transcript.complete) cursor=\(frame.transcript.cursor?.startSeq ?? -1)…\(frame.transcript.cursor?.endSeq ?? -1)", "thread.transcript replace 9 total=9 complete=true cursor=1…9")
            let eng = ThreadStore(page: frame.transcript)
            expect("engine page through the store: four rows, five entries folded", "\(eng.entries.count) folded=\(eng.foldedCount) remaining=\(eng.remaining) kinds=\(ThreadEntries.build(eng).map { switch $0 { case .utterance: return "u"; case .delegation: return "d"; case .system: return "s" } }.joined())", "4 folded=5 remaining=0 kinds=sudu")
            let engCard = eng.entries.first { $0.kind == "delegation" }?.delegation
            expect("engine card: the steps in order, the confirm last, awaiting, its thread", "\(engCard?.steps.map(\.kind.rawValue).joined(separator: ",") ?? "nil") \(engCard?.status.rawValue ?? "nil") thread=\(engCard?.threadId ?? "nil") doneAt=\(engCard?.timings.doneAt != nil)", "thinking,tool,screenshot,confirm awaiting-confirmation thread=t_f1xtur3 doneAt=true")
            expect("engine page: the typed utterance draws keyboard.fill", frame.transcript.entries[1].item.map(UtteranceRow.symbol) ?? "nil", "keyboard.fill")
            // A step without a delegationId (no engine writes one; a newer one might): one quiet row, never a loss.
            var loose = frame.transcript.entries[4]; loose.delegationId = nil; loose.seq = 99
            var eng2 = eng
            eng2.append(ThreadTranscript(threadId: frame.transcript.threadId, entries: [loose], total: 10, complete: true, live: true))
            expect("a step with no delegationId is one quiet row", "\(eng2.entries.count) \(ThreadEntries.build(eng2).last.map { if case .system(let s) = $0 { return "\(s.id) \(s.text)" } else { return "other" } } ?? "nil")", "5 tstep:99 open_app · ok · 640 ms")
        } else {
            expect("engine page decodes", "undecodable", "decodable")
        }
        print("check: \(failed == 0 ? "all ok" : "\(failed) FAILED") (threads) at \(stamp)s")
    }

    /// The right rail's scroll view: the one whose width is the rail's.
    /// `Scripts/fixtures/ledger-days.json` (PREVIEW_STATE_DIR): the `ledger-months` days, newest first.
    static func fixtureDays(_ dir: URL) -> [String]? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("ledger-days.json")),
              let days = try? JSONDecoder().decode([String].self, from: data), !days.isEmpty else { return nil }
        return days
    }

    private static func railScrollView(in view: NSView?) -> NSScrollView? {
        guard let view = view else { return nil }
        var found: [NSScrollView] = []
        func walk(_ v: NSView) {
            if let s = v as? NSScrollView { found.append(s) }
            v.subviews.forEach(walk)
        }
        walk(view)
        return found.first { abs($0.frame.width - ConsoleLayout.rightRailWidth) < 2 }
    }

    /// The stream's scroll view: the widest one in the window (the rails are narrower).
    private static func widestScrollView(in view: NSView?) -> NSScrollView? {
        guard let view = view else { return nil }
        var found: [NSScrollView] = []
        func walk(_ v: NSView) {
            if let s = v as? NSScrollView { found.append(s) }
            v.subviews.forEach(walk)
        }
        walk(view)
        return found.max { $0.frame.width < $1.frame.width }
    }
}

/// The main thread's turns, measured from the run loop itself (`trace:<label>` … `trace-stop`).
/// Two observers on the main run loop: `.afterWaiting` at the lowest order marks the moment the
/// thread wakes, `.beforeWaiting` at the highest marks the moment it goes back to sleep — after
/// Core Animation's commit observer (order 2 000 000), which is where SwiftUI's layers draw their
/// contents (the masked pane's rasterisation showed up there). Whatever the thread did between the
/// two — the scheduled action, the SwiftUI update, the layer commit, any rasterisation — is one turn's
/// cost; an iteration that polls without sleeping fires neither observer and merges into the turn
/// before it, which is the stall as the eye sees it. Turns of `floor` ms or more print as `frame:`
/// lines (the first `printCap` of them); the stop prints the summary. Everything runs on main.
final class MainThreadTrace {
    private let launchedAt: Date
    private var observers: [CFRunLoopObserver] = []
    private var turnStart: CFAbsoluteTime?
    private var turns: [(at: Double, ms: Double)] = []
    private var label = ""
    private var startedAt: Date?
    /// When the traced switch was made (`mark`), seconds since launch; nil before it.
    private var markAt: Double?
    private var printed = 0
    /// Turns under this many ms are housekeeping (a 20 Hz level tick's meter update): not counted.
    let floor = 4.0
    /// Listed: every counted turn in the first `listWindow` s after the mark (the wipe is 0.24 s of
    /// it), any turn over `heavy` ms whenever it lands, and the first `printCap` before the mark.
    let listWindow = 0.6
    let heavy = 50.0
    let printCap = 6

    init(launchedAt: Date) { self.launchedAt = launchedAt }

    /// The switch itself (called by `perform` for every action that is not a trace action).
    func mark() {
        guard startedAt != nil, markAt == nil else { return }
        markAt = Date().timeIntervalSince(launchedAt)
    }

    func start(label: String, stamp: String) {
        if startedAt != nil { stop(stamp: stamp) }
        self.label = label
        turns = []
        printed = 0
        turnStart = nil
        markAt = nil
        startedAt = Date()
        let after = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, CFIndex.min) { [weak self] _, _ in
            self?.turnStart = CFAbsoluteTimeGetCurrent()
        }
        let before = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { [weak self] _, _ in
            self?.turnEnded()
        }
        for o in [after, before].compactMap({ $0 }) {
            CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
            observers.append(o)
        }
        print("trace: \(label) started at \(stamp)s")
    }

    private func turnEnded() {
        guard let t0 = turnStart else { return }
        turnStart = nil
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        guard ms >= floor else { return }
        let end = Date().timeIntervalSince(launchedAt)
        let at = end - ms / 1000
        turns.append((at, ms))
        // Listed: the switch's own turn and the ones in the window after it (the wipe's frames),
        // anything heavy whenever it lands, and a few of the idle turns before the mark.
        let listed: Bool
        if let m = markAt {
            listed = (end >= m && at <= m + listWindow) || ms > heavy
        } else if printed < printCap {
            printed += 1
            listed = true
        } else {
            listed = ms > heavy
        }
        if listed {
            let tag = markAt.map { end >= $0 ? String(format: " +%.0f ms", (at - $0) * 1000) : " (before)" } ?? " (before)"
            print(String(format: "frame: t=%.3fs cost=%.1f ms (%@%@)", at, ms, label, tag))
        }
    }

    func stop(stamp: String) {
        guard let started = startedAt else { print("timing: nothing traced (no trace:<label> before trace-stop)"); return }
        for o in observers { CFRunLoopRemoveObserver(CFRunLoopGetMain(), o, .commonModes) }
        observers = []
        startedAt = nil
        let window = Date().timeIntervalSince(started) * 1000
        // The switch's turn: the first counted turn that ends after the mark (the action runs
        // inside it, then SwiftUI's update and Core Animation's commit — the first frame).
        let after = markAt.map { m in turns.filter { $0.at + $0.ms / 1000 >= m } } ?? turns
        let wipe = markAt.map { m in after.filter { $0.at <= m + Motion.base + 0.05 } } ?? []
        let longest = after.max { $0.ms < $1.ms }
        let over = after.filter { $0.ms > heavy }.count
        let busy = after.reduce(0) { $0 + $1.ms }
        func f(_ t: (at: Double, ms: Double)?) -> String { t.map { String(format: "%.1f ms at t=%.3fs", $0.ms, $0.at) } ?? "none" }
        print(String(format: "timing: %@ — switch turn %@; wipe frames (0.29 s): %d, longest %@; after the switch: %d turns ≥ %.0f ms in %.0f ms, longest %@, over %.0f ms: %d, busy %.0f ms; stopped at %@s",
                     label, f(after.first), wipe.count, f(wipe.max { $0.ms < $1.ms }),
                     after.count, floor, window, f(longest), heavy, over, busy, stamp))
    }
}

struct FakeData {
    let shot: String
    let now = Date().timeIntervalSince1970 * 1000
    func ago(_ s: Double) -> Double { now - s * 1000 }

    var settings: Settings {
        Settings(voice: "cedar", brain: .claudeCode, brainModel: "claude-opus-5", brainBaseUrl: nil, effort: "medium", onboarded: true, micDeviceId: nil,
                 idleSleepMinutes: 10, autoWake: true, orbPosition: nil, wake: WakeSettings(enabled: true, phrases: ["jarhead", "jar head", "hey jarhead"], auth: .either),
                 reflexes: true, orbHome: "notch", ledgerRetentionDays: 0, shotsRetentionDays: 14, threads: true, language: "en", accent: "british", memory: true,
                 observe: true, typedWakes: false, threadOverflow: "supersede", warmThreads: 2)
    }

    /// Every permission row (Snapshot.permissions.all) with the three the hands and the voice need
    /// set as given and the rest granted; the harness compiles without Permissions/, so the rows
    /// carry their own short labels.
    func permissions(microphone: Grant, screenRecording: Grant, accessibility: Grant) -> Permissions {
        let required: [PermissionKind: Grant] = [.microphone: microphone, .speechRecognition: .granted, .screenRecording: screenRecording, .accessibility: accessibility]
        let settingsOnly: Set<PermissionKind> = [.screenRecording, .accessibility, .inputMonitoring, .fullDiskAccess]
        return Permissions(all: PermissionKind.allCases.map { kind in
            PermissionInfo(kind: kind, grant: required[kind] ?? .granted, ask: kind == .automation ? .perApp : (settingsOnly.contains(kind) ? .settings : .prompt),
                           required: required[kind] != nil, label: kind.rawValue, why: "", checkedAt: ago(90))
        })
    }

    /// Keys on file, the brain probed and ready: what Settings shows on a working Mac. No local
    /// server answered; the four data-path rows say the brain and memory are in the cloud.
    var setup: SetupStatus {
        SetupStatus(openaiKey: .ok, brain: .ok, brainDetail: "ok", brainResolved: .claudeCode, liveModel: "gpt-live-1",
                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false),
                    local: noServer(), dataPaths: cloudPaths(brain: "claude-opus-5 — Anthropic (your Claude Code login); screenshots and tool results leave"))
    }

    // MARK: the Local brain (SetupStatus.local / dataPaths as the engine's discovery would send them)

    /// This Mac's memory as the engine reports it (128 GiB).
    static let ram: Double = 137_438_953_472

    /// Ollama 0.34.0 up with six models: four tool-capable that fit (one tight), one too big, one
    /// without tools; embeddinggemma pulled for memory. The engine's best fit is qwen3.5:27b.
    func ollamaUp() -> LocalServerStatus {
        LocalServerStatus(reachable: true, flavor: .ollama, version: "0.34.0", baseUrl: "http://127.0.0.1:11434", models: [
            LocalModel(id: "qwen3.5:27b", capabilities: ["completion", "tools", "vision", "thinking"], sizeBytes: 17.0e9, contextLength: 262_144, family: "qwen3", parameterSize: "27B", modifiedAt: ago(2 * 3600), fit: .good, loaded: true, cloud: false),
            LocalModel(id: "qwen3.5:9b", capabilities: ["completion", "tools", "thinking"], sizeBytes: 6.6e9, contextLength: 262_144, family: "qwen3", parameterSize: "9B", modifiedAt: ago(5 * 86_400), fit: .good, loaded: false, cloud: false),
            LocalModel(id: "gpt-oss:120b", capabilities: ["completion", "tools", "thinking"], sizeBytes: 65.0e9, contextLength: 131_072, family: "gptoss", parameterSize: "120B", modifiedAt: ago(9 * 86_400), fit: .tight, loaded: false, cloud: false),
            LocalModel(id: "llama3.3:70b", capabilities: ["completion", "tools"], sizeBytes: 43.0e9, contextLength: 131_072, family: "llama", parameterSize: "70B", modifiedAt: ago(12 * 86_400), fit: .good, loaded: false, cloud: false),
            LocalModel(id: "deepseek-v3.1:671b", capabilities: ["completion", "tools"], sizeBytes: 404.0e9, contextLength: 163_840, family: "deepseek2", parameterSize: "671B", modifiedAt: ago(20 * 86_400), fit: .no, loaded: false, cloud: false),
            LocalModel(id: "gemma4:31b", capabilities: ["completion", "vision"], sizeBytes: 19.0e9, contextLength: 131_072, family: "gemma4", parameterSize: "31B", modifiedAt: ago(3 * 86_400), fit: .good, loaded: false, cloud: false),
        ], picked: "qwen3.5:27b", embedModel: "embeddinggemma", suggested: nil, ramBytes: Self.ram, checkedAt: now)
    }

    /// Ollama up with nothing that can call tools (a vision model and an embedding model): the
    /// engine suggests the pull for this Mac and falls back to OpenAI, loudly.
    func ollamaEmpty() -> LocalServerStatus {
        LocalServerStatus(reachable: true, flavor: .ollama, version: "0.34.0", baseUrl: "http://127.0.0.1:11434", models: [
            LocalModel(id: "gemma4:31b", capabilities: ["completion", "vision"], sizeBytes: 19.0e9, contextLength: 131_072, family: "gemma4", parameterSize: "31B", modifiedAt: ago(3 * 86_400), fit: .good, loaded: false, cloud: false),
        ], picked: nil, embedModel: nil, suggested: LocalSuggested(id: "qwen3.5:27b", sizeBytes: 17.0e9, command: "ollama pull qwen3.5:27b"), ramBytes: Self.ram, checkedAt: now)
    }

    /// Nothing answered on 11434, 1234 or 8080; the engine still names this Mac's memory.
    func noServer() -> LocalServerStatus {
        var s = LocalServerStatus.none
        s.ramBytes = Self.ram
        s.checkedAt = now
        return s
    }

    /// The four rows with the brain and memory in the cloud (a Codex / Claude / OpenAI brain).
    func cloudPaths(brain: String) -> [DataPath] {
        [
            DataPath(what: "voice", where: "cloud", detail: "OpenAI gpt-live-1 — every word heard and said; billed per second of open session"),
            DataPath(what: "brain", where: "cloud", detail: brain),
            DataPath(what: "memory", where: "cloud", detail: "text-embedding-3-small + a mini model — item text and closed conversations leave"),
            DataPath(what: "web", where: "cloud", detail: "the sites you ask for (web_fetch, web_search)"),
        ]
    }

    /// The four rows under the Local brain: only the voice and the web leave.
    func localPaths() -> [DataPath] {
        [
            DataPath(what: "voice", where: "cloud", detail: "OpenAI gpt-live-1 — every word heard and said; billed per second of open session"),
            DataPath(what: "brain", where: "mac", detail: "qwen3.5:27b on Ollama 0.34.0 — nothing leaves"),
            DataPath(what: "memory", where: "mac", detail: "embeddings embeddinggemma 768 dims · extractor qwen3.5:27b — nothing leaves"),
            DataPath(what: "web", where: "cloud", detail: "the sites you ask for (web_fetch, web_search)"),
        ]
    }

    /// Memory matched on this Mac: embeddinggemma's 768 dims, the local extractor.
    func memorySummaryLocal() -> MemorySummary {
        var m = memorySummary()
        m.embeddings = "local"
        m.embeddingModel = "embeddinggemma"
        m.embeddingDims = 768
        m.lastRun = MemorySummary.LastRun(extractor: "local", added: 3, updated: 1, noop: 4, refused: 1, ms: 6_400)
        return m
    }

    /// The amber row when nothing on the server can call tools: Retry re-discovers; Copy carries
    /// the pull Kevin runs himself.
    var localProblem: Problem {
        Problem(kind: "brain.local",
                text: "Nothing on Ollama 0.34.0 can call tools; pull a model with the tools badge. The brain's work goes to OpenAI until then; memory stays local.",
                remedy: ProblemRemedy(label: "Retry", command: ["type": .string("problem.retry"), "kind": .string("brain.local")], open: nil, copy: "ollama pull qwen3.5:27b"),
                since: ago(2 * 60))
    }

    /// Backend → Local model, asleep, Ollama up: the engine's best fit runs (brainModel ""), the
    /// Status line says so, memory is local.
    func localSnapshot() -> Snapshot {
        var s = asleep()
        s.settings.brain = .local
        s.settings.brainModel = ""
        s.settings.brainBaseUrl = nil
        s.setup = SetupStatus(openaiKey: .ok, brain: .ok,
                              brainDetail: "Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools · best fit (pick another in Settings)",
                              brainResolved: .local, liveModel: "gpt-live-1",
                              secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false),
                              local: ollamaUp(), dataPaths: localPaths())
        s.memory = memorySummaryLocal()
        return s
    }

    /// Local model picked, Ollama up, nothing on it can call tools: the loud fallback to OpenAI,
    /// memory kept local by keywords, the amber row with its Copy.
    func localEmptySnapshot() -> Snapshot {
        var s = live()
        s.settings.brain = .local
        s.settings.brainModel = ""
        s.settings.brainBaseUrl = nil
        var paths = cloudPaths(brain: "gpt-5.6-terra — OpenAI (the voice key), while nothing local can call tools; screenshots and tool results leave")
        paths[2] = DataPath(what: "memory", where: "mac", detail: "keywords · rules — nothing leaves")
        s.setup = SetupStatus(openaiKey: .ok, brain: .ok,
                              brainDetail: "Local · nothing on Ollama 0.34.0 can call tools → OpenAI gpt-5.6-terra until a model with the tools badge is pulled",
                              brainResolved: .openaiResponses, liveModel: "gpt-live-1",
                              secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false),
                              local: ollamaEmpty(), dataPaths: paths)
        s.problems = [localProblem]
        var m = memorySummary()
        m.embeddings = "keyword"
        m.embeddingModel = nil
        m.embeddingDims = nil
        s.memory = m
        return s
    }

    /// The ended Codex thread the `threads` scenario steps into: no process owns it, its last
    /// tool call never answered (`interrupted`), and its tail flag is stale — the way a pane
    /// finds a transcript after a daemon restart.
    static let endedId = "sessions:codex:w2p1"

    /// The rail's sessions. `tool` is what the connector says; the two Claude ids
    /// without a tool prefix (`sessions:cc:*`) rely on it, the rest would resolve
    /// from their ids alone. Details read the way the sessions connector writes
    /// them — "tool · msgs · dir · hint", never a relative time (the rail computes
    /// the age from `updatedAt`; a time in the detail churned a snapshot a second) —
    /// so the Console's parsing gets exercised. `hint` is the connector's one word
    /// on why the status is what it is. The two sessions the conversation scenarios
    /// step into live in ~/gt, which exists on this Mac, so their Reveal shows.
    func agents() -> [AgentInfo] {
        [
            AgentInfo(id: "sessions:cc:1", kind: .sessions, tool: .claude, name: "jarhead · console", status: .working, detail: "claude · 128 msgs · mac · editing UI/Console", cwd: "/Users/kevinliu/jarvis/apps/mac", updatedAt: ago(120), messageCount: 128, hint: "running"),
            AgentInfo(id: "sessions:cc:2", kind: .sessions, tool: .claude, name: "kevin-wiki", status: .idle, detail: "claude · 42 msgs · kevin-wiki · waiting for input", cwd: "/Users/kevinliu/Documents/GitHub/kevin-wiki", updatedAt: ago(31 * 60), messageCount: 42, hint: "quiet"),
            AgentInfo(id: "sessions:codex:1", kind: .sessions, name: "gt · api hotfix", status: .done, detail: "codex · 57 msgs · gt · opened PR #412", cwd: "/Users/kevinliu/gt", updatedAt: ago(48 * 60), messageCount: 57, hint: "archived"),
            AgentInfo(id: "claude-code:jarhead", kind: .claudeCode, name: "brain", status: .working, detail: "Delegation 5knl2 in flight", cwd: "/Users/kevinliu", updatedAt: ago(3)),
            AgentInfo(id: "sessions:claude:w1p2", kind: .sessions, name: "gt · api auth", status: .blocked, detail: "claude · 61 msgs · gt · needs Kevin's yes or no: Bash — pnpm test --filter auth", cwd: "/Users/kevinliu/gt", updatedAt: ago(6 * 60), messageCount: 61, hint: "blocked"),
            AgentInfo(id: "sessions:claude:w1p1", kind: .sessions, name: "gt · api tests", status: .done, detail: "claude · 33 msgs · api · pnpm test — 84 passed", cwd: "/Users/kevinliu/gt/apps/api", updatedAt: ago(7 * 60), messageCount: 33),
            // Over: its `codex exec` was killed mid-tool 40 minutes ago; the lease made it `ended`
            // at the next poll and the engine flipped the open call to `interrupted`.
            AgentInfo(id: Self.endedId, kind: .sessions, name: "gt · sdk", status: .ended, detail: "codex · ~1.2k msgs · sdk", cwd: "/Users/kevinliu/gt/packages/sdk", updatedAt: ago(40 * 60), messageCount: 1_200, hint: "ended"),
            // Degraded evidence (ps/lsof timed out): unknown, not ended — the glyph is the question mark.
            AgentInfo(id: "sessions:codex:w2p2", kind: .sessions, name: "gt · web perf", status: .unknown, detail: "codex · 9 msgs · web", cwd: "/Users/kevinliu/gt/apps/web", updatedAt: ago(55 * 60), messageCount: 9, hint: "unseen"),
            AgentInfo(id: "sessions:codex:thread-9", kind: .sessions, name: "Landing refresh", status: .offline, detail: "codex · 210 msgs · web · archived", cwd: "/Users/kevinliu/gt/apps/web", updatedAt: ago(2 * 3600), messageCount: 210),
            AgentInfo(id: "sessions:cursor:a7f1", kind: .sessions, tool: .cursor, name: "gt · web polish", status: .idle, detail: "cursor · 18 msgs · web · waiting for input", cwd: "/Users/kevinliu/gt/apps/web", updatedAt: ago(52 * 60), messageCount: 18),
            AgentInfo(id: "sessions:gemini:c02e", kind: .sessions, tool: .gemini, name: "docs sweep", status: .done, detail: "gemini · 9 msgs · docs · done", cwd: "/Users/kevinliu/gt/docs", updatedAt: ago(3 * 3600), messageCount: 9),
            // The drawn bolt and the "Agent" monogram, so the marks that must not look
            // like the Wake / tool-call glyphs are in every rail shot.
            AgentInfo(id: "sessions:amp:5d2", kind: .sessions, tool: .amp, name: "cli · release notes", status: .working, detail: "amp · 14 msgs · cli · drafting", cwd: "/Users/kevinliu/gt/packages/cli", updatedAt: ago(45), messageCount: 14),
            AgentInfo(id: "sessions:other:aider-1", kind: .sessions, tool: .other, name: "aider · migrations", status: .idle, detail: "agent · 6 msgs · db · waiting for input", cwd: "/Users/kevinliu/gt/packages/db", updatedAt: ago(70 * 60), messageCount: 6),
        ]
    }

    /// What Kevin circled: a crop the engine has taken (snapped to Slack's Send button, so the caption names
    /// it), one still on its way, one a delegation already used — and the front window captured whole from
    /// the notch's Window box (`source` "window": its caption reads "Captured · Safari · 1280×800 · …").
    func marks() -> [ScreenMark] {
        [
            ScreenMark(id: "m1", rect: Rect(x: 412, y: 220, w: 640, h: 400), path: nil, at: ago(9 * 60), screenshotPath: shot, consumed: true),
            ScreenMark(id: "m2", rect: Rect(x: 880, y: 140, w: 512, h: 384), path: nil, at: ago(95), screenshotPath: shot, consumed: false,
                       element: ScreenMark.MarkElement(role: "button", title: "Send", app: "Slack")),
            ScreenMark(id: "m3", rect: Rect(x: 120, y: 600, w: 320, h: 200), path: nil, at: ago(4), screenshotPath: nil, consumed: false),
            ScreenMark(id: "m4", rect: Rect(x: 120, y: 60, w: 1280, h: 800), path: nil, at: ago(30), screenshotPath: shot, consumed: false,
                       element: ScreenMark.MarkElement(role: "window", title: "Jarhead — Safari", app: "Safari"), source: "window"),
        ]
    }

    /// The conversations behind two rail rows, as `agent.transcript` would deliver them.
    func transcripts() -> [String: AgentTranscript] {
        func msg(_ id: String, _ role: AgentRole, _ text: String, _ at: Double, tool: AgentToolCall? = nil, thinking: Bool? = nil) -> AgentMessage {
            AgentMessage(id: id, role: role, text: text, at: at, tool: tool, thinking: thinking)
        }
        func call(_ name: String, _ input: String, _ output: String?, _ status: AgentToolCall.Status = .done) -> AgentToolCall {
            AgentToolCall(name: name, input: input, output: output, status: status)
        }

        // gt · api auth — a resumed Claude Code session, tailing live, waiting on a Bash permission.
        let a0 = ago(6 * 60 + 40)
        let claude = AgentTranscript(agentId: "sessions:claude:w1p2", messages: [
            msg("c1", .user, "The auth suite is red — a missing bearer token returns 403 where the spec expects 401. Fix it and run the suite.", a0),
            msg("c2", .assistant, "The spec wants 401 when the Authorization header is absent and 403 when a token is present but fails verification. requireBearer collapses both into 403. Read the handler and the spec before touching anything.", a0 + 4_000, thinking: true),
            msg("c3", .tool, "", a0 + 6_000, tool: call("Read", "{\"file_path\": \"apps/api/src/auth.ts\"}", "export function requireBearer(req: Request) {\n  const h = req.headers.authorization;\n  if (!h || !verify(h)) throw new HttpError(403, \"forbidden\");\n  return decode(h);\n}")),
            msg("c4", .tool, "", a0 + 7_000, tool: call("Read", "{\"file_path\": \"apps/api/src/__tests__/auth.spec.ts\"}", "it(\"rejects a missing bearer token with 401\", async () => {\n  const res = await app.inject({ url: \"/v1/me\" });\n  expect(res.statusCode).toBe(401);\n});")),
            msg("c5", .assistant, "Found it: `requireBearer` throws 403 for both a missing and an invalid token. The spec wants 401 when the header is absent. I'll split the two cases.", a0 + 12_000),
            msg("c6", .tool, "", a0 + 15_000, tool: call("Edit", "{\"file_path\": \"apps/api/src/auth.ts\", \"old_string\": \"if (!h || !verify(h)) throw new HttpError(403, \\\"forbidden\\\");\", \"new_string\": \"if (!h) throw new HttpError(401, \\\"unauthorized\\\");\\n  if (!verify(h)) throw new HttpError(403, \\\"forbidden\\\");\"}", "Edited apps/api/src/auth.ts (1 replacement)")),
            msg("c7", .assistant, "Edited. Running the auth suite to confirm.", a0 + 17_000),
            msg("c8", .tool, "", a0 + 18_000, tool: call("Bash", "pnpm test --filter auth", nil, .running)),
            // Still being thought while the suite runs: the live thinking row (the ASCII indicator on its icon column).
            msg("c9", .assistant, "The suite takes about forty seconds. If the 401 case passes, the 403 case with a bad token still needs its own assertion.", a0 + 19_000, thinking: true),
        ], total: 62, complete: false, live: true)

        // gt · api hotfix — a finished Codex thread, read from its rollout.
        let x0 = ago(75 * 60)
        let codex = AgentTranscript(agentId: "sessions:codex:1", messages: [
            msg("x1", .user, "Hotfix: /v1/translate 500s when `targetLocales` is empty. Ship a PR.", x0),
            msg("x2", .assistant, "An empty array reaches the batcher, which divides by the locale count. Guard the body early and return 400 with a message the SDK can show.", x0 + 3_000, thinking: true),
            msg("x3", .tool, "", x0 + 5_000, tool: call("shell", "rg -n \"targetLocales\" apps/api/src", "apps/api/src/routes/translate.ts:41:  const batches = chunk(body.targetLocales, perBatch(body));\napps/api/src/batcher.ts:12:  const per = Math.ceil(items / locales.length);")),
            msg("x4", .assistant, "The batcher divides by `targetLocales.length`. I'll validate the body before batching and return 400 with a clear message.", x0 + 9_000),
            msg("x5", .tool, "", x0 + 14_000, tool: call("apply_patch", "*** Begin Patch\n*** Update File: apps/api/src/routes/translate.ts\n@@\n+  if (body.targetLocales.length === 0) throw new HttpError(400, \"targetLocales must name at least one locale\");\n*** Add File: apps/api/src/__tests__/translate-empty.spec.ts\n*** End Patch", "Success. Updated the following files:\nM apps/api/src/routes/translate.ts\nA apps/api/src/__tests__/translate-empty.spec.ts")),
            msg("x6", .tool, "", x0 + 41_000, tool: call("shell", "pnpm test --filter api", "Test Files  9 passed (9)\n     Tests  85 passed (85)")),
            msg("x7", .tool, "", x0 + 58_000, tool: call("shell", "gh pr create --fill", "https://github.com/generaltranslation/gt/pull/412")),
            msg("x8", .assistant, "Opened PR #412: validates `targetLocales` (400 on empty) and adds a regression test. 85 tests pass.", x0 + 61_000),
            msg("x9", .user, "thanks", x0 + 120_000),
            msg("x10", .assistant, "Anytime.", x0 + 122_000),
        ], total: 57, complete: false, live: false)

        // gt · sdk — the ended thread's tail as the engine last sent it: the `live: true` is STALE
        // (the daemon that set it is gone), which is exactly why the pane derives the dot from
        // status + connection and never from this flag alone.
        let e0 = ago(41 * 60)
        let ended = AgentTranscript(agentId: Self.endedId, messages: [
            msg("e1", .user, "Bump the sdk's peer range for React 19 and run its tests.", e0),
            msg("e2", .assistant, "The peer range and the test matrix both name React 18; the change is two files and a rerun.", e0 + 3_000, thinking: true),
            msg("e3", .tool, "", e0 + 5_000, tool: call("apply_patch", "*** Update File: packages/sdk/package.json\n@@\n-    \"react\": \"^18\"\n+    \"react\": \"^18 || ^19\"", "Success. Updated the following files:\nM packages/sdk/package.json")),
            msg("e4", .assistant, "Peer range widened. Running the sdk suite.", e0 + 8_000),
            msg("e5", .tool, "", e0 + 9_000, tool: call("shell", "pnpm test --filter sdk", nil, .interrupted)),
        ], total: 1_200, complete: false, live: true)

        return [claude.agentId: claude, codex.agentId: codex, ended.agentId: ended]
    }

    /// A long conversation for the feed's cap: `count` messages a minute apart — user and
    /// assistant turns, a folded thought every fifth, a finished tool call every seventh — and,
    /// last, the ended thread's interrupted call. `live: true` is stale on purpose (see `transcripts`).
    func longTranscript(agentId: String, count: Int) -> AgentTranscript {
        let t0 = ago(Double(count + 40) * 60)
        var messages: [AgentMessage] = []
        messages.reserveCapacity(count)
        for i in 0..<(count - 1) {
            let at = t0 + Double(i) * 60_000
            let id = "long-\(i)"
            if i % 7 == 6 {
                messages.append(AgentMessage(id: id, role: .tool, text: "", at: at,
                                             tool: AgentToolCall(name: i % 2 == 0 ? "shell" : "apply_patch", input: "pnpm test --filter sdk -- --grep case-\(i)", output: "Tests  \(12 + i % 5) passed", status: .done), thinking: nil))
            } else if i % 5 == 4 {
                messages.append(AgentMessage(id: id, role: .assistant, text: "Case \(i): the fixture's locale list needs the new entry before the snapshot is regenerated.", at: at, tool: nil, thinking: true))
            } else if i % 2 == 0 {
                messages.append(AgentMessage(id: id, role: .user, text: "Next: case \(i) of the sdk matrix — same treatment.", at: at, tool: nil, thinking: nil))
            } else {
                messages.append(AgentMessage(id: id, role: .assistant, text: "Case \(i) done: the peer range holds and the snapshot matches. Moving on.", at: at, tool: nil, thinking: nil))
            }
        }
        messages.append(AgentMessage(id: "long-last", role: .tool, text: "", at: t0 + Double(count - 1) * 60_000,
                                     tool: AgentToolCall(name: "shell", input: "pnpm test --filter sdk", output: nil, status: .interrupted), thinking: nil))
        return AgentTranscript(agentId: agentId, messages: messages, total: count, complete: false, live: true)
    }

    // MARK: memory (Snapshot.memory; `memory.list` / `memory.search`)

    /// What the Console's counts and the Now rail read (Snapshot.memory): seven live items, one
    /// forgotten, one archived; OpenAI matching; a run twelve minutes ago and one conversation
    /// waiting for a quiet moment; the three lines the last delegation was given.
    func memorySummary() -> MemorySummary {
        MemorySummary(enabled: true, count: 7, forgotten: 1, archived: 1, embeddings: "openai", pending: 1, lastRunAt: ago(12 * 60),
                      lastRun: MemorySummary.LastRun(extractor: "responses", added: 3, updated: 1, noop: 4, refused: 1, ms: 1_800),
                      budgetUsed: MemorySummary.BudgetUsed(brain: 180, voice: 96),
                      lastUsedIds: ["m_short", "m_kev", "m_diff"])
    }

    /// The store, every state: what `memory.list all` would answer. Texts are the extractor's
    /// third-person sentences; one Kevin asked for outright (origin kevin), one superseded by its
    /// reversal (forgotten), one episode that decayed (archived).
    func memoryItems() -> [MemoryItem] {
        func item(_ id: String, _ kind: MemoryKind, _ text: String, subjects: [String], importance: Double, confidence: Double,
                  seen: Int, lastSeen: Double, state: MemoryState = .live, origin: String = "extracted", sources: [(Double, String)]) -> MemoryItem {
            MemoryItem(id: id, kind: kind, text: text, subjects: subjects, confidence: confidence, importance: importance,
                       createdAt: sources.first?.0 ?? lastSeen, lastSeenAt: lastSeen, seenCount: seen,
                       sources: sources.map { MemorySource(sessionId: FakeData.chainPausedId, at: $0.0, type: $0.1) },
                       state: state, mergedInto: nil, supersedes: nil, origin: origin)
        }
        let h = 3_600.0, d = 24 * h
        return [
            item("m_kev", .fact, "Kevin goes by Kev.", subjects: ["name"], importance: 1.0, confidence: 0.95, seen: 5, lastSeen: ago(12 * h),
                 sources: [(ago(6 * d), "heard"), (ago(12 * h), "heard")]),
            item("m_short", .preference, "Kevin prefers short answers; one sentence when one will do.", subjects: ["answers", "brevity"], importance: 0.9, confidence: 0.9, seen: 4, lastSeen: ago(26 * h),
                 sources: [(ago(5 * d), "heard"), (ago(26 * h), "heard")]),
            item("m_dark", .preference, "Kevin prefers dark mode.", subjects: ["appearance"], importance: 0.9, confidence: 0.9, seen: 3, lastSeen: ago(2 * d), origin: "kevin",
                 sources: [(ago(3 * d), "kevin"), (ago(2 * d), "heard")]),
            item("m_diff", .procedure, "How Kevin likes it done: read the diff before saying a PR is fine.", subjects: ["review", "pr"], importance: 0.8, confidence: 0.85, seen: 2, lastSeen: ago(3 * d),
                 sources: [(ago(3 * d), "heard")]),
            item("m_gt", .fact, "Kevin's main project is gt, the General Translation monorepo.", subjects: ["gt", "work"], importance: 0.7, confidence: 0.9, seen: 6, lastSeen: ago(4 * d),
                 sources: [(ago(9 * d), "request"), (ago(4 * d), "heard")]),
            item("m_dentist", .contact, "Kevin's dentist is Dr. Alvarez, on 3rd Street.", subjects: ["dentist", "alvarez"], importance: 0.5, confidence: 0.8, seen: 1, lastSeen: ago(5 * d), origin: "kevin",
                 sources: [(ago(5 * d), "kevin")]),
            item("m_office", .place, "Kevin's office is the desk by the window; the notch Mac lives there.", subjects: ["office", "desk"], importance: 0.4, confidence: 0.7, seen: 1, lastSeen: ago(6 * d),
                 sources: [(ago(6 * d), "heard")]),
            // Reversed by m_dark two days later: the newer superseded it, so it is out of the prompts.
            item("m_light", .preference, "Kevin prefers light mode.", subjects: ["appearance"], importance: 0.9, confidence: 0.7, seen: 1, lastSeen: ago(3 * d), state: .forgotten,
                 sources: [(ago(3 * d), "heard")]),
            // A dated thing worth little a week later: decayed out of the prompts, still restorable.
            item("m_ep", .episode, "On Sep 8 Kevin shipped the api hotfix (PR #412) with Codex.", subjects: ["gt", "hotfix"], importance: 0.3, confidence: 0.9, seen: 1, lastSeen: ago(4 * d), state: .archived,
                 sources: [(ago(4 * d), "summary")]),
        ]
    }

    /// `memory.list {state, limit}`: that state's items ("all" for every state), newest seen first, capped.
    func memoryList(state: String, limit: Int) -> [MemoryItem]? {
        let all = memoryItems().sorted { $0.lastSeenAt > $1.lastSeenAt }
        let picked = state == "all" ? all : all.filter { $0.state.rawValue == state }
        return Array(picked.prefix(max(1, min(limit, 200))))
    }

    /// `memory.search {query, limit}`: scored like the daemon's (cosine + substring, best first) —
    /// so a hit need not carry the words. The stand-in for the embedding: a few meanings the
    /// fixture "knows" ("theme" → dark mode, "terse" → short answers, "teeth" → the dentist, "work" →
    /// the office), ranked above the substring hits; live items only, in score order (not recency).
    static let semanticHits: [String: [String]] = ["theme": ["m_dark"], "terse": ["m_short"], "brief": ["m_short"], "teeth": ["m_dentist"], "work": ["m_office"]]

    func memorySearch(_ query: String, limit: Int) -> [MemoryItem]? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        let live = memoryItems().filter { $0.state == .live }
        var ranked: [MemoryItem] = []
        for id in Self.semanticHits[q] ?? [] {
            if let hit = live.first(where: { $0.id == id }) { ranked.append(hit) }
        }
        for item in live.sorted(by: { $0.lastSeenAt > $1.lastSeenAt })
        where !ranked.contains(where: { $0.id == item.id }) && (item.text.lowercased().contains(q) || item.subjects.contains { $0.lowercased().contains(q) }) {
            ranked.append(item)
        }
        return Array(ranked.prefix(max(1, min(limit, 200))))
    }

    func connectors() -> [ConnectorHealth] {
        [
            ConnectorHealth(kind: .sessions, ok: true, detail: "claude 3 sessions · codex 4 · running: 1 claude, 1 codex"),
            ConnectorHealth(kind: .claudeCode, ok: true, detail: "Agent SDK · resumable"),
        ]
    }

    func transcript() -> [TranscriptItem] {
        [
            TranscriptItem(id: "u1", speaker: .kevin, text: "Hey Jarhead, what's the Claude session doing on the auth branch?", startMs: 0, endMs: 2400, at: ago(140), final: true),
            TranscriptItem(id: "u2", speaker: .jarhead, text: "Two sessions are active in gt. The auth one has been blocked for six minutes on a failing test in auth.spec.ts — want me to look?", startMs: 2600, endMs: 6100, at: ago(139), final: true),
            TranscriptItem(id: "u3", speaker: .kevin, text: "Yeah, go ahead and fix it if it's obvious.", startMs: 7000, endMs: 9200, at: ago(138), final: true),
            TranscriptItem(id: "u4", speaker: .jarhead, text: "On it.", startMs: 9400, endMs: 9800, at: ago(137), final: true),
        ]
    }

    func runningDelegation(awaiting: Bool) -> Delegation {
        let t0 = ago(136)
        var steps: [DelegationStep] = [
            DelegationStep(id: "s1", at: t0 + 350, kind: .thinking, text: "Checking which sessions are active and what the auth one is stuck on…", tool: nil, screenshotPath: nil),
            DelegationStep(id: "s2", at: t0 + 700, kind: .tool, text: nil, tool: ToolStep(name: "agents_list", input: .object(["project": .string("gt")]), output: .array([.object(["session": .string("api tests"), "status": .string("done")]), .object(["session": .string("api auth"), "status": .string("blocked")])]), ok: true, ms: 212), screenshotPath: nil),
            DelegationStep(id: "s3", at: t0 + 1100, kind: .commentary, text: "The auth session is blocked on a failing test. Let me look at the terminal.", tool: nil, screenshotPath: nil),
            DelegationStep(id: "s4", at: t0 + 1400, kind: .screenshot, text: "Terminal — gt · api auth", tool: nil, screenshotPath: shot),
            DelegationStep(id: "s5", at: t0 + 1800, kind: .thinking, text: "The assertion expects 401 for a missing bearer token but the handler returns 403. One-line fix in auth.ts.", tool: nil, screenshotPath: nil),
            DelegationStep(id: "s6", at: t0 + 2100, kind: .tool, text: nil, tool: ToolStep(name: "hands.click", input: .object(["coordinate": .array([.number(512), .number(384)])]), output: nil, ok: true, ms: 640), screenshotPath: nil),
        ]
        if awaiting {
            steps.append(DelegationStep(id: "s7", at: t0 + 2500, kind: .confirm, text: "Change the missing-token status code in auth.ts from 403 to 401 and re-run the suite?", tool: nil, screenshotPath: nil))
        }
        return Delegation(id: "del_5knl2", liveId: "live_9f8e7d", createdAt: t0, offsetMs: 9400, request: "Kevin asked what the auth session is doing and to fix its failing test if it is obvious.", status: awaiting ? .awaitingConfirmation : .running, steps: steps, summary: nil, timings: DelegationTimings(delegatedAt: t0, firstThinkingAt: t0 + 350, firstCommentaryAt: t0 + 1100, doneAt: nil))
    }

    func doneDelegation() -> Delegation {
        let t0 = ago(600)
        let steps: [DelegationStep] = [
            DelegationStep(id: "d1", at: t0 + 640, kind: .thinking, text: "Listing sessions across ~/.claude and ~/.codex…", tool: nil, screenshotPath: nil),
            DelegationStep(id: "d2", at: t0 + 1500, kind: .tool, text: nil, tool: ToolStep(name: "agents_list", input: .object([:]), output: nil, ok: true, ms: 188), screenshotPath: nil),
            DelegationStep(id: "d3", at: t0 + 2100, kind: .commentary, text: "One session is stuck: gt · sdk, waiting on a prompt.", tool: nil, screenshotPath: nil),
        ]
        return Delegation(id: "del_5se34", liveId: "live_1a2b", createdAt: t0, offsetMs: 100, request: "Kevin asked which sessions are stuck.", status: .done, steps: steps, summary: "Found one stuck session (gt · sdk).", timings: DelegationTimings(delegatedAt: t0, firstThinkingAt: t0 + 640, firstCommentaryAt: t0 + 2100, doneAt: t0 + 3900))
    }

    func failedDelegation() -> Delegation {
        let t0 = ago(20)
        let steps: [DelegationStep] = [
            DelegationStep(id: "f1", at: t0 + 233, kind: .thinking, text: "Trying the Codex session directly…", tool: nil, screenshotPath: nil),
            DelegationStep(id: "f2", at: t0 + 467, kind: .tool, text: nil, tool: ToolStep(name: "agent_send", input: .null, output: .string("codex sessions are read-only"), ok: false, ms: 1200), screenshotPath: nil),
            DelegationStep(id: "f3", at: t0 + 700, kind: .error, text: "Codex sessions are read-only; cannot send to that one.", tool: nil, screenshotPath: nil),
        ]
        return Delegation(id: "del_l4m0c", liveId: "live_77", createdAt: t0, offsetMs: 300, request: "Kevin asked Codex to pick the landing refresh back up.", status: .failed, steps: steps, summary: "Codex sessions are read-only.", timings: DelegationTimings(delegatedAt: t0, firstThinkingAt: t0 + 233, firstCommentaryAt: nil, doneAt: t0 + 741))
    }

    // MARK: threads (Snapshot.threads, thread.event, thread.transcript)

    /// When the threads' parent delegation was created: 8 s ago, so the threads are a few seconds in.
    var splitAt: Double { ago(8) }

    static let slackId = "t_sl4ck00"
    static let spotifyId = "t_sp0t1fy"
    static let notesId = "t_n0tes01"

    /// One thread as the engine's table would summarise it: `status` and `startedAt` vary, the
    /// rest read from the errand (the brief, the lane, the app it claimed).
    func thread(_ id: String, status: ThreadStatus, startedAt: Double) -> WorkThread {
        let live = status.isLive
        switch id {
        case FakeData.slackId:
            return WorkThread(id: id, name: "Slack", lane: .screen, status: status, parentId: "main", parentDelegationId: "del_thr3ads", liveId: session().id,
                              task: "tell Ben on Slack that Kevin is running late", detail: status == .waitingKevin ? "click_element Send" : "type", apps: ["Slack"], app: "Slack",
                              at: Point2(x: 812, y: 604), startedAt: startedAt, updatedAt: startedAt + 6_100, doneAt: live ? nil : startedAt + 6_100,
                              turns: 1, steps: 4, waits: 1, budget: WorkThread.Budget(steps: 25, seconds: 180),
                              question: status == .waitingKevin ? "Send “running late — there in 10” to Ben?" : nil,
                              currentDelegationId: "del_t_slack_1", lastScreenshotPath: shot, canSay: live, canStop: live)
        case FakeData.spotifyId:
            return WorkThread(id: id, name: "Spotify", lane: .background, status: status, parentId: "main", parentDelegationId: "del_thr3ads", liveId: session().id,
                              task: "play the playlist Focus in Spotify", detail: "applescript", apps: ["Spotify"], app: "Spotify", at: nil,
                              startedAt: startedAt, updatedAt: startedAt + 1_700, doneAt: live ? nil : startedAt + 1_700,
                              turns: 1, steps: 2, waits: 0, budget: WorkThread.Budget(steps: 25, seconds: 180), question: nil,
                              currentDelegationId: "del_t_spotify_1", lastScreenshotPath: nil, canSay: live, canStop: live)
        case FakeData.notesId:
            return WorkThread(id: id, name: "Notes", lane: .background, status: status, parentId: "main", parentDelegationId: "del_thr3ads", liveId: session().id,
                              task: "append today's standup line to the Notes daily page", detail: "appended one line to Daily", apps: ["Notes"], app: "Notes", at: nil,
                              startedAt: startedAt, updatedAt: startedAt + 3_200, doneAt: live ? nil : startedAt + 3_200,
                              turns: 1, steps: 3, waits: 0, budget: WorkThread.Budget(steps: 25, seconds: 180), question: nil,
                              currentDelegationId: "del_t_notes_1", lastScreenshotPath: nil, canSay: live, canStop: live)
        case "main":
            return WorkThread(id: "main", name: "Jarhead", lane: .voice, status: status, parentId: nil, parentDelegationId: nil, liveId: session().id,
                              task: "", detail: "Slack and Spotify alongside.", apps: [], app: nil, at: nil,
                              startedAt: startedAt, updatedAt: splitAt + 800, doneAt: nil, turns: 4, steps: 0, waits: 0,
                              budget: WorkThread.Budget(steps: 40, seconds: 300), question: nil, currentDelegationId: nil, lastScreenshotPath: nil, canSay: true, canStop: false)
        default:
            return WorkThread(id: id, name: id, lane: .background, status: status, parentId: "main", parentDelegationId: nil, liveId: nil, task: "", detail: nil, apps: [], app: nil, at: nil,
                              startedAt: startedAt, updatedAt: startedAt, doneAt: live ? nil : startedAt, turns: 1, steps: 0, waits: 0,
                              budget: WorkThread.Budget(steps: 25, seconds: 180), question: nil, currentDelegationId: nil, lastScreenshotPath: nil, canSay: live, canStop: live)
        }
    }

    /// Snapshot.threads for the `threads` scenarios: the main thread idle between turns, Spotify
    /// acting (background), Slack waiting on Kevin (screen) with its question, Notes done a
    /// moment ago and lingering. Never more than main + 3 (THREAD_MAX_LIVE).
    func threads() -> [WorkThread] {
        let t0 = splitAt
        return [
            thread("main", status: .idle, startedAt: session().startedAt),
            thread(FakeData.notesId, status: .done, startedAt: t0 + 800),
            thread(FakeData.spotifyId, status: .acting, startedAt: t0 + 3_500),
            thread(FakeData.slackId, status: .waitingKevin, startedAt: t0 + 4_500),
        ]
    }

    /// The main brain's own turn for the errand: it thought, started the three threads in one
    /// exec batch (`thread_start`), said the split line and ended its turn — no `thread_wait`.
    func threadsDelegation() -> Delegation {
        let t0 = splitAt
        func start(_ id: String, _ at: Double, _ name: String, _ task: String, _ lane: String) -> DelegationStep {
            DelegationStep(id: id, at: at, kind: .tool, text: nil,
                           tool: ToolStep(name: "thread_start", input: .object(["name": .string(name), "task": .string(task), "lane": .string(lane)]),
                                          output: .string("\(name) started (\(lane))"), ok: true, ms: 3), screenshotPath: nil)
        }
        let steps: [DelegationStep] = [
            DelegationStep(id: "th-s1", at: t0 + 420, kind: .thinking, text: "Three independent apps: Notes and Spotify take Apple events, Slack needs the pointer. One thread each, then end the turn.", tool: nil, screenshotPath: nil),
            start("th-s2", t0 + 800, "Notes", "append today's standup line to the Notes daily page", "background"),
            start("th-s3", t0 + 3_500, "Spotify", "play the playlist Focus in Spotify", "background"),
            start("th-s4", t0 + 4_500, "Slack", "tell Ben on Slack that Kevin is running late", "screen"),
            DelegationStep(id: "th-s5", at: t0 + 4_900, kind: .commentary, text: "Notes, Spotify and Slack alongside.", tool: nil, screenshotPath: nil),
        ]
        return Delegation(id: "del_thr3ads", liveId: session().id, createdAt: t0, offsetMs: 400,
                          request: "Kevin asked to add today's standup line to Notes, put on Focus on Spotify and tell Ben on Slack he is running late.",
                          status: .done, steps: steps, summary: "Started three threads: Notes and Spotify in the background, Slack on the screen.",
                          timings: DelegationTimings(delegatedAt: t0, firstThinkingAt: t0 + 420, firstCommentaryAt: t0 + 4_900, doneAt: t0 + 5_100), threadId: "main")
    }

    /// What was heard and said around the split: the ask, "on it", the one coalesced split line,
    /// Notes' finish line, and Slack's question spoken with its name.
    func threadsTranscript(from t0: Double) -> [TranscriptItem] {
        [
            TranscriptItem(id: "th-u1", speaker: .kevin, text: "Jarhead, add today's standup line to my Notes, put on Focus on Spotify, and tell Ben on Slack I'm running late.", startMs: 0, endMs: 4200, at: t0 - 1200, final: true),
            TranscriptItem(id: "th-u2", speaker: .jarhead, text: "On it.", startMs: 4400, endMs: 4800, at: t0 - 500, final: true),
            TranscriptItem(id: "th-u3", speaker: .jarhead, text: "Notes, Spotify and Slack alongside.", startMs: 6000, endMs: 7200, at: t0 + 5_000, final: true),
            TranscriptItem(id: "th-u4", speaker: .jarhead, text: "Notes: appended one line to Daily.", startMs: 8500, endMs: 10200, at: t0 + 4_100, final: true),
            TranscriptItem(id: "th-u5", speaker: .jarhead, text: "Slack asks: send “running late — there in 10” to Ben?", startMs: 11000, endMs: 13500, at: t0 + 10_800, final: true),
        ]
    }

    /// One thread's conversation as its `thread.open` page would land: a system row for its
    /// start, its own delegation card (the brief as the request; its steps, screenshot and — for
    /// Slack — the confirm step it waits on, folded in by the store), the lines spoken for it.
    /// The main thread's is the live stream's own rows numbered by seq.
    func threadTranscript(_ id: String) -> ThreadTranscript {
        let t0 = splitAt
        func sys(_ seq: Int, _ at: Double, _ symbol: String, _ text: String, mono: String? = nil, trailing: String? = nil) -> ThreadEntry {
            ThreadEntry(kind: "system", seq: seq, at: at, symbol: symbol, text: text, mono: mono, trailing: trailing)
        }
        func utt(_ seq: Int, _ item: TranscriptItem) -> ThreadEntry { ThreadEntry(kind: "utterance", seq: seq, item: item) }
        func card(_ seq: Int, _ d: Delegation) -> ThreadEntry { ThreadEntry(kind: "delegation", seq: seq, delegation: d) }
        func step(_ seq: Int, _ delegationId: String, _ s: DelegationStep) -> ThreadEntry { ThreadEntry(kind: "step", seq: seq, delegationId: delegationId, step: s) }
        func status(_ seq: Int, _ delegationId: String, _ st: DelegationStatus, summary: String?, timings: DelegationTimings) -> ThreadEntry {
            ThreadEntry(kind: "status", seq: seq, delegationId: delegationId, status: st, summary: summary, timings: timings)
        }
        let talk = threadsTranscript(from: t0)
        switch id {
        case FakeData.slackId:
            let s0 = t0 + 4_500
            let d = Delegation(id: "del_t_slack_1", liveId: session().id, createdAt: s0, offsetMs: 0, request: "tell Ben on Slack that Kevin is running late", status: .running, steps: [
                DelegationStep(id: "sl-1", at: s0 + 900, kind: .thinking, text: "Slack needs the pointer: take the screen, find Ben, type, then ask before Send.", tool: nil, screenshotPath: nil),
                DelegationStep(id: "sl-2", at: s0 + 1_400, kind: .tool, text: nil, tool: ToolStep(name: "open_app", input: .object(["name": .string("Slack")]), output: .string("Slack is frontmost · now: Slack, Ben (DM), the message field focused"), ok: true, ms: 640), screenshotPath: nil),
                DelegationStep(id: "sl-3", at: s0 + 2_100, kind: .screenshot, text: "Slack — Ben", tool: nil, screenshotPath: shot),
                DelegationStep(id: "sl-4", at: s0 + 3_800, kind: .tool, text: nil, tool: ToolStep(name: "type", input: .object(["text": .string("running late — there in 10")]), output: .string("typed 26 chars · now: Slack, the message field holds the text"), ok: true, ms: 1_210), screenshotPath: nil),
            ], summary: nil, timings: DelegationTimings(delegatedAt: s0, firstThinkingAt: s0 + 900, firstCommentaryAt: nil, doneAt: nil, speechEndAt: nil, firstActionAt: s0 + 1_400), threadId: id)
            return ThreadTranscript(threadId: id, entries: [
                sys(1, s0, ConsoleTheme.threadsSymbol, "Slack · started", mono: "screen", trailing: "tell Ben on Slack that Kevin is running late"),
                card(2, d),
                step(3, d.id, DelegationStep(id: "sl-5", at: s0 + 6_100, kind: .confirm, text: "Send “running late — there in 10” to Ben?", tool: nil, screenshotPath: nil)),
                status(4, d.id, .awaitingConfirmation, summary: nil, timings: d.timings),
                utt(5, talk[4]),
            ], total: 5, complete: true, live: true, cursor: ThreadTranscript.Cursor(startSeq: 1, endSeq: 5), readMs: 3)
        case FakeData.spotifyId:
            let s0 = t0 + 3_500
            let d = Delegation(id: "del_t_spotify_1", liveId: session().id, createdAt: s0, offsetMs: 0, request: "play the playlist Focus in Spotify", status: .running, steps: [
                DelegationStep(id: "sp-1", at: s0 + 700, kind: .thinking, text: "An Apple event does it; no screen needed.", tool: nil, screenshotPath: nil),
                DelegationStep(id: "sp-2", at: s0 + 1_700, kind: .tool, text: nil, tool: ToolStep(name: "applescript", input: .string("tell application \"Spotify\" to play track \"spotify:playlist:37i9dQZF1DWZeKCadgRdKQ\""), output: .string("ok · now: Spotify playing Focus"), ok: true, ms: 388), screenshotPath: nil),
            ], summary: nil, timings: DelegationTimings(delegatedAt: s0, firstThinkingAt: s0 + 700, firstCommentaryAt: nil, doneAt: nil, speechEndAt: nil, firstActionAt: s0 + 1_700), threadId: id)
            return ThreadTranscript(threadId: id, entries: [
                sys(1, s0, ConsoleTheme.threadsSymbol, "Spotify · started", mono: "background", trailing: "play the playlist Focus in Spotify"),
                card(2, d),
            ], total: 2, complete: true, live: true, cursor: ThreadTranscript.Cursor(startSeq: 1, endSeq: 2), readMs: 2)
        case FakeData.notesId:
            let s0 = t0 + 800
            let d = Delegation(id: "del_t_notes_1", liveId: session().id, createdAt: s0, offsetMs: 0, request: "append today's standup line to the Notes daily page", status: .done, steps: [
                DelegationStep(id: "no-1", at: s0 + 500, kind: .thinking, text: "One Apple event on the Daily note.", tool: nil, screenshotPath: nil),
                DelegationStep(id: "no-2", at: s0 + 1_500, kind: .tool, text: nil, tool: ToolStep(name: "applescript", input: .string("tell application \"Notes\" to tell note \"Daily\" of folder \"Standup\" to set body to body & \"<div>…\""), output: .string("ok"), ok: true, ms: 612), screenshotPath: nil),
                DelegationStep(id: "no-3", at: s0 + 2_300, kind: .note, text: "appended one line to Daily", tool: nil, screenshotPath: nil),
            ], summary: "appended one line to Daily", timings: DelegationTimings(delegatedAt: s0, firstThinkingAt: s0 + 500, firstCommentaryAt: nil, doneAt: s0 + 3_200, speechEndAt: nil, firstActionAt: s0 + 1_500), threadId: id)
            return ThreadTranscript(threadId: id, entries: [
                sys(1, s0, ConsoleTheme.threadsSymbol, "Notes · started", mono: "background", trailing: "append today's standup line to the Notes daily page"),
                card(2, d),
                utt(3, talk[3]),
                sys(4, s0 + 3_200, "checkmark.circle.fill", "Notes · done", mono: "3 steps · 00:03", trailing: "appended one line to Daily"),
            ], total: 4, complete: true, live: false, cursor: ThreadTranscript.Cursor(startSeq: 1, endSeq: 4), readMs: 2)
        default:
            // main: the live stream's own rows, in time order, numbered.
            var rows: [(at: Double, entry: (Int) -> ThreadEntry)] = []
            for item in live().transcript + talk { rows.append((item.at, { utt($0, item) })) }
            for d in live().delegations + [threadsDelegation()] { rows.append((d.createdAt, { card($0, d) })) }
            rows.sort { $0.at < $1.at }
            let entries = rows.enumerated().map { $0.element.entry($0.offset + 1) }
            return ThreadTranscript(threadId: "main", entries: entries, total: entries.count, complete: false, live: true,
                                    cursor: ThreadTranscript.Cursor(startSeq: 1, endSeq: entries.count), readMs: 4)
        }
    }

    /// A line Kevin typed in the composer (TranscriptItem.source "typed") and Jarhead's answer.
    func typedTranscript() -> [TranscriptItem] {
        [
            TranscriptItem(id: "ty-1", speaker: .kevin, text: "open safari and pull up the gt repo", startMs: 0, endMs: 0, at: ago(9), final: true, source: "typed"),
            TranscriptItem(id: "ty-2", speaker: .jarhead, text: "Safari's up on the gt repo.", startMs: 0, endMs: 1400, at: ago(6), final: true),
        ]
    }

    /// The main thread's record as a longer log the engine pages: 61 entries. Seq 1 is a card
    /// recorded at creation (no steps yet), 2–4 its steps and 5 its status — so the newest page
    /// of 60 (seqs 2…61) holds the steps without the card, as four orphan rows, until "Load
    /// earlier" brings seq 1. Then 39 lines of older chatter, then the live rows (the same rows
    /// `threadTranscript("main")` numbers), in time order.
    struct PagedMain {
        let record: [ThreadEntry]
        /// The page `thread.open` answers with: the newest 60, `complete: false`.
        var newest: ThreadTranscript { page(before: nil) }
        /// The page `thread.history {before}` answers with: ≤ 60 entries before that seq, `complete` at the record's first.
        func older(before: Int) -> ThreadTranscript { page(before: before) }
        private func page(before: Int?) -> ThreadTranscript {
            let upto = before.map { b in record.firstIndex { $0.seq >= b } ?? record.count } ?? record.count
            let start = max(0, upto - 60)
            let entries = Array(record[start..<upto])
            return ThreadTranscript(threadId: "main", entries: entries, total: record.count, complete: start == 0, live: true,
                                    cursor: entries.isEmpty ? nil : ThreadTranscript.Cursor(startSeq: entries[0].seq, endSeq: entries[entries.count - 1].seq), readMs: 3)
        }
    }

    func pagedMain() -> PagedMain {
        let t0 = splitAt
        let old = ago(3_600)
        let card = Delegation(id: "del_pag3d", liveId: session().id, createdAt: old, offsetMs: 0, request: "Kevin asked to open the PR for the landing refresh.", status: .running, steps: [],
                              summary: nil, timings: DelegationTimings(delegatedAt: old), threadId: "main", stepCount: 0)
        var record: [ThreadEntry] = [
            ThreadEntry(kind: "delegation", seq: 1, delegation: card),
            ThreadEntry(kind: "step", seq: 2, delegationId: card.id, step: DelegationStep(id: "pg-1", at: old + 400, kind: .thinking, text: "The branch is pushed; gh opens the PR.", tool: nil, screenshotPath: nil)),
            ThreadEntry(kind: "step", seq: 3, delegationId: card.id, step: DelegationStep(id: "pg-2", at: old + 900, kind: .tool, text: nil, tool: ToolStep(name: "run_shell", input: .object(["cmd": .string("gh pr create --fill")]), output: .string("https://github.com/gt/landing/pull/418"), ok: true, ms: 2_140), screenshotPath: nil)),
            ThreadEntry(kind: "step", seq: 4, delegationId: card.id, step: DelegationStep(id: "pg-3", at: old + 3_200, kind: .commentary, text: "PR 418 is open.", tool: nil, screenshotPath: nil)),
            ThreadEntry(kind: "status", seq: 5, delegationId: card.id, status: .done, summary: "opened the PR", timings: DelegationTimings(delegatedAt: old, firstThinkingAt: old + 400, firstCommentaryAt: old + 3_200, doneAt: old + 3_400)),
        ]
        for i in 0..<39 {
            let kevin = i % 2 == 0
            let at = old + 4_000 + Double(i) * 40_000
            record.append(ThreadEntry(kind: "utterance", seq: record.count + 1,
                                      item: TranscriptItem(id: "pg-u\(i)", speaker: kevin ? .kevin : .jarhead,
                                                           text: kevin ? "Older line \(i + 1) — something Kevin said an hour ago." : "Older line \(i + 1) — and what Jarhead answered.",
                                                           startMs: 0, endMs: 1_200, at: at, final: true)))
        }
        var rows: [(at: Double, entry: (Int) -> ThreadEntry)] = []
        for item in live().transcript + threadsTranscript(from: t0) { rows.append((item.at, { ThreadEntry(kind: "utterance", seq: $0, item: item) })) }
        for d in live().delegations + [threadsDelegation()] { rows.append((d.createdAt, { ThreadEntry(kind: "delegation", seq: $0, delegation: d) })) }
        rows.sort { $0.at < $1.at }
        for row in rows { record.append(row.entry(record.count + 1)) }
        return PagedMain(record: record)
    }

    /// One `thread.transcript` frame as B2's ThreadLog/ThreadTurns emit it (Scripts: the tsx probe
    /// thread-page-fixture.ts, no ledger, no network): a system row, a typed utterance, a card at
    /// creation, four steps, its status, a spoken line — the bytes the store must decode.
    static let engineThreadPageJSON = #"""
    {"type":"thread.transcript","mode":"replace","transcript":{"threadId":"t_f1xtur3","entries":[{"kind":"system","at":1757800000250,"symbol":"square.stack.fill","text":"Slack · started","mono":"screen","seq":1},{"kind":"utterance","item":{"id":"u1","speaker":"kevin","text":"slack, tell ben I'm late","startMs":0,"endMs":900,"at":1757800000500,"final":true,"source":"typed"},"seq":2},{"kind":"delegation","delegation":{"id":"dlg_mu04afnbef4y3h","liveId":"live_1","createdAt":1757800000750,"offsetMs":120,"request":"tell Ben on Slack that Kevin is running late","status":"running","steps":[],"timings":{"delegatedAt":1757800000750},"threadId":"t_f1xtur3","stepCount":0},"seq":3},{"kind":"step","delegationId":"dlg_mu04afnbef4y3h","step":{"id":"step_mu04afnbk61q1b","at":1757800001000,"kind":"thinking","text":"Slack needs the pointer."},"seq":4},{"kind":"step","delegationId":"dlg_mu04afnbef4y3h","step":{"id":"step_mu04afnbot538t","at":1757800001250,"kind":"tool","tool":{"name":"open_app","input":{"name":"Slack"},"output":"Slack is frontmost · now: Slack, Ben (DM)","ok":true,"ms":640}},"seq":5},{"kind":"step","delegationId":"dlg_mu04afnbef4y3h","step":{"id":"step_mu04afnba77cgv","at":1757800001500,"kind":"screenshot","text":"Slack — Ben","screenshotPath":"/tmp/shot.png"},"seq":6},{"kind":"step","delegationId":"dlg_mu04afnbef4y3h","step":{"id":"step_mu04afnbymxlp0","at":1757800001750,"kind":"confirm","text":"Send “running late” to Ben?"},"seq":7},{"kind":"status","delegationId":"dlg_mu04afnbef4y3h","status":"awaiting-confirmation","timings":{"delegatedAt":1757800000750,"firstToolAt":1757800001250,"firstActionAt":1757800001250,"toolRoundTripMs":[640],"doneAt":1757800002000},"seq":8},{"kind":"utterance","item":{"id":"u2","speaker":"jarhead","text":"Slack asks: send “running late” to Ben?","startMs":1000,"endMs":2400,"at":1757800002250,"final":true},"seq":9}],"total":9,"complete":true,"live":true,"cursor":{"startSeq":1,"endSeq":9},"readMs":2}}
    """#

    func session() -> SessionInfo {
        SessionInfo(id: "sess_7f3a9c2e41b0", startedAt: ago(14 * 60 + 35), expiresAt: now + 45 * 60 * 1000 + 46_000, usageSeconds: 758, contextRatio: 0.31)
    }

    func live() -> Snapshot {
        var t = transcript()
        t.append(TranscriptItem(id: "u5", speaker: .kevin, text: "Yes, do it.", startMs: 12000, endMs: 12600, at: ago(60), final: true))
        t.append(TranscriptItem(id: "u6", speaker: .jarhead, text: "Done — the auth session is green again. The handler now returns 401 for a missing bearer token.", startMs: 12800, endMs: 16000, at: ago(58), final: true))
        t.append(TranscriptItem(id: "u7", speaker: .kevin, text: "Nice. What's Codex up to?", startMs: 17000, endMs: 18200, at: ago(22), final: true))
        t.append(TranscriptItem(id: "u8", speaker: .jarhead, text: "Codex finished the api hotfix and opened PR #412; the landing refresh session is archived", startMs: 19000, endMs: 22000, at: ago(18), final: false))
        var running = runningDelegation(awaiting: false)
        running.status = .done
        running.summary = "Diagnosed the blocked session and dispatched a one-line fix to gt · api auth."
        running.timings.doneAt = running.timings.delegatedAt + 3100
        var s = Snapshot(phase: .speaking, session: session(), transcript: t, delegations: [doneDelegation(), running, failedDelegation()], agents: agents(), connectors: connectors(), settings: settings,
                         permissions: permissions(microphone: .granted, screenRecording: .granted, accessibility: .denied),
                         problems: [accessibilityProblem], brainReady: true, handsReady: false, setup: setup, marks: [], threads: [])
        // What the trash holds, for the Trash head's folder and Settings › Retention.
        s.trash = trash
        // What Jarhead remembers, and the three lines the last delegation was given (the Now rail).
        s.memory = memorySummary()
        return s
    }

    /// The live day's stream with the session closed: asleep, nothing billed, the wake gate in charge.
    func asleep() -> Snapshot {
        var s = live()
        s.phase = .asleep
        s.session = nil
        s.problems = []
        return s
    }

    func confirm() -> Snapshot {
        Snapshot(phase: .acting, session: session(), transcript: transcript(), delegations: [runningDelegation(awaiting: true)], agents: agents(), connectors: connectors(), settings: settings,
                 permissions: permissions(microphone: .denied, screenRecording: .granted, accessibility: .denied),
                 problems: [accessibilityProblem], brainReady: true, handsReady: false, setup: setup, marks: [], threads: [])
    }

    func empty() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: [],
                 connectors: [ConnectorHealth(kind: .sessions, ok: false, detail: "No Claude Code or Codex session store under ~"), ConnectorHealth(kind: .claudeCode, ok: true, detail: "Agent SDK · ready")],
                 settings: settings, permissions: permissions(microphone: .unknown, screenRecording: .granted, accessibility: .granted), problems: [], brainReady: true, handsReady: true, setup: setup, marks: [], threads: [])
    }

    // MARK: Jarhead's own sessions (the ledger's `sessions()` / `readSession()`)

    /// The paused → resumed chain the `jarhead` scenarios step into.
    static let chainPausedId = "live_u7_EN2HiSxSGcjkzAI8uPHQj"
    static let chainResumedId = "live_u7_EN2KpQ4mWvB8xRtZaYc3L"
    static let yesterdayId = "live_u7_EMzfmCLOp7XvtmJ3RJTTs"
    static let lostId = "live_u7_EMz1thmn1cGwzD4Cpbp6P"
    /// The cleanup scenarios' chains: one Kevin pinned and named, two archived, two in the Trash
    /// (one by hand, one the retention sweep moved).
    static let pinnedId = "live_u7_EMyQ9pinnedAuthTriage01"
    static let archivedAId = "live_u7_EMxa1archivedDocs0001"
    static let archivedBId = "live_u7_EMxa2archivedSlack001"
    static let trashedAId = "live_u7_EMwt1trashedTestRun01"
    static let trashedBId = "live_u7_EMwt2trashedRetention1"

    /// What the trash holds (Snapshot.trash): three day files, 129 MB of screenshots.
    var trash: TrashInfo { TrashInfo(path: "/Users/kevinliu/.jarhead/trash", days: 3, bytes: 129_400_000) }

    /// The one problem the live day carries: Accessibility denied, with Request as its remedy.
    var accessibilityProblem: Problem {
        Problem(kind: "permission.accessibility", text: "Accessibility permission denied — hands can click but cannot read the UI tree.",
                remedy: ProblemRemedy(label: "Request", command: ["type": .string("request-permission"), "which": .string("accessibility")], open: nil), since: ago(40 * 60))
    }

    /// The Problems section (Snapshot.problems): a kind, one line, one remedy each.
    func problems() -> [Problem] {
        [
            Problem(kind: "permission.accessibility", text: "Accessibility not granted: the hands can click but cannot read the UI tree.",
                    remedy: ProblemRemedy(label: "Request", command: ["type": .string("request-permission"), "which": .string("accessibility")], open: nil), since: ago(40 * 60)),
            Problem(kind: "brain.unavailable", text: "Claude Code brain unavailable: did not answer a probe within 30 s.",
                    remedy: ProblemRemedy(label: "Retry", command: ["type": .string("problem.retry"), "kind": .string("brain.unavailable")], open: nil), since: ago(6 * 60)),
            Problem(kind: "voice.limit", text: "GPT-Live-1 refused a note: the session's input history is full (128 items).",
                    remedy: nil, since: ago(3 * 60)),
            // The engine's own words and remedy (packages/engine/src/engine.ts, `disk.low`): the figure
            // and the volume, and "Reveal shots" opens the shots folder — the one thing that frees space.
            Problem(kind: "disk.low", text: "Disk low: 412 MB free on /Users/kevinliu/.jarhead; screenshots are not being saved",
                    remedy: ProblemRemedy(label: "Reveal shots", command: nil, open: "/Users/kevinliu/.jarhead/shots"), since: ago(90)),
        ]
    }

    /// `ledger.search` over the fake rows: heard and said lines, delegation requests and summaries, newest first.
    func searchHits(_ query: String) -> [LedgerHit] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        var hits: [LedgerHit] = []
        let sessions = jarheadSessions()
        let root: [String: String] = {
            var byId: [String: JarheadSessionSummary] = [:]
            for s in sessions { byId[s.id] = s }
            var out: [String: String] = [:]
            for s in sessions {
                var current = s
                while let from = current.resumedFrom, let previous = byId[from] { current = previous }
                out[s.id] = current.id
            }
            return out
        }()
        for s in sessions {
            for row in jarheadRows(for: s.id) {
                let found: (kind: String, text: String)?
                switch row.type {
                case "heard", "said": found = row.item.map { (row.type, $0.text) }
                case "delegation.created": found = row.delegation.map { ("request", $0.request) }
                case "delegation.finished": found = row.summary.map { ("summary", $0) }
                default: found = nil
                }
                guard let found, found.text.lowercased().contains(q) else { continue }
                hits.append(LedgerHit(sessionId: s.id, chainId: root[s.id], at: row.at, type: found.kind, text: found.text, day: s.day))
            }
        }
        return hits.sorted { $0.at > $1.at }
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    func day(_ ms: Double) -> String { Self.dayFormatter.string(from: Date(timeIntervalSince1970: ms / 1000)) }

    /// Newest first, the way `ledger.sessions` answers: the live session (open — the rail
    /// shows it as Now, not here), the chain (B resumed from A), and yesterday's two —
    /// one closed by a lost connection, one never closed at all (lost when the next began).
    func jarheadSessions() -> [JarheadSessionSummary] {
        let live = session()
        let a0 = ago(3 * 3600 + 5 * 60), aClosed = ago(3 * 3600 - 3 * 60)
        let b0 = ago(3 * 3600 - 3 * 60 - 8 * 60), bClosed = ago(2 * 3600 + 31 * 60)
        let y0 = ago(26 * 3600 + 12 * 60), yClosed = ago(26 * 3600 + 2 * 60)
        let l0 = ago(27 * 3600 + 40 * 60)
        // The cleanup scenarios' chains, older still: a pinned one Kevin named, two archived, two trashed.
        let p0 = ago(30 * 3600), pClosed = ago(30 * 3600 - 14 * 60)
        let d0 = ago(50 * 3600), dClosed = ago(50 * 3600 - 6 * 60)
        let s0 = ago(51 * 3600), sClosed = ago(51 * 3600 - 9 * 60)
        let t0 = ago(74 * 3600), tClosed = ago(74 * 3600 - 2 * 60)
        let r0 = ago(75 * 3600), rClosed = ago(75 * 3600 - 20 * 60)
        var pinned = JarheadSessionSummary(id: Self.pinnedId, day: day(p0), startedAt: p0, closedAt: pClosed, reason: "stopped", usageSeconds: 812,
                                           heard: 9, said: 8, delegations: 4, title: "What's blocking the auth branch? Walk me through the", resumedFrom: nil)
        pinned.name = "Auth branch triage"
        pinned.pinned = true
        var docs = JarheadSessionSummary(id: Self.archivedAId, day: day(d0), startedAt: d0, closedAt: dClosed, reason: "stopped", usageSeconds: 360,
                                         heard: 4, said: 4, delegations: 2, title: "Sweep the docs folder for broken links.", resumedFrom: nil)
        docs.state = "archived"
        var slack = JarheadSessionSummary(id: Self.archivedBId, day: day(s0), startedAt: s0, closedAt: sClosed, reason: "idle", usageSeconds: 540,
                                          heard: 6, said: 5, delegations: 3, title: "Read me the Slack thread about the launch.", resumedFrom: nil)
        slack.state = "archived"
        var testRun = JarheadSessionSummary(id: Self.trashedAId, day: day(t0), startedAt: t0, closedAt: tClosed, reason: "stopped", usageSeconds: 120,
                                            heard: 1, said: 1, delegations: 0, title: "Testing, testing.", resumedFrom: nil)
        testRun.state = "trashed"
        testRun.trashedAt = ago(20 * 3600)
        var retention = JarheadSessionSummary(id: Self.trashedBId, day: day(r0), startedAt: r0, closedAt: rClosed, reason: "stopped", usageSeconds: 1200,
                                              heard: 12, said: 11, delegations: 5, title: "Open Codex and pick the landing refresh back up.", resumedFrom: nil)
        retention.state = "trashed"
        retention.trashedAt = ago(2 * 3600)
        let cleanup = [pinned, docs, slack, testRun, retention]
        return [
            JarheadSessionSummary(id: live.id, day: day(live.startedAt), startedAt: live.startedAt, closedAt: nil, reason: nil, usageSeconds: 0,
                                  heard: 4, said: 4, delegations: 3, title: "Hey Jarhead, what's the Claude session doing on the auth", resumedFrom: nil),
            // An idle sleep is the engine closing the session with no transport row before it: the ledger keeps the server's word, the view says "closed".
            JarheadSessionSummary(id: Self.chainResumedId, day: day(b0), startedAt: b0, closedAt: bClosed, reason: "close_requested", usageSeconds: 140,
                                  heard: 2, said: 2, delegations: 1, title: "Okay, carry on — what did Codex do?", resumedFrom: Self.chainPausedId),
            JarheadSessionSummary(id: Self.chainPausedId, day: day(a0), startedAt: a0, closedAt: aClosed, reason: "paused", usageSeconds: 312,
                                  heard: 3, said: 3, delegations: 1, title: "Pull up my sessions and tell me who's stuck.", resumedFrom: nil),
            JarheadSessionSummary(id: Self.yesterdayId, day: day(y0), startedAt: y0, closedAt: yClosed, reason: "connection_lost", usageSeconds: 252,
                                  heard: 2, said: 2, delegations: 1, title: "Open the PR for the landing refresh and read me the diff summ", resumedFrom: nil),
            JarheadSessionSummary(id: Self.lostId, day: day(l0), startedAt: l0, closedAt: y0, reason: "lost", usageSeconds: 0,
                                  heard: 0, said: 0, delegations: 0, title: "", resumedFrom: nil),
        ] + cleanup
    }

    /// One session's rows, its started row through its closed row, the transport rows included.
    func jarheadRows(for id: String) -> [LedgerRow] {
        func row(_ at: Double, _ type: String) -> LedgerRow {
            LedgerRow(at: at, type: type, item: nil, delegation: nil, delegationId: nil, step: nil, status: nil, summary: nil, text: nil, sessionId: nil, reason: nil, usageSeconds: nil, agent: nil)
        }
        func heard(_ at: Double, _ id: String, _ text: String) -> LedgerRow {
            var r = row(at, "heard"); r.item = TranscriptItem(id: id, speaker: .kevin, text: text, startMs: 0, endMs: 2000, at: at, final: true); return r
        }
        func said(_ at: Double, _ id: String, _ text: String) -> LedgerRow {
            var r = row(at, "said"); r.item = TranscriptItem(id: id, speaker: .jarhead, text: text, startMs: 0, endMs: 3000, at: at, final: true); return r
        }
        /// A finished delegation as its created / step / finished rows.
        func delegationRows(_ delId: String, at t0: Double, request: String, summary: String, steps: [DelegationStep]) -> [LedgerRow] {
            let created = Delegation(id: delId, liveId: "live_\(delId)", createdAt: t0, offsetMs: 100, request: request, status: .running, steps: [], summary: nil,
                                     timings: DelegationTimings(delegatedAt: t0, firstThinkingAt: nil, firstCommentaryAt: nil, doneAt: nil))
            var rows: [LedgerRow] = []
            var r = row(t0, "delegation.created"); r.delegation = created; rows.append(r)
            for s in steps { r = row(s.at, "delegation.step"); r.delegationId = delId; r.step = s; rows.append(r) }
            let done = (steps.last?.at ?? t0) + 900
            r = row(done, "delegation.finished"); r.delegationId = delId; r.status = .done; r.summary = summary; rows.append(r)
            return rows
        }
        guard let s = jarheadSessions().first(where: { $0.id == id }) else { return [] }
        var rows: [LedgerRow] = []
        var r = row(s.startedAt, "session.started"); r.sessionId = s.id; r.resumedFrom = s.resumedFrom; rows.append(r)
        let t = s.startedAt
        switch id {
        case Self.chainPausedId:
            rows.append(heard(t + 9_000, "ja1", "Pull up my sessions and tell me who's stuck."))
            rows += delegationRows("del_7q2wz", at: t + 10_200, request: "Kevin asked which sessions are stuck.", summary: "Found one stuck session (gt · sdk).", steps: [
                DelegationStep(id: "ja-s1", at: t + 10_840, kind: .thinking, text: "Listing sessions across ~/.claude and ~/.codex…", tool: nil, screenshotPath: nil),
                DelegationStep(id: "ja-s2", at: t + 11_700, kind: .tool, text: nil, tool: ToolStep(name: "agents_list", input: .object(["project": .string("gt")]), output: nil, ok: true, ms: 188), screenshotPath: nil),
                DelegationStep(id: "ja-s3", at: t + 12_300, kind: .commentary, text: "One session is stuck: gt · sdk, waiting on a prompt.", tool: nil, screenshotPath: nil),
            ])
            rows.append(said(t + 14_000, "ja2", "The gt · sdk session is waiting for you — it wants to know whether to delete the old migrations."))
            rows.append(heard(t + 61_000, "ja3", "Tell it yes, keep going."))
            rows.append(said(t + 63_500, "ja4", "Told it yes. It is running the migration now."))
            var stop = row(t + 4 * 60_000, "stop"); stop.how = "said"; stop.cancelled = "del_9x1vk"; rows.append(stop)
            rows.append(heard(t + 4 * 60_000 + 900, "ja5", "Stop — pause for a bit, I'll be right back."))
            rows.append(said(t + 4 * 60_000 + 2_600, "ja6", "Pausing."))
            var pause = row(s.closedAt! - 400, "pause"); pause.sessionId = s.id; pause.usageSeconds = 312; rows.append(pause)
            // The server's word for the close the pause asked for; the summary (and the view) say "paused".
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "close_requested"; closed.usageSeconds = 312; rows.append(closed)
        case Self.chainResumedId:
            var resume = row(t - 600, "resume"); resume.sessionId = s.id; resume.resumedFrom = Self.chainPausedId; resume.pausedMs = 8 * 60_000; rows.insert(resume, at: 0)
            rows.append(heard(t + 6_000, "jb1", "Okay, carry on — what did Codex do?"))
            rows += delegationRows("del_2m8hd", at: t + 7_100, request: "Kevin asked what Codex did while he was away.", summary: "Codex opened PR #412 and passed the api suite.", steps: [
                DelegationStep(id: "jb-s1", at: t + 7_600, kind: .thinking, text: "Reading the Codex rollout for gt · api hotfix…", tool: nil, screenshotPath: nil),
                DelegationStep(id: "jb-s2", at: t + 8_400, kind: .tool, text: nil, tool: ToolStep(name: "agent_transcript", input: .object(["agentId": .string("sessions:codex:1"), "last": .number(12)]), output: nil, ok: true, ms: 412), screenshotPath: nil),
            ])
            rows.append(said(t + 11_000, "jb2", "Codex finished the api hotfix and opened PR #412; 85 tests pass."))
            var problem = row(t + 40_000, "problem"); problem.text = "Accessibility permission denied — hands can click but cannot read the UI tree."; rows.append(problem)
            rows.append(heard(t + 95_000, "jb3", "Great, that's all for now."))
            // The dismissal: the voice's one-word farewell, the sleep row (why, the cue, that the
            // farewell was said) before the close, then the server's word for the close it asked for.
            rows.append(said(t + 97_000, "jb4", "night."))
            var slept = row(s.closedAt! - 300, "sleep"); slept.sessionId = s.id; slept.cause = "said"; slept.phrase = "that's all for now"; slept.farewell = true; rows.append(slept)
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "close_requested"; closed.usageSeconds = 140; rows.append(closed)
        case Self.yesterdayId:
            rows.append(heard(t + 5_000, "jy1", "Open the PR for the landing refresh and read me the diff summary."))
            rows += delegationRows("del_4kq0p", at: t + 6_300, request: "Kevin asked for the landing refresh PR and its diff summary.", summary: "Read the summary of PR #398 aloud.", steps: [
                DelegationStep(id: "jy-s1", at: t + 7_000, kind: .tool, text: nil, tool: ToolStep(name: "browser_read", input: .object(["url": .string("https://github.com/generaltranslation/gt/pull/398")]), output: nil, ok: true, ms: 1_240), screenshotPath: nil),
            ])
            rows.append(said(t + 12_000, "jy2", "PR #398 replaces the hero with the new blob and trims the pricing table to three tiers."))
            rows.append(heard(t + 40_000, "jy3", "Thanks."))
            rows.append(said(t + 41_500, "jy4", "Anytime."))
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "connection_lost"; closed.usageSeconds = 252; rows.append(closed)
        case Self.pinnedId:
            rows.append(heard(t + 4_000, "jp1", "What's blocking the auth branch? Walk me through the failing tests."))
            rows += delegationRows("del_8auth", at: t + 5_200, request: "Kevin asked what is blocking the auth branch and to walk through the failing tests.", summary: "Two tests fail on the missing-bearer status; the Codex session has a fix queued.", steps: [
                DelegationStep(id: "jp-s1", at: t + 6_000, kind: .tool, text: nil, tool: ToolStep(name: "agents_list", input: .object(["project": .string("gt")]), output: nil, ok: true, ms: 190), screenshotPath: nil),
            ])
            rows.append(said(t + 12_000, "jp2", "Two tests fail on the missing-bearer status code. Codex has a fix queued in the api hotfix session."))
            rows.append(heard(t + 60_000, "jp3", "Pin this one, I'll come back to it."))
            rows.append(said(t + 61_000, "jp4", "Pinned."))
            var renamed = row(t + 62_000, "conversation.renamed"); renamed.chainId = s.id; renamed.name = "Auth branch triage"; rows.append(renamed)
            var pinned = row(t + 62_100, "conversation.pinned"); pinned.chainId = s.id; pinned.pinned = true; rows.append(pinned)
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "close_requested"; closed.usageSeconds = 812; rows.append(closed)
        case Self.trashedBId:
            rows.append(heard(t + 3_000, "jr1", "Open Codex and pick the landing refresh back up."))
            rows += delegationRows("del_3land", at: t + 4_000, request: "Kevin asked Codex to pick the landing refresh back up.", summary: "Codex resumed the landing refresh thread and is editing the hero.", steps: [
                DelegationStep(id: "jr-s1", at: t + 5_000, kind: .tool, text: nil, tool: ToolStep(name: "agent_send", input: .object(["agentId": .string("sessions:codex:thread-9")]), output: nil, ok: true, ms: 640), screenshotPath: nil),
            ])
            rows.append(said(t + 9_000, "jr2", "Codex is back on the landing refresh; it is editing the hero now."))
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "close_requested"; closed.usageSeconds = 1200; rows.append(closed)
            var trashed = row(ago(2 * 3600), "conversation.trashed"); trashed.chainId = s.id; trashed.by = "retention"; rows.append(trashed)
        case Self.trashedAId:
            rows.append(heard(t + 2_000, "jt1", "Testing, testing."))
            rows.append(said(t + 3_000, "jt2", "Loud and clear."))
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "close_requested"; closed.usageSeconds = 120; rows.append(closed)
            var trashed = row(ago(20 * 3600), "conversation.trashed"); trashed.chainId = s.id; trashed.by = "kevin"; rows.append(trashed)
        case Self.archivedAId:
            rows.append(heard(t + 2_000, "jd1", "Sweep the docs folder for broken links."))
            rows.append(said(t + 30_000, "jd2", "Three broken links, all in the SDK page; fixed."))
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "close_requested"; closed.usageSeconds = 360; rows.append(closed)
            var archived = row(ago(40 * 3600), "conversation.archived"); archived.chainId = s.id; rows.append(archived)
        case Self.archivedBId:
            rows.append(heard(t + 2_000, "js1", "Read me the Slack thread about the launch."))
            rows.append(said(t + 20_000, "js2", "Twelve messages. The short version: the launch moves to Thursday."))
            var closed = row(s.closedAt!, "session.closed"); closed.sessionId = s.id; closed.reason = "idle"; closed.usageSeconds = 540; rows.append(closed)
            var archived = row(ago(41 * 3600), "conversation.archived"); archived.chainId = s.id; rows.append(archived)
        default:
            break
        }
        return rows
    }

    func ledgerRows() -> [LedgerRow] {
        func row(_ at: Double, _ type: String) -> LedgerRow {
            LedgerRow(at: at, type: type, item: nil, delegation: nil, delegationId: nil, step: nil, status: nil, summary: nil, text: nil, sessionId: nil, reason: nil, usageSeconds: nil, agent: nil)
        }
        let d = doneDelegation()
        var created = d; created.steps = []; created.status = .running; created.summary = nil; created.timings = DelegationTimings(delegatedAt: d.timings.delegatedAt, firstThinkingAt: nil, firstCommentaryAt: nil, doneAt: nil)
        var rows: [LedgerRow] = []
        var r = row(ago(900), "session.started"); r.sessionId = "sess_7f3a9c2e41b0"; rows.append(r)
        r = row(ago(604), "heard"); r.item = TranscriptItem(id: "l1", speaker: .kevin, text: "Pull up my sessions and tell me who's stuck.", startMs: 0, endMs: 2000, at: ago(604), final: true); rows.append(r)
        r = row(d.createdAt, "delegation.created"); r.delegation = created; rows.append(r)
        for s in d.steps { r = row(s.at, "delegation.step"); r.delegationId = d.id; r.step = s; rows.append(r) }
        r = row(d.timings.doneAt!, "delegation.finished"); r.delegationId = d.id; r.status = .done; r.summary = d.summary; rows.append(r)
        r = row(ago(595), "said"); r.item = TranscriptItem(id: "l2", speaker: .jarhead, text: "The gt · sdk session is waiting for you — it wants to know whether to delete the old migrations.", startMs: 5000, endMs: 9000, at: ago(595), final: true); rows.append(r)
        // Two problems in the same millisecond, the way the engine writes them on a fresh install.
        let sameMs = ago(586)
        r = row(sameMs, "problem"); r.text = "Screen recording permission was revoked by the system."; rows.append(r)
        r = row(sameMs, "problem"); r.text = "Accessibility permission denied — hands can click but cannot read the UI tree."; rows.append(r)
        r = row(ago(583), "agent"); r.agent = agents()[6]; rows.append(r)
        // An idle sleep: the sleep row says why, then the server's word for the close it asked for.
        r = row(ago(61), "sleep"); r.sessionId = "sess_7f3a9c2e41b0"; r.cause = "idle"; rows.append(r)
        r = row(ago(60), "session.closed"); r.sessionId = "sess_7f3a9c2e41b0"; r.reason = "close_requested"; r.usageSeconds = 1020; rows.append(r)
        return rows
    }
}

// MARK: - The kit (step 0): keys through the responder chain, clicks, floats, the pure pins

extension PreviewDelegate {
    /// PREVIEW_ACTION's list, split on commas outside parentheses (`click:(300,300)` is one action).
    static func splitActions(_ list: String) -> [String] {
        var out: [String] = [], current = "", depth = 0
        for ch in list {
            if ch == "(" { depth += 1 } else if ch == ")" { depth = max(0, depth - 1) }
            if ch == ",", depth == 0 { out.append(current); current = "" } else { current.append(ch) }
        }
        out.append(current)
        return out.filter { !$0.isEmpty }
    }

    private var jarheadWindow: NSWindow? { NSApp.windows.first(where: { $0.title == "Jarhead" }) }

    /// `focus:` `menuOpen:` `tipOpen:` `chip:` `highlight:` `fold:<id>:<open|closed>` → userInfo.
    func kitAction(_ action: String) -> [String: Any]? {
        let plain = [ConsolePreviewKey.focus, ConsolePreviewKey.menuOpen, ConsolePreviewKey.tipOpen, ConsolePreviewKey.chip, ConsolePreviewKey.highlight,
                     ConsolePreviewKey.hover, ConsolePreviewKey.leave]
        for key in plain where action.hasPrefix(key + ":") { return [key: String(action.dropFirst(key.count + 1))] }
        if action.hasPrefix("fold:") {
            let parts = action.dropFirst("fold:".count).split(separator: ":").map(String.init)
            guard parts.count == 2 else { return nil }
            return [ConsolePreviewKey.fold: parts[0], ConsolePreviewKey.foldOpen: parts[1] == "open"]
        }
        return nil
    }

    /// A key's virtual code, characters and modifiers, by the name `keyDown:` takes.
    static func keySpec(_ name: String) -> (code: UInt16, chars: String, flags: NSEvent.ModifierFlags)? {
        switch name {
        case "escape": return (53, "\u{1b}", [])
        case "return": return (36, "\r", [])
        case "space": return (49, " ", [])
        case "tab": return (48, "\t", [])
        case "up": return (126, "\u{F700}", .function)
        case "down": return (125, "\u{F701}", .function)
        case "left": return (123, "\u{F702}", .function)
        case "right": return (124, "\u{F703}", .function)
        case "?": return (44, "?", .shift)
        /// ⌘↓ — the list's verbs float (`ConsoleListModel.command`).
        case "cmd-down": return (125, "\u{F701}", [.function, .command])
        default: break
        }
        let letters: [Character: UInt16] = ["a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
                                            "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46]
        guard name.count == 1, let ch = name.first, let code = letters[ch] else { return nil }
        return (code, name, [])
    }

    static func keyEvent(_ name: String, window: NSWindow, down: Bool) -> NSEvent? {
        guard let spec = keySpec(name) else { return nil }
        return NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: spec.flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                windowNumber: window.windowNumber, context: nil, characters: spec.chars, charactersIgnoringModifiers: spec.chars,
                                isARepeat: false, keyCode: spec.code)
    }

    /// `keyDown:<name>[+<name>…]`: each key down and up through the window's sendEvent, 40 ms apart.
    func keyDown(_ spec: String, stamp: String) {
        guard let window = jarheadWindow else { print("action: keyDown \(spec) at \(stamp)s → no window"); return }
        window.makeKeyAndOrderFront(nil)
        for (index, name) in spec.split(separator: "+").map(String.init).enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04 * Double(index)) {
                guard let down = Self.keyEvent(name, window: window, down: true), let up = Self.keyEvent(name, window: window, down: false) else {
                    print("action: keyDown \(name) → unknown key (see the names in the header)")
                    return
                }
                window.sendEvent(down)
                window.sendEvent(up)
                let responder = window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
                print("action: keyDown \(name) at \(stamp)s → key=\(window.isKeyWindow) firstResponder=\(responder)")
            }
        }
    }

    /// `click:(x,y)` — points from the content view's top-left; a left mouse down and up through sendEvent.
    func click(_ spec: String, stamp: String) {
        let numbers = spec.split(whereSeparator: { !"0123456789.".contains($0) }).compactMap { Double($0) }
        guard numbers.count == 2, let window = jarheadWindow, let content = window.contentView else { print("action: click \(spec) → want (x,y) and a window"); return }
        let point = NSPoint(x: numbers[0], y: content.bounds.height - numbers[1])
        window.makeKeyAndOrderFront(nil)
        let before = window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        let hit = content.hitTest(point).map { String(describing: type(of: $0)) } ?? "nil"
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
                window.sendEvent(event)
            }
        }
        let after = window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        print("action: click (\(Int(numbers[0])),\(Int(numbers[1]))) at \(stamp)s → hit \(hit); firstResponder \(before) → \(after)")
    }

    /// `probe-floats`: the rect of every float the layer has placed, in the root's space.
    func probeFloats(stamp: String) {
        let placed = ConsoleFloatSlot.placed
        floatProbes.append(placed)
        guard !placed.isEmpty else { print("probe-floats: none at \(stamp)s"); return }
        let line = placed.keys.sorted().map { id -> String in
            let r = placed[id] ?? .zero
            return String(format: "%@ x=%.1f y=%.1f w=%.1f h=%.1f", id, r.minX, r.minY, r.width, r.height)
        }.joined(separator: " · ")
        print("probe-floats: \(line) at \(stamp)s")
    }

    /// `check-kit`: the kit's pure pins as `check: ok|FAIL` lines.
    func checkKit(stamp: String) {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        func fmt(_ r: CGRect) -> String { String(format: "%.0f,%.0f %.0f×%.0f", r.minX, r.minY, r.width, r.height) }
        let bounds = CGRect(x: 0, y: 0, width: 1180, height: 760)
        let field = CGRect(x: 900, y: 200, width: 182, height: 26)
        let popup = CGSize(width: 220, height: 300)
        expect("placement: below, leading-aligned, gap 4", fmt(ConsoleFloatPlacement.rect(anchor: field, size: popup, bounds: bounds, edge: .below)), "900,230 220×300")
        let low = CGRect(x: 900, y: 600, width: 182, height: 26)
        expect("placement: flips above when short", fmt(ConsoleFloatPlacement.rect(anchor: low, size: popup, bounds: bounds, edge: .below)), "900,296 220×300")
        let right = CGRect(x: 1000, y: 200, width: 182, height: 26)
        expect("placement: clamps x to maxX − 8", fmt(ConsoleFloatPlacement.rect(anchor: right, size: CGSize(width: 300, height: 300), bounds: bounds, edge: .below)), "872,230 300×300")
        let row = CGRect(x: 8, y: 300, width: 244, height: 44)
        let card = CGSize(width: 280, height: 160)
        expect("placement: trailing beside a rail row, top-aligned", fmt(ConsoleFloatPlacement.rect(anchor: row, size: card, bounds: bounds, edge: .trailing)), "256,300 280×160")
        let rightRow = CGRect(x: 900, y: 300, width: 260, height: 44)
        expect("placement: trailing flips to leading when short", fmt(ConsoleFloatPlacement.rect(anchor: rightRow, size: card, bounds: bounds, edge: .trailing)), "616,300 280×160")
        let clamped = ConsoleFloatPlacement.rect(anchor: right, size: CGSize(width: 300, height: 300), bounds: bounds, edge: .below)
        expect("placement: arrow points at the anchor's centre", String(format: "%.0f", ConsoleFloatPlacement.arrowOffset(anchor: right, rect: clamped, side: .below)), "219")
        let corner = CGRect(x: 870, y: 200, width: 4, height: 26)
        expect("placement: arrow ≥ r + 4 from a corner", String(format: "%.0f", ConsoleFloatPlacement.arrowOffset(anchor: corner, rect: clamped, side: .below)), "10")
        expect("placement: max list height under the field", String(format: "%.0f", ConsoleFloatPlacement.maxListHeight(anchor: field, bounds: bounds, side: .below)), "522")
        expect("placement: size == .zero places at the preferred side", fmt(ConsoleFloatPlacement.rect(anchor: field, size: .zero, bounds: bounds, edge: .below)), "900,230 0×0")
        expect("tip delay: cold 2.0 s", "\(ConsoleTip.delay(sinceLastHide: 2.0))", "0.35")
        expect("tip delay: warm 0.2 s", "\(ConsoleTip.delay(sinceLastHide: 0.2))", "0.0")
        expect("tip delay: never hidden", "\(ConsoleTip.delay(sinceLastHide: -1))", "0.35")
        func badge(_ w: ConsoleBadge.Word) -> String { "\(ConsoleBadge.text(w)) · \(ConsoleBadge.toneKind(w).rawValue)" }
        expect("badge: fits titanium", badge(.fits), "fits · rest")
        expect("badge: tight speaking", badge(.tight), "tight · speaking")
        expect("badge: too big error", badge(.tooBig), "too big · error")
        expect("badge: missing(1) speaking", badge(.missing(1)), "1 missing · speaking")
        expect("badge: asks speaking", badge(.asks), "asks · speaking")
        expect("badge: asks(1) is one badge", badge(.asks(1)), "1 asks · speaking")
        expect("badge: off speaking", badge(.off), "off · speaking")
        expect("badge: failed error", badge(.failed), "failed · error")
        expect("badge: resting words", [ConsoleBadge.Word.noTools, .loaded, .saved, .auto, .default, .noKey, .thisMac, .ready, .allOk].map(badge).joined(separator: " / "),
               "no tools · rest / loaded · rest / saved · rest / auto · rest / default · rest / no key · rest / this Mac · rest / Ready · rest / all ok · rest")
        expect("badge: a figure is mono", "\(ConsoleBadge.isFigure(.figure("17 GB"))) \(ConsoleBadge.isFigure(.word("live")))", "true false")
        for entry in HelpCopy.all { expect("copy: \(entry.name)", HelpCopy.violations(entry).joined(separator: ", "), "") }
        expect("copy: catches a full stop and you", HelpCopy.violations(HelpCopy.Entry(name: "Forget", hint: "Forget your circle.")).joined(separator: ", "), "full stop, says you")
        expect("copy: catches the shortcut in the hint", HelpCopy.violations(HelpCopy.Entry(name: "Go", hint: "Go (⌘P)", key: "⌘P")).joined(separator: ", "), "shortcut in the hint")
        expect("copy: spoken form carries the key last", HelpCopy.spoken(HelpCopy.go), "Open the live session (⌘P)")
        expect("copy: a thread's verb carries its name", HelpCopy.stopThread("Slack").hint, "Stop Slack — the others carry on")
        checkTipCards(expect)
        checkKitMenu(expect)
        failed += checkKitLists()
        failed += checkKitRail()
        print("check: \(failed == 0 ? "all ok" : "\(failed) FAILED") (kit) at \(stamp)s")
    }

    /// The tip's pure pins: the card's spoken form, the stable id, the outline's arrow inside its frame.
    func checkTipCards(_ expect: (String, String, String) -> Void) {
        let t0: Double = 1_757_856_000_000
        if let slack = fake?.thread(FakeData.slackId, status: .waitingKevin, startedAt: t0) {
            let card = ConsoleTipCard.thread(slack)
            expect("tip card: thread title · badge · lines", "\(card.title) · \(card.badge.map(ConsoleBadge.text) ?? "-") · \(card.lines.count) lines · foot \(card.foot.map(\.key).joined(separator: " "))",
                   "Slack · asks · 2 lines · foot started lane steps budget")
            expect("tip card: thread spoken", card.spoken,
                   "Slack, asks, Send “running late — there in 10” to Ben?, tell Ben on Slack that Kevin is running late, started \(ConsoleFormat.time(t0)), lane screen, steps 4 · 1 turn, budget 25 steps / 180 s, Opens its pane ⏎")
            expect("tip card: thread meta line", ConsoleTipCard.threadMetaLine(slack), "started \(ConsoleFormat.time(t0)) · 1 turn · budget 25 steps / 180 s")
        }
        expect("tip card: connection foot", ConsoleTipCard.connection(connected: true, detail: "engine · pid 48213").spoken, "Connected, daemon engine · pid 48213")
        expect("tip card: chain sessions", ConsoleTipCard.chain(sessionIds: ["7f3a9c2e41b0aaaa", "8c1d2e3f4a5b6c7d"]).spoken, "2 sessions, 7f3a9c2e → 8c1d2e3f")
        expect("tip card: empty lines drop", ConsoleTipCard(title: "T", lines: ["", "a"]).spoken, "T, a")
        expect("tip id: stable and distinct", "\(ConsoleTip.id(for: "Go") == ConsoleTip.id(for: "Go")) \(ConsoleTip.id(for: "Go") != ConsoleTip.id(for: "Pause"))", "true true")
        let rect = CGRect(x: 0, y: 0, width: 200, height: 40)
        let below = ConsoleTipOutline(side: .below, arrow: 20).path(in: rect)
        expect("tip arrow: inside the frame, on the facing edge", "\(below.boundingRect == rect) \(below.contains(CGPoint(x: 20, y: 1))) \(below.contains(CGPoint(x: 40, y: 1))) \(below.contains(CGPoint(x: 40, y: 6)))", "true true false true")
        let trailing = ConsoleTipOutline(side: .trailing, arrow: 12).path(in: rect)
        expect("tip arrow: beside a row it points left", "\(trailing.contains(CGPoint(x: 1, y: 12))) \(trailing.contains(CGPoint(x: 1, y: 30)))", "true false")
        expect("tip words", "\(ConsoleTipWords.opensPane) \(ConsoleTipWords.returnKey) \(ConsoleTipWords.question)", "Opens its pane ⏎ ?")
        expect("tip bubble: the arrow's edge faces the anchor", "\(ConsoleTipBubble<EmptyView>.arrowEdge(.below) == .top) \(ConsoleTipBubble<EmptyView>.arrowEdge(.trailing) == .leading)", "true true")
    }

    /// `check-tips`: from the `tip:` trail — the cold tip waited, the warm one showed at once.
    func checkTips(stamp: String) {
        let shown = tipLog.compactMap { line -> (String, Double)? in
            let parts = line.split(separator: " ").map(String.init)
            guard parts.count >= 5, parts[0] == "shown", parts[2] == "after", let ms = Double(parts[3]) else { return nil }
            return (parts[1], ms)
        }
        guard shown.count >= 2 else { print("check: FAIL tips — wanted two `shown` lines, got \(tipLog)"); return }
        let cold = shown[0], warm = shown[1]
        let coldOk = cold.1 >= 300, warmOk = warm.1 <= 16   // shown on the hover's own pass: a frame at most, never a hop
        print(String(format: "check: %@ tip cold waits 350 ms → %@ after %.0f ms", coldOk ? "ok  " : "FAIL", cold.0, cold.1))
        print(String(format: "check: %@ tip warm shows at once → %@ after %.0f ms", warmOk ? "ok  " : "FAIL", warm.0, warm.1))
        print("check: \(coldOk && warmOk ? "all ok" : "FAILED") (tips) at \(stamp)s")
    }

    /// `check-floats:<none|id[+id]>`: exactly those floats are open, and the composer has not taken focus.
    func checkFloats(_ spec: String, stamp: String) {
        let want = spec == "none" ? [] : spec.split(separator: "+").map(String.init).sorted()
        let have = ConsoleFloatSlot.placed.keys.sorted()
        let responder = jarheadWindow?.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        let composerFree = !responder.contains("TextView")
        print("check: \(have == want ? "ok  " : "FAIL") floats open → \(have.isEmpty ? "none" : have.joined(separator: "+"))\(have == want ? "" : " (want \(spec))")")
        print("check: \(composerFree ? "ok  " : "FAIL") composer not focused → firstResponder \(responder)")
        print("check: \(have == want && composerFree ? "all ok" : "FAILED") (floats) at \(stamp)s")
    }

    /// The dropdown's pure pins (Builder B): sections, steps, type-ahead, the words, the Local words.
    func checkKitMenu(_ expect: (String, String, String) -> Void) {
        let voices = ConsoleTheme.voices
        let groups = ConsoleMenuModel.sections(voices, group: VoiceWords.group, title: VoiceWords.name, detail: nil, query: "")
        expect("menu: sections voice groups", groups.map { "\($0.title ?? "-")[\($0.rows.count)]" }.joined(separator: " "), "Default[1] Also[2] All voices[19]")
        let ma = ConsoleMenuModel.sections(voices, group: VoiceWords.group, title: VoiceWords.name, detail: nil, query: "ma")
        expect("menu: sections query ma", ma.flatMap(\.rows).map(VoiceWords.name).joined(separator: ", "), "Marin, Meridian")
        expect("menu: empty groups vanish while filtering", ma.map { $0.title ?? "-" }.joined(separator: " · "), "Also · All voices")
        guard let up = fake?.ollamaUp() else { expect("menu: the local fixture", "none", "fixtures"); return }
        expect("menu: model order fits → tight → too big → no tools", LocalBrainWords.modelRows(saved: "qwen3:8b", status: up).joined(separator: ","),
               ",qwen3.5:27b,qwen3.5:9b,llama3.3:70b,gpt-oss:120b,deepseek-v3.1:671b,gemma4:31b,qwen3:8b")
        let rows = ["a", "b", "c", "d"]
        let off: (String) -> Bool = { $0 == "c" }
        expect("menu: step clamps at the end", ConsoleMenuModel.step("d", by: 1, in: rows, disabled: { _ in false }) ?? "nil", "d")
        expect("menu: step clamps at the top", ConsoleMenuModel.step("a", by: -1, in: rows, disabled: { _ in false }) ?? "nil", "a")
        expect("menu: step skips disabled", ConsoleMenuModel.step("b", by: 1, in: rows, disabled: off) ?? "nil", "d")
        expect("menu: step back skips disabled", ConsoleMenuModel.step("d", by: -1, in: rows, disabled: off) ?? "nil", "b")
        expect("menu: step from nothing lands on the first", ConsoleMenuModel.step(nil, by: 1, in: rows, disabled: off) ?? "nil", "a")
        expect("menu: ⌥↓ goes to the last enabled", ConsoleMenuModel.step("a", by: 4, in: rows, disabled: off) ?? "nil", "d")
        expect("menu: typeAhead finds the next", ConsoleMenuModel.typeAhead(voices, title: VoiceWords.name, prefix: "s", after: "ripple") ?? "nil", "sage")
        expect("menu: typeAhead wraps", ConsoleMenuModel.typeAhead(voices, title: VoiceWords.name, prefix: "b", after: "willow") ?? "nil", "ballad")
        expect("menu: typeAhead passes the highlight", ConsoleMenuModel.typeAhead(voices, title: VoiceWords.name, prefix: "c", after: "cedar") ?? "nil", "cinder")
        expect("menu: filterPlaceholder", ConsoleMenuModel.filterPlaceholder(count: 22, noun: "voices"), "Filter 22 voices")
        expect("menu: countWord typing", ConsoleMenuModel.countWord(shown: 2, of: 22, typing: true), "2 of 22")
        expect("menu: countWord at rest", ConsoleMenuModel.countWord(shown: 22, of: 22, typing: false), "22")
        let w = ConsoleMenuModel.width(field: 182, minimum: 300, bounds: CGRect(x: 0, y: 0, width: 1180, height: 760), anchorMinX: 986)
        expect("menu: width clamp", String(format: "x=%.0f w=%.0f", w.x, w.w), "x=872 w=300")
        let narrow = ConsoleMenuModel.width(field: 400, minimum: 220, bounds: CGRect(x: 0, y: 0, width: 1180, height: 760), anchorMinX: 100)
        expect("menu: width takes the field when wider", String(format: "x=%.0f w=%.0f", narrow.x, narrow.w), "x=100 w=400")
        expect("menu: filter past eight rows", "\(ConsoleMenuModel.showsFilter(nil, count: 8)) \(ConsoleMenuModel.showsFilter(nil, count: 9)) \(ConsoleMenuModel.showsFilter(true, count: 2))", "false true true")
        checkKitWords(expect, up: up)
    }

    /// The sites' words: the Local rows, the voices, the backends, the toggle, the Effort foot.
    func checkKitWords(_ expect: (String, String, String) -> Void, up: LocalServerStatus) {
        expect("local: size", LocalBrainWords.size("qwen3.5:27b", status: up) ?? "nil", "17 GB")
        expect("local: badges", ["", "qwen3.5:27b", "gpt-oss:120b", "deepseek-v3.1:671b", "gemma4:31b", "qwen3:8b"]
            .map { LocalBrainWords.badges($0, status: up).map(ConsoleBadge.text).joined(separator: "+") }.joined(separator: " / "),
               "auto / fits / tight / too big / no tools / saved")
        expect("local: meta", LocalBrainWords.meta("qwen3.5:27b", status: up) ?? "nil", "256k · tools · vision · thinking")
        expect("local: meta of a saved id", LocalBrainWords.meta("qwen3:8b", status: up) ?? "nil", "not on Ollama 0.34.0")
        expect("local: groups", ["", "qwen3.5:9b", "qwen3:8b"].map { LocalBrainWords.group($0, status: up) }.joined(separator: " / "), "Automatic / On Ollama 0.34.0 / Saved, not listed")
        expect("local: group count and caption", "\(LocalBrainWords.groupCount("On Ollama 0.34.0", status: up) ?? "nil") · \(LocalBrainWords.groupCaption("On Ollama 0.34.0", status: up) ?? "nil")", "5 can call tools · size · fit")
        expect("local: field", "\(LocalBrainWords.fieldTitle(saved: "", status: up)) [\(LocalBrainWords.fieldBadge(saved: "", status: up).map(ConsoleBadge.text) ?? "-")]", "qwen3.5:27b [auto]")
        expect("local: field saved unlisted is quiet", "\(LocalBrainWords.fieldTitle(saved: "qwen3:8b", status: up)) \(LocalBrainWords.isQuiet(saved: "qwen3:8b", status: up))", "qwen3:8b true")
        expect("local: disabled is the tool-less one", "\(LocalBrainWords.isDisabled("gemma4:31b", status: up)) \(LocalBrainWords.isDisabled("deepseek-v3.1:671b", status: up))", "true false")
        expect("local: loaded", "\(LocalBrainWords.isLoaded("qwen3.5:27b", status: up)) \(LocalBrainWords.isLoaded("qwen3.5:9b", status: up))", "true false")
        expect("local: foot tight", LocalBrainWords.foot("gpt-oss:120b", status: up) ?? "nil", "gpt-oss:120b · 65 GB on a 137 GB Mac — tight: slow first token, swaps under load.")
        expect("local: foot too big", LocalBrainWords.foot("deepseek-v3.1:671b", status: up) ?? "nil", "deepseek-v3.1:671b · 404 GB on a 137 GB Mac — too big: it will not load.")
        expect("local: foot no tools", LocalBrainWords.foot("gemma4:31b", status: up) ?? "nil", "gemma4:31b cannot call tools — the hands need them, so it is listed and greyed.")
        expect("voice: default badge", VoiceWords.badges("ballad").map(ConsoleBadge.text).joined(), "default")
        expect("voice: saved outside the list", "\(VoiceWords.group("nova")) · \(VoiceWords.badges("nova").map(ConsoleBadge.text).joined()) · \(VoiceWords.meta("nova") ?? "nil")", "Saved, not listed · saved · from env")
        expect("voice: the field shows the name alone", VoiceWords.name("cedar"), "Cedar")
        expect("brain: badges", BrainKind.allCases.map { BrainWords.badge($0).map(ConsoleBadge.text).joined() }.joined(separator: ","), ",no key,no key,,,,this Mac")
        expect("brain: needs is the foot", BrainWords.needs(.local), "A model on this Mac through Ollama or LM Studio. Everything but the voice stays here.")
        expect("toggle: word", "\(ConsoleToggle.word(true)) | \(ConsoleToggle.word(false))", "On | Off")
        expect("segments: heights", "\(ConsoleSegments<Bool>.height(.rail)) \(ConsoleSegments<Bool>.height(.row)) \(ConsoleSegments<Bool>.height(.toggle))", "28.0 26.0 22.0")
        expect("field: heights", "\(ConsoleField.height(.edit)) \(ConsoleField.height(.filter)) \(ConsoleField.height(.row)) \(ConsoleField.height(.composer))", "22.0 24.0 26.0 32.0")
        for level in ConsoleTheme.efforts {
            let hint = HelpCopy.effort(level) ?? ""
            expect("copy: effort \(level)", HelpCopy.violations(HelpCopy.Entry(name: level, hint: hint)).joined(separator: ", ") + (hint.isEmpty ? "empty" : ""), "")
        }
    }
}

// MARK: - The kit (Builder C): rows, lists, disclosures — the pure pins

extension PreviewDelegate {
    /// `ConsoleListModel` (heights · step · typeAhead · kinds · months · keys) and the disclosure
    /// summaries' words, as `check:` lines; returns how many failed (folded into `check-kit`'s total).
    func checkKitLists() -> Int {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        expect("row height: one line", "\(Int(ConsoleListModel.height(lines: 1, meta: false)))", "28")
        expect("row height: title + meta", "\(Int(ConsoleListModel.height(lines: 1, meta: true)))", "40")
        expect("row height: two lines + meta", "\(Int(ConsoleListModel.height(lines: 2, meta: true)))", "56")
        expect("row height: agents rail", "\(Int(ConsoleListModel.height(lines: 1, meta: true, rail: .agents)))", "44")
        let ids = ["a", "b", "c"]
        expect("list step: clamps at the end", ConsoleListModel.step("c", by: 1, in: ids) ?? "nil", "c")
        expect("list step: clamps at the top", ConsoleListModel.step("a", by: -1, in: ids) ?? "nil", "a")
        expect("list step: nothing focused → first on down", ConsoleListModel.step(nil, by: 1, in: ids) ?? "nil", "a")
        expect("list step: nothing focused → last on up", ConsoleListModel.step(nil, by: -1, in: ids) ?? "nil", "c")
        let titles = ["Ballad", "Cedar", "Coral", "Marin"]
        expect("list typeAhead: next after the highlight", ConsoleListModel.typeAhead(titles, title: { $0 }, prefix: "c", after: "Cedar") ?? "nil", "Coral")
        expect("list typeAhead: wraps to the top", ConsoleListModel.typeAhead(titles, title: { $0 }, prefix: "b", after: "Marin") ?? "nil", "Ballad")
        expect("list countWord", ConsoleListModel.countWord(shown: 2, of: 7, typing: true) + " / " + ConsoleListModel.countWord(shown: 7, of: 7, typing: false), "2 of 7 / 7")
        let kinds = ConsoleListModel.memoryKinds(fake?.memoryList(state: "live", limit: 30) ?? [])
        expect("memory kinds: first-seen order with counts", kinds.map { "\(MemoryWords.kindChip($0.kind)) \($0.count)" }.joined(separator: " · "), "fact 2 · pref 2 · how 1 · who 1 · where 1")
        expect("memory kinds: every chip word", MemoryKind.allCases.map(MemoryWords.kindChip).joined(separator: ","), "pref,fact,when,how,who,where")
        let sept = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 14)) ?? Date()
        let months = ConsoleListModel.ledgerMonths(["2026-09-10", "2026-09-09", "2026-08-31", "2025-12-01"], now: sept)
        expect("ledger months: first-seen, the year only when not this one", months.map { "\($0.title)[\($0.days.count)]" }.joined(separator: " "), "September[2] August[1] December 2025[1]")
        expect("list keys: ⌘↓ floats the row's verbs", "\(ConsoleListModel.command(.down, option: false, command: true, typeAhead: true))", "verbs")
        expect("list keys: any other ⌘ is the window's", "\(ConsoleListModel.command(.up, option: false, command: true, typeAhead: true))", "ignore")
        let nested = [ConsoleVerb(id: "edit", title: "Edit"), ConsoleVerb(id: "kind", title: "Kind", children: [ConsoleVerb(id: "kind.pref", title: "pref", checked: true), ConsoleVerb(id: "kind.fact", title: "fact")]),
                      ConsoleVerb(id: "forget", title: "Forget", separatorBefore: true)]
        expect("verb float: children under their parent, the checked one current", ConsoleVerbFloatModel.flat(nested).map { "\($0.id) \($0.title)\($0.checked ? " ✓" : "")" }.joined(separator: " · ") + " → " + ConsoleVerbFloatModel.spec(id: "row", verbs: nested, close: {}).current,
               "edit Edit · kind/kind.pref Kind › pref ✓ · kind/kind.fact Kind › fact · forget Forget → kind/kind.pref")
        expect("list keys: ⌥↓ jumps to the end", "\(ConsoleListModel.command(.down, option: true, command: false, typeAhead: true))", "jump(toEnd: true)")
        expect("list keys: Space is never a yes", "\(ConsoleListModel.command(.space, option: false, command: false, typeAhead: true))", "swallow")
        expect("list keys: a letter types ahead only without a filter", "\(ConsoleListModel.command(.char("m"), option: false, command: false, typeAhead: false))", "ignore")
        // The folded heads' words (ConsoleDisclosureSummary): the seven Settings heads, a permission
        // area, a problem kind, a tool's agents, a ledger month, a fold.
        let text = ConsoleDisclosureSummary.text
        expect("disclosure: Audio", text(ConsoleDisclosureSummary.audio(voice: "Cedar", accent: "British")), "Cedar · British")
        expect("disclosure: Brain", text(ConsoleDisclosureSummary.brain(kind: "Local", model: "qwen3.5:27b", ready: true)), "Local · qwen3.5:27b · [Ready]")
        expect("disclosure: Leaves the Mac", text(ConsoleDisclosureSummary.leaves(cloud: 2, mac: 2)), "2 cloud · 2 mac")
        expect("disclosure: Session", text(ConsoleDisclosureSummary.session(home: "Notch", idleMinutes: 10)), "Notch · 10 min")
        expect("disclosure: Memory", text(ConsoleDisclosureSummary.memory(enabled: true, learnedAgo: "12m")), "[learned 12m]")
        expect("disclosure: Memory off", text(ConsoleDisclosureSummary.memory(enabled: false, learnedAgo: "12m")), "[off]")
        expect("disclosure: Retention", text(ConsoleDisclosureSummary.retention(ledgerDays: nil, trashDays: 30)), "forever · 30 d")
        expect("disclosure: Wake", text(ConsoleDisclosureSummary.wake(enabled: false, phrases: 2)), "[off]")
        expect("disclosure: Permissions area missing", text(ConsoleDisclosureSummary.permissionGroup(missing: ["Input Monitoring"], granted: ["Accessibility"])), "[1 missing] · Input Monitoring")
        expect("disclosure: Permissions area granted", text(ConsoleDisclosureSummary.permissionGroup(missing: [], granted: ["Desktop", "Documents"])), "Desktop · Documents")
        expect("disclosure: Problems kind", text(ConsoleDisclosureSummary.problemGroup(first: "Delegation failed: Codex session refused input")), "Delegation failed: Codex session refused input")
        expect("disclosure: Ready", text(ConsoleDisclosureSummary.ready(notReady: 0)) + " / " + text(ConsoleDisclosureSummary.ready(notReady: 1)), "[all ok] / [1 missing]")
        expect("disclosure: Codex agents", text(ConsoleDisclosureSummary.agents(asks: 1, working: 2, idle: 1, done: 1)), "[1 asks] · 2 working")
        expect("disclosure: idle agents", text(ConsoleDisclosureSummary.agents(asks: 0, working: 0, idle: 3, done: 1)), "3 idle")
        expect("disclosure: September", text(ConsoleDisclosureSummary.ledgerMonth(read: 1, billedSeconds: 3_720)) + " / " + text(ConsoleDisclosureSummary.ledgerMonth(read: 0, billedSeconds: 0)), "62.0 min · " + TransportFormat.dollars(3_720) + " / ")
        expect("disclosure: Trash fold", text(ConsoleDisclosureSummary.fold(inside: "3 days · 129 MB")), "3 days · 129 MB")
        expect("fold store: remembers in memory when not persisting", { ConsoleFoldStore.persists = false; ConsoleFoldStore.set("kit.check", false); return "\(ConsoleFoldStore.isOpen("kit.check", default: true))" }(), "false")
        return failed
    }
}

// MARK: - The right rail (Builder D): the folded heads, the areas and kinds, the rows' words — the pure pins

extension PreviewDelegate {
    /// `RightRailView`'s pure words (the Settings index, the Permissions areas, the Problems kinds, a
    /// thread row's line, the ledger's figures and filter, the mic dropdown's groups and badges) as
    /// `check:` lines; returns how many failed (folded into `check-kit`'s total).
    func checkKitRail() -> Int {
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        let text = ConsoleDisclosureSummary.text
        expect("rail: the seven fold ids", SettingsWords.folds.joined(separator: ","),
               "settings.audio,settings.brain,settings.leaves,settings.session,settings.memory,settings.retention,settings.wake")
        expect("rail: toggle hints", [SettingsWords.autoWakeHint, SettingsWords.rememberHint, SettingsWords.wakeHint].joined(separator: " / "),
               "wakes on launch / learns nothing while off / listens on-device")
        expect("rail: filter days", "\(LedgerWords.filterDays) · \(LedgerWords.filterPast) · \(LedgerWords.unread)", "Filter days · 8 · —")
        guard let fake else { expect("rail: fixtures", "none", "fixtures"); return failed }
        // Permissions: the areas, their counts and the closed heads' words.
        let all = fake.permissions(microphone: .granted, screenRecording: .unknown, accessibility: .denied).all
        let senses = PermissionsRailList.rows(all, in: .senses), hands = PermissionsRailList.rows(all, in: .hands), files = PermissionsRailList.rows(all, in: .files)
        expect("rail: permission areas", "\(senses.count) \(hands.count) \(files.count)", "6 3 7")
        expect("rail: Senses head", text(PermissionsRailList.summary(senses)), "[1 missing] · screenRecording")
        expect("rail: Hands head", text(PermissionsRailList.summary(hands)), "[1 missing] · accessibility")
        expect("rail: Files head", text(PermissionsRailList.summary(files)), "fullDiskAccess · contacts · +5")
        expect("rail: Problems kind head line", ProblemsRailList.headLine("Delegation failed: Codex session refused input") ?? "nil", "Delegation failed: Codex s…")
        expect("rail: Permissions folded", text(PermissionsRailList.headSummary(all)), "[2 missing]")
        expect("rail: a granted set is all ok", text(PermissionsRailList.headSummary(fake.permissions(microphone: .granted, screenRecording: .granted, accessibility: .granted).all)), "[all ok]")
        let denied = all.first { $0.kind == .accessibility }, notAsked = all.first { $0.kind == .screenRecording }
        expect("rail: a denied grant opens Settings", "\(denied.map(PermissionRailRow.opensSettings) ?? false) \(notAsked.map(PermissionRailRow.opensSettings) ?? false)", "true true")
        expect("rail: the why is the row's line 2", PermissionRailRow.meta(PermissionInfo(kind: .microphone, grant: .granted, ask: .prompt, required: true, label: "Microphone", why: "hears you")) ?? "nil", "hears you")
        // Problems: Kevin's grants apart from the engine's; `since 10:08 · Retry` under the line.
        let problems = fake.problems()
        expect("rail: problem kinds", problems.map { ProblemsRailList.isGrant($0) ? "grant" : "engine" }.joined(separator: ","), "grant,engine,engine,engine")
        expect("rail: Problems folded", text(ProblemsRailList.summary(problems)), "[1 missing] · 3 engine")
        if let p = problems.last {
            expect("rail: problem meta", ProblemsRailList.meta(p), "since \(ConsoleFormat.time(p.since)) · Reveal shots")
            expect("rail: problem remedy tip opens", ProblemsRailList.remedyTip(p), "Opens \(ConsoleFormat.truncPath("/Users/kevinliu/.jarhead/shots", max: 40))")
        }
        expect("rail: problem remedy tip sends", ProblemsRailList.remedyTip(problems[0]), "Sends request-permission")
        expect("rail: problem verb word", [ProblemRailRow.verbWord("Request"), ProblemRailRow.verbWord("Reveal shots"), ProblemRailRow.verbWord(nil)].joined(separator: " "), "Ask Reveal Retry")
        // Threads: the status word first, then the figures.
        let t0: Double = 1_757_856_000_000
        let slack = fake.thread(FakeData.slackId, status: .waitingKevin, startedAt: t0)
        expect("rail: thread word", "\(ThreadRailRow.word(slack) ?? "-") / \(ThreadRailRow.word(fake.thread(FakeData.slackId, status: .acting, startedAt: t0)) ?? "-")", "- / " + ConsoleTheme.thread(.acting).label)
        expect("rail: thread line", ThreadRailRow.line(slack, now: t0 + 6_000), ConsoleFormat.threadMeta(slack, now: t0 + 6_000))
        // Leaves the Mac: the destinations counted.
        let paths = fake.cloudPaths(brain: "x")
        expect("rail: leaves counts", "\(LeavesSection.counts(paths).cloud) \(LeavesSection.counts(paths).mac)", "4 0")
        // Ledger: figures once read, `—` until then; the filter matches the date and the words.
        let stats = StreamBuilder.stats(fake.ledgerRows())
        expect("rail: day figures", LedgerPanel.figures("2026-09-10", in: ["2026-09-10": stats]) + " / " + LedgerPanel.figures("2026-09-09", in: [:]), ConsoleFormat.billed(stats.billedSeconds) + " / —")
        let sept = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 14)) ?? Date()
        expect("rail: filter days by date and word", LedgerPanel.filtered(["2026-09-10", "2026-08-31"], query: "08", now: sept).joined() + " / " + LedgerPanel.filtered(["2026-09-10", "2026-08-31"], query: "thu", now: sept).joined(), "2026-08-31 / 2026-09-10")
        // Mic: Auto / Ranked / Connected, the badges.
        expect("rail: mic groups", [SettingsPanel.micGroup(id: "", ranked: false, connected: false), SettingsPanel.micGroup(id: "a", ranked: true, connected: true),
                                    SettingsPanel.micGroup(id: "b", ranked: false, connected: true), SettingsPanel.micGroup(id: "c", ranked: false, connected: false)].joined(separator: " / "),
               "Auto / Ranked / Connected / Saved, not listed")
        expect("rail: mic badges", SettingsPanel.micBadges(id: "a", active: "a", virtual: true, connected: true).map(ConsoleBadge.text).joined(separator: "+") + " / "
               + SettingsPanel.micBadges(id: "c", active: "a", virtual: false, connected: false).map(ConsoleBadge.text).joined(separator: "+"), "active+virtual / gone")
        expect("rail: brain model word", "\(SettingsPanel.brainModelWord(kind: .local, model: "", local: fake.ollamaUp()) ?? "nil") / \(SettingsPanel.brainModelWord(kind: .claudeCode, model: "claude-opus-5", local: fake.noServer()) ?? "nil")",
               "qwen3.5:27b / claude-opus-5")
        expect("rail: Brain head", text(ConsoleDisclosureSummary.brain(kind: SettingsPanel.brainKindWord(kind: .local, model: "qwen3.5:27b"), model: "qwen3.5:27b", ready: true)) + " / "
               + text(ConsoleDisclosureSummary.brain(kind: SettingsPanel.brainKindWord(kind: .claudeCode, model: "claude-opus-5"), model: "claude-opus-5", ready: true)) + " / "
               + text(ConsoleDisclosureSummary.brain(kind: SettingsPanel.brainKindWord(kind: .auto, model: nil), model: nil, ready: nil)),
               "Local · qwen3.5:27b · [Ready] / claude-opus-5 · [Ready] / Automatic")
        let summary = fake.memorySummary()
        expect("rail: learned word", SettingsPanel.learnedWord(summary, now: fake.now), "learned 12m")
        expect("rail: learned card", SettingsPanel.lastRunCard(summary, now: fake.now).spoken, "Last run, learned 12m ago, extractor responses, added +3, updated ~1, same 4, refused 1, took 1.8 s")
        return failed
    }
}
