import AppKit
import SwiftUI

// Throwaway preview harness: builds an AppState full of realistic fake data and
// shows the Console window. Not part of the package; compiled only by
// Scripts/console-preview.sh.
//   PREVIEW_SCENARIO=live|confirm|empty|settings|wake-locked|ledger|light|conversation|conversation-codex|jarhead|jarhead-log|paused|switch
//                    |cleanup|cleanup-select|cleanup-rename|cleanup-undo|search|problems|cleared|workers|loading|wipe|timing|memory|threads
//     memory       = the durable memory of Kevin: asleep, the Settings tab scrolled to its Memory section —
//                    the Remember toggle, Matching, the counts with "learned … ago", Learn now, the budget
//                    hint, and the rail under them (search, Live | Forgotten | Archived, ≤ 30 rows with
//                    Edit / Forget / Restore behind ⋯ and the context menu, the Forget hint). The rows come
//                    from FakeData.memoryItems through the same handlers the app installs. Its default action
//                    runs `check-durability` (the pure words of this pass, run.log `check:` lines).
//     threads      = long-horizon durability: the ended Codex thread (no process; its last tool call
//                    `interrupted`, settled grey, never a pulse; no live dot — `isLive` is derived from
//                    status + connection, never latched) stepped into with a 1 200-message transcript the
//                    feed caps at 400 (LazyVStack; "Load earlier" offers the rest). Then a daemon reconnect
//                    at 1.0 s (the pane must re-send ONE agent.open naming its viewer — the same token as
//                    its first), the window hidden at 1.4 s (agent.close, same viewer) and shown at 1.8 s
//                    (agent.open again): run.log's `send:` lines are the check. PREVIEW_CONNECTED=0 on `live`
//                    is the caret gate's control: a non-final item sits still while disconnected.
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
//     workers      = the split: the main brain handed Notes and Spotify to background hands and Slack
//                    to a screen hand (Snapshot.workers) under one running delegation — the rail's
//                    Workers section (glyph · name · status · Stop; elapsed · lane; the last line), the
//                    card's chips under its timeline, and the [Name] tag on the steps a worker ran;
//                    Notes finished a moment ago and lingers. The `ledger` and `jarhead-log` scenarios
//                    carry the ledger side: `worker` rows as system lines (a hand's first "working" and
//                    its end; the log lists every row) and a `sleep` row (the moon, "asleep · idle" /
//                    "asleep · said “that's all for now”") before the close it explains
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
//   PREVIEW_APPEARANCE=dark|light   (default dark; the `light` scenario is live data in aqua)
//   PREVIEW_STATE_DIR               where screenshot paths resolve
//   PREVIEW_SHOT_PNG                the screenshot step's file inside that dir
//   PREVIEW_WINDOW_SIZE=WxH         window frame (default 1180x760; clamped to the minimum)
//   PREVIEW_BRAIN=<BrainKind raw>   swap the brain (openai-compatible shows the Server row)
//   PREVIEW_GATE=off|awake          the gate switched off, or resting because the engine is awake
//   PREVIEW_REDUCE_MOTION=1         pin Motion.reduced on (Motion.reducedOverride): plain fades, halved
//                                   durations, no rise/slide, still two-tone dither glyphs — the Reduce Motion path for real
//   PREVIEW_SLOW_THUMBS=1           hold every screenshot thumbnail for a minute before it decodes
//                                   (ConsoleThumbnails.holdForPreview), so the dithered skeletons are shot
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
//     check-sleep          print the sleep / worker word checks (close reasons, tombstones, remedy decoding,
//                          the stream from ledger rows end to end, the feed's redraw seams) as
//                          `check: ok|FAIL …` lines; worker-stop:<workerId> sends one worker.stop the
//                          way the rail row's Stop does (the `send:` line must not be a transport stop)
//     check-durability     print this pass's pure words as `check: ok|FAIL` lines: isLive / typing from
//                          status + connection (never the tail flag alone), the caret gate, the feed's 400
//                          cap, the rail's live-first order and hint word, the voice labels and accents,
//                          Switch now's rule, the memory rail's formatting, and that every memory symbol exists
//     reconnect            the daemon came back (ConsoleSession.reconnectCount += 1): the open pane must re-send
//                          agent.open as the same viewer; hide-window / show-window flip windowVisible (the
//                          tail closes and reopens — one agent.close, one agent.open, the same viewer)
//     rail-scroll:<pt>     scroll the right rail down by that many points (the Settings tab is taller than
//                          the window; the Memory section sits under Session)
//     key:<char>           send ⌘<char> to the window (key:f must open the search); undo runs the
//                          window's undo manager once (the last cleanup's inverse must be sent);
//                          undo-toast presses the toast's Undo (AppState.undoCleanup(id:)); redo
//                          runs the manager's redo once — the toast-then-⌘Z sequence must not
//                          re-perform the action (undo after undo-toast: canUndo=false, nothing sent)
//     Every action may carry `@<seconds>` (from launch): "open-jarhead@1.2,shot:mid@1.36";
//     without it the old cadence holds (the first at 1.2 s, then one every 0.8 s).

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
            ConsoleThumbnails.holdForPreview = true
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
        // Jarhead's own sessions, as `ledger.sessions` / `ledger.session` would answer:
        // the list is set outright so the rail has it before the window opens.
        state.jarheadSessions = fake.jarheadSessions()
        state.jarheadSessionsHandler = { fake.jarheadSessions() }
        state.jarheadSessionRowsHandler = { id in fake.jarheadRows(for: id) }
        // The rail's search, as `ledger.search` would answer: a scan of the fake rows.
        state.ledgerSearchHandler = { query, limit in Array(fake.searchHits(query).prefix(limit)) }

        switch scenario {
        case "empty": state.snapshot = fake.empty()
        case "cleanup", "cleanup-select", "cleanup-rename", "cleanup-undo", "cleanup-undo-toast", "cleanup-log", "search", "search-hit", "cleared":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.snapshot.trash = fake.trash
            state.snapshot.hiddenAgents = ["sessions:codex:thread-9"]
            // Fewer sessions in the `cleanup` shot, so the Agents section's "Hidden (1)" is on screen.
            if scenario == "cleanup" {
                let keep: Set<String> = ["sessions:cc:1", "sessions:codex:thread-9"]
                state.snapshot.agents = fake.agents().filter { keep.contains($0.id) }
            }
        case "problems":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.snapshot.trash = fake.trash
            let typed = fake.problemsTyped()
            state.snapshot.problemsTyped = typed
            state.snapshot.problems = typed.map(\.text)
        case "paused":
            state.snapshot = fake.live()
            state.snapshot.phase = .paused
            state.snapshot.pause = PauseInfo(at: fake.ago(40), sessionId: fake.session().id, usageSeconds: 758, sleepsAt: fake.now + 9 * 60 * 1000)
            state.snapshot.session = nil
            state.snapshot.problems = []
        case "confirm": state.snapshot = fake.confirm()
        case "settings":
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
                                               liveModel: "gpt-live-1", secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false))
            state.wakeGate = .lockedOut(until: Date().addingTimeInterval(47))
            state.wakeHeard = ""
            state.wakePassphraseSet = false
        case "conversation", "conversation-codex", "timing":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            // The transcripts the engine would have sent for the two sessions we step into.
            state.transcripts = fake.transcripts()
        case "memory":
            // Asleep (the extractor runs only then), the Settings tab, its Memory section in view.
            state.snapshot = fake.asleep()
            state.snapshot.memory = fake.memorySummary()
        case "threads":
            // The ended Codex thread, with its long transcript (1 200 messages, the last call interrupted).
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            state.transcripts = fake.transcripts()
            // Through the model, the way the engine's `replace` page lands: AppState trims to its 400
            // and says `complete: false`, so "Load earlier" offers the rest and a `load-earlier:` action
            // prepends into the same cap the app has (the view's own ceiling is the pure check).
            state.applyTranscript(fake.longTranscript(agentId: FakeData.endedId, count: 1_200), mode: "replace")
        case "workers":
            // The split. The parent delegation stays running while its hands work (the notch and
            // the phase read from it as ever); the workers ride on the snapshot beside it.
            var snap = fake.live()
            snap.marks = fake.marks()
            snap.phase = .acting
            snap.problems = []
            let split = fake.splitDelegation()
            snap.delegations.append(split)
            snap.workers = fake.workers(parent: split.id)
            snap.transcript += fake.splitTranscript(from: split.createdAt)
            state.snapshot = snap
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
            state.snapshot.settings.wake?.enabled = false
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
        case "settings", "wake-locked", "memory": console.selectTab(.settings)
        case "ledger": console.pickLedgerDay("2026-09-10")
        case "threads":
            pendingAgentOpen = FakeData.endedId
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
        case "cleanup": defaultActions = "trash-open@0.4,hidden-open@0.4"
        // A chain's id is its root session's (the paused one), not the resumed session's.
        case "cleanup-select": defaultActions = "trash-open@0.4,select:\(FakeData.chainPausedId)+\(FakeData.yesterdayId)@0.6"
        case "cleanup-rename": defaultActions = "rename:\(FakeData.pinnedId)@0.5"
        case "cleanup-undo": defaultActions = "trash-open@0.3,trash:\(FakeData.yesterdayId)@0.5"
        case "cleanup-undo-toast": defaultActions = "trash-open@0.3,trash:\(FakeData.yesterdayId)@0.5,undo-toast@1.2,undo@1.8,redo@2.4"
        case "search": defaultActions = "search:codex@0.4"
        // One hit only (the resumed session's delegation request), in a past chain: the hit path proper.
        case "search-hit": defaultActions = "search:codex did while@0.4,hit-first@1.2,probe@2.2"
        case "cleared": defaultActions = "clear-now@0.5"
        // The pure words behind the sleep and worker rows, checked into run.log (the package has no
        // test target), then Spotify's Stop the way the rail's button sends it (`send: worker.stop`).
        case "workers": defaultActions = "check-sleep@0.3,worker-stop:w_sp0t1fy@0.5"
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
        case "threads": defaultActions = "check-durability@0.3,reconnect@1.0,hide-window@1.4,show-window@1.8,geometry@2.2,load-earlier:60@2.4,geometry@3.0"
        default: defaultActions = nil
        }
        if let actions = env["PREVIEW_ACTION"] ?? defaultActions {
            for (index, spec) in actions.split(separator: ",").enumerated() {
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
                checkSleepAndWorkerWords(stamp: stamp)
            } else if action == "check-dither" {
                checkDither(stamp: stamp)
            } else if action == "check-durability" {
                checkDurabilityWords(stamp: stamp)
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
            } else if action.hasPrefix("worker-stop:") {
                // The rail row's Stop, through AppState's helper: one `worker.stop`, never the transport.
                let id = String(action.dropFirst("worker-stop:".count))
                state.workerStop(id)
                print("action: worker-stop \(id) at \(stamp)s (the line above must be worker.stop, not stop)")
            } else if action.hasPrefix("load-earlier:") || action == "history" {
                loadEarlier(action, stamp: stamp)
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

    /// `check-sleep`: the pure words behind the sleep and worker rows, each named and compared
    /// (run.log: `check: ok` / `check: FAIL`) — the Swift package has no test target, so this is
    /// where the behaviour is pinned. A close after a `sleep` row reads "asleep · why"; a pressed
    /// Stop's sleep stays "stopped" (its stop row is the record); the engine's own "sleep:<cause>"
    /// label reads the same; a server word that is not a requested close is kept; the sleep
    /// tombstone is the moon with the cue quoted; a worker row is "Name · status" with its lane;
    /// the remedy decoder yields `worker.stop` and `sleep {cause}` (and refuses a stop without an id).
    /// Then the stream built from ledger rows end to end (the sleep row's close, a hand's seven
    /// rows as two lines, a pressed Stop's silent sleep row, no leak across sessions) and the
    /// feed's redraw seams (StreamPane / StreamRow equality over workers; a card's own workers).
    private func checkSleepAndWorkerWords(stamp: String) {
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
        expect("older engine's sleep row is the command", ConsoleFormat.tombstone(old)?.text ?? "", "asleep · sleep command")
        old.cause = ""
        expect("an empty cause is the command too", old.sleepCause ?? "nil", "command")
        expect("sleepCause of a non-sleep row", row("pause").sleepCause ?? "nil", "nil")

        let hand = Worker(id: "w_1", name: "Spotify", delegationId: "d", task: "play Focus", lane: .background, status: .waitingScreen, detail: "Kevin is typing", startedAt: 0, doneAt: nil, steps: 2)
        var workerRow = row("worker"); workerRow.worker = hand
        let workerLine = ConsoleFormat.tombstone(workerRow)
        expect("worker tombstone", [workerLine?.symbol, workerLine?.text, workerLine?.mono, workerLine?.trailing].compactMap { $0 }.joined(separator: " | "),
               "person.2.fill | Spotify · waiting for the screen | background | Kevin is typing")
        expect("worker row without a record is ignored", ConsoleFormat.tombstone(row("worker")) == nil ? "nil" : "some", "nil")
        expect("worker meta ticks", ConsoleFormat.workerMeta(hand, now: 3_400), "00:03 · background")
        var done = hand; done.status = .done; done.doneAt = 65_000
        expect("worker meta frozen at doneAt", ConsoleFormat.workerMeta(done, now: 999_999), "01:05 · background")
        let statuses: [WorkerStatus] = [.starting, .working, .waitingScreen, .awaitingConfirmation, .done, .failed, .cancelled]
        expect("status words", statuses.map(\.words).joined(separator: ", "), "starting, working, waiting for the screen, waiting for Kevin, done, failed, cancelled")
        expect("running statuses", statuses.map { $0.isRunning ? "1" : "0" }.joined(), "1111000")
        expect("glyphs: dot while alive, hourglass and hand for the waits, settled symbols after",
               statuses.map { ConsoleTheme.worker($0).live ? "dot" : ConsoleTheme.worker($0).symbol }.joined(separator: ","),
               "dot,dot,hourglass.tophalf.filled,hand.raised.fill,checkmark.circle.fill,xmark.octagon.fill,slash.circle.fill")

        expect("remedy worker.stop", EngineCommand(remedyJSON: ["type": .string("worker.stop"), "workerId": .string("w_1")]) == .workerStop(workerId: "w_1") ? "workerStop(w_1)" : "other", "workerStop(w_1)")
        expect("remedy worker.stop without an id", EngineCommand(remedyJSON: ["type": .string("worker.stop")]) == nil ? "nil" : "some", "nil")
        expect("remedy sleep with a cause", EngineCommand(remedyJSON: ["type": .string("sleep"), "cause": .string("dock")]) == .sleepCause("dock") ? "sleepCause(dock)" : "other", "sleepCause(dock)")
        expect("remedy bare sleep", EngineCommand(remedyJSON: ["type": .string("sleep")]) == .sleep ? "sleep" : "other", "sleep")
        expect("worker.stop on the wire", (EngineCommand.workerStop(workerId: "w_1").json["type"] as? String ?? "") + " " + (EngineCommand.workerStop(workerId: "w_1").json["workerId"] as? String ?? ""), "worker.stop w_1")
        expect("sleep cause on the wire", (EngineCommand.sleepCause("dock").json["type"] as? String ?? "") + " " + (EngineCommand.sleepCause("dock").json["cause"] as? String ?? ""), "sleep dock")
        expect("workers slice", state.workers.map(\.name).joined(separator: ","), "Notes,Spotify,Slack")
        expect("running workers slice", state.runningWorkers.map(\.name).joined(separator: ","), "Spotify,Slack")

        // The stream from the ledger, end to end. A `sleep` row threads the close reason and a
        // `session.started` after a close-less sleep resets it; a hand's seven rows read as two
        // lines; a pressed Stop's sleep row is silent (its stop row is the record).
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
        // A screen-lane hand's life as the engine writes it: one row per status change.
        var life = Worker(id: "w_sl4ck00", name: "Slack", delegationId: "d", task: "tell Ben", lane: .screen, status: .starting, detail: nil, startedAt: 1_000, doneAt: nil, steps: 0)
        let lifeStatuses: [(Double, WorkerStatus, String?)] = [
            (1_000, .starting, nil), (2_000, .working, nil), (3_000, .waitingScreen, "waiting for the screen: Kevin is typing"),
            (4_000, .working, nil), (5_000, .awaitingConfirmation, "send it?"), (6_000, .working, nil), (7_000, .done, "told Ben"),
        ]
        var lifeRows: [LedgerRow] = []
        for (ms, status, detail) in lifeStatuses {
            life.status = status; life.detail = detail; life.doneAt = status.isRunning ? nil : ms
            var r = at(ms, "worker"); r.worker = life; lifeRows.append(r)
        }
        expect("fromLedger: seven worker rows, two lines", texts(lifeRows), "Slack · working | Slack · done")
        expect("fromLedger: the end line carries the last detail", systemLines(lifeRows).map { $0.trailing ?? "-" }.joined(separator: " | "), "- | told Ben")
        var quick = life; quick.status = .starting; quick.detail = nil; quick.doneAt = nil
        var q1 = at(1_000, "worker"); q1.worker = quick
        quick.status = .failed; quick.detail = "no Slack"; quick.doneAt = 2_000
        var q2 = at(2_000, "worker"); q2.worker = quick
        expect("fromLedger: a hand that failed before working reads its end only", texts([q1, q2]), "Slack · failed")
        expect("fromLedger: a worker row without a record is ignored", String(systemLines([at(1_000, "worker")]).count), "0")
        expect("JarheadLog keeps every worker row", String(JarheadLog.lines(lifeRows).filter { $0.kind == "worker" }.count), "7")

        // The feed's redraw seams: a worker's status alone makes the pane and its card unequal
        // (the rail and the card redraw on it), and only the card that owns the hand is handed it.
        let fake = self.fake ?? FakeData(shot: "preview.png")
        let hand0 = Worker(id: "w_sp0t1fy", name: "Spotify", delegationId: "del_spl1t", task: "play Focus", lane: .background, status: .working, detail: nil, startedAt: 0, doneAt: nil, steps: 1)
        var hand1 = hand0; hand1.status = .done
        func pane(_ ws: [Worker]) -> StreamPane {
            StreamPane(transcript: [], delegations: [], phase: .acting, hasSession: true, ledgerDay: nil, ledgerEntries: [], ledgerLoading: false, clearedAt: nil, workers: ws)
        }
        expect("StreamPane: equal with the same workers", pane([hand0]) == pane([hand0]) ? "equal" : "differ", "equal")
        expect("StreamPane: a worker's status alone makes it redraw", pane([hand0]) == pane([hand1]) ? "equal" : "differ", "differ")
        let card = StreamEntry.delegation(fake.splitDelegation())
        expect("StreamRow: a worker's status alone makes the card redraw", StreamRow(entry: card, workers: [hand0]) == StreamRow(entry: card, workers: [hand1]) ? "equal" : "differ", "differ")
        let all = fake.workers(parent: "del_spl1t")
        expect("a card is handed its own workers", card.workers(from: all).map(\.name).joined(separator: ","), "Notes,Spotify,Slack")
        expect("another delegation's card is handed none", String(StreamEntry.delegation(fake.doneDelegation()).workers(from: all).count), "0")
        expect("an utterance row is handed none", String(StreamEntry.utterance(fake.splitTranscript(from: 0)[0]).workers(from: all).count), "0")
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
        expect("hint word: none from an older daemon", ConsoleFormat.hintWord(agent(.idle)) ?? "nil", "nil")
        let nowMs = 10 * 60_000.0
        expect("agent meta: project · msgs · age (client-side) · hint", ConsoleFormat.agentMeta(agent(.unknown, hint: "unseen", at: nowMs - 2 * 60_000), now: nowMs), "api · 42 msgs · 2m · unseen")
        expect("agent meta: no hint word on ended", ConsoleFormat.agentMeta(agent(.ended, hint: "ended", at: nowMs - 3 * 3_600_000), now: nowMs), "api · 42 msgs · 3h")
        // Voice: the labels, the roster, the accents, the one language.
        expect("voices: 22", String(ConsoleTheme.voices.count), "22")
        expect("voices: cedar and marin first", ConsoleTheme.voices.prefix(2).joined(separator: ","), "cedar,marin")
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
        expect("needsSwitch: an older daemon that did not say → no (it has no voice.reopen either)", String(SettingsPanel.needsSwitch(settings: settings, session: session, phase: .listening)), "false")
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
        expect("memory matching: openai", ConsoleTheme.memoryMatching("openai"), "OpenAI · 512 dims")
        expect("memory matching: keyword", ConsoleTheme.memoryMatching("keyword"), "keyword · no key")
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

    /// The right rail's scroll view: the one whose width is the rail's.
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
        Settings(voice: "cedar", brain: .claudeCode, brainModel: "claude-opus-5", effort: "medium", micDeviceId: nil, idleSleepMinutes: 10, autoWake: true, orbPosition: nil,
                 wake: WakeSettings(enabled: true, phrases: ["jarhead", "jar head", "hey jarhead"], auth: .either), onboarded: true)
    }

    /// Keys on file, the brain probed and ready: what Settings shows on a working Mac.
    var setup: SetupStatus {
        SetupStatus(openaiKey: .ok, brain: .ok, brainDetail: "ok", brainResolved: .claudeCode, liveModel: "gpt-live-1",
                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false))
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
            AgentInfo(id: "sessions:cc:1", kind: .sessions, tool: .claude, name: "jarvis · console", status: .working, detail: "claude · 128 msgs · mac · editing UI/Console", cwd: "/Users/kevinliu/jarvis/apps/mac", updatedAt: ago(120), messageCount: 128, hint: "running"),
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

    /// What Kevin circled: a crop the engine has taken, one still on its way, and one a delegation already used.
    func marks() -> [ScreenMark] {
        [
            ScreenMark(id: "m1", rect: Rect(x: 412, y: 220, w: 640, h: 400), path: nil, at: ago(9 * 60), screenshotPath: shot, consumed: true),
            ScreenMark(id: "m2", rect: Rect(x: 880, y: 140, w: 512, h: 384), path: nil, at: ago(95), screenshotPath: shot, consumed: false),
            ScreenMark(id: "m3", rect: Rect(x: 120, y: 600, w: 320, h: 200), path: nil, at: ago(4), screenshotPath: nil, consumed: false),
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

    // MARK: workers (Snapshot.workers, DelegationStep.worker)

    /// When the split's parent delegation was created: 8 s ago, so the hands are a few seconds in.
    var splitAt: Double { ago(8) }

    /// The main brain's own steps for a three-app errand: it thought, started Notes and Spotify
    /// in the background lane and Slack in the screen lane, and waits on them. The steps a hand
    /// ran carry its name (`worker`), so the card tags them `[Spotify]`. Still running: the
    /// parent drains its workers before it finishes.
    func splitDelegation() -> Delegation {
        let t0 = splitAt
        func start(_ id: String, _ at: Double, _ name: String, _ task: String, _ lane: String) -> DelegationStep {
            DelegationStep(id: id, at: at, kind: .tool, text: nil,
                           tool: ToolStep(name: "worker_start", input: .object(["name": .string(name), "task": .string(task), "lane": .string(lane)]),
                                          output: .string("\(name) started (\(lane))"), ok: true, ms: 41), screenshotPath: nil)
        }
        let steps: [DelegationStep] = [
            DelegationStep(id: "w-s1", at: t0 + 420, kind: .thinking, text: "Three independent things: the Notes line and Spotify need no screen — Apple events; Slack needs the pointer. Split them.", tool: nil, screenshotPath: nil),
            start("w-s2", t0 + 800, "Notes", "append today's standup line to the Notes daily page", "background"),
            DelegationStep(id: "w-s3", at: t0 + 1500, kind: .commentary, text: "Notes alongside.", tool: nil, screenshotPath: nil),
            DelegationStep(id: "w-s4", at: t0 + 2300, kind: .tool, text: nil,
                           tool: ToolStep(name: "applescript", input: .string("tell application \"Notes\" to tell note \"Daily\" of folder \"Standup\" to set body to body & \"<div>…\""), output: .string("ok"), ok: true, ms: 612),
                           screenshotPath: nil, worker: "Notes"),
            start("w-s5", t0 + 3500, "Spotify", "play the playlist Focus in Spotify", "background"),
            DelegationStep(id: "w-s6", at: t0 + 4000, kind: .note, text: "appended one line to Daily", tool: nil, screenshotPath: nil, worker: "Notes"),
            start("w-s7", t0 + 4500, "Slack", "tell Ben on Slack that Kevin is running late", "screen"),
            DelegationStep(id: "w-s8", at: t0 + 5200, kind: .tool, text: nil,
                           tool: ToolStep(name: "applescript", input: .string("tell application \"Spotify\" to play track \"spotify:playlist:37i9dQZF1DWZeKCadgRdKQ\""), output: .string("ok"), ok: true, ms: 388),
                           screenshotPath: nil, worker: "Spotify"),
            DelegationStep(id: "w-s9", at: t0 + 5600, kind: .screenshot, text: "Slack — Ben", tool: nil, screenshotPath: shot, worker: "Slack"),
            DelegationStep(id: "w-s10", at: t0 + 6100, kind: .note, text: "waiting for the screen: Kevin is typing", tool: nil, screenshotPath: nil, worker: "Slack"),
            DelegationStep(id: "w-s11", at: t0 + 6400, kind: .tool, text: nil,
                           tool: ToolStep(name: "worker_wait", input: .object(["name": .string("all"), "timeout": .number(120)]), output: nil, ok: true, ms: 0), screenshotPath: nil),
        ]
        return Delegation(id: "del_spl1t", liveId: "live_9f8e7d", createdAt: t0, offsetMs: 400,
                          request: "Kevin asked to add today's standup line to Notes, put on Focus on Spotify and tell Ben on Slack he is running late.",
                          status: .running, steps: steps, summary: nil,
                          timings: DelegationTimings(delegatedAt: t0, firstThinkingAt: t0 + 420, firstCommentaryAt: t0 + 1500, doneAt: nil))
    }

    /// The split's hands (Snapshot.workers): Notes done a moment ago and lingering (the snapshot
    /// keeps a finished worker half a minute), Spotify working in the background lane, Slack in
    /// the screen lane waiting for the pointer while Kevin types. Never more than two alive at
    /// once (WORKER_MAX): Notes was done before Slack started.
    func workers(parent: String) -> [Worker] {
        let t0 = splitAt
        return [
            Worker(id: "w_n0tes01", name: "Notes", delegationId: parent, task: "append today's standup line to the Notes daily page", lane: .background,
                   status: .done, detail: "appended one line to Daily", startedAt: t0 + 800, doneAt: t0 + 4000, steps: 3),
            Worker(id: "w_sp0t1fy", name: "Spotify", delegationId: parent, task: "play the playlist Focus in Spotify", lane: .background,
                   status: .working, detail: "tell application \"Spotify\" to play …", startedAt: t0 + 3500, doneAt: nil, steps: 2),
            Worker(id: "w_sl4ck00", name: "Slack", delegationId: parent, task: "tell Ben on Slack that Kevin is running late", lane: .screen,
                   status: .waitingScreen, detail: "waiting for the screen: Kevin is typing", startedAt: t0 + 4500, doneAt: nil, steps: 2),
        ]
    }

    /// What was heard and said around the split: the ask, "on it", the one split line when the
    /// first hand started, and Notes' one finish line.
    func splitTranscript(from t0: Double) -> [TranscriptItem] {
        [
            TranscriptItem(id: "w-u1", speaker: .kevin, text: "Jarhead, add today's standup line to my Notes, put on Focus on Spotify, and tell Ben on Slack I'm running late.", startMs: 0, endMs: 4200, at: t0 - 1200, final: true),
            TranscriptItem(id: "w-u2", speaker: .jarhead, text: "On it.", startMs: 4400, endMs: 4800, at: t0 - 500, final: true),
            TranscriptItem(id: "w-u3", speaker: .jarhead, text: "Notes alongside.", startMs: 6000, endMs: 6900, at: t0 + 1500, final: true),
            TranscriptItem(id: "w-u4", speaker: .jarhead, text: "Notes: appended one line to Daily.", startMs: 8500, endMs: 10200, at: t0 + 4100, final: true),
        ]
    }

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
                         permissions: Permissions(microphone: .granted, screenRecording: .granted, accessibility: .denied),
                         problems: ["Accessibility permission denied — hands can click but cannot read the UI tree."], brainReady: true, handsReady: false, setup: setup)
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
                 permissions: Permissions(microphone: .denied, screenRecording: .granted, accessibility: .denied),
                 problems: ["Accessibility permission denied — hands can click but cannot read the UI tree."], brainReady: true, handsReady: false, setup: setup)
    }

    func empty() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: [],
                 connectors: [ConnectorHealth(kind: .sessions, ok: false, detail: "No Claude Code or Codex session store under ~"), ConnectorHealth(kind: .claudeCode, ok: true, detail: "Agent SDK · ready")],
                 settings: settings, permissions: Permissions(microphone: .unknown, screenRecording: .granted, accessibility: .granted), problems: [], brainReady: true, handsReady: true, setup: setup)
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

    /// The Problems section, typed (Snapshot.problemsTyped): a kind, one line, one remedy each.
    func problemsTyped() -> [Problem] {
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
        // A worker's life as the ledger writes it: one row per status change, the whole record each
        // time (the stream keeps the first "working" and the end; the log lists both rows).
        var hand = Worker(id: "w_r0ll0ut", name: "Rollouts", delegationId: d.id, task: "read the Codex rollouts for threads waiting on a prompt", lane: .background,
                          status: .working, detail: nil, startedAt: ago(602), doneAt: nil, steps: 0)
        r = row(ago(602), "worker"); r.worker = hand; rows.append(r)
        hand.status = .done; hand.detail = "one thread waiting: gt · sdk"; hand.doneAt = ago(597); hand.steps = 3
        r = row(ago(597), "worker"); r.worker = hand; rows.append(r)
        // An idle sleep: the sleep row says why, then the server's word for the close it asked for.
        r = row(ago(61), "sleep"); r.sessionId = "sess_7f3a9c2e41b0"; r.cause = "idle"; rows.append(r)
        r = row(ago(60), "session.closed"); r.sessionId = "sess_7f3a9c2e41b0"; r.reason = "close_requested"; r.usageSeconds = 1020; rows.append(r)
        return rows
    }
}
