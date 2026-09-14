import Foundation

// Codable mirrors of packages/protocol/src/index.ts. The daemon sends these as
// JSON over the socket; every field name matches the TypeScript exactly. Unknown
// enum values decode to a safe default so a newer daemon never crashes the app.

public enum Phase: String, Codable, CaseIterable {
    case asleep, connecting, listening, speaking, thinking, acting, muted, error, paused

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
    /// "typed" when Kevin typed it in the Console.
    public var source: String?
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
    /// The spawned thread's name when it ran this step on its parent's timeline; nil: main's.
    public var thread: String?
}

// MARK: - Threads: independent lines of work, each as capable as the main conversation (mirror of Thread).

public enum ThreadLane: String, Codable, Equatable, Sendable {
    case voice, screen, background
    public init(from decoder: Decoder) throws {
        self = ThreadLane(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .background
    }
}

public enum ThreadStatus: String, Codable, Equatable, Sendable {
    case idle, queued, starting, thinking, acting, paused, done, failed, stopped
    case waitingScreen = "waiting-screen"
    case waitingKevin = "waiting-kevin"
    public init(from decoder: Decoder) throws {
        self = ThreadStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .thinking
    }
    /// Not done, failed or stopped.
    public var isLive: Bool { !(self == .done || self == .failed || self == .stopped) }
    /// Live and doing something (main between turns is idle).
    public var isBusy: Bool { isLive && self != .idle }
}

/// Named `WorkThread` here because Foundation's `Thread` is in scope; the wire type is `Thread`.
public struct WorkThread: Codable, Identifiable, Equatable, Sendable {
    public struct Budget: Codable, Equatable, Sendable {
        public var steps: Int
        public var seconds: Int
    }
    public var id: String
    public var name: String
    public var lane: ThreadLane
    public var status: ThreadStatus
    public var parentId: String?
    public var parentDelegationId: String?
    public var liveId: String?
    public var task: String
    public var detail: String?
    public var apps: [String]
    public var app: String?
    public var at: Point2?
    public var startedAt: Double
    public var updatedAt: Double
    public var doneAt: Double?
    public var turns: Int
    public var steps: Int
    public var waits: Int
    public var budget: Budget
    public var question: String?
    public var currentDelegationId: String?
    public var lastScreenshotPath: String?
    public var canSay: Bool
    public var canStop: Bool
}

/// One change on one thread (the wire's `thread.event`); `kind` says which fields are set.
public struct ThreadEvent: Codable, Equatable {
    public var seq: Int
    public var at: Double
    public var threadId: String
    public var kind: String
    public var thread: WorkThread?
    public var status: ThreadStatus?
    public var detail: String?
    public var steps: Int?
    public var tool: String?
    public var ok: Bool?
    public var delegationId: String?
    public var request: String?
    public var question: String?
    public var text: String?
    public var summary: String?
    public var x: Double?
    public var y: Double?
    public var app: String?
}

/// One row of a thread's conversation, numbered by `seq`; `kind` says which fields are set.
public struct ThreadEntry: Codable, Equatable, Identifiable {
    public var kind: String
    public var seq: Int
    public var item: TranscriptItem?
    public var delegation: Delegation?
    public var delegationId: String?
    public var step: DelegationStep?
    public var status: DelegationStatus?
    public var summary: String?
    public var timings: DelegationTimings?
    public var at: Double?
    public var symbol: String?
    public var text: String?
    public var mono: String?
    public var trailing: String?
    public var id: Int { seq }
}

public struct ThreadTranscript: Codable, Equatable {
    public struct Cursor: Codable, Equatable {
        public var startSeq: Int
        public var endSeq: Int
    }
    public var threadId: String
    public var entries: [ThreadEntry]
    public var total: Int
    public var complete: Bool
    public var live: Bool
    public var cursor: Cursor?
    public var readMs: Double?
}

// MARK: - Memory: what Jarhead knows about Kevin across sessions (mirror of MemoryItem / MemorySummary).

public enum MemoryKind: String, Codable, CaseIterable, Equatable, Sendable {
    case preference, fact, episode, procedure, contact, place
    public init(from decoder: Decoder) throws {
        self = MemoryKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .fact
    }
}

public enum MemoryState: String, Codable, Equatable, Sendable {
    case live, forgotten, merged, archived
    public init(from decoder: Decoder) throws {
        self = MemoryState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .live
    }
}

public struct MemorySource: Codable, Equatable, Sendable {
    public var sessionId: String?
    public var at: Double
    public var type: String
}

public struct MemoryItem: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var kind: MemoryKind
    public var text: String
    public var subjects: [String]
    public var confidence: Double
    public var importance: Double
    public var createdAt: Double
    public var lastSeenAt: Double
    public var seenCount: Int
    public var sources: [MemorySource]
    public var state: MemoryState
    public var mergedInto: String?
    public var supersedes: [String]?
    /// extracted | kevin | tool
    public var origin: String
}

public struct MemorySummary: Codable, Equatable, Sendable {
    public struct LastRun: Codable, Equatable, Sendable {
        public var extractor: String
        public var added: Int
        public var updated: Int
        public var noop: Int
        public var refused: Int
        public var ms: Double
    }
    public struct BudgetUsed: Codable, Equatable, Sendable {
        public var brain: Int
        public var voice: Int
    }
    public var enabled: Bool
    public var count: Int
    public var forgotten: Int
    public var archived: Int
    /// openai | keyword
    public var embeddings: String
    public var pending: Int
    public var lastRunAt: Double?
    public var lastRun: LastRun?
    public var budgetUsed: BudgetUsed?
    public var lastUsedIds: [String]?
}

public struct DelegationTimings: Codable, Equatable {
    public var delegatedAt: Double
    public var firstThinkingAt: Double?
    public var firstCommentaryAt: Double?
    public var doneAt: Double?
    /// Wall clock when Kevin's triggering utterance ended (the transcript's end placed on the session's start clock); absent when the session start is unknown.
    public var speechEndAt: Double?
    /// Wall clock of the first acting tool (click, type, key, scroll, open_app, applescript, run_shell, a file write, a browser action) that returned ok.
    public var firstActionAt: Double?
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
    /// The thread that ran it; nil = main.
    public var threadId: String?
    /// Step total of a thread's delegation; a thread page shows it before its steps are paged in. Absent on main's delegations.
    public var stepCount: Int?
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
    case idle, working, blocked, done, ended, unknown, offline
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentStatus(rawValue: raw) ?? .unknown
    }
}

/// The CLI or app behind a session; drives the icon and brand colour.
public enum AgentTool: String, Codable, CaseIterable {
    case claude, codex, cursor, gemini, opencode, amp, droid, hermes, pi, other
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentTool(rawValue: raw) ?? .other
    }
    public var label: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .cursor: return "Cursor"
        case .gemini: return "Gemini CLI"
        case .opencode: return "OpenCode"
        case .amp: return "Amp"
        case .droid: return "Droid"
        case .hermes: return "Hermes"
        case .pi: return "Pi"
        case .other: return "Agent"
        }
    }
}

public struct AgentInfo: Codable, Identifiable, Equatable {
    public var id: String
    public var kind: AgentKind
    public var tool: AgentTool?
    public var name: String
    public var status: AgentStatus
    public var detail: String?
    public var cwd: String?
    public var updatedAt: Double
    public var messageCount: Int?
    /// One word on why the status is what it is (archived, blocked, running, quiet, ended, unseen, resumed).
    public var hint: String?
    /// Whether a message can be sent into this session now, and how.
    public var send: SendGate?
    public struct SendGate: Codable, Equatable {
        public var ok: Bool
        public var reason: String?
        public var mode: String?
    }

    /// The tool, inferred from the id when the connector did not say.
    public var resolvedTool: AgentTool {
        if let tool { return tool }
        if id.hasPrefix("sessions:codex:") { return .codex }
        if id.hasPrefix("sessions:claude:") || id.hasPrefix("claude-code:") { return .claude }
        return .other
    }
}

// MARK: - Conversations

public enum AgentRole: String, Codable {
    case user, assistant, tool, system
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentRole(rawValue: raw) ?? .system
    }
}

public struct AgentToolCall: Codable, Equatable {
    public enum Status: String, Codable {
        case running, done, error, interrupted
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .done
        }
    }
    public var name: String
    public var input: String?
    public var output: String?
    public var status: Status
}

public struct AgentMessage: Codable, Identifiable, Equatable {
    public var id: String
    public var role: AgentRole
    public var text: String
    public var at: Double
    public var tool: AgentToolCall?
    public var thinking: Bool?
    /// A message Kevin just sent, echoed before the session confirms it.
    public var pending: Bool?
}

public struct AgentTranscript: Codable, Equatable {
    public var agentId: String
    public var messages: [AgentMessage]
    public var total: Int
    public var complete: Bool
    public var live: Bool
    /// Byte range of the session file these messages came from; older pages are read before `startOffset`.
    public var cursor: TranscriptCursor?
    public var readMs: Double?

    public struct TranscriptCursor: Codable, Equatable {
        public var startOffset: Int
        public var endOffset: Int
    }

    public static func empty(_ agentId: String) -> AgentTranscript {
        AgentTranscript(agentId: agentId, messages: [], total: 0, complete: false, live: false)
    }
}

// MARK: - Marks (what Kevin circled)

public struct ScreenMark: Codable, Identifiable, Equatable {
    public var id: String
    public var rect: Rect
    public var path: [Point2]?
    public var at: Double
    public var screenshotPath: String?
    public var consumed: Bool
    public var element: MarkElement?

    public struct MarkElement: Codable, Equatable {
        public var role: String?
        public var title: String?
        public var app: String?
    }
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
    /// First-run onboarding finished (keys, brain, permissions, wake word).
    public var onboarded: Bool
    /// getUserMedia deviceId; nil = the system default.
    public var micDeviceId: String?
    public var idleSleepMinutes: Double
    /// Start listening on launch (ignored while the wake word gate is enabled).
    public var autoWake: Bool
    /// Where the Orb sits, saved across launches.
    public var orbPosition: OrbPosition?
    public var wake: WakeSettings
    /// Act on unambiguous spoken commands without the model (the 250 ms path).
    public var reflexes: Bool
    /// "free" (float where it last worked) or "notch" (live in the MacBook notch).
    public var orbHome: String
    /// Retention: days before a day's ledger / shots move to the trash (0 = never).
    public var ledgerRetentionDays: Int
    public var shotsRetentionDays: Int
    /// Let the brain split independent work across threads.
    public var threads: Bool
    /// The language the voice speaks ("en") and how the English sounds (american | british | none).
    public var language: String
    public var accent: String
    /// Durable memory of Kevin across sessions.
    public var memory: Bool
    /// Every acting tool answers with what is now in front (the observation line).
    public var observe: Bool
    /// A typed line while asleep wakes Jarhead (opens a paid session).
    public var typedWakes: Bool
    /// A new request naming an unclaimed app while main has acted: "supersede" or "spawn".
    public var threadOverflow: String
    /// Warm codex app-server processes kept ready for threads (0..3).
    public var warmThreads: Int

    public var livesInNotch: Bool { orbHome == "notch" }
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

public enum Grant: String, Codable, Sendable {
    case granted, denied, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Grant(rawValue: raw) ?? .unknown
    }
}

/// Every macOS permission Jarhead asks for (mirror of PERMISSION_KINDS). The first four
/// are what the voice and the hands need; the rest let the brain reach what Kevin asks
/// about.
public enum PermissionKind: String, Codable, CaseIterable, Equatable, Sendable {
    case microphone, speechRecognition, screenRecording, accessibility
    case inputMonitoring, automation, fullDiskAccess, notifications, camera
    case contacts, calendars, reminders, localNetwork
    case filesDesktop, filesDocuments, filesDownloads
}

/// How a permission is obtained: a system prompt, System Settings only, or one prompt per target app (Automation).
public enum PermissionAsk: String, Codable, Equatable, Sendable {
    case prompt, settings, perApp
}

public struct PermissionInfo: Codable, Equatable, Identifiable, Sendable {
    public var kind: PermissionKind
    public var grant: Grant
    public var ask: PermissionAsk
    public var required: Bool
    public var label: String
    public var why: String
    public var detail: String?
    public var checkedAt: Double?
    public var id: PermissionKind { kind }
    public init(kind: PermissionKind, grant: Grant, ask: PermissionAsk, required: Bool, label: String, why: String, detail: String? = nil, checkedAt: Double? = nil) {
        self.kind = kind; self.grant = grant; self.ask = ask; self.required = required; self.label = label; self.why = why; self.detail = detail; self.checkedAt = checkedAt
    }
    public var json: [String: Any] {
        var o: [String: Any] = ["kind": kind.rawValue, "grant": grant.rawValue, "ask": ask.rawValue, "required": required, "label": label, "why": why]
        if let detail { o["detail"] = detail }
        if let checkedAt { o["checkedAt"] = checkedAt }
        return o
    }
}

/// Every permission as the app last read it (the process TCC keys on); one row per kind.
public struct Permissions: Codable, Equatable {
    public var all: [PermissionInfo]
    public init(all: [PermissionInfo]) { self.all = all }
    /// The grant a row records for `kind`; `.unknown` when no row has been read yet.
    public func grant(_ kind: PermissionKind) -> Grant { all.first { $0.kind == kind }?.grant ?? .unknown }
    /// Required permissions that are not granted, by kind.
    public var missingRequired: [PermissionKind] { all.filter { $0.required && $0.grant != .granted }.map(\.kind) }
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
    /// The voice and accent this session opened with (a change is heard at the next wake).
    public var voice: String?
    public var accent: String?
}

/// Present while paused: the pause closed `sessionId` (the meter stopped) and holds the
/// conversation; `sleepsAt` (ms) is when an unresumed pause decays to sleep.
public struct PauseInfo: Codable, Equatable {
    public var at: Double
    public var sessionId: String
    public var usageSeconds: Double
    public var sleepsAt: Double
}

/// Live seconds billed today: closed sessions from the ledger plus the open one.
public struct UsageToday: Codable, Equatable {
    public var seconds: Double
    public var sessions: Int
}

/// GPT-Live-1 list price, for the meter. Billed per second.
public enum LivePrice {
    public static let perMinuteUSD = 0.05
    public static func dollars(seconds: Double) -> Double { seconds / 60 * perMinuteUSD }
}

/// One of Jarhead's own Live sessions as the ledger recorded it (the Console's "Jarhead"
/// section). A resume opens a new session continuing the paused one; `resumedFrom` links
/// the chain into one conversation.
public struct JarheadSessionSummary: Codable, Equatable, Identifiable {
    public var id: String
    public var day: String
    public var startedAt: Double
    public var closedAt: Double?
    public var reason: String?
    public var usageSeconds: Double
    public var heard: Int
    public var said: Int
    public var delegations: Int
    public var title: String
    public var resumedFrom: String?
    /// Conversation (chain) state from the tombstone rows; nil = active.
    public var state: String?
    /// Kevin's own name; nil or "" = the auto title.
    public var name: String?
    public var pinned: Bool?
    public var trashedAt: Double?
    public var isOpen: Bool { closedAt == nil }
    public var isTrashed: Bool { state == "trashed" }
    public var isArchived: Bool { state == "archived" }
    public var displayTitle: String { (name?.isEmpty == false ? name! : title) }
}

/// A problem with its one remedy (mirror of Problem / ProblemRemedy).
public struct ProblemRemedy: Codable, Equatable {
    public var label: String
    public var command: [String: JSONValue]?
    public var open: String?
}

public struct Problem: Codable, Equatable, Identifiable {
    /// Mirror of `ProblemKind`, kept a String on purpose: a kind this app does not know
    /// (a newer daemon) decodes as itself and the Console shows it with the default glyph.
    /// Today: permission.accessibility, permission.screenRecording, permission.microphone,
    /// permission.fullDiskAccess, permission.other, brain.unavailable, brain.probe,
    /// voice.limit, voice.connection, voice.key, hands.helper, disk.low, dock, daemon,
    /// crash, other. `dock` is Jarhead twice in the Dock; its remedy is "Fix the Dock"
    /// (`problem.retry {kind:"dock"}`).
    public var kind: String
    public var text: String
    public var remedy: ProblemRemedy?
    public var since: Double
    public var id: String { kind + "|" + text }
}

public struct TrashInfo: Codable, Equatable {
    public var path: String
    public var days: Int
    public var bytes: Double
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
    /// Most recent problems, newest last: what kind, one line, and the one action that fixes it.
    public var problems: [Problem]
    public var brainReady: Bool
    public var handsReady: Bool
    public var setup: SetupStatus
    /// Regions Kevin circled, newest last.
    public var marks: [ScreenMark]
    /// While paused: which session the pause closed and when the pause decays to sleep.
    public var pause: PauseInfo?
    /// Today's billed seconds (for the meter); optional in the contract.
    public var usageToday: UsageToday?
    public var trash: TrashInfo?
    public var hiddenAgents: [String]?
    /// What Jarhead remembers about Kevin (counts, mode, the last run); optional in the contract.
    public var memory: MemorySummary?
    /// Every live thread (main first) and those finished within the linger.
    public var threads: [WorkThread]

    public var liveThreads: [WorkThread] { threads.filter { $0.status.isLive } }
    public var spawnedLiveThreads: [WorkThread] { liveThreads.filter { $0.id != "main" } }

    /// The contract's DEFAULT_SETTINGS, no session, nothing read yet.
    public static let empty = Snapshot(
        phase: .asleep, session: nil, transcript: [], delegations: [], agents: [], connectors: [],
        settings: Settings(voice: "ballad", brain: .auto, brainModel: "", brainBaseUrl: nil, effort: "medium", onboarded: false, micDeviceId: nil,
                           idleSleepMinutes: 10, autoWake: true, orbPosition: nil, wake: .standard, reflexes: true, orbHome: "notch",
                           ledgerRetentionDays: 0, shotsRetentionDays: 14, threads: true, language: "en", accent: "british", memory: true,
                           observe: true, typedWakes: false, threadOverflow: "supersede", warmThreads: 2),
        permissions: Permissions(all: []),
        problems: [], brainReady: false, handsReady: false, setup: .unknown, marks: [], pause: nil, usageToday: nil, threads: [])
}

// MARK: - Commands (app → engine). Encoded as {"type": ..., ...} exactly like EngineCommand.

public enum EngineCommand: Equatable {
    /// `stop` is the transport's stop: interrupt everything, close the session (the meter
    /// stops), sleep. `go` is its one button: wake when asleep, resume when paused.
    /// `interrupt` cancels the current work and speech but stays awake (a spoken "stop").
    case sleep, mute, unmute, stop, go
    /// Sleep with a cause the ledger records ("dock" when the blob is dropped into the notch).
    case sleepCause(String)
    case interrupt(how: String)
    case sayText(String)
    case setSettings(SettingsPatch)
    case clearProblems
    case agentSend(agentId: String, text: String)
    case agentRefresh
    /// Follow / stop following an agent's conversation; older page before a message id.
    case agentOpen(agentId: String)
    case agentClose(agentId: String)
    /// The same, naming the pane (`viewer`) so opens are per pane and a closed pane's tail ends.
    case agentOpenAs(agentId: String, viewer: String)
    case agentCloseAs(agentId: String, viewer: String)
    /// Switch now: pause, then resume with the newly picked voice or accent (refused while work runs).
    case voiceReopen
    // Memory (the Console's Memory rail). Forget and Restore are states; nothing is deleted.
    case memoryForget(id: String)
    case memoryRestore(id: String)
    case memoryEdit(id: String, text: String, kind: String?)
    case memoryAdd(text: String, kind: String?)
    case memoryRun
    // Threads (the Console's panes, a satellite's drop, the CLI). `viewer` names the pane.
    case threadOpen(threadId: String, viewer: String?)
    case threadClose(threadId: String, viewer: String?)
    case threadHistory(threadId: String, before: Int)
    case threadStop(threadId: String)
    case threadPause(threadId: String)
    case threadResume(threadId: String)
    case threadAnswer(threadId: String, yes: Bool)
    case threadSay(threadId: String, text: String)
    case agentHistory(agentId: String, before: String)
    /// Kevin circled a region (global points, y down) — with his stroke.
    case markAdd(rect: Rect, path: [Point2]?)
    case markClear
    /// Restart the engine process on its current code (the app respawns it).
    case daemonRestart
    /// Keep the session open but silent (mic muted, output dropped, no delegations) / undo that.
    case pause
    case resume
    // Conversation cleanup (the Console's). Every one is undoable; nothing is deleted.
    case conversationTrash(chainId: String)
    case conversationRestore(chainId: String)
    case conversationArchive(chainId: String)
    case conversationRename(chainId: String, name: String)
    case conversationPin(chainId: String, pinned: Bool)
    case conversationNew
    case nowClear
    case nowRestore
    case ledgerTrashDay(day: String, what: String)
    case ledgerRestoreDay(day: String)
    case ledgerSweep
    case agentHide(agentId: String, hidden: Bool)
    case problemRetry(kind: String)
    case openConsole, openLedger
    case requestPermission(String)
    /// Secrets to write to ~/.jarhead/env; nil removes. Keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, JARHEAD_BRAIN_API_KEY.
    case setSecrets([String: String?])
    /// Re-check the OpenAI key and the brain; results arrive in snapshot.setup.
    case probeSetup

    public var json: [String: Any] {
        switch self {
        case .sleep: return ["type": "sleep"]
        case .sleepCause(let cause): return ["type": "sleep", "cause": cause]
        case .mute: return ["type": "mute"]
        case .unmute: return ["type": "unmute"]
        case .stop: return ["type": "stop"]
        case .go: return ["type": "go"]
        case .interrupt(let how): return ["type": "interrupt", "how": how]
        case .sayText(let text): return ["type": "say-text", "text": text]
        case .setSettings(let patch): return ["type": "set-settings", "patch": patch.json]
        case .clearProblems: return ["type": "clear-problems"]
        case .agentSend(let id, let text): return ["type": "agent.send", "agentId": id, "text": text]
        case .agentRefresh: return ["type": "agent.refresh"]
        case .agentOpen(let id): return ["type": "agent.open", "agentId": id]
        case .agentClose(let id): return ["type": "agent.close", "agentId": id]
        case .agentOpenAs(let id, let viewer): return ["type": "agent.open", "agentId": id, "viewer": viewer]
        case .agentCloseAs(let id, let viewer): return ["type": "agent.close", "agentId": id, "viewer": viewer]
        case .voiceReopen: return ["type": "voice.reopen"]
        case .memoryForget(let id): return ["type": "memory.forget", "id": id]
        case .memoryRestore(let id): return ["type": "memory.restore", "id": id]
        case .memoryEdit(let id, let text, let kind):
            var o: [String: Any] = ["type": "memory.edit", "id": id, "text": text]
            if let kind { o["kind"] = kind }
            return o
        case .memoryAdd(let text, let kind):
            var o: [String: Any] = ["type": "memory.add", "text": text]
            if let kind { o["kind"] = kind }
            return o
        case .memoryRun: return ["type": "memory.run"]
        case .threadOpen(let id, let viewer):
            var o: [String: Any] = ["type": "thread.open", "threadId": id]
            if let viewer { o["viewer"] = viewer }
            return o
        case .threadClose(let id, let viewer):
            var o: [String: Any] = ["type": "thread.close", "threadId": id]
            if let viewer { o["viewer"] = viewer }
            return o
        case .threadHistory(let id, let before): return ["type": "thread.history", "threadId": id, "before": before]
        case .threadStop(let id): return ["type": "thread.stop", "threadId": id]
        case .threadPause(let id): return ["type": "thread.pause", "threadId": id]
        case .threadResume(let id): return ["type": "thread.resume", "threadId": id]
        case .threadAnswer(let id, let yes): return ["type": "thread.answer", "threadId": id, "yes": yes]
        case .threadSay(let id, let text): return ["type": "thread.say", "threadId": id, "text": text]
        case .agentHistory(let id, let before): return ["type": "agent.history", "agentId": id, "before": before]
        case .markAdd(let rect, let path):
            var o: [String: Any] = ["type": "mark.add", "rect": ["x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h]]
            if let path { o["path"] = path.map { ["x": $0.x, "y": $0.y] } }
            return o
        case .markClear: return ["type": "mark.clear"]
        case .daemonRestart: return ["type": "daemon.restart"]
        case .pause: return ["type": "pause"]
        case .resume: return ["type": "resume"]
        case .conversationTrash(let id): return ["type": "conversation.trash", "chainId": id]
        case .conversationRestore(let id): return ["type": "conversation.restore", "chainId": id]
        case .conversationArchive(let id): return ["type": "conversation.archive", "chainId": id]
        case .conversationRename(let id, let name): return ["type": "conversation.rename", "chainId": id, "name": name]
        case .conversationPin(let id, let pinned): return ["type": "conversation.pin", "chainId": id, "pinned": pinned]
        case .conversationNew: return ["type": "conversation.new"]
        case .nowClear: return ["type": "now.clear"]
        case .nowRestore: return ["type": "now.restore"]
        case .ledgerTrashDay(let day, let what): return ["type": "ledger.trash-day", "day": day, "what": what]
        case .ledgerRestoreDay(let day): return ["type": "ledger.restore-day", "day": day]
        case .ledgerSweep: return ["type": "ledger.sweep"]
        case .agentHide(let id, let hidden): return ["type": "agent.hide", "agentId": id, "hidden": hidden]
        case .problemRetry(let kind): return ["type": "problem.retry", "kind": kind]
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
    public var reflexes: Bool?
    public var orbHome: String?
    public var ledgerRetentionDays: Int?
    public var shotsRetentionDays: Int?
    public var threads: Bool?
    public var language: String?
    public var accent: String?
    public var memory: Bool?
    public var observe: Bool?
    public var typedWakes: Bool?
    public var threadOverflow: String?
    public var warmThreads: Int?

    public init(voice: String? = nil, brain: BrainKind? = nil, brainModel: String? = nil, brainBaseUrl: String?? = nil, effort: String? = nil,
                onboarded: Bool? = nil, micDeviceId: String?? = nil, idleSleepMinutes: Double? = nil, autoWake: Bool? = nil, orbPosition: OrbPosition? = nil,
                wake: WakeSettings? = nil, reflexes: Bool? = nil, orbHome: String? = nil,
                threads: Bool? = nil, language: String? = nil, accent: String? = nil, memory: Bool? = nil) {
        self.voice = voice; self.brain = brain; self.brainModel = brainModel; self.brainBaseUrl = brainBaseUrl; self.effort = effort
        self.onboarded = onboarded
        self.micDeviceId = micDeviceId; self.idleSleepMinutes = idleSleepMinutes; self.autoWake = autoWake; self.orbPosition = orbPosition
        self.wake = wake
        self.reflexes = reflexes; self.orbHome = orbHome
        self.threads = threads; self.language = language; self.accent = accent; self.memory = memory
    }

    /// The thread knobs, set after init (rarely patched; Settings › Threads).
    public mutating func setThreads(observe: Bool? = nil, typedWakes: Bool? = nil, threadOverflow: String? = nil, warmThreads: Int? = nil) {
        self.observe = observe; self.typedWakes = typedWakes; self.threadOverflow = threadOverflow; self.warmThreads = warmThreads
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
        if let v = reflexes { o["reflexes"] = v }
        if let v = orbHome { o["orbHome"] = v }
        if let v = ledgerRetentionDays { o["ledgerRetentionDays"] = v }
        if let v = shotsRetentionDays { o["shotsRetentionDays"] = v }
        if let v = threads { o["threads"] = v }
        if let v = language { o["language"] = v }
        if let v = accent { o["accent"] = v }
        if let v = memory { o["memory"] = v }
        if let v = observe { o["observe"] = v }
        if let v = typedWakes { o["typedWakes"] = v }
        if let v = threadOverflow { o["threadOverflow"] = v }
        if let v = warmThreads { o["warmThreads"] = v }
        return o
    }
}

// MARK: - Overlay commands (engine → annotation layer). Global points, y down.

public struct Rect: Codable, Equatable {
    public var x: Double, y: Double, w: Double, h: Double
}

public struct Point2: Codable, Equatable, Sendable {
    public var x: Double, y: Double
}

/// Colour family of an annotation.
public enum OverlayTone: String, Codable {
    case accent, ok, warn, mark
}

public enum OverlayCommand: Equatable {
    case point(x: Double, y: Double, label: String?, ttlMs: Double?)
    case highlight(rect: Rect, label: String?, ttlMs: Double?)
    case path(from: Point2, to: Point2, ttlMs: Double?)
    case clickPulse(x: Double, y: Double)
    /// Teaching shapes on the click-through layer; fade after ttlMs (default 6 s).
    case circle(x: Double, y: Double, radius: Double, label: String?, ttlMs: Double?, tone: OverlayTone)
    case arrow(from: Point2, to: Point2, label: String?, ttlMs: Double?, tone: OverlayTone)
    case rect(rect: Rect, label: String?, ttlMs: Double?, tone: OverlayTone)
    case text(x: Double, y: Double, text: String, ttlMs: Double?, tone: OverlayTone)
    case stroke(points: [Point2], label: String?, ttlMs: Double?, tone: OverlayTone)
    /// The blob flies to a point and hovers dwellMs (default 2 s) before drifting home.
    /// `thread` names the thread whose blob flies; nil = the main blob.
    case orbFly(x: Double, y: Double, dwellMs: Double?, reason: String?, thread: String?)
    /// The blob flies to the first point, becomes a cursor, and drags the stroke along the points.
    case orbTrace(points: [Point2], closed: Bool, label: String?, ttlMs: Double?, tone: OverlayTone, reason: String?, thread: String?)
    case orbHome
    case clear

    public init?(json: [String: Any]) {
        guard let cmd = json["cmd"] as? String else { return nil }
        func num(_ k: String) -> Double? { (json[k] as? NSNumber)?.doubleValue }
        func pt(_ v: Any?) -> Point2? {
            guard let d = v as? [String: Any], let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue else { return nil }
            return Point2(x: x, y: y)
        }
        func rectOf(_ v: Any?) -> Rect? {
            guard let r = v as? [String: Any], let x = (r["x"] as? NSNumber)?.doubleValue, let y = (r["y"] as? NSNumber)?.doubleValue,
                  let w = (r["w"] as? NSNumber)?.doubleValue, let h = (r["h"] as? NSNumber)?.doubleValue else { return nil }
            return Rect(x: x, y: y, w: w, h: h)
        }
        let tone = OverlayTone(rawValue: json["tone"] as? String ?? "") ?? .accent
        switch cmd {
        case "circle":
            guard let x = num("x"), let y = num("y"), let r = num("radius") else { return nil }
            self = .circle(x: x, y: y, radius: r, label: json["label"] as? String, ttlMs: num("ttlMs"), tone: tone)
        case "arrow":
            guard let f = pt(json["from"]), let t = pt(json["to"]) else { return nil }
            self = .arrow(from: f, to: t, label: json["label"] as? String, ttlMs: num("ttlMs"), tone: tone)
        case "rect":
            guard let r = rectOf(json["rect"]) else { return nil }
            self = .rect(rect: r, label: json["label"] as? String, ttlMs: num("ttlMs"), tone: tone)
        case "text":
            guard let x = num("x"), let y = num("y"), let text = json["text"] as? String else { return nil }
            self = .text(x: x, y: y, text: text, ttlMs: num("ttlMs"), tone: tone)
        case "stroke":
            guard let raw = json["points"] as? [Any] else { return nil }
            let pts = raw.compactMap(pt)
            guard pts.count >= 2 else { return nil }
            self = .stroke(points: pts, label: json["label"] as? String, ttlMs: num("ttlMs"), tone: tone)
        case "orb.fly":
            guard let x = num("x"), let y = num("y") else { return nil }
            self = .orbFly(x: x, y: y, dwellMs: num("dwellMs"), reason: json["reason"] as? String, thread: json["thread"] as? String)
        case "orb.trace":
            guard let raw = json["points"] as? [Any] else { return nil }
            let pts = raw.compactMap(pt)
            guard pts.count >= 2 else { return nil }
            self = .orbTrace(points: pts, closed: (json["closed"] as? Bool) ?? false, label: json["label"] as? String, ttlMs: num("ttlMs"), tone: tone, reason: json["reason"] as? String, thread: json["thread"] as? String)
        case "orb.home":
            self = .orbHome
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
//
// Rows from day files before 2026-09-13 may say `worker` (a row type, a step key): all-optional
// columns and per-row decoding (EngineClient.decodeRows) skip them.

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
    /// `session.started` rows: the voice, and the language and accent the session opened with.
    public var voice: String?
    public var language: String?
    public var accent: String?
    public var reason: String?
    public var usageSeconds: Double?
    public var agent: AgentInfo?
    /// `stop` rows: pressed | said, and the delegation cut. `resume` rows: the paused session and how long it was paused.
    public var how: String?
    public var cancelled: String?
    public var resumedFrom: String?
    public var pausedMs: Double?
    /// conversation.* / now.* / ledger.moved / agent.hidden / grant rows.
    public var chainId: String?
    public var by: String?
    public var name: String?
    public var pinned: Bool?
    public var day: String?
    public var what: String?
    public var to: String?
    public var path: String?
    public var agentId: String?
    public var hidden: Bool?
    public var app: String?
    public var actionClass: String?
    public var until: Double?
    /// `sleep` rows: why, the cue, the farewell.
    public var cause: String?
    public var phrase: String?
    public var farewell: Bool?
    /// `thread.*` rows: the record at start, the thread id, and at the end its steps and seconds.
    public var thread: WorkThread?
    public var threadId: String?
    public var steps: Int?
    public var seconds: Double?
    /// The thread's own status word on `thread.status` / `thread.ended` rows (`status` above is the delegation's), and the change's detail.
    public var threadStatus: ThreadStatus?
    public var detail: String?
    public var id: String { "\(type)-\(at)-\(item?.id ?? step?.id ?? delegation?.id ?? threadId ?? "")" }
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
