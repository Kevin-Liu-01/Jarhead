import Foundation

// Codable mirrors of packages/protocol/src/index.ts. The daemon sends these as
// JSON over the socket; every field name matches the TypeScript exactly. Unknown
// enum values decode to a safe default so a newer daemon never crashes the app.

public enum Phase: String, Codable, CaseIterable {
    case asleep, connecting, listening, speaking, thinking, acting, muted, error

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Phase(rawValue: raw) ?? .error
    }
}

public enum SpeakerRole: String, Codable {
    case kevin, jarhead
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SpeakerRole(rawValue: raw) ?? .kevin
    }
}

public struct TranscriptItem: Codable, Identifiable, Equatable {
    public var id: String
    public var speaker: SpeakerRole
    public var text: String
    public var startMs: Double
    public var endMs: Double
    public var at: Double
    public var final: Bool
}

public enum DelegationStatus: String, Codable {
    case running, done, failed, cancelled
    case awaitingConfirmation = "awaiting-confirmation"
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DelegationStatus(rawValue: raw) ?? .running
    }
}

public enum StepKind: String, Codable {
    case thinking, commentary, tool, screenshot, confirm, note, error
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = StepKind(rawValue: raw) ?? .note
    }
}

public struct ToolStep: Codable, Equatable {
    public var name: String
    public var input: JSONValue?
    public var output: JSONValue?
    public var ok: Bool
    public var ms: Double
}

public struct DelegationStep: Codable, Identifiable, Equatable {
    public var id: String
    public var at: Double
    public var kind: StepKind
    public var text: String?
    public var tool: ToolStep?
    public var screenshotPath: String?
}

public struct DelegationTimings: Codable, Equatable {
    public var delegatedAt: Double
    public var firstThinkingAt: Double?
    public var firstCommentaryAt: Double?
    public var doneAt: Double?
}

public struct Delegation: Codable, Identifiable, Equatable {
    public var id: String
    public var liveId: String
    public var createdAt: Double
    public var offsetMs: Double
    public var request: String
    public var status: DelegationStatus
    public var steps: [DelegationStep]
    public var summary: String?
    public var timings: DelegationTimings
}

/// Mirror of the TS `AgentKind`: "claude-code" | "sessions" (Codex sessions arrive as `sessions`, id `sessions:codex:<id>`).
public enum AgentKind: String, Codable {
    case claudeCode = "claude-code"
    case sessions
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentKind(rawValue: raw) ?? .sessions
    }
}

public enum AgentStatus: String, Codable {
    case idle, working, blocked, done, unknown, offline
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentStatus(rawValue: raw) ?? .unknown
    }
}

public struct AgentInfo: Codable, Identifiable, Equatable {
    public var id: String
    public var kind: AgentKind
    public var name: String
    public var status: AgentStatus
    public var detail: String?
    public var cwd: String?
    public var updatedAt: Double
}

public struct ConnectorHealth: Codable, Equatable {
    public var kind: AgentKind
    public var ok: Bool
    public var detail: String
}

public enum BrainKind: String, Codable, CaseIterable {
    case auto
    case codex
    case claudeCode = "claude-code"
    case anthropicApi = "anthropic-api"
    case openaiResponses = "openai-responses"
    case openaiCompatible = "openai-compatible"
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BrainKind(rawValue: raw) ?? .auto
    }
    public var label: String {
        switch self {
        case .auto: return "Automatic"
        case .codex: return "Codex"
        case .claudeCode: return "Claude Code"
        case .anthropicApi: return "Anthropic API"
        case .openaiResponses: return "OpenAI"
        case .openaiCompatible: return "OpenAI-compatible server"
        }
    }
    /// One line for a picker: what it needs.
    public var needs: String {
        switch self {
        case .auto: return "Whatever is signed in on this Mac — Codex, Claude Code — or a key you add."
        case .codex: return "Your ChatGPT / Codex login on this Mac. No key."
        case .claudeCode: return "Your Claude Code login on this Mac. No key."
        case .anthropicApi: return "An Anthropic API key."
        case .openaiResponses: return "The OpenAI key you already use for the voice."
        case .openaiCompatible: return "A base URL and a key: OpenRouter, Ollama, LM Studio, vLLM…"
        }
    }
    /// Which secret, if any, a kind wants entered.
    public var secretKey: String? {
        switch self {
        case .auto, .codex, .claudeCode: return nil
        case .anthropicApi: return "ANTHROPIC_API_KEY"
        case .openaiResponses: return "OPENAI_API_KEY"
        case .openaiCompatible: return "JARHEAD_BRAIN_API_KEY"
        }
    }
}

public struct OrbPosition: Codable, Equatable {
    public var x: Double
    public var y: Double
}

/// How the wake word gate authenticates before it opens the paid voice session.
public enum WakeAuth: String, Codable, Equatable, CaseIterable {
    case touchId = "touch-id", passphrase, either, none
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WakeAuth(rawValue: raw) ?? .either
    }
    public var label: String {
        switch self {
        case .touchId: return "Touch ID"
        case .passphrase: return "Passphrase"
        case .either: return "Touch ID or passphrase"
        case .none: return "None"
        }
    }
}

/// The local wake word: on-device speech recognition while asleep, then authentication.
public struct WakeSettings: Codable, Equatable {
    public var enabled: Bool
    public var phrases: [String]
    public var auth: WakeAuth

    public init(enabled: Bool, phrases: [String], auth: WakeAuth) {
        self.enabled = enabled; self.phrases = phrases; self.auth = auth
    }

    public static let standard = WakeSettings(enabled: true, phrases: ["jarhead", "jar head", "hey jarhead"], auth: .either)

    public var json: [String: Any] { ["enabled": enabled, "phrases": phrases, "auth": auth.rawValue] }
}

public struct Settings: Codable, Equatable {
    public var voice: String
    public var brain: BrainKind
    public var brainModel: String
    /// openai-compatible only: the Chat Completions server.
    public var brainBaseUrl: String?
    public var effort: String
    public var micDeviceId: String?
    public var idleSleepMinutes: Double
    public var autoWake: Bool
    public var orbPosition: OrbPosition?
    /// Optional on the wire so a daemon from before the gate existed still decodes.
    public var wake: WakeSettings?
    /// First-run onboarding finished. Optional on the wire for the same reason.
    public var onboarded: Bool?

    public var wakeSettings: WakeSettings { wake ?? .standard }
    public var isOnboarded: Bool { onboarded ?? false }
}

/// Configuration health without secrets: key presence and the last probe.
public struct SetupStatus: Codable, Equatable {
    public enum KeyState: String, Codable { case ok, missing, invalid, unchecked
        public init(from decoder: Decoder) throws { self = KeyState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unchecked }
    }
    public enum BrainState: String, Codable { case ok, unavailable, unchecked
        public init(from decoder: Decoder) throws { self = BrainState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unchecked }
    }
    public struct Secrets: Codable, Equatable {
        public var openai: Bool
        public var anthropic: Bool
        public var brainApiKey: Bool
    }
    public var openaiKey: KeyState
    public var brain: BrainState
    public var brainDetail: String
    /// What `auto` resolved to (or the chosen kind), when a brain is running.
    public var brainResolved: BrainKind?
    public var liveModel: String
    public var secrets: Secrets

    public static let unknown = SetupStatus(openaiKey: .unchecked, brain: .unchecked, brainDetail: "", brainResolved: nil, liveModel: "gpt-live-1", secrets: Secrets(openai: false, anthropic: false, brainApiKey: false))
}

public enum Grant: String, Codable {
    case granted, denied, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Grant(rawValue: raw) ?? .unknown
    }
}

public struct Permissions: Codable, Equatable {
    public var microphone: Grant
    public var screenRecording: Grant
    public var accessibility: Grant
}

public struct AudioLevels: Codable, Equatable {
    public var input: Double
    public var output: Double
    public static let silent = AudioLevels(input: 0, output: 0)
}

public struct SessionInfo: Codable, Equatable {
    public var id: String
    public var startedAt: Double
    public var expiresAt: Double
    public var usageSeconds: Double
    public var contextRatio: Double?
}

public struct Snapshot: Codable, Equatable {
    public var phase: Phase
    public var session: SessionInfo?
    public var transcript: [TranscriptItem]
    public var delegations: [Delegation]
    public var agents: [AgentInfo]
    public var connectors: [ConnectorHealth]
    public var settings: Settings
    public var permissions: Permissions
    public var problems: [String]
    public var brainReady: Bool
    public var handsReady: Bool
    /// Optional on the wire for older daemons.
    public var setup: SetupStatus?

    public var setupStatus: SetupStatus { setup ?? .unknown }

    public static let empty = Snapshot(
        phase: .asleep, session: nil, transcript: [], delegations: [], agents: [], connectors: [],
        settings: Settings(voice: "cedar", brain: .auto, brainModel: "", brainBaseUrl: nil, effort: "medium", micDeviceId: nil, idleSleepMinutes: 10, autoWake: true, orbPosition: nil, wake: .standard, onboarded: nil),
        permissions: Permissions(microphone: .unknown, screenRecording: .unknown, accessibility: .unknown),
        problems: [], brainReady: false, handsReady: false, setup: nil)
}

// MARK: - Commands (app → engine). Encoded as {"type": ..., ...} exactly like EngineCommand.

public enum EngineCommand: Equatable {
    case wake, sleep, mute, unmute, stop
    case sayText(String)
    case setSettings(SettingsPatch)
    case clearProblems
    case agentSend(agentId: String, text: String)
    case agentRefresh
    case openConsole, openLedger
    case requestPermission(String)
    /// Secrets to write to ~/.jarhead/env; nil removes. Keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, JARHEAD_BRAIN_API_KEY.
    case setSecrets([String: String?])
    /// Re-check the OpenAI key and the brain; results arrive in snapshot.setup.
    case probeSetup

    public var json: [String: Any] {
        switch self {
        case .wake: return ["type": "wake"]
        case .sleep: return ["type": "sleep"]
        case .mute: return ["type": "mute"]
        case .unmute: return ["type": "unmute"]
        case .stop: return ["type": "stop"]
        case .sayText(let text): return ["type": "say-text", "text": text]
        case .setSettings(let patch): return ["type": "set-settings", "patch": patch.json]
        case .clearProblems: return ["type": "clear-problems"]
        case .agentSend(let id, let text): return ["type": "agent.send", "agentId": id, "text": text]
        case .agentRefresh: return ["type": "agent.refresh"]
        case .openConsole: return ["type": "open-console"]
        case .openLedger: return ["type": "open-ledger"]
        case .requestPermission(let which): return ["type": "request-permission", "which": which]
        case .setSecrets(let secrets):
            var o: [String: Any] = [:]
            for (k, v) in secrets { o[k] = v ?? NSNull() }
            return ["type": "config.set-secrets", "secrets": o]
        case .probeSetup: return ["type": "config.probe"]
        }
    }
}

/// Partial<Settings>; only set fields are sent.
public struct SettingsPatch: Equatable {
    public var voice: String?
    public var brain: BrainKind?
    public var brainModel: String?
    /// `.some(nil)` clears it (system default / none).
    public var brainBaseUrl: String??
    public var effort: String?
    public var onboarded: Bool?
    public var micDeviceId: String??
    public var idleSleepMinutes: Double?
    public var autoWake: Bool?
    public var orbPosition: OrbPosition?
    /// Replaces the whole wake block (the engine fills any field left out with its default).
    public var wake: WakeSettings?

    public init(voice: String? = nil, brain: BrainKind? = nil, brainModel: String? = nil, brainBaseUrl: String?? = nil, effort: String? = nil,
                onboarded: Bool? = nil, micDeviceId: String?? = nil, idleSleepMinutes: Double? = nil, autoWake: Bool? = nil, orbPosition: OrbPosition? = nil,
                wake: WakeSettings? = nil) {
        self.voice = voice; self.brain = brain; self.brainModel = brainModel; self.brainBaseUrl = brainBaseUrl; self.effort = effort
        self.onboarded = onboarded
        self.micDeviceId = micDeviceId; self.idleSleepMinutes = idleSleepMinutes; self.autoWake = autoWake; self.orbPosition = orbPosition
        self.wake = wake
    }

    public var json: [String: Any] {
        var o: [String: Any] = [:]
        if let v = voice { o["voice"] = v }
        if let v = brain { o["brain"] = v.rawValue }
        if let v = brainModel { o["brainModel"] = v }
        if let v = effort { o["effort"] = v }
        if let v = brainBaseUrl { o["brainBaseUrl"] = v ?? NSNull() }
        if let v = onboarded { o["onboarded"] = v }
        if let v = micDeviceId { o["micDeviceId"] = v ?? NSNull() }
        if let v = idleSleepMinutes { o["idleSleepMinutes"] = v }
        if let v = autoWake { o["autoWake"] = v }
        if let v = orbPosition { o["orbPosition"] = ["x": v.x, "y": v.y] }
        if let v = wake { o["wake"] = v.json }
        return o
    }
}

// MARK: - Overlay commands (engine → annotation layer). Global points, y down.

public struct Rect: Codable, Equatable {
    public var x: Double, y: Double, w: Double, h: Double
}

public struct Point2: Codable, Equatable {
    public var x: Double, y: Double
}

public enum OverlayCommand: Equatable {
    case point(x: Double, y: Double, label: String?, ttlMs: Double?)
    case highlight(rect: Rect, label: String?, ttlMs: Double?)
    case path(from: Point2, to: Point2, ttlMs: Double?)
    case clickPulse(x: Double, y: Double)
    case clear

    public init?(json: [String: Any]) {
        guard let cmd = json["cmd"] as? String else { return nil }
        func num(_ k: String) -> Double? { (json[k] as? NSNumber)?.doubleValue }
        switch cmd {
        case "point":
            guard let x = num("x"), let y = num("y") else { return nil }
            self = .point(x: x, y: y, label: json["label"] as? String, ttlMs: num("ttlMs"))
        case "highlight":
            guard let r = json["rect"] as? [String: Any],
                  let x = (r["x"] as? NSNumber)?.doubleValue, let y = (r["y"] as? NSNumber)?.doubleValue,
                  let w = (r["w"] as? NSNumber)?.doubleValue, let h = (r["h"] as? NSNumber)?.doubleValue else { return nil }
            self = .highlight(rect: Rect(x: x, y: y, w: w, h: h), label: json["label"] as? String, ttlMs: num("ttlMs"))
        case "path":
            guard let f = json["from"] as? [String: Any], let t = json["to"] as? [String: Any],
                  let fx = (f["x"] as? NSNumber)?.doubleValue, let fy = (f["y"] as? NSNumber)?.doubleValue,
                  let tx = (t["x"] as? NSNumber)?.doubleValue, let ty = (t["y"] as? NSNumber)?.doubleValue else { return nil }
            self = .path(from: Point2(x: fx, y: fy), to: Point2(x: tx, y: ty), ttlMs: num("ttlMs"))
        case "click-pulse":
            guard let x = num("x"), let y = num("y") else { return nil }
            self = .clickPulse(x: x, y: y)
        case "clear":
            self = .clear
        default:
            return nil
        }
    }
}

// MARK: - Ledger rows (loosely typed: the Console renders what it recognises).

public struct LedgerRow: Codable, Identifiable {
    public var at: Double
    public var type: String
    public var item: TranscriptItem?
    public var delegation: Delegation?
    public var delegationId: String?
    public var step: DelegationStep?
    public var status: DelegationStatus?
    public var timings: DelegationTimings?
    public var summary: String?
    public var text: String?
    public var sessionId: String?
    public var reason: String?
    public var usageSeconds: Double?
    public var agent: AgentInfo?
    public var id: String { "\(type)-\(at)-\(item?.id ?? step?.id ?? delegation?.id ?? "")" }
}

// MARK: - A JSON value for tool inputs/outputs of unknown shape.

public enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Compact single-line rendering for the Console (`{coordinate: [512, 384]}`).
    public var compact: String {
        switch self {
        case .string(let s): return "\"\(s)\""
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map { $0.compact }.joined(separator: ", ") + "]"
        case .object(let o): return "{" + o.keys.sorted().map { "\($0): \(o[$0]!.compact)" }.joined(separator: ", ") + "}"
        }
    }
}

public let jarheadJSONDecoder: JSONDecoder = {
    let d = JSONDecoder()
    return d
}()
