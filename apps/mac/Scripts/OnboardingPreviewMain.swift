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

@main
struct OnboardingPreviewMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        let stepName = env["PREVIEW_STEP"] ?? "welcome"
        let scenario = env["PREVIEW_SCENARIO"] ?? "ready"
        let appearance = env["PREVIEW_APPEARANCE"] ?? "dark"
        NSApp.appearance = NSAppearance(named: appearance == "light" ? .aqua : .darkAqua)

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

        let controller = OnboardingWindowController(state: state)
        controller.permissionProbe = OnboardingPermissionProbe {
            switch scenario {
            case "fresh": return OnboardingPermissions(microphone: .unknown, screenRecording: .denied, accessibility: .denied, speech: .unknown)
            case "broken": return OnboardingPermissions(microphone: .denied, screenRecording: .granted, accessibility: .denied, speech: .denied)
            default: return OnboardingPermissions(microphone: .granted, screenRecording: .granted, accessibility: .denied, speech: .granted)
            }
        }
        controller.systemActions = OnboardingSystemActions(
            requestScreenRecording: { print("requestScreenRecording") },
            requestAccessibility: { print("requestAccessibility") },
            requestSpeech: { print("requestSpeech") },
            openURL: { print("openURL:", $0.absoluteString) })
        self.onboarding = controller
        controller.show()
        if let step = OnboardingStep(rawValue: stepName) { controller.select(step) }
        if let size = env["PREVIEW_SIZE"] {
            let parts = size.lowercased().split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 { controller.resize(to: CGSize(width: parts[0], height: parts[1])) }
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

struct OnboardingFakeData {
    let now = Date().timeIntervalSince1970 * 1000
    func ago(_ s: Double) -> Double { now - s * 1000 }

    func settings(brain: BrainKind, model: String, baseUrl: String? = nil, onboarded: Bool?, wake: WakeSettings) -> Settings {
        Settings(voice: "cedar", brain: brain, brainModel: model, brainBaseUrl: baseUrl, effort: "medium", micDeviceId: nil,
                 idleSleepMinutes: 10, autoWake: true, orbPosition: nil, wake: wake, onboarded: onboarded)
    }

    func agents() -> [AgentInfo] {
        [
            AgentInfo(id: "sessions:cc:1", kind: .sessions, name: "jarvis · console", status: .working, detail: "Claude Code — editing UI/Console", cwd: "/Users/kevinliu/jarvis/apps/mac", updatedAt: ago(120)),
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
                 permissions: Permissions(microphone: .granted, screenRecording: .granted, accessibility: .denied),
                 problems: [], brainReady: true, handsReady: false,
                 setup: SetupStatus(openaiKey: .ok, brain: .ok, brainDetail: "Claude Agent SDK · claude-opus-5 · logged in as kevin", liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false)))
    }

    /// Brain "auto", resolved by the engine to Claude Code; no explicit model.
    func auto() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: agents(), connectors: connectors(codexOk: true),
                 settings: settings(brain: .auto, model: "", onboarded: true, wake: .standard),
                 permissions: Permissions(microphone: .granted, screenRecording: .granted, accessibility: .granted),
                 problems: [], brainReady: true, handsReady: true,
                 setup: SetupStatus(openaiKey: .ok, brain: .ok, brainDetail: "Claude Agent SDK · logged in as kevin", brainResolved: .claudeCode, liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: false)))
    }

    func fresh() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: [], connectors: [ConnectorHealth(kind: .sessions, ok: true, detail: "No sessions found")],
                 settings: settings(brain: .claudeCode, model: "claude-opus-5", onboarded: false, wake: WakeSettings(enabled: true, phrases: ["jarhead", "hey jarhead"], auth: .either)),
                 permissions: Permissions(microphone: .unknown, screenRecording: .denied, accessibility: .denied),
                 problems: [], brainReady: false, handsReady: false,
                 setup: SetupStatus(openaiKey: .missing, brain: .unavailable, brainDetail: "claude: not logged in — run `claude` once in a terminal", liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: false, anthropic: false, brainApiKey: false)))
    }

    func broken() -> Snapshot {
        Snapshot(phase: .asleep, session: nil, transcript: [], delegations: [], agents: agents(), connectors: connectors(codexOk: true),
                 settings: settings(brain: .openaiCompatible, model: "qwen3:32b", baseUrl: "http://localhost:11434", onboarded: true,
                                    wake: WakeSettings(enabled: true, phrases: ["jarhead"], auth: .passphrase)),
                 permissions: Permissions(microphone: .denied, screenRecording: .granted, accessibility: .denied),
                 problems: ["could not reach api.openai.com: fetch failed"], brainReady: false, handsReady: false,
                 setup: SetupStatus(openaiKey: .invalid, brain: .unavailable, brainDetail: "connect ECONNREFUSED 127.0.0.1:11434", liveModel: "gpt-live-1",
                                    secrets: SetupStatus.Secrets(openai: true, anthropic: false, brainApiKey: true)))
    }
}
