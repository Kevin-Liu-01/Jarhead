import AppKit
import SwiftUI

// Throwaway preview harness: builds an AppState full of realistic fake data and
// shows the Console window. Not part of the package; compiled only by
// Scripts/console-preview.sh.
//   PREVIEW_SCENARIO=live|confirm|empty|settings|wake-locked|ledger|light|conversation|conversation-codex|jarhead|jarhead-log|paused|switch
//                    |cleanup|cleanup-select|cleanup-rename|cleanup-undo|search|problems|cleared
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
//                                   durations, no rise/slide — the Reduce Motion path for real
//   PREVIEW_ACTION=scroll-up,append drive the feed after it settles (use PREVIEW_SETTLE>=3)
//     scroll-top,history   in a conversation: scroll to the top, then prepend an older page
//                          (the feed must keep the row on screen where it was)
//     drop-open,restore-agents   take the open session off the rail, then put the rail
//                          back: the stream must stay (one agent.close in the log, no
//                          second agent.open — the root forgets an orphaned id)
//     open-jarhead / show-now / open-agent:<id> / tab:now|settings|ledger / pick-day:<yyyy-mm-dd>
//                          step around the Console the way clicks would (each inside
//                          withAnimation, so the transitions run)
//     geometry             print the stream's scroll geometry (minY, viewport, content, distance)
//     shot:<name>          screenshot the window now → <PREVIEW_OUT_DIR>/<name>.png (a moment
//                          mid-transition, where the script's own shot comes too late)
//     search:<query>       open the rail's search box with the query (hits from the fake ledger)
//     trash-open / archived-open / hidden-open   unfold the rail's folded groups
//     select:<id>+<id>     ⌘-pick chains (the strip shows from two); rename:<id> opens the inline field
//     trash:<id>           move a chain to the Trash the way the menu would (the toast with Undo)
//     clear-now            clear the Now stream (the feed's "Cleared · Undo")
//     hit-first            open the first search hit the way its row would (the conversation,
//                          scrolled to the row and lit); hit:<sessionId>:<atMs> names one outright
//     probe                print the open conversation's state (open / loaded / entries / scroll
//                          target / the entry it resolves to) so a landed hit is checked, not reasoned
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        let scenario = env["PREVIEW_SCENARIO"] ?? "live"
        let shot = env["PREVIEW_SHOT_PNG"] ?? "preview-orb-expanded.png"
        // Screenshots must be deterministic whatever the Mac is set to, so the
        // harness pins the appearance; the real window follows the system.
        let appearance = env["PREVIEW_APPEARANCE"] ?? (scenario == "light" ? "light" : "dark")
        NSApp.appearance = NSAppearance(named: appearance == "light" ? .aqua : .darkAqua)
        // PREVIEW_REDUCE_MOTION=1: the Reduce Motion path for real, whatever the Mac is set to.
        if env["PREVIEW_REDUCE_MOTION"] == "1" {
            Motion.reducedOverride = true
            print("reduce motion: pinned on")
        }

        state.stateDir = URL(fileURLWithPath: env["PREVIEW_STATE_DIR"] ?? FileManager.default.currentDirectoryPath)
        state.connected = true
        state.daemonDetail = "engine · pid 48213"
        state.sendHandler = { cmd in print("send:", cmd.json) }
        let fake = FakeData(shot: shot)
        self.fake = fake
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
        case "conversation", "conversation-codex":
            state.snapshot = fake.live()
            state.snapshot.marks = fake.marks()
            // The transcripts the engine would have sent for the two sessions we step into.
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
        case "settings", "wake-locked": console.selectTab(.settings)
        case "ledger": console.pickLedgerDay("2026-09-10")
        case "confirm":
            state.toast("Waiting for your confirmation", tone: .warn)
        case "conversation": console.openAgent("sessions:claude:w1p2")
        case "conversation-codex": console.openAgent("sessions:codex:1")
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

        // Fake audio levels at 20 Hz so the meters move.
        var t = 0.0
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
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

    private func perform(_ action: String) {
        let stamp = String(format: "%.2f", Date().timeIntervalSince(launchedAt))
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
            withAnimation(Motion.snappy) { console?.showNow() }
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
                withAnimation(Motion.snappy) { console?.openAgent(id) }
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
            } else if action.hasPrefix("shot:") {
                let name = String(action.dropFirst("shot:".count))
                let dir = ProcessInfo.processInfo.environment["PREVIEW_OUT_DIR"] ?? FileManager.default.currentDirectoryPath
                let path = (dir as NSString).appendingPathComponent(name.hasSuffix(".png") ? name : name + ".png")
                shoot(to: path, stamp: stamp)
            } else if keyAction(action) {
                // printed by keyAction
            } else if let info = cleanupAction(action) {
                // The rail's cleanup state (ConsoleSession.previewNotification; the root view applies it).
                NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: info)
                print("action: \(action) at \(stamp)s")
            } else {
                performFeed(action)
            }
        }
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
        if action.hasPrefix("hit:") {
            // hit:<sessionId>:<atMs>
            let parts = action.dropFirst("hit:".count).split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2, let at = Double(parts[1]) else { return nil }
            return ["hit": ["sessionId": parts[0], "at": at] as [String: Any]]
        }
        return nil
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
        case "history":
            // An older page for the open conversation, the way `agent.history` answers:
            // a `replace` whose newest message is older than what is on screen, which
            // AppState.applyTranscript merges in front. The feed should hold its place.
            let openId: String? = console?.openAgentIdForPreview
            guard let agentId = openId, let current = state.transcripts[agentId], let first = current.messages.first else { return }
            var older: [AgentMessage] = []
            for i in 1...4 {
                let role: AgentRole = i % 2 == 0 ? .assistant : .user
                let minutesBefore = Double(5 - i) * 60_000
                older.append(AgentMessage(id: "\(agentId)-older-\(i)", role: role,
                                          text: "Earlier message \(i) of this session, loaded on request.",
                                          at: first.at - minutesBefore, tool: nil, thinking: nil))
            }
            // `complete: false`: AppState.applyTranscript only merges an older page in
            // front while the page says more remains; a `complete: true` page replaces
            // the transcript outright (see the report — the last page of history is
            // always complete, so that branch needs the Model's attention).
            let page = AgentTranscript(agentId: agentId, messages: older, total: current.total, complete: false, live: current.live)
            state.applyTranscript(page, mode: "replace")
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

    /// The rail's sessions. `tool` is what the connector says; the two Claude ids
    /// without a tool prefix (`sessions:cc:*`) rely on it, the rest would resolve
    /// from their ids alone. Details read the way the sessions connector writes
    /// them — "tool · msgs · dir · hint" — so the Console's parsing gets exercised.
    /// The two sessions the conversation scenarios step into live in ~/gt, which
    /// exists on this Mac, so their Reveal shows.
    func agents() -> [AgentInfo] {
        [
            AgentInfo(id: "sessions:cc:1", kind: .sessions, tool: .claude, name: "jarvis · console", status: .working, detail: "claude · 128 msgs · mac · editing UI/Console", cwd: "/Users/kevinliu/jarvis/apps/mac", updatedAt: ago(120), messageCount: 128),
            AgentInfo(id: "sessions:cc:2", kind: .sessions, tool: .claude, name: "kevin-wiki", status: .idle, detail: "claude · 42 msgs · kevin-wiki · waiting for input", cwd: "/Users/kevinliu/Documents/GitHub/kevin-wiki", updatedAt: ago(31 * 60), messageCount: 42),
            AgentInfo(id: "sessions:codex:1", kind: .sessions, name: "gt · api hotfix", status: .done, detail: "codex · 57 msgs · gt · opened PR #412", cwd: "/Users/kevinliu/gt", updatedAt: ago(48 * 60), messageCount: 57),
            AgentInfo(id: "claude-code:jarhead", kind: .claudeCode, name: "brain", status: .working, detail: "Delegation 5knl2 in flight", cwd: "/Users/kevinliu", updatedAt: ago(3)),
            AgentInfo(id: "sessions:claude:w1p2", kind: .sessions, name: "gt · api auth", status: .blocked, detail: "claude · 61 msgs · gt · needs Kevin's yes or no: Bash — pnpm test --filter auth", cwd: "/Users/kevinliu/gt", updatedAt: ago(6 * 60), messageCount: 61),
            AgentInfo(id: "sessions:claude:w1p1", kind: .sessions, name: "gt · api tests", status: .done, detail: "claude · 33 msgs · api · pnpm test — 84 passed", cwd: "/Users/kevinliu/gt/apps/api", updatedAt: ago(7 * 60), messageCount: 33),
            AgentInfo(id: "sessions:codex:w2p1", kind: .sessions, name: "gt · sdk", status: .unknown, detail: "codex · ~12 msgs · sdk · no output for 40 min", cwd: "/Users/kevinliu/gt/packages/sdk", updatedAt: ago(40 * 60), messageCount: 12),
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
        ], total: 61, complete: false, live: true)

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

        return [claude.agentId: claude, codex.agentId: codex]
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
            Problem(kind: "disk.low", text: "Disk space is low: 3.1 GB free. Screenshots keep 14 days; the sweep can run now.",
                    remedy: ProblemRemedy(label: "Run sweep", command: ["type": .string("ledger.sweep")], open: nil), since: ago(90)),
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
            rows.append(said(t + 97_000, "jb4", "Going quiet."))
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
        r = row(ago(60), "session.closed"); r.sessionId = "sess_7f3a9c2e41b0"; r.reason = "idle"; r.usageSeconds = 1020; rows.append(r)
        return rows
    }
}
