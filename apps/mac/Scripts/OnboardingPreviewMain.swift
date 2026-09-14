import AppKit
import SwiftUI

// Throwaway preview harness: an AppState full of fake setup state and the
// onboarding window open on one step. Not part of the package; compiled only by
// Scripts/onboarding-preview.sh. It never talks to the daemon, TCC or OpenAI:
// commands are printed, permissions are canned, prompts are printed.
//   PREVIEW_STEP=welcome|voice|brain|permissions|wake|agents|done   (default welcome)
//   PREVIEW_SCENARIO=ready|fresh|broken|auto (default ready: everything set up; fresh: nothing yet;
//                                          broken: an invalid key and an unavailable brain;
//                                          auto: brain "auto" resolved to Claude Code)
//   PREVIEW_APPEARANCE=dark|light         (default dark, so shots are deterministic)
//   PREVIEW_SIZE=WxH                      (content size, e.g. 560x480 for the minimum; default 620x520)
//   PREVIEW_GO=<step>@<seconds>           go to another step at that moment (inside withAnimation,
//                                         so the slide runs; the rail's highlight glides)
//   PREVIEW_SHOT_AT=<seconds>:<out.png>   a window-only screenshot at that moment (screencapture -l),
//                                         for a frame mid-transition; the script's own shot comes later
//   PREVIEW_REDUCE_MOTION=1               pin Motion.reduced on (Motion.reducedOverride): plain fades,
//                                         halved durations, no slide — the Reduce Motion path for real
//   PREVIEW_SWEEP=asking|waiting|settings|folders|done    pin an "Ask for everything" sweep on the Permissions step
//                                         (the progress line, the Next/Cancel controls, the summary)
// Permissions are a canned list of all sixteen kinds with mixed statuses (per scenario); every
// ask — the sweep, a row's Request, Open Settings — prints instead of prompting.
// Both `go:` and `shot:` lines are stamped with the REAL time since launch (a timer and a
// screencapture spawn land late under a step rebuild), so a "mid-transition" frame can be
// trusted from the log: compare the stamp with the step change's own stamp.

@main
struct OnboardingPreviewMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // never a Dock tile: previews are throwaway
        let delegate = OnboardingPreviewDelegate()
        app.delegate = delegate
        app.run()
    }
}

@MainActor
final class OnboardingPreviewDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()
    var onboarding: OnboardingWindowController?
    var timer: Timer?
    /// When the harness came up; every `go:` / `shot:` line is stamped against it.
    let launchedAt = Date()

    private func stamp() -> String { String(format: "%.2f", Date().timeIntervalSince(launchedAt)) }

    /// The step's scroll view (the tallest NSScrollView in the wizard's window) scrolled to its
    /// top, the way the harness's Console sibling pins a feed; a no-op when already there.
    private func pinScrollToTop() {
        guard let number = onboarding?.windowNumber, let window = NSApp.window(withWindowNumber: number),
              let scroll = Self.tallestScrollView(in: window.contentView) else {
            print("scroll: no step scroll view to pin at \(stamp())s")
            return
        }
        let clip = scroll.contentView
        let was = clip.bounds.origin.y
        if abs(was) > 0.5 {
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
            scroll.reflectScrolledClipView(clip)
        }
        print(String(format: "scroll: pinned to top at %@s (was y=%.1f)", stamp(), was))
        fflush(stdout) // the script kills the process right after its shot; a buffered line would be lost
    }

    private static func tallestScrollView(in view: NSView?) -> NSScrollView? {
        guard let view else { return nil }
        var found: [NSScrollView] = []
        func walk(_ v: NSView) {
            if let s = v as? NSScrollView { found.append(s) }
            v.subviews.forEach(walk)
        }
        walk(view)
        return found.max { $0.frame.height < $1.frame.height }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The dither tiles first, so a shot never catches the fade fallback `Motion.wipe` takes
        // before `Dither.Tiles` has landed. (The app must do the same in AppDelegate — a seam
        // outside UI/**; without it the tiles land lazily on the first wipe, which is a fade.)
        Dither.prewarm(scale: NSScreen.main?.backingScaleFactor ?? 2)
        let env = ProcessInfo.processInfo.environment
        let stepName = env["PREVIEW_STEP"] ?? "welcome"
        let scenario = env["PREVIEW_SCENARIO"] ?? "ready"
        let appearance = env["PREVIEW_APPEARANCE"] ?? "dark"
        NSApp.appearance = NSAppearance(named: appearance == "light" ? .aqua : .darkAqua)
        // PREVIEW_REDUCE_MOTION=1: the Reduce Motion path for real, whatever the Mac is set to.
        if env["PREVIEW_REDUCE_MOTION"] == "1" {
            Motion.reducedOverride = true
            print("reduce motion: pinned on")
        }

        state.connected = true
        state.daemonDetail = "engine · pid 48213"
        state.sendHandler = { cmd in print("send:", cmd.json) }
        state.wakeActions.setPassphrase = { phrase in print("setPassphrase(\(phrase.count) chars)"); return phrase.count >= 8 }
        state.wakeActions.clearPassphrase = { print("clearPassphrase") }

        let fake = OnboardingFakeData()
        switch scenario {
        case "fresh":
            state.snapshot = fake.fresh()
            state.wakeGate = .off(reason: "Speech Recognition not granted")
            state.wakeHeard = ""
            state.wakePassphraseSet = false
        case "broken":
            state.snapshot = fake.broken()
            state.wakeGate = .denied(reason: "wrong passphrase")
            state.wakeHeard = "open the pod bay doors"
            state.wakePassphraseSet = true
        case "auto":
            state.snapshot = fake.auto()
            state.wakeGate = .listening
            state.wakeHeard = "so anyway hey jarhead"
            state.wakePassphraseSet = true
        default:
            state.snapshot = fake.ready()
            state.wakeGate = .listening
            state.wakeHeard = "so anyway hey jarhead"
            state.wakePassphraseSet = true
        }

        // Permissions: a canned list with mixed statuses per scenario; the actions print.
        state.permissionList = OnboardingFakePermissions.list(scenario: scenario)
        var perms = PermissionActions()
        perms.requestAll = { print("permissions.requestAll") }
        perms.request = { print("permissions.request(\($0.rawValue))") }
        perms.openSettings = { print("permissions.openSettings(\($0.rawValue))") }
        perms.refresh = {}
        perms.sweepNext = { print("permissions.sweepNext") }
        perms.sweepCancel = { print("permissions.sweepCancel") }
        state.permissionActions = perms
        if let sweep = env["PREVIEW_SWEEP"] { state.permissionSweep = OnboardingFakePermissions.sweep(sweep) }

        let controller = OnboardingWindowController(state: state)
        self.onboarding = controller
        controller.show()
        if let step = OnboardingStep(rawValue: stepName) { controller.select(step) }
        if let size = env["PREVIEW_SIZE"] {
            let parts = size.lowercased().split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 { controller.resize(to: CGSize(width: parts[0], height: parts[1])) }
        }
        // The step's ScrollView pinned to its top once the step has laid out and its slide has
        // settled (Motion.gentle is done by 0.9 s), so a shot at PREVIEW_SETTLE (1.5 s) is the top
        // of the list every time: the first responder a key window picks (a row's button below
        // the fold) or a resize could otherwise leave the Permissions list scrolled a little.
        // Prints the offset it found, so the log says whether anything had moved it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [self] in pinScrollToTop() }

        // PREVIEW_GO=brain@1.0: a step change the way Continue or the rail would make it.
        if let spec = env["PREVIEW_GO"] {
            let parts = spec.split(separator: "@", maxSplits: 1).map(String.init)
            if let step = OnboardingStep(rawValue: parts[0]) {
                let at = parts.count == 2 ? (Double(parts[1]) ?? 1) : 1
                DispatchQueue.main.asyncAfter(deadline: .now() + at) { [self] in
                    withAnimation(Motion.snappy) { controller.select(step) }
                    print("go: \(step.rawValue) at \(stamp())s (asked for \(at)s)")
                    fflush(stdout)
                }
            }
        }
        // PREVIEW_SHOT_AT=1.12:/path/mid.png: the window as it is at that moment.
        if let spec = env["PREVIEW_SHOT_AT"] {
            let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2, let at = Double(parts[0]) {
                let path = parts[1]
                DispatchQueue.main.asyncAfter(deadline: .now() + at) { [self] in
                    guard let win = controller.windowNumber else { return }
                    // Stamped when the capture is asked for: the frame screencapture grabs
                    // is the one on screen a few ms after this, never before it.
                    let asked = stamp()
                    let p = Process()
                    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                    p.arguments = ["-x", "-o", "-l", String(win), path]
                    try? p.run()
                    p.waitUntilExit()
                    print("shot: \(path) asked at \(asked)s, done at \(stamp())s (wanted \(at)s; status \(p.terminationStatus))")
                    fflush(stdout)
                }
            }
        }

        // Fake audio levels at 20 Hz: the wizard must not care.
        var t = 0.0
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            t += 0.05
            let inL = abs(sin(t * 3.1)) * 0.35
            Task { @MainActor in self?.state.levels = AudioLevels(input: inL, output: 0) }
        }

        if let n = controller.windowNumber {
            print("WINDOW_NUMBER=\(n)")
            fflush(stdout)
        }
    }
}

/// Every kind with a status, per scenario. `ready`: the hands lack Accessibility and Full
/// Disk Access, most capabilities never asked; `fresh`: nothing asked yet; `broken`: the
/// microphone denied, Automation with a denied target.
enum OnboardingFakePermissions {
    static func list(scenario: String) -> [PermissionInfo] {
        let grants: [PermissionKind: (Grant, String?)]
        switch scenario {
        case "fresh":
            grants = [
                .screenRecording: (.denied, nil), .accessibility: (.denied, nil), .inputMonitoring: (.denied, nil),
                .automation: (.unknown, "nothing scriptable running · 11 not running"), .fullDiskAccess: (.denied, nil),
                .filesDesktop: (.unknown, "~/Desktop"), .filesDocuments: (.unknown, "~/Documents"), .filesDownloads: (.unknown, "~/Downloads"),
            ]
        case "broken":
            grants = [
                .microphone: (.denied, nil), .speechRecognition: (.denied, nil), .screenRecording: (.granted, nil), .accessibility: (.denied, nil),
                .inputMonitoring: (.granted, nil), .automation: (.denied, "granted: Finder, System Events · denied: Google Chrome · 8 not running"),
                .fullDiskAccess: (.denied, nil), .notifications: (.denied, nil), .camera: (.denied, nil), .contacts: (.granted, nil),
                .calendars: (.denied, "write only · needs full access"), .reminders: (.granted, nil), .localNetwork: (.denied, nil),
                .filesDesktop: (.granted, "~/Desktop"), .filesDocuments: (.denied, "~/Documents"), .filesDownloads: (.granted, "~/Downloads"),
            ]
        case "auto":
            grants = Dictionary(uniqueKeysWithValues: PermissionKind.allCases.map { ($0, (Grant.granted, $0 == .automation ? "granted: Finder, Google Chrome, System Events · 8 not running" : nil)) })
        default:
            grants = [
                .microphone: (.granted, nil), .speechRecognition: (.granted, nil), .screenRecording: (.granted, nil), .accessibility: (.denied, nil),
                .inputMonitoring: (.unknown, nil), .automation: (.unknown, "granted: Finder, System Events · not asked: Google Chrome · 7 not running"),
                .fullDiskAccess: (.denied, nil), .notifications: (.granted, nil), .camera: (.unknown, nil), .contacts: (.denied, nil),
                .calendars: (.granted, nil), .reminders: (.unknown, nil), .localNetwork: (.unknown, nil),
                .filesDesktop: (.granted, "~/Desktop"), .filesDocuments: (.unknown, "~/Documents"), .filesDownloads: (.denied, "~/Downloads"),
            ]
        }
        let now = Date().timeIntervalSince1970 * 1000
        return PermissionKind.allCases.map { kind in
            let m = PermissionsKit.meta(kind)
            let (grant, detail) = grants[kind] ?? (.unknown, nil)
            return PermissionInfo(kind: kind, grant: grant, ask: m.ask, required: m.required, label: m.label, why: m.why, detail: detail, checkedAt: now)
        }
    }

    /// PREVIEW_SWEEP=asking|waiting|settings|folders|done.
    static func sweep(_ stage: String) -> PermissionSweepProgress? {
        switch stage {
        case "asking":
            return PermissionSweepProgress(stage: .asking, total: 16, index: 6, current: .automation, line: "6 of 16 · asking for Automation…")
        case "waiting":
            // A dialog that returned at once: the sweep waits for the grant, Next or Cancel.
            return PermissionSweepProgress(stage: .waiting, total: 16, index: 3, current: .screenRecording,
                                           line: "3 of 16 · Screen Recording · allow it, or switch Jarhead on in Privacy & Security › Screen & System Audio Recording",
                                           remaining: [.screenRecording], group: [.screenRecording])
        case "settings":
            return PermissionSweepProgress(stage: .settings, total: 16, index: 7, current: .fullDiskAccess,
                                           line: "7 of 16 · Full Disk Access · switch Jarhead on in Privacy & Security › Full Disk Access",
                                           remaining: [.fullDiskAccess, .filesDocuments], group: [.fullDiskAccess])
        case "folders":
            // Kinds that share a pane walk as one step.
            return PermissionSweepProgress(stage: .settings, total: 16, index: 14, current: .filesDesktop,
                                           line: "14 of 16 · Desktop folder, Documents folder, Downloads folder · switch Jarhead on for each in Privacy & Security › Files and Folders",
                                           remaining: [.filesDesktop, .filesDocuments, .filesDownloads], group: [.filesDesktop, .filesDocuments, .filesDownloads])
        case "done":
            return PermissionSweepProgress(stage: .done, total: 16, index: 16, current: nil,
                                           line: "14 of 16 granted · Full Disk Access needs System Settings",
                                           summary: "14 of 16 granted · Full Disk Access needs System Settings")
        default:
            return nil
        }
    }
}

struct OnboardingFakeData {
    let now = Date().timeIntervalSince1970 * 1000
    func ago(_ s: Double) -> Double { now - s * 1000 }

    func settings(brain: BrainKind, model: String, baseUrl: String? = nil, onboarded: Bool, wake: WakeSettings) -> Settings {
        Settings(voice: "cedar", brain: brain, brainModel: model, brainBaseUrl: baseUrl, effort: "medium", onboarded: onboarded, micDeviceId: nil,
                 idleSleepMinutes: 10, autoWake: true, orbPosition: nil, wake: wake, reflexes: true, orbHome: "notch", ledgerRetentionDays: 0, shotsRetentionDays: 14,
                 threads: true, language: "en", accent: "american", memory: true, observe: true, typedWakes: false, threadOverflow: "supersede", warmThreads: 2)
    }

    /// Snapshot.permissions: the canned rows with the three the hands and the voice need overridden.
    func permissions(microphone: Grant, screenRecording: Grant, accessibility: Grant) -> Permissions {
        let overrides: [PermissionKind: Grant] = [.microphone: microphone, .screenRecording: screenRecording, .accessibility: accessibility]
        return Permissions(all: OnboardingFakePermissions.list(scenario: "ready").map { row in
            var r = row
            if let g = overrides[row.kind] { r.grant = g }
            return r
        })
    }

    func agents() -> [AgentInfo] {
        [
            AgentInfo(id: "sessions:cc:1", kind: .sessions, name: "jarhead · console", status: .working, detail: "Claude Code — editing UI/Console", cwd: "/Users/kevinliu/jarvis/apps/mac", updatedAt: ago(120)),
            AgentInfo(id: "sessions:cc:2", kind: .sessions, name: "kevin-wiki", status: .idle, detail: "Claude Code — waiting for input", cwd: "/Users/kevinliu/Documents/GitHub/kevin-wiki", updatedAt: ago(31 * 60)),
            AgentInfo(id: "sessions:codex:1", kind: .sessions, name: "gt · api hotfix", status: .done, detail: "Codex — opened PR #412", cwd: "/Users/kevinliu/gt/apps/api", updatedAt: ago(48 * 60)),
            AgentInfo(id: "claude-code:jarhead", kind: .claudeCode, name: "brain", status: .idle, detail: "Idle", cwd: "/Users/kevinliu", updatedAt: ago(3)),
            AgentInfo(id: "sessions:codex:w2p1", kind: .sessions, name: "gt · sdk", status: .unknown, detail: "No output for 40 min", cwd: "/Users/kevinliu/gt/packages/sdk", updatedAt: ago(40 * 60)),
        ]
    }

    func connectors(codexOk: Bool) -> [ConnectorHealth] {
        [
            ConnectorHealth(kind: .sessions, ok: true, detail: codexOk ? "claude 3 sessions · codex 2 · running: 1 claude, 1 codex" : "claude 3 sessions · running: 1 claude · no ~/.codex store"),
            ConnectorHealth(kind: .claudeCode, ok: true, detail: "Agent SDK · resumable"),
        ]
    }

    func ready() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: agents(), connectors: connectors(codexOk: false),
                 settings: settings(brain: .claudeCode, model: "claude-opus-5", onboarded: false, wake: .standard),
                 permissions: permissions(microphone: .granted, screenRecording: .granted, accessibility: .denied),
                 problems: [], brainReady: true, handsReady: false,
                 setup: SetupStatus(openaiKey: .ok, brain: .ok, brainDetail: "Claude Agent SDK · claude-opus-5 · logged in as kevin", liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false)), marks: [], threads: [])
    }

    /// Brain "auto", resolved by the engine to Claude Code; no explicit model.
    func auto() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: agents(), connectors: connectors(codexOk: true),
                 settings: settings(brain: .auto, model: "", onboarded: true, wake: .standard),
                 permissions: permissions(microphone: .granted, screenRecording: .granted, accessibility: .granted),
                 problems: [], brainReady: true, handsReady: true,
                 setup: SetupStatus(openaiKey: .ok, brain: .ok, brainDetail: "Claude Agent SDK · logged in as kevin", brainResolved: .claudeCode, liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false)), marks: [], threads: [])
    }

    func fresh() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: [], connectors: [ConnectorHealth(kind: .sessions, ok: true, detail: "No sessions found")],
                 settings: settings(brain: .claudeCode, model: "claude-opus-5", onboarded: false, wake: WakeSettings(enabled: true, phrases: ["jarhead", "hey jarhead"], auth: .either)),
                 permissions: permissions(microphone: .unknown, screenRecording: .denied, accessibility: .denied),
                 problems: [], brainReady: false, handsReady: false,
                 setup: SetupStatus(openaiKey: .missing, brain: .unavailable, brainDetail: "claude: not logged in — run `claude` once in a terminal", liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: false, anthropic: false, brainApiKey: false)), marks: [], threads: [])
    }

    func broken() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: agents(), connectors: connectors(codexOk: true),
                 settings: settings(brain: .openaiCompatible, model: "qwen3:32b", baseUrl: "http://localhost:11434", onboarded: true,
                                    wake: WakeSettings(enabled: true, phrases: ["jarhead"], auth: .passphrase)),
                 permissions: permissions(microphone: .denied, screenRecording: .granted, accessibility: .denied),
                 problems: [Problem(kind: "voice.connection", text: "could not reach api.openai.com: fetch failed", remedy: nil, since: ago(30))], brainReady: false, handsReady: false,
                 setup: SetupStatus(openaiKey: .invalid, brain: .unavailable, brainDetail: "connect ECONNREFUSED 127.0.0.1:11434", liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: true)), marks: [], threads: [])
    }
}
