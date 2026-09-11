import AppKit
import SwiftUI
import Speech

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

    /// Preview/test hook (module-internal): canned TCC answers so screenshots are deterministic.
    var permissionProbe: OnboardingPermissionProbe = .live
    /// Preview/test hook: stands in for the calls that prompt or open System Settings.
    var systemActions: OnboardingSystemActions = .live

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
        guard state.snapshot.settings.isOnboarded else { return .welcome }
        let report = OnboardingReport(model: OnboardingModel(state: state), permissions: permissionProbe.read())
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
            system: systemActions,
            finish: { [weak self] in
                state.send(.setSettings(SettingsPatch(onboarded: true)))
                self?.close()
            })

        let root = OnboardingRootView(actions: actions, probe: permissionProbe)
            .environmentObject(state)
            .environmentObject(session)
        let hosting = NSHostingView(rootView: root)
        hosting.autoresizingMask = [.width, .height]
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
enum OnboardingStep: String, CaseIterable, Identifiable {
    case welcome, voice, brain, permissions, wake, agents, done

    var id: String { rawValue }

    var word: String {
        switch self {
        case .welcome: return "Welcome"
        case .voice: return "Voice"
        case .brain: return "Brain"
        case .permissions: return "Permissions"
        case .wake: return "Wake"
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
        case .wake: return "ear.fill"
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
        if step != to { step = to }
    }

    func next() { if let n = step.next { go(n) } }
    func back() { if let p = step.previous { go(p) } }

    /// The window is coming back: drop stale drafts (they were never saved) and start over.
    func reopen(at start: OnboardingStep) {
        commit = nil
        if dirty { dirty = false }
        generation += 1
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

    @MainActor init(state: AppState) {
        let snap = state.snapshot
        connected = state.connected
        daemonDetail = state.daemonDetail
        setup = snap.setupStatus
        brain = snap.settings.brain
        brainModel = snap.settings.brainModel
        brainBaseUrl = snap.settings.brainBaseUrl
        wake = snap.settings.wakeSettings
        onboarded = snap.settings.isOnboarded
        agents = snap.agents
        connectors = snap.connectors
        wakeGate = state.wakeGate
        wakeHeard = state.wakeHeard
        wakePassphraseSet = state.wakePassphraseSet
    }
}

/// TCC as this process sees it right now. Read locally (not from the snapshot):
/// this process is the one TCC answers for.
struct OnboardingPermissions: Equatable {
    var microphone: Grant
    var screenRecording: Grant
    var accessibility: Grant
    /// Speech Recognition, for the on-device wake word.
    var speech: Grant

    static let unknown = OnboardingPermissions(microphone: .unknown, screenRecording: .unknown, accessibility: .unknown, speech: .unknown)

    var handsGranted: Bool { microphone == .granted && screenRecording == .granted && accessibility == .granted }
}

struct OnboardingPermissionProbe {
    var read: () -> OnboardingPermissions

    static let live = OnboardingPermissionProbe {
        OnboardingPermissions(microphone: PermissionsKit.microphoneStatus(),
                              screenRecording: PermissionsKit.screenRecordingStatus(),
                              accessibility: PermissionsKit.accessibilityStatus(),
                              speech: OnboardingSpeech.status())
    }
}

/// Calls that prompt the user or leave the app; swapped out by the preview.
struct OnboardingSystemActions {
    var requestScreenRecording: () -> Void
    var requestAccessibility: () -> Void
    var requestSpeech: () -> Void
    var openURL: (URL) -> Void

    static let live = OnboardingSystemActions(
        requestScreenRecording: {
            // The first call shows the system prompt; every later one only opens Settings.
            PermissionsKit.requestScreenRecording()
            PermissionsKit.openSettings(pane: .screenRecording)
        },
        requestAccessibility: { PermissionsKit.requestAccessibility() },
        requestSpeech: { OnboardingSpeech.request() },
        openURL: { NSWorkspace.shared.open($0) })
}

/// What the step views can do. Closures, so the views never see `AppState`.
struct OnboardingActions {
    var send: (EngineCommand) -> Void
    /// Enrol the wake passphrase; false when it is too short.
    var setPassphrase: (String) -> Bool
    var clearPassphrase: () -> Void
    /// Tell the session the step has (or no longer has) unsaved edits, and how to send them.
    var draft: (_ dirty: Bool, _ commit: (() -> Void)?) -> Void
    var system: OnboardingSystemActions
    /// Marks setup finished and closes the window.
    var finish: () -> Void
}

/// Speech Recognition status and request. `PermissionsKit.Pane` has no Speech
/// Recognition case, so the Settings deep link lives here (same scheme).
enum OnboardingSpeech {
    static func status() -> Grant {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .unknown
        @unknown default: return .unknown
        }
    }

    /// Prompts when undetermined (needs NSSpeechRecognitionUsageDescription);
    /// opens System Settings when already denied. Nothing is sent anywhere.
    static func request() {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .notDetermined: SFSpeechRecognizer.requestAuthorization { _ in }
        case .authorized: break
        default: openSettings()
        }
    }

    static func openSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")!
        NSWorkspace.shared.open(url)
    }
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

    /// "Claude Code", or "Automatic → Claude Code" once `auto` has resolved.
    static func brainName(_ kind: BrainKind, resolved: BrainKind?) -> String {
        if kind == .auto, let r = resolved, r != .auto { return "Automatic → \(r.label)" }
        return kind.label
    }

    /// The model id worth showing next to the brain: none when the engine's own
    /// detail already names it, or when the engine picks the model.
    static func brainModelId(_ model: String, detail: String) -> String? {
        let m = model.trimmingCharacters(in: .whitespacesAndNewlines)
        return m.isEmpty || detail.contains(m) ? nil : m
    }

    init(model m: OnboardingModel, permissions p: OnboardingPermissions) {
        let setup = m.setup
        switch setup.openaiKey {
        case .ok: voice = Line(mark: .ok, text: "OpenAI key works", id: setup.liveModel)
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

        var missing: [String] = []
        if p.microphone != .granted { missing.append("microphone") }
        if p.screenRecording != .granted { missing.append("screen recording") }
        if p.accessibility != .granted { missing.append("accessibility") }
        if m.wake.enabled, p.speech != .granted { missing.append("speech recognition") }
        permissions = missing.isEmpty
            ? Line(mark: .ok, text: "Microphone, screen recording and accessibility granted")
            : Line(mark: .attention, text: "Missing: " + missing.joined(separator: ", "))

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
        case .wake: return wake.mark
        case .welcome, .agents, .done: return nil
        }
    }

    var firstProblem: OnboardingStep? {
        [.voice, .brain, .permissions, .wake].first { mark($0) == .attention }
    }
}
