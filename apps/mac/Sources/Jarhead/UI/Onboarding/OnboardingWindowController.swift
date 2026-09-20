import AppKit
import SwiftUI

/// First-run setup (and "Set Up…" later): the voice key, the brain, permissions,
/// the wake word, agents. One titled window, a rail of steps on the left and the
/// current step on the right. Created once by AppDelegate; `show()` builds the
/// window lazily, `close()` hides it. A finished setup reopens on the first step
/// that has a problem; a fresh one starts at Welcome.
@MainActor
public final class OnboardingWindowController: NSObject, NSWindowDelegate {
    public let state: AppState
    private let session = OnboardingSession()
    private var window: NSWindow?

    public init(state: AppState) {
        self.state = state
        super.init()
    }

    public var isVisible: Bool { window?.isVisible ?? false }

    public func show() {
        let window = self.window ?? makeWindow()
        self.window = window
        if !window.isVisible {
            // A fresh pass: the step views are rebuilt so a key typed before the
            // window was closed is not still sitting in a field.
            session.reopen(at: startStep())
            window.center()
        }
        session.visible = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Open on one step (the status menu's "Permissions: n missing" row lands on Permissions).
    public func show(at step: OnboardingStep) {
        show()
        session.go(step)
    }

    public func close() {
        session.visible = false
        window?.orderOut(nil)
    }

    /// Window number for scripted screenshots (`screencapture -l`). nil until shown.
    var windowNumber: Int? { window.map(\.windowNumber) }

    /// Preview/test hook: jump to a step without a mouse.
    func select(_ step: OnboardingStep) { session.go(step) }

    /// Preview/test hook: resize the content (min-size checks).
    func resize(to size: CGSize) {
        guard let window = window else { return }
        window.setContentSize(NSSize(width: size.width, height: size.height))
        window.center()
    }

    private func startStep() -> OnboardingStep {
        guard state.snapshot.settings.onboarded else { return .welcome }
        let report = OnboardingReport(model: OnboardingModel(state: state))
        return report.firstProblem ?? .welcome
    }

    // MARK: - window

    private func makeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Set up Jarhead"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = ConsoleTheme.groundNS
        window.minSize = NSSize(width: 560, height: 480)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.delegate = self

        let state = self.state
        let session = self.session
        let actions = OnboardingActions(
            send: { state.send($0) },
            setPassphrase: { state.wakeActions.setPassphrase($0) },
            clearPassphrase: { state.wakeActions.clearPassphrase() },
            draft: { session.draft(dirty: $0, commit: $1) },
            permissions: OnboardingPermissionActions(
                requestAll: { state.requestAll() },
                request: { state.request($0) },
                openSettings: { state.openPermissionSettings($0) },
                refresh: { state.refreshPermissions() },
                sweepNext: { state.permissionSweepNext() },
                sweepCancel: { state.permissionSweepCancel() }),
            openURL: { NSWorkspace.shared.open($0) },
            finish: { [weak self] in
                state.send(.setSettings(SettingsPatch(onboarded: true)))
                self?.close()
            })

        let root = OnboardingRootView(actions: actions)
            .environmentObject(state)
            .environmentObject(session)
        let hosting = ConsoleHostingView(rootView: root)
        hosting.autoresizingMask = [.width, .height]
        // The window's minimum is `minSize` above; the hosting view must not derive one too (the
        // default options make AppKit ask it for min / intrinsic / max size on every constraint
        // re-validation — a full SwiftUI layout pass of the step; see ConsoleWindowController).
        hosting.sizingOptions = []
        window.contentView = hosting
        return window
    }

    // MARK: - NSWindowDelegate

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }
}

// MARK: - Steps

/// The rail, in order. `word` is the one word on the rail; `symbol` a solid SF Symbol.
public enum OnboardingStep: String, CaseIterable, Identifiable {
    case welcome, voice, brain, permissions
    /// The wake word step; "wake" in PREVIEW_STEP and the harness's file names. Declaration order is the wizard's order.
    case wakeWord = "wake"
    case agents, done

    public var id: String { rawValue }

    var word: String {
        switch self {
        case .welcome: return "Welcome"
        case .voice: return "Voice"
        case .brain: return "Brain"
        case .permissions: return "Permissions"
        case .wakeWord: return "Wake"
        case .agents: return "Agents"
        case .done: return "Done"
        }
    }

    var symbol: String {
        switch self {
        case .welcome: return "sparkles"
        case .voice: return "waveform.circle.fill"
        case .brain: return "brain.fill"
        case .permissions: return "lock.shield.fill"
        case .wakeWord: return "ear.fill"
        case .agents: return "terminal.fill"
        case .done: return "checkmark.circle.fill"
        }
    }

    var index: Int { OnboardingStep.allCases.firstIndex(of: self) ?? 0 }
    var next: OnboardingStep? { OnboardingStep.allCases.dropFirst(index + 1).first }
    var previous: OnboardingStep? { index > 0 ? OnboardingStep.allCases[index - 1] : nil }
}

/// Where the wizard is, and whether the step on screen holds unsaved edits.
/// Owned by the controller so the step survives hide/show and the preview can
/// drive it. Every step change goes through `go`, which saves the drafts first:
/// Back, Continue and the rail never drop a typed key.
@MainActor
final class OnboardingSession: ObservableObject {
    @Published var step: OnboardingStep = .welcome
    /// Which way the last step change went — forward (Continue, a later rail row) or
    /// back — so the step arriving slides in from that side (OnboardingRootView).
    @Published private(set) var forward = true
    /// The window is on screen; the permissions poll runs only while it is.
    @Published var visible = false
    /// The current step has edits it has not sent yet; the footer says "Save & continue".
    @Published private(set) var dirty = false
    /// Bumped on every reopen; the step views are keyed on it so their drafts reset.
    @Published private(set) var generation = 0

    /// Sends the current step's drafts. A step registers it while dirty.
    private var commit: (() -> Void)?

    /// Called by the step on screen whenever its drafts start or stop differing
    /// from what the engine has.
    func draft(dirty: Bool, commit: (() -> Void)?) {
        self.commit = dirty ? commit : nil
        if self.dirty != dirty { self.dirty = dirty }
    }

    /// Save whatever the current step is holding, then forget it.
    func flush() {
        let c = commit
        commit = nil
        if dirty { dirty = false }
        c?()
    }

    func go(_ to: OnboardingStep) {
        flush()
        guard step != to else { return }
        forward = to.index > step.index
        step = to
    }

    func next() { if let n = step.next { go(n) } }
    func back() { if let p = step.previous { go(p) } }

    /// The window is coming back: drop stale drafts (they were never saved) and start over.
    func reopen(at start: OnboardingStep) {
        commit = nil
        if dirty { dirty = false }
        generation += 1
        forward = true
        step = start
    }
}

// MARK: - The slice of AppState the wizard reads

/// Everything the wizard renders, as one Equatable value. The root view builds
/// it from `AppState` on each change and hands slices down; every step, the rail
/// and the footer are Equatable on their data, so the 20 Hz levels stream
/// re-evaluates nothing below the root.
struct OnboardingModel: Equatable {
    var connected: Bool
    var daemonDetail: String
    var setup: SetupStatus
    /// The voice id and accent the engine has (Settings.voice, Settings.accent).
    var voice: String
    var accent: String
    /// Settings.userName as the engine has it, trimmed; "" = unset (the account's name is used).
    var userName: String
    var brain: BrainKind
    var brainModel: String
    var brainBaseUrl: String?
    var wake: WakeSettings
    var onboarded: Bool
    var agents: [AgentInfo]
    var connectors: [ConnectorHealth]
    var wakeGate: WakeGateState
    var wakeHeard: String
    var wakePassphraseSet: Bool
    /// Every permission as this process last read it (AppState's permissions region).
    var permissions: [PermissionInfo]
    /// The "Ask for everything" sweep while it runs (and its summary for a while after).
    var sweep: PermissionSweepProgress?

    @MainActor init(state: AppState) {
        let snap = state.snapshot
        connected = state.connected
        daemonDetail = state.daemonDetail
        setup = snap.setup
        voice = snap.settings.voice
        accent = snap.settings.accent
        userName = snap.settings.userNameSet
        brain = snap.settings.brain
        brainModel = snap.settings.brainModel
        brainBaseUrl = snap.settings.brainBaseUrl
        wake = snap.settings.wake
        onboarded = snap.settings.onboarded
        agents = snap.agents
        connectors = snap.connectors
        wakeGate = state.wakeGate
        wakeHeard = state.wakeHeard
        wakePassphraseSet = state.wakePassphraseSet
        permissions = state.permissionList
        sweep = state.permissionSweep
    }
}

/// What the Permissions step can ask for. Closures over `AppState`'s permissions region
/// (the PermissionsCenter behind it), so the views never see `AppState`; the preview
/// harness installs printers there instead.
struct OnboardingPermissionActions {
    /// The sweep: required kinds first, one dialog at a time, then the System Settings walk.
    var requestAll: () -> Void
    /// One kind: its prompt, or its pane when only System Settings grants it.
    var request: (PermissionKind) -> Void
    var openSettings: (PermissionKind) -> Void
    /// Re-read every kind (read-only, never a prompt).
    var refresh: () -> Void
    /// The settings walk's Next / Cancel.
    var sweepNext: () -> Void
    var sweepCancel: () -> Void
}

/// What the step views can do. Closures, so the views never see `AppState`.
struct OnboardingActions {
    var send: (EngineCommand) -> Void
    /// Enrol the wake passphrase; false when it is too short.
    var setPassphrase: (String) -> Bool
    var clearPassphrase: () -> Void
    /// Tell the session the step has (or no longer has) unsaved edits, and how to send them.
    var draft: (_ dirty: Bool, _ commit: (() -> Void)?) -> Void
    var permissions: OnboardingPermissionActions
    /// Leaves the app for a web page (the key pages); the preview prints instead.
    var openURL: (URL) -> Void
    /// Marks setup finished and closes the window.
    var finish: () -> Void
}

// MARK: - Report: one line per step, for the rail dots, the Done page and where to reopen

struct OnboardingReport: Equatable {
    enum Mark: Equatable { case ok, attention, neutral }

    /// `text` in sans, an optional `id` (a model id) in mono, an optional quieter `detail`.
    struct Line: Equatable {
        var mark: Mark
        var text: String
        var id: String? = nil
        var detail: String? = nil
    }

    var voice: Line
    var brain: Line
    var permissions: Line
    var wake: Line
    /// Where words go (from SetupStatus.dataPaths); nil until the engine has said, and the Done
    /// page draws no row then.
    var data: Line?

    /// "Claude Code", or "Automatic → Claude Code" once `auto` has resolved.
    static func brainName(_ kind: BrainKind, resolved: BrainKind?) -> String {
        if kind == .auto, let r = resolved, r != .auto { return "Automatic → \(r.label)" }
        return kind.label
    }

    /// The Done page's data line from the engine's rows: "Voice in the cloud (OpenAI); brain and
    /// memory on this Mac." / "Voice, brain and memory in the cloud." / "Voice in the cloud;
    /// brain on this Mac; memory by keywords." — the phrase is per row, never a global promise.
    static func dataLine(_ paths: [DataPath]) -> Line? {
        guard let brain = paths.first(where: { $0.what == "brain" }),
              let memory = paths.first(where: { $0.what == "memory" }) else { return nil }
        let brainPhrase: String
        switch brain.where {
        case "mac": brainPhrase = "brain on this Mac"
        case "lan": brainPhrase = "brain on your network"
        default: brainPhrase = "brain in the cloud"
        }
        let memoryPhrase: String
        if memory.where == "off" {
            memoryPhrase = "memory off"
        } else if memory.detail.hasPrefix("keywords") {
            memoryPhrase = "memory by keywords"
        } else if memory.where == "mac" || memory.where == "lan" {
            memoryPhrase = "memory on this Mac"
        } else {
            memoryPhrase = "memory in the cloud"
        }
        if brainPhrase == "brain in the cloud", memoryPhrase == "memory in the cloud" {
            return Line(mark: .neutral, text: "Voice, brain and memory in the cloud.")
        }
        if brainPhrase == "brain on this Mac", memoryPhrase == "memory on this Mac" {
            return Line(mark: .neutral, text: "Voice in the cloud (OpenAI); brain and memory on this Mac.")
        }
        return Line(mark: .neutral, text: "Voice in the cloud; \(brainPhrase); \(memoryPhrase).")
    }

    /// The model id worth showing next to the brain: none when the engine's own
    /// detail already names it, or when the engine picks the model.
    static func brainModelId(_ model: String, detail: String) -> String? {
        let m = model.trimmingCharacters(in: .whitespacesAndNewlines)
        return m.isEmpty || detail.contains(m) ? nil : m
    }

    /// "Cedar · English, American accent" — the voice as the Done page names it; no accent
    /// phrase for "none" (the voice keeps its own rendering).
    static func voiceDetail(_ voice: String, accent: String) -> String {
        let label = ConsoleTheme.voiceLabel(voice)
        return accent == "none" ? label : "\(label), \(ConsoleTheme.accentLabel(accent)) accent"
    }

    init(model m: OnboardingModel) {
        let setup = m.setup
        switch setup.openaiKey {
        case .ok: voice = Line(mark: .ok, text: "OpenAI key works", id: setup.liveModel, detail: OnboardingReport.voiceDetail(m.voice, accent: m.accent))
        case .noLiveModel: voice = Line(mark: .attention, text: OnboardingWords.noLiveModel, detail: OnboardingWords.noLiveModelRemedy(setup.liveModel))
        case .invalid: voice = Line(mark: .attention, text: "OpenAI rejected the key")
        case .missing: voice = Line(mark: .attention, text: "No OpenAI key")
        case .unchecked: voice = setup.secrets.openai ? Line(mark: .neutral, text: "OpenAI key on file, not checked yet") : Line(mark: .attention, text: "No OpenAI key")
        }

        let name = OnboardingReport.brainName(m.brain, resolved: setup.brainResolved)
        let id = OnboardingReport.brainModelId(m.brainModel, detail: setup.brainDetail)
        let detail: String? = setup.brainDetail.isEmpty ? nil : setup.brainDetail
        switch setup.brain {
        case .ok: brain = Line(mark: .ok, text: "\(name) ready", id: id, detail: detail)
        // No model id on a failure: the detail (and the fix in it) leads.
        case .unavailable: brain = Line(mark: .attention, text: "\(name) unavailable", detail: detail)
        case .unchecked: brain = Line(mark: .neutral, text: "\(name) not checked yet")
        }
        data = OnboardingReport.dataLine(setup.dataPaths)

        // Required kinds decide the mark; the count of everything rides along as detail.
        // Speech Recognition is required only while the wake word is on.
        let all = m.permissions
        let required = all.filter { $0.required && ($0.kind != .speechRecognition || m.wake.enabled) }
        let missing = required.filter { $0.grant != .granted }
        let granted = all.filter { $0.grant == .granted }.count
        if all.isEmpty {
            permissions = Line(mark: .neutral, text: "Permissions not read yet")
        } else if missing.isEmpty {
            permissions = Line(mark: .ok, text: "All \(required.count) required granted", detail: "\(granted) of \(all.count) in all")
        } else {
            permissions = Line(mark: .attention, text: "Missing: " + missing.map { $0.label.lowercased() }.joined(separator: ", "),
                               detail: "\(granted) of \(all.count) granted")
        }

        let phrases = m.wake.phrases.filter { !$0.isEmpty }
        if !m.wake.enabled {
            wake = Line(mark: .neutral, text: "Wake word off")
        } else if phrases.isEmpty {
            wake = Line(mark: .attention, text: "No wake phrases")
        } else if m.wake.auth == .passphrase, !m.wakePassphraseSet {
            wake = Line(mark: .attention, text: "Passphrase auth, but no passphrase set")
        } else {
            let auth = m.wake.auth == .either && !m.wakePassphraseSet ? "Touch ID" : m.wake.auth.label
            wake = Line(mark: .ok, text: "“\(phrases[0])” · \(auth)")
        }
    }

    func mark(_ step: OnboardingStep) -> Mark? {
        switch step {
        case .voice: return voice.mark
        case .brain: return brain.mark
        case .permissions: return permissions.mark
        case .wakeWord: return wake.mark
        case .welcome, .agents, .done: return nil
        }
    }

    var firstProblem: OnboardingStep? {
        [.voice, .brain, .permissions, .wakeWord].first { mark($0) == .attention }
    }
}

#if DEBUG
// MARK: - Bench (debug builds; no XCTest target in apps/mac)

/// The Setup › Voice pins, runnable from Scripts/appstate-bench.sh's `onboarding` stage
/// (compiled with -D DEBUG -D ONBOARDING_BENCH and the onboarding preview's file list): the Done
/// report names the voice "Cedar · English, American accent" and drops the accent phrase for
/// none; the Voice and Accent rows keep a saved id outside their lists so a pick never shows
/// nothing. One line per check, "ok" or "FAIL" first — the shape AppStateBench uses.
@MainActor
enum OnboardingBench {
    static func run() -> [String] {
        var out: [String] = []
        func check(_ ok: Bool, _ what: String) { out.append((ok ? "ok   " : "FAIL ") + what) }

        let cedar = OnboardingReport.voiceDetail("cedar", accent: "american")
        check(cedar == "Cedar · English, American accent", "Done report names the voice: \(cedar)")
        let none = OnboardingReport.voiceDetail("cedar", accent: "none")
        check(none == "Cedar · English", "no accent phrase for none: \(none)")
        let british = OnboardingReport.voiceDetail("marin", accent: "british")
        check(british == "Marin · English, British accent", "british: \(british)")
        let unknown = OnboardingReport.voiceDetail("zz-unknown", accent: "american")
        check(unknown == "zz-unknown · English, American accent", "an unknown voice id is kept raw, still English: \(unknown)")

        check(OnboardingVoiceStep.voiceOptions(for: "cedar") == ConsoleTheme.voices, "a known voice: the 22 as they are")
        check(OnboardingVoiceStep.voiceOptions(for: "zz-unknown") == ConsoleTheme.voices + ["zz-unknown"], "an unknown saved voice is appended so the field shows it")
        check(ConsoleTheme.voices.count == 22, "ConsoleTheme.voices mirrors VOICES (22)")
        let accents = ConsoleTheme.accents.map(\.id)
        check(accents == ["american", "british", "none"], "accents in the protocol's order: \(accents)")
        check(OnboardingVoiceStep.accentOptions(for: "british") == accents, "a known accent: the three as they are")
        check(OnboardingVoiceStep.accentOptions(for: "scottish") == accents + ["scottish"], "an unknown saved accent is appended")

        // The Done page's data line, from the engine's four rows; none before they arrive.
        func path(_ what: String, _ where: String, _ detail: String) -> DataPath { DataPath(what: what, where: `where`, detail: detail) }
        let voice = path("voice", "cloud", "OpenAI gpt-live-1 — every word heard and said; billed per second of open session")
        let web = path("web", "cloud", "the sites you ask for (web_fetch, web_search)")
        let local = OnboardingReport.dataLine([voice, path("brain", "mac", "qwen3.5:27b on Ollama 0.34.0 — nothing leaves"), path("memory", "mac", "embeddings embeddinggemma 768 dims · extractor qwen3.5:27b — nothing leaves"), web])
        check(local?.text == "Voice in the cloud (OpenAI); brain and memory on this Mac.", "Done data line, local brain and memory: \(local?.text ?? "nil")")
        let cloud = OnboardingReport.dataLine([voice, path("brain", "cloud", "gpt-5.3-codex — OpenAI via your ChatGPT login"), path("memory", "cloud", "text-embedding-3-small + a mini model — item text leaves"), web])
        check(cloud?.text == "Voice, brain and memory in the cloud.", "Done data line, everything in the cloud: \(cloud?.text ?? "nil")")
        let keywords = OnboardingReport.dataLine([voice, path("brain", "mac", "qwen3.5:27b on Ollama 0.34.0 — nothing leaves"), path("memory", "mac", "keywords · rules — nothing leaves"), web])
        check(keywords?.text == "Voice in the cloud; brain on this Mac; memory by keywords.", "Done data line, memory by keywords: \(keywords?.text ?? "nil")")
        check(OnboardingReport.dataLine([]) == nil, "no data line before the engine has said")
        check(OnboardingBrainStep.defaultModel(.local) == "" && OnboardingBrainStep.takesBaseUrl(.local) && !OnboardingBrainStep.takesBaseUrl(.codex), "the Local kind: no default model, takes a server pin")
        return out
    }
}
#endif
