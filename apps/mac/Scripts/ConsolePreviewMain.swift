import AppKit
import SwiftUI

// Throwaway preview harness: builds an AppState full of realistic fake data and
// shows the Console window. Not part of the package; compiled only by
// Scripts/console-preview.sh.
//   PREVIEW_SCENARIO=live|confirm|empty|settings|wake-locked|ledger|light|conversation|conversation-codex
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
//   PREVIEW_ACTION=scroll-up,append drive the feed after it settles (use PREVIEW_SETTLE>=3)
//     scroll-top,history   in a conversation: scroll to the top, then prepend an older page
//                          (the feed must keep the row on screen where it was)
//     drop-open,restore-agents   take the open session off the rail, then put the rail
//                          back: the stream must stay (one agent.close in the log, no
//                          second agent.open — the root forgets an orphaned id)

@main
struct ConsolePreviewMain {
    static func main() {
        // Line-buffered, so the `send:` / `action:` trail survives the screenshot script's kill.
        setlinebuf(stdout)
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        let scenario = env["PREVIEW_SCENARIO"] ?? "live"
        let shot = env["PREVIEW_SHOT_PNG"] ?? "preview-orb-expanded.png"
        // Screenshots must be deterministic whatever the Mac is set to, so the
        // harness pins the appearance; the real window follows the system.
        let appearance = env["PREVIEW_APPEARANCE"] ?? (scenario == "light" ? "light" : "dark")
        NSApp.appearance = NSAppearance(named: appearance == "light" ? .aqua : .darkAqua)

        state.stateDir = URL(fileURLWithPath: env["PREVIEW_STATE_DIR"] ?? FileManager.default.currentDirectoryPath)
        state.connected = true
        state.daemonDetail = "engine · pid 48213"
        state.sendHandler = { cmd in print("send:", cmd.json) }
        let fake = FakeData(shot: shot)
        self.fake = fake
        state.ledgerDaysHandler = { ["2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07"] }
        state.ledgerReadHandler = { day in day == "2026-09-10" ? fake.ledgerRows() : [] }

        switch scenario {
        case "empty": state.snapshot = fake.empty()
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
        }

        switch scenario {
        case "settings", "wake-locked": console.selectTab(.settings)
        case "ledger": console.pickLedgerDay("2026-09-10")
        case "confirm":
            state.toast("Waiting for your confirmation", tone: .warn)
        case "conversation": console.openAgent("sessions:claude:w1p2")
        case "conversation-codex": console.openAgent("sessions:codex:1")
        case "live", "light": state.toast("Delegation failed: Codex session refused input", tone: .error)
        default: break
        }

        // PREVIEW_ACTION=scroll-up,append,… drives the feed after it has settled
        // (one action every 0.8 s from t=1.2 s) so the sticky auto-scroll and the
        // jump pill can be checked from a screenshot: `scroll-up` scrolls the
        // stream 300pt toward older rows like a trackpad would; `append` adds a
        // transcript line to the snapshot. Use PREVIEW_SETTLE=3 or more.
        if let actions = env["PREVIEW_ACTION"] {
            for (index, action) in actions.split(separator: ",").enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2 + 0.8 * Double(index)) { [weak self] in
                    self?.perform(String(action))
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
            snap.transcript.append(TranscriptItem(id: "u-appended-\(Int(now))", speaker: .kevin,
                                                  text: "Appended after the window opened.", startMs: 0, endMs: 900, at: now, final: true))
            state.snapshot = snap
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
        return Snapshot(phase: .speaking, session: session(), transcript: t, delegations: [doneDelegation(), running, failedDelegation()], agents: agents(), connectors: connectors(), settings: settings,
                        permissions: Permissions(microphone: .granted, screenRecording: .granted, accessibility: .denied),
                        problems: ["Accessibility permission denied — hands can click but cannot read the UI tree."], brainReady: true, handsReady: false, setup: setup)
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
