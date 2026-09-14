import SwiftUI
import AppKit

// Design tokens, metadata, formatting and the shared controls for the Console.
// The palette is Prototemplate's: ink, raised ink, titanium, paper, and exactly
// one accent. Light and dark are a token remap resolved through dynamic
// NSColors, so the window follows the system appearance and nothing below
// this file names a raw colour. Every type here is prefixed `Console…` so it
// cannot collide with helpers the other UI directories define.

enum ConsoleTheme {
    // MARK: ground + text (light, dark)

    static let ground = dynamic(light: .white, dark: nsColor(0x070707))
    static let raised = dynamic(light: NSColor(white: 0.965, alpha: 1), dark: nsColor(0x101010))
    static let fg = dynamic(light: nsColor(0x070707), dark: .white)
    static let fg2 = dynamic(light: nsColor(0x070707, 0.72), dark: NSColor(white: 1, alpha: 0.72))
    static let fg3 = dynamic(light: nsColor(0x070707, 0.48), dark: NSColor(white: 1, alpha: 0.48))
    static let titanium = rgb(0x8a8f98)

    // MARK: lines — three weights, each drawn exactly once by one owner
    //
    // Every rule is 1pt. The one exception is the pair of seams between the
    // rails and the stream (`ConsoleHairline.sidebarEdge`, 2pt, structural
    // colour) — attributed to Kevin mid-review and kept as written; set it back
    // to 1 to restore the canon exactly.

    /// Structural: the shell's dividers, section rules, field and button boxes.
    static let hair = dynamic(light: nsColor(0x070707, 0.18), dark: NSColor(white: 1, alpha: 0.22))
    /// Row: rules inside a card.
    static let hairRow = dynamic(light: nsColor(0x070707, 0.09), dark: NSColor(white: 1, alpha: 0.10))
    /// Frame: around images only.
    static let hairFrame = dynamic(light: nsColor(0x070707, 0.62), dark: NSColor(white: 1, alpha: 0.55))

    // MARK: states

    static let hover = dynamic(light: nsColor(0x070707, 0.04), dark: NSColor(white: 1, alpha: 0.05))
    static let active = dynamic(light: nsColor(0x070707, 0.07), dark: NSColor(white: 1, alpha: 0.08))
    /// The one accent: the primary action, focus rings, the selected state.
    static let accent = dynamic(light: nsColor(0x2f5ce0), dark: nsColor(0x5b82ff))
    static let onAccent = Color.white
    static let scrim = Color.black.opacity(0.6)

    /// The window's own background — the same token as `ground`, for AppKit.
    static let groundNS = dynamicNS(light: .white, dark: nsColor(0x070707))

    // MARK: phases (dots and icon tints only; the blob is the exception)

    static let listening = rgb(0x5ad7ff)
    static let speaking = rgb(0xffb454)
    static let thinking = rgb(0xb48cff)
    static let acting = rgb(0x6ee7a0)
    static let error = rgb(0xff5d6c)
    static let asleep = rgb(0x7a6a5a)
    static let muted = rgb(0x6b7280)
    static let connecting = rgb(0x9fb4c8)

    // MARK: motion — opacity and transform only, from the one vocabulary (UI/Motion.swift)

    /// Moves on its own: a view switch, a card arriving (`Motion.gentle`).
    static var motion: Animation { Motion.gentle }
    /// Answers the hand: a selection, a toggle (`Motion.snappy`).
    static var fast: Animation { Motion.snappy }

    // MARK: colour helpers

    static func rgb(_ hex: UInt32, _ alpha: Double = 1) -> Color {
        Color(.sRGB,
              red: Double((hex >> 16) & 0xff) / 255,
              green: Double((hex >> 8) & 0xff) / 255,
              blue: Double(hex & 0xff) / 255,
              opacity: alpha)
    }

    static func nsColor(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
                green: CGFloat((hex >> 8) & 0xff) / 255,
                blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
    }

    /// A colour that resolves against the effective appearance at draw time.
    static func dynamicNS(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        }
    }

    static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: dynamicNS(light: light, dark: dark))
    }

    // MARK: type — SF Pro at 11/12/13/15; SF Mono for ids, paths, timings, counts

    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    // MARK: metadata

    struct PhaseMeta: Equatable {
        let label: String
        let color: Color
        let hint: String
    }

    static func phase(_ p: Phase) -> PhaseMeta {
        switch p {
        case .asleep: return PhaseMeta(label: "Asleep", color: asleep, hint: "No live session. Nothing billed.")
        case .connecting: return PhaseMeta(label: "Connecting", color: connecting, hint: "Opening the live session.")
        case .listening: return PhaseMeta(label: "Listening", color: listening, hint: "Mic is hot.")
        case .speaking: return PhaseMeta(label: "Speaking", color: speaking, hint: "Jarhead is talking.")
        case .thinking: return PhaseMeta(label: "Thinking", color: thinking, hint: "The brain is working.")
        case .acting: return PhaseMeta(label: "Acting", color: acting, hint: "Jarhead is using the computer.")
        case .muted: return PhaseMeta(label: "Muted", color: muted, hint: "Mic muted. Session open.")
        case .paused: return PhaseMeta(label: "Paused", color: titanium, hint: "Paused. Session closed, meter stopped; Go resumes with the context.")
        case .error: return PhaseMeta(label: "Error", color: error, hint: "Something broke. See problems.")
        }
    }

    static let busyPhases: Set<Phase> = [.speaking, .thinking, .acting]
    /// A live session is open or opening (the composer shows Pause, Mute is enabled).
    /// Paused is not one: a pause closes the session — the meter stops — and only the
    /// conversation is kept, so the composer shows Go and the placeholder says so.
    static let sessionPhases: Set<Phase> = AppState.inSessionPhases.union([.connecting])
    /// Phases whose dot pulses.
    static let livePhases: Set<Phase> = [.listening, .speaking, .thinking, .acting, .connecting]

    struct StatusMeta {
        let color: Color
        /// nil draws a dot instead of a glyph.
        let symbol: String?
        let live: Bool
    }

    static func status(_ s: AgentStatus) -> StatusMeta {
        switch s {
        case .working: return StatusMeta(color: listening, symbol: nil, live: true)
        case .idle: return StatusMeta(color: titanium, symbol: nil, live: false)
        case .blocked: return StatusMeta(color: speaking, symbol: "exclamationmark.circle.fill", live: false)
        case .done: return StatusMeta(color: acting, symbol: "checkmark.circle.fill", live: false)
        // The process is gone: over, however old. Never a pulse.
        case .ended: return StatusMeta(color: titanium, symbol: "stop.circle.fill", live: false)
        case .unknown: return StatusMeta(color: titanium, symbol: "questionmark.circle.fill", live: false)
        case .offline: return StatusMeta(color: fg3, symbol: "circle.slash.fill", live: false)
        }
    }

    struct DelegationMeta: Equatable {
        let label: String
        let color: Color
        let live: Bool
        let symbol: String
    }

    static func delegation(_ s: DelegationStatus) -> DelegationMeta {
        switch s {
        case .running: return DelegationMeta(label: "running", color: thinking, live: true, symbol: "circle.fill")
        case .awaitingConfirmation: return DelegationMeta(label: "waiting for Kevin", color: speaking, live: true, symbol: "hand.raised.fill")
        case .done: return DelegationMeta(label: "done", color: acting, live: false, symbol: "checkmark.circle.fill")
        case .failed: return DelegationMeta(label: "failed", color: error, live: false, symbol: "xmark.octagon.fill")
        case .cancelled: return DelegationMeta(label: "cancelled", color: fg3, live: false, symbol: "slash.circle.fill")
        }
    }

    /// A thread's lane on its mono meta line: "voice" (the main conversation), "screen" (waits
    /// for the pointer) or "background" (Apple events, browser, files, shell, web — the pointer
    /// is never its).
    static func lane(_ l: ThreadLane) -> String { l.rawValue }

    struct ThreadMeta: Equatable {
        let label: String
        let color: Color
        /// A dot on the icon column (pulsing while `live`) instead of the symbol.
        let dot: Bool
        let live: Bool
        let symbol: String
    }

    /// A thread's status as one glyph on the rail row, the card's chip and the pane's header:
    /// a still grey dot for the idle main, a pulsing dot while it starts / thinks / acts
    /// (the connecting grey, the thinking violet, the acting green), the hourglass while it waits
    /// for the screen, the raised hand while it waits for Kevin, the pause bars while paused, and
    /// the delegation's settled symbols once done, failed or stopped.
    static func thread(_ s: ThreadStatus) -> ThreadMeta {
        switch s {
        case .idle: return ThreadMeta(label: s.words, color: titanium, dot: true, live: false, symbol: "circle.fill")
        case .queued: return ThreadMeta(label: s.words, color: connecting, dot: true, live: false, symbol: "circle.fill")
        case .starting: return ThreadMeta(label: s.words, color: connecting, dot: true, live: true, symbol: "circle.fill")
        case .thinking: return ThreadMeta(label: s.words, color: thinking, dot: true, live: true, symbol: "circle.fill")
        case .acting: return ThreadMeta(label: s.words, color: acting, dot: true, live: true, symbol: "circle.fill")
        case .waitingScreen: return ThreadMeta(label: s.words, color: fg3, dot: false, live: false, symbol: "hourglass.tophalf.filled")
        case .waitingKevin: return ThreadMeta(label: s.words, color: speaking, dot: false, live: false, symbol: "hand.raised.fill")
        case .paused: return ThreadMeta(label: s.words, color: titanium, dot: false, live: false, symbol: "pause.fill")
        case .done: return ThreadMeta(label: s.words, color: acting, dot: false, live: false, symbol: "checkmark.circle.fill")
        case .failed: return ThreadMeta(label: s.words, color: error, dot: false, live: false, symbol: "xmark.octagon.fill")
        case .stopped: return ThreadMeta(label: s.words, color: fg3, dot: false, live: false, symbol: "slash.circle.fill")
        }
    }

    /// The Threads section's own symbol (the rail head, the ledger's thread rows).
    static let threadsSymbol = "square.stack.fill"

    struct GrantMeta {
        let label: String
        let color: Color
        let symbol: String
    }

    static func grant(_ g: Grant) -> GrantMeta {
        switch g {
        case .granted: return GrantMeta(label: "granted", color: acting, symbol: "checkmark.circle.fill")
        case .denied: return GrantMeta(label: "denied", color: error, symbol: "xmark.circle.fill")
        case .unknown: return GrantMeta(label: "not asked", color: titanium, symbol: "questionmark.circle.fill")
        }
    }

    static func kindTitle(_ k: AgentKind) -> String {
        switch k {
        case .sessions: return "Sessions"
        case .claudeCode: return "Claude Code"
        }
    }

    static func kindSymbol(_ k: AgentKind) -> String {
        switch k {
        case .sessions: return "terminal.fill"
        case .claudeCode: return "brain.fill"
        }
    }

    /// Display order of connector groups in the left rail.
    static let kindOrder: [AgentKind] = [.sessions, .claudeCode]

    // MARK: voice — the 22 GPT-Live-1 voices (protocol VOICES, mirrored by hand), the one language, the accents

    /// One voice as the Audio menu lists it. A voice is a timbre, not a language: every label
    /// ends "· English" because the engine's `# Language` section pins English whatever the voice.
    /// No character notes ("warm", "bright"): none can be verified without a paid session.
    struct VoiceOption: Hashable {
        let id: String
        let name: String
    }

    /// The 22 GPT-Live-1 voices (mirror of VOICES): ballad first (the default — the male voice with
    /// the British lean), then cedar and marin, the rest alphabetical, so a saved pick keeps its
    /// place in the menu.
    static let voiceOptions: [VoiceOption] = [
        VoiceOption(id: "ballad", name: "Ballad"), VoiceOption(id: "cedar", name: "Cedar"), VoiceOption(id: "marin", name: "Marin"),
        VoiceOption(id: "alloy", name: "Alloy"), VoiceOption(id: "ash", name: "Ash"),
        VoiceOption(id: "beacon", name: "Beacon"), VoiceOption(id: "bossa", name: "Bossa"), VoiceOption(id: "cinder", name: "Cinder"),
        VoiceOption(id: "coral", name: "Coral"), VoiceOption(id: "delta", name: "Delta"), VoiceOption(id: "echo", name: "Echo"),
        VoiceOption(id: "gleam", name: "Gleam"), VoiceOption(id: "meridian", name: "Meridian"), VoiceOption(id: "quartz", name: "Quartz"),
        VoiceOption(id: "ripple", name: "Ripple"), VoiceOption(id: "sage", name: "Sage"), VoiceOption(id: "shimmer", name: "Shimmer"),
        VoiceOption(id: "stone", name: "Stone"), VoiceOption(id: "tempo", name: "Tempo"), VoiceOption(id: "verse", name: "Verse"),
        VoiceOption(id: "vesper", name: "Vesper"), VoiceOption(id: "willow", name: "Willow"),
    ]
    /// The ids alone, for every caller that only wants the list.
    static let voices: [String] = voiceOptions.map(\.id)

    /// The languages the voice can be asked for. One today; the Audio row is a read-only value
    /// until a second appears (a menu with one option reads as broken).
    static let languages: [String: String] = ["en": "English"]

    /// "en" → "English"; an unknown tag falls back to English on purpose — the engine does too.
    static func languageLabel(_ tag: String) -> String {
        languages[tag.lowercased().split(separator: "-").first.map(String.init) ?? tag] ?? "English"
    }

    /// "Cedar · English" — the name when the id is known, the raw id when it is not (a
    /// JARHEAD_VOICE outside the list still shows), always with the language it will speak.
    static func voiceLabel(_ id: String) -> String {
        let name = voiceOptions.first { $0.id == id }?.name ?? id
        return "\(name) · \(languageLabel("en"))"
    }

    /// How the English sounds (protocol Accent): the Audio row's three segments. Best-effort on
    /// the model's side; the language lock is the robust half.
    struct AccentOption: Hashable {
        let id: String
        let label: String
    }
    static let accents: [AccentOption] = [AccentOption(id: "american", label: "American"), AccentOption(id: "british", label: "British"), AccentOption(id: "none", label: "None")]
    static func accentLabel(_ id: String) -> String { accents.first { $0.id == id }?.label ?? id.capitalized }

    // MARK: memory — what Jarhead remembers about Kevin (protocol MemoryItem / MemorySummary)

    /// One solid symbol per kind on the icon column.
    static func memorySymbol(_ kind: MemoryKind) -> String {
        switch kind {
        case .preference: return "hand.thumbsup.fill"
        case .fact: return "lightbulb.fill"
        case .episode: return "clock.fill"
        case .procedure: return "list.bullet.rectangle.fill"
        case .contact: return "person.crop.circle.fill"
        case .place: return "mappin.circle.fill"
        }
    }

    /// The state's word as the rail's segments and rows say it. Forget and Archive are
    /// states, never deletions: the store keeps every item.
    static func memoryStateLabel(_ s: MemoryState) -> String {
        switch s {
        case .live: return "Live"
        case .forgotten: return "Forgotten"
        case .merged: return "Merged"
        case .archived: return "Archived"
        }
    }

    /// The Settings row's "Matching" value: how items are compared. OpenAI embeddings (the voice
    /// key; item text leaves the Mac for that), a local embedding model on this Mac, or keyword
    /// matching (nothing leaves). "—" before a summary has arrived.
    static func memoryMatching(_ m: MemorySummary?) -> String {
        guard let m else { return "—" }
        switch m.embeddings {
        case "openai":
            if let dims = m.embeddingDims { return "OpenAI · \(dims) dims" }
            return "OpenAI · 512 dims"
        case "local":
            var parts = ["local"]
            if let model = m.embeddingModel, !model.isEmpty { parts.append(model) }
            if let dims = m.embeddingDims { parts.append("\(dims) dims") }
            return parts.joined(separator: " · ")
        default:
            return "keyword · nothing leaves"
        }
    }

    /// "142 live · 3 forgotten · 1 archived" — the counts in one mono line.
    static func memoryCounts(_ m: MemorySummary) -> String {
        "\(m.count) live · \(m.forgotten) forgotten · \(m.archived) archived"
    }

    /// The honest framing: the budget CAPS what memory costs a turn; the saving is Kevin never
    /// re-explaining himself. The two figures are the protocol's BRAIN_MEMORY_TOKENS / VOICE_MEMORY_TOKENS.
    static let memoryBudgetHint = "Capped at 250 brain · 120 voice tokens a turn. The saving is never re-explaining yourself."
    /// Every Forget in the Console says the same thing; no control offers a deletion verb.
    static let memoryForgetHint = "Forget hides it from Jarhead; Jarhead's own record keeps it (nothing is deleted)."
    /// Settings › Audio: the promise, and when a pick is heard.
    static let languageHint = "English at all times. A change is heard at the next wake."

    /// Every brain the contract knows, so whatever the daemon runs is a valid pick.
    static let brains: [BrainKind] = BrainKind.allCases
    static let efforts = ["low", "medium", "high", "xhigh", "max"]

    /// The model to suggest when a brain is picked; "" leaves it to the engine.
    static func defaultBrainModel(_ kind: BrainKind) -> String {
        switch kind {
        case .claudeCode, .anthropicApi: return "claude-opus-5"
        case .openaiResponses: return "gpt-5.6-terra"
        case .auto, .codex, .openaiCompatible, .local: return ""
        }
    }

    // MARK: data paths (SetupStatus.dataPaths) — the "Leaves the Mac" rows

    /// One solid symbol per `what` (voice · brain · memory · web).
    static func dataPathSymbol(_ what: String) -> String {
        switch what {
        case "voice": return "waveform"
        case "brain": return "brain.fill"
        case "memory": return "tray.full.fill"
        case "web": return "globe"
        default: return "questionmark.circle.fill"
        }
    }

    /// The trailing glyph for `where`: the cloud, this Mac, the LAN, off.
    static func dataPathWhereSymbol(_ where: String) -> String {
        switch `where` {
        case "cloud": return "icloud.fill"
        case "mac": return "laptopcomputer"
        case "lan": return "network"
        default: return "minus.circle"
        }
    }

    /// Cloud in titanium (the fact, not a fault), this Mac in the acting green, the LAN in amber, off quiet.
    static func dataPathTint(_ where: String) -> Color {
        switch `where` {
        case "cloud": return titanium
        case "mac": return acting
        case "lan": return speaking
        default: return fg3
        }
    }

    /// The row's name: "Voice", "Brain", "Memory", "Web"; an unknown `what` capitalised.
    static func dataPathName(_ what: String) -> String {
        switch what {
        case "voice": return "Voice"
        case "brain": return "Brain"
        case "memory": return "Memory"
        case "web": return "Web"
        default: return what.capitalized
        }
    }

    /// "Claude Code", or "Automatic → Codex" once `auto` has resolved.
    static func brainName(_ kind: BrainKind, resolved: BrainKind?) -> String {
        if kind == .auto, let r = resolved, r != .auto { return "Automatic → \(r.label)" }
        return kind.label
    }

    // MARK: wake word gate — the status menu's wording (StatusItem.gateLabel/gateSymbol), as one meta

    struct GateMeta: Equatable {
        let symbol: String
        let color: Color
        let label: String
    }

    /// `auth` is named when it is `.none`, so a gate that opens the session on the
    /// word alone never looks like one that authenticates. `now` feeds the lockout
    /// countdown so a TimelineView can tick it.
    static func gate(_ g: WakeGateState, phrases: [String], auth: WakeAuth, now: Date = Date(), paused: Bool = false) -> GateMeta {
        switch g {
        case .off(let reason):
            // The gate's reason for the plain switch-off is itself "wake word off";
            // the em-dash form would read "Wake word off — wake word off".
            let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = why.isEmpty || why.lowercased() == "wake word off" ? "Wake word off" : "Wake word off — \(why)"
            return GateMeta(symbol: "ear.trianglebadge.exclamationmark", color: titanium, label: label)
        case .listening:
            let phrase = phrases.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "the wake word"
            // Paused: the word resumes without authentication (WakeGate.isPaused); say so, and name the button.
            if paused { return GateMeta(symbol: "ear.fill", color: listening, label: "paused · say “\(phrase)” or press Go") }
            return GateMeta(symbol: "ear.fill", color: listening, label: "Listening for “\(phrase)”" + (auth == .none ? " — no authentication" : ""))
        case .heard:
            return GateMeta(symbol: "waveform.circle.fill", color: acting, label: "Heard you")
        case .authenticating(let method):
            return GateMeta(symbol: "lock.fill", color: speaking, label: "Waiting for \(method)")
        case .granted:
            return GateMeta(symbol: "waveform.circle.fill", color: acting, label: paused ? "Resuming…" : "Waking…")
        case .denied(let reason):
            return GateMeta(symbol: "xmark.circle.fill", color: error, label: "Not this time — \(reason)")
        case .lockedOut(let until):
            return GateMeta(symbol: "lock.slash.fill", color: error, label: "Locked for \(max(1, Int(until.timeIntervalSince(now).rounded()))) s")
        }
    }

    /// The gate holds the microphone while dormant (asleep, error) and while paused
    /// (WakeGate.listens(in:)); anywhere else the voice engine has it and the gate rests.
    static func gateRests(_ phase: Phase) -> Bool { phase != .asleep && phase != .error && phase != .paused }

    // MARK: problems (Snapshot.problems) — the glyph table is ProblemGlyphs; the colours are the Console's

    /// The Problems section's glyph and tint for a `ProblemKind`: a warning (a permission
    /// missing, `dock`, `brain.local`) in the speaking amber, an error in red.
    static func problem(_ kind: String) -> (symbol: String, tint: Color) {
        (ProblemGlyphs.symbol(for: kind), ProblemGlyphs.isWarning(kind) ? speaking : error)
    }

    // MARK: retention (Settings) — the menus' options and their words

    /// Ledger: keep forever · 30 · 90 · 365 days (0 = never).
    static let ledgerRetentionOptions = [0, 30, 90, 365]
    /// Screenshots: 7 · 14 · 30 · 90 days · forever.
    static let shotsRetentionOptions = [7, 14, 30, 90, 0]

    static func retentionTitle(_ days: Int, forever: String) -> String {
        days <= 0 ? forever : (days == 1 ? "1 day" : "\(days) days")
    }
}

// MARK: - Formatting (pure)

enum ConsoleFormat {
    private static func pad2(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// 4523 s → "1:15:23"; 383 s → "06:23"
    static func duration(_ totalSeconds: Double) -> String {
        let s = max(0, Int(totalSeconds.isFinite ? totalSeconds : 0))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? "\(h):\(pad2(m)):\(pad2(sec))" : "\(pad2(m)):\(pad2(sec))"
    }

    /// Billed seconds → "12.4 min"
    static func minutes(_ seconds: Double) -> String {
        let m = seconds / 60
        return m < 10 ? String(format: "%.1f min", m) : "\(Int(m.rounded())) min"
    }

    /// The meter's line: billed seconds → "2.3 min · $0.12" (TransportFormat, shared with the capsule).
    static func billed(_ seconds: Double) -> String { TransportFormat.billed(seconds) }

    /// The paused line (TransportFormat.pausedLine): the meter stopped, the conversation
    /// kept, the decay to sleep counting down.
    static func pausedLine(_ pause: PauseInfo, now: Date) -> String { TransportFormat.pausedLine(pause, now: now) }

    /// Milliseconds → "412 ms" | "1.2 s" | "1:04"
    static func ms(_ ms: Double?) -> String {
        guard let ms = ms, ms.isFinite else { return "—" }
        if ms < 1000 { return "\(Int(ms.rounded())) ms" }
        if ms < 60_000 { return ms < 10_000 ? String(format: "%.1f s", ms / 1000) : "\(Int((ms / 1000).rounded())) s" }
        return duration(ms / 1000)
    }

    static func delta(_ ms: Double?) -> String { ms == nil ? "—" : "+" + self.ms(ms) }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    /// Wall clock ms → "14:03:22"
    static func time(_ ms: Double) -> String {
        timeFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func fullDate(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        return d.formatted(date: .abbreviated, time: .standard)
    }

    /// "now", "12s", "3m", "2h", "yesterday", "Sep 3"
    static func relative(_ ms: Double, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        let s = Int(max(0, now - ms) / 1000)
        if s < 5 { return "now" }
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h" }
        let d = h / 24
        if d == 1 { return "yesterday" }
        if d < 7 { return "\(d)d" }
        return Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.month(.abbreviated).day())
    }

    private static let dayParser: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// "2026-09-10" → "Today" / "Yesterday" / "Tue, Sep 8"
    static func day(_ s: String, now: Date = Date()) -> String {
        guard let date = dayParser.date(from: s) else { return s }
        let cal = Calendar.current
        let today = cal.startOfDay(for: now)
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: today).day ?? 0
        if days == 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    /// Middle-ellipsize a path, keeping the tail: "~/…/apps/mac/Scripts"
    static func truncPath(_ path: String?, max: Int = 34) -> String {
        guard var p = path, !p.isEmpty else { return "" }
        if p.hasPrefix("/Users/") {
            var parts = p.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            if parts.count >= 2 { parts.removeFirst(2); p = "~" + (parts.isEmpty ? "" : "/" + parts.joined(separator: "/")) }
        }
        if p.count <= max { return p }
        var parts = p.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var tail = parts.popLast() ?? ""
        while parts.count > 1, let last = parts.last, tail.count + last.count + 2 <= max - 3 {
            tail = "\(parts.removeLast())/\(tail)"
        }
        let head = parts.first == "~" ? "~/" : ""
        let out = "\(head)…/\(tail)"
        return out.count <= max ? out : "…" + String(tail.suffix(max - 1))
    }

    /// "sess_7f3a9c2e…" → "7f3a9c2e"
    static func shortId(_ id: String?, _ n: Int = 8) -> String {
        guard let id = id, !id.isEmpty else { return "—" }
        let tail = id.split(whereSeparator: { $0 == ":" || $0 == "_" || $0 == "-" }).last.map(String.init) ?? id
        return tail.count > n ? String(tail.prefix(n)) : tail
    }

    /// Pretty JSON for tool inputs/outputs; bare strings shown raw.
    static func pretty(_ v: JSONValue?, max: Int = 600) -> String {
        guard let v = v else { return "" }
        var text: String
        if case .string(let s) = v { text = s } else { text = prettyJSON(v, indent: 0) }
        if text.count > max { text = String(text.prefix(max)) + "\n…" }
        return text
    }

    private static func prettyJSON(_ v: JSONValue, indent: Int) -> String {
        let pad = String(repeating: "  ", count: indent)
        let padIn = String(repeating: "  ", count: indent + 1)
        switch v {
        case .string(let s):
            let escaped = s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n")
            return "\"\(escaped)\""
        case .number, .bool, .null: return v.compact
        case .array(let a):
            if a.isEmpty { return "[]" }
            return "[\n" + a.map { padIn + prettyJSON($0, indent: indent + 1) }.joined(separator: ",\n") + "\n\(pad)]"
        case .object(let o):
            if o.isEmpty { return "{}" }
            return "{\n" + o.keys.sorted().map { "\(padIn)\"\($0)\": \(prettyJSON(o[$0]!, indent: indent + 1))" }.joined(separator: ",\n") + "\n\(pad)}"
        }
    }

    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// Bytes → "412 KB" · "129 MB" · "1.2 GB" (the Trash row's size).
    static func bytes(_ n: Double) -> String {
        guard n.isFinite, n > 0 else { return "0 KB" }
        if n < 1_000_000 { return "\(max(1, Int((n / 1000).rounded()))) KB" }
        if n < 1_000_000_000 { return "\(Int((n / 1_000_000).rounded())) MB" }
        return String(format: "%.1f GB", n / 1_000_000_000)
    }

    /// "3 days" · "1 day" · "empty" (the Trash row's count of day files).
    static func days(_ n: Int) -> String {
        n <= 0 ? "empty" : (n == 1 ? "1 day" : "\(n) days")
    }

    /// The Trash row: "3 days · 129 MB"; "empty" when nothing is there.
    static func trashLine(_ t: TrashInfo) -> String {
        t.days <= 0 && t.bytes <= 0 ? "empty" : "\(days(t.days)) · \(bytes(t.bytes))"
    }

    /// A thread's mono meta: "00:12 · screen · 7 steps" — how long it has run (ticking while
    /// live, frozen at `doneAt` after), its lane, its step count. The main thread has no steps
    /// of its own to count between turns, so an idle main reads "00:12 · voice".
    static func threadMeta(_ t: WorkThread, now: Double) -> String {
        let end = t.doneAt ?? now
        var parts = [duration(max(0, end - t.startedAt) / 1000), ConsoleTheme.lane(t.lane)]
        if t.steps > 0 || t.id != "main" { parts.append(t.steps == 1 ? "1 step" : "\(t.steps) steps") }
        return parts.joined(separator: " · ")
    }

    /// The Threads head's count: "3 · 2 running" — how many are on the rail, how many are busy.
    static func threadsCount(total: Int, busy: Int) -> String {
        busy > 0 ? "\(total) · \(busy) running" : "\(total)"
    }
}

// MARK: - Motion: the Console's bridge onto UI/Motion.swift

/// The shared vocabulary in the shapes SwiftUI asks for here: Motion's Core Animation
/// curves as `Animation`s, the arrive/leave transition every toast and pill uses, the
/// hover answer, the content transitions for a symbol that swaps and digits that count.
/// Every number is Motion's; Reduce Motion is Motion's call (`Motion.reduced`), read
/// when a body is built — so a toggle of the system setting while the Console is open
/// takes effect from each view's next state change, not on the frame it flips (the
/// feeds' scroll trackers and `ConsoleDot`, which watch the SwiftUI environment value,
/// follow it live). A harness pins it with `Motion.reducedOverride`.
enum ConsoleMotion {
    /// A Core Animation curve (`Motion.easeOut` / `easeIn` / `easeInOut`) as a SwiftUI
    /// animation of `duration`, honouring Reduce Motion the way `Motion.seconds` does.
    static func animation(_ curve: CAMediaTimingFunction, _ duration: Double) -> Animation {
        Motion.animation(curve, duration)
    }

    /// Leaving, gaining speed: `Motion.easeIn` over `Motion.base`.
    static var leave: Animation { animation(Motion.easeIn, Motion.base) }

    /// A hover state or a press being felt: `Motion.instant`, eased out.
    static var hover: Animation { .easeOut(duration: Motion.seconds(Motion.instant)) }

    /// How far a view rises as it arrives — `Motion.appear`'s insertion offset, for the
    /// row-level appear that must not touch layout (`ConsoleRowAppear`).
    static let rise: CGFloat = 6

    /// A toast or a pill: arrives with a fade and a rise (`Motion.bouncy`, a little
    /// life), leaves with a fade and a drop gaining speed (`Motion.easeIn`). Stacked
    /// neighbours reflow under the container's own animation. A plain fade under
    /// Reduce Motion.
    static var arriveLeave: AnyTransition {
        if Motion.reduced { return .opacity.animation(Motion.fade) }
        return .asymmetric(insertion: .opacity.combined(with: .offset(y: 8)).animation(Motion.bouncy),
                           removal: .opacity.combined(with: .offset(y: 8)).animation(leave))
    }

    /// A step changing hands: the new one fades in from one side by `distance` (from the
    /// right going forward, from the left going back) over the old one fading out where
    /// it stands. The removal is a plain fade on purpose: a view leaving keeps the
    /// transition it was given when it arrived, so a slide-out would go the wrong way the
    /// moment the direction flips. A plain fade both ways under Reduce Motion.
    static func slide(forward: Bool, distance: CGFloat = 12) -> AnyTransition {
        if Motion.reduced { return .opacity }
        return .asymmetric(insertion: .opacity.combined(with: .offset(x: forward ? distance : -distance)),
                           removal: .opacity)
    }

    /// A symbol whose name changes: the SF Symbol replace effect, a fade under Reduce Motion.
    static var symbol: ContentTransition { Motion.reduced ? .opacity : .symbolEffect(.replace) }

    /// Digits that count (a meter, a message count): each changed digit rolls; a fade under Reduce Motion.
    static var numeric: ContentTransition { Motion.reduced ? .opacity : .numericText() }
}

/// A row arriving in a feed: the fade and 6pt rise of `Motion.appear`, done on the row's
/// own opacity and offset — never on its layout. The feed's sticky bottom is pinned to
/// the document's height by an AppKit probe (StreamFeed), and a transition that grew the
/// document over 0.4 s would move that pin every frame; this way the height is exactly
/// what it will be from the first frame and only the ink moves. Rows already there when
/// the feed opened, and the rows a read it opened waiting on (`animated: false` until the
/// feed has settled with content), show at once — the pane they are in is arriving on
/// its own. Reduce Motion: a fade, no rise.
struct ConsoleRowAppear: ViewModifier {
    let animated: Bool
    @State private var shown: Bool

    init(animated: Bool) {
        self.animated = animated
        _shown = State(initialValue: !animated)
    }

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || Motion.reduced ? 0 : ConsoleMotion.rise)
            .onAppear {
                guard !shown else { return }
                withAnimation(Motion.gentle) { shown = true }
            }
    }
}

extension View {
    /// Fade in and rise as a new row (see `ConsoleRowAppear`).
    func rowAppear(animated: Bool = true) -> some View { modifier(ConsoleRowAppear(animated: animated)) }
}

// MARK: - Shared controls

/// A status dot; pulses while `live`. The pulse starts and stops with the
/// value (not only on appear) and is absent under reduce motion, so a finished
/// dot never carries a running repeatForever animation. A colour change (the
/// phase turning) crossfades.
struct ConsoleDot: View {
    let color: Color
    var live = false
    var size: CGFloat = 6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    private var pulsing: Bool { live && !reduceMotion }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .animation(Motion.fade, value: color)
            .overlay {
                if pulsing {
                    Circle()
                        .stroke(color.opacity(pulse ? 0 : 0.5), lineWidth: 1.5)
                        .scaleEffect(pulse ? 2.4 : 1)
                }
            }
            .onAppear(perform: sync)
            .onChange(of: live) { sync() }
            .onChange(of: reduceMotion) { sync() }
    }

    /// Snap the ring back without animation (which cancels a running loop),
    /// then start a fresh loop on the next tick if the dot is live.
    private func sync() {
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { pulse = false }
        guard pulsing else { return }
        DispatchQueue.main.async {
            guard pulsing else { return }
            withAnimation(.easeOut(duration: Motion.pulse).repeatForever(autoreverses: false)) { pulse = true }
        }
    }
}

/// A solid SF Symbol on the fixed 20pt icon column. A name that changes (a grant
/// landing, Go turning into Pause) swaps with the symbol replace effect; a tint that
/// changes crossfades — so no glyph in the Console ever cuts.
struct ConsoleIcon: View {
    let name: String
    var tint: Color = ConsoleTheme.titanium
    var size: CGFloat = 13

    var body: some View {
        Image(systemName: name)
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 20, height: 20)
            .contentTransition(ConsoleMotion.symbol)
            .animation(Motion.fade, value: name)
            .animation(Motion.fade, value: tint)
    }
}

/// An agent's status as one glyph on the icon column: a (pulsing) dot for
/// working/idle, a solid symbol for everything else.
struct ConsoleStatusGlyph: View {
    let status: AgentStatus

    var body: some View {
        let meta = ConsoleTheme.status(status)
        // A ZStack, so the dot and the symbol crossfade when the status settles.
        ZStack {
            if let symbol = meta.symbol {
                ConsoleIcon(name: symbol, tint: meta.color).transition(.opacity)
            } else {
                ConsoleDot(color: meta.color, live: meta.live, size: meta.live ? 7 : 6).transition(.opacity)
            }
        }
        .frame(width: 20, height: 20)
        .animation(Motion.fade, value: status)
        .help(status.rawValue)
        .accessibilityLabel(status.rawValue)
    }
}

/// A delegation's status as one glyph: a pulsing dot while live, a symbol once settled;
/// the two crossfade as the status changes.
struct ConsoleDelegationGlyph: View {
    let status: DelegationStatus

    var body: some View {
        let meta = ConsoleTheme.delegation(status)
        ZStack {
            if meta.live {
                ConsoleDot(color: meta.color, live: true, size: 7).transition(.opacity)
            } else {
                ConsoleIcon(name: meta.symbol, tint: meta.color).transition(.opacity)
            }
        }
        .frame(width: 20, height: 20)
        .animation(Motion.fade, value: status)
        .help(meta.label)
        .accessibilityLabel(meta.label)
    }
}

/// A thread's status as one glyph on the icon column: a dot while it is starting, thinking or
/// acting (pulsing then; still and grey for the idle main), a solid symbol while it waits (the
/// hourglass, the raised hand), while paused, and once it settles; the two crossfade as the
/// status turns, so a thread finishing never cuts.
struct ConsoleThreadGlyph: View {
    let status: ThreadStatus

    var body: some View {
        let meta = ConsoleTheme.thread(status)
        ZStack {
            if meta.dot {
                ConsoleDot(color: meta.color, live: meta.live, size: meta.live ? 7 : 6).transition(.opacity)
            } else {
                ConsoleIcon(name: meta.symbol, tint: meta.color).transition(.opacity)
            }
        }
        .frame(width: 20, height: 20)
        .animation(Motion.fade, value: status)
        .help(meta.label)
        .accessibilityLabel(meta.label)
    }
}

/// A 28pt section head: one-word title, optional count, optional trailing control.
struct ConsoleSectionHead<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    let trailing: Trailing

    init(_ title: String, count: Int? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.count = count
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.titanium)
            if let count = count {
                // The count rolls its digits as sessions come and go; the number arriving
                // or leaving altogether fades.
                Text("\(count)").font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                    .contentTransition(ConsoleMotion.numeric)
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
            trailing
        }
        .padding(.horizontal, 12)
        .frame(height: 28)
        .animation(Motion.snappy, value: count)
    }
}

extension ConsoleSectionHead where Trailing == EmptyView {
    init(_ title: String, count: Int? = nil) {
        self.init(title, count: count) { EmptyView() }
    }
}

/// Buttons: one filled accent for the primary action, ghost with a hairline
/// elsewhere, `plain` for icon-only chrome, `danger` for a hot Stop.
struct ConsoleButtonStyle: ButtonStyle {
    enum Kind { case ghost, plain, primary, danger }
    var kind: Kind = .ghost
    var iconOnly = false
    var height: CGFloat = 28
    var small = false

    func makeBody(configuration: Configuration) -> some View {
        ConsoleButtonBody(kind: kind, iconOnly: iconOnly, height: height, small: small, configuration: configuration)
    }
}

private struct ConsoleButtonBody: View {
    let kind: ConsoleButtonStyle.Kind
    let iconOnly: Bool
    let height: CGFloat
    let small: Bool
    let configuration: ButtonStyle.Configuration

    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .font(ConsoleTheme.sans(small ? 11 : 12, .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, iconOnly ? 0 : (small ? 8 : 10))
            .frame(width: iconOnly ? height : nil, height: height)
            .background(RoundedRectangle(cornerRadius: 6).fill(background))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(border, lineWidth: 1))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
            .onHover { hovering = $0 }
            // The hover and the press are felt at once; a kind that flips (Stop turning
            // red, Send filling with text, Go becoming a ghost) crossfades its fill.
            .animation(ConsoleMotion.hover, value: hovering)
            .animation(ConsoleMotion.hover, value: configuration.isPressed)
            .animation(Motion.snappy, value: kind)
            .animation(Motion.fade, value: enabled)
    }

    private var lit: Bool { hovering || configuration.isPressed }

    private var foreground: Color {
        switch kind {
        case .ghost, .plain: return lit ? ConsoleTheme.fg : ConsoleTheme.fg2
        case .primary, .danger: return ConsoleTheme.onAccent
        }
    }

    private var background: Color {
        switch kind {
        case .ghost, .plain: return configuration.isPressed ? ConsoleTheme.active : (hovering ? ConsoleTheme.hover : .clear)
        case .primary: return ConsoleTheme.accent.opacity(configuration.isPressed ? 0.8 : 1)
        case .danger: return ConsoleTheme.error.opacity(configuration.isPressed ? 0.8 : 1)
        }
    }

    private var border: Color {
        switch kind {
        case .ghost: return ConsoleTheme.hair
        case .plain, .primary, .danger: return .clear
        }
    }
}

/// Text field chrome: 6pt box, hairline at rest, accent ring while focused; the
/// one ring turns red while `error` (a rejected passphrase), never a second stroke.
/// `grows` is for a `TextField(axis: .vertical)`: `height` becomes the minimum and
/// the box wraps with the text instead of clipping it.
struct ConsoleFieldModifier: ViewModifier {
    var mono = false
    var height: CGFloat = 32
    var focused = false
    var error = false
    var grows = false

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(mono ? ConsoleTheme.mono(12) : ConsoleTheme.sans(13))
            .foregroundStyle(ConsoleTheme.fg)
            .tint(ConsoleTheme.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, grows ? 5 : 0)
            .frame(minHeight: height, maxHeight: grows ? nil : height)
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.ground))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(error ? ConsoleTheme.error : (focused ? ConsoleTheme.accent : ConsoleTheme.hair), lineWidth: 1))
            // The ring answers focus and a rejection at once.
            .animation(Motion.snappy, value: error)
            .animation(Motion.snappy, value: focused)
    }
}

extension View {
    func consoleField(mono: Bool = false, height: CGFloat = 32, focused: Bool = false, error: Bool = false, grows: Bool = false) -> some View {
        modifier(ConsoleFieldModifier(mono: mono, height: height, focused: focused, error: error, grows: grows))
    }
}

/// A short sideways shake (three cycles, ±4pt) for a rejected entry. Drive it by
/// adding 1 to `shakes` inside `withAnimation`; the caller skips that under reduce motion.
struct ConsoleShake: GeometryEffect {
    var shakes: CGFloat
    var amplitude: CGFloat = 4

    var animatableData: CGFloat {
        get { shakes }
        set { shakes = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: amplitude * sin(shakes * .pi * 6), y: 0))
    }
}

/// A picker drawn as a field: value, chevron, hairline box; the menu lists the options.
/// `fieldTitle` is the collapsed label when the full title is too long for the field; `dim`
/// names the options drawn quiet (a model that does not fit this Mac) — still pickable.
struct ConsoleMenuField<Value: Hashable>: View {
    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void
    var mono = false
    var fieldTitle: ((Value) -> String)? = nil
    var dim: ((Value) -> Bool)? = nil

    @State private var hovering = false

    private func isDim(_ option: Value) -> Bool {
        guard let dim else { return false }
        return dim(option)
    }

    var body: some View {
        Menu {
            Picker("", selection: Binding(get: { value }, set: { pick($0) })) {
                ForEach(options, id: \.self) { option in
                    Text(title(option)).foregroundStyle(isDim(option) ? ConsoleTheme.fg3 : ConsoleTheme.fg).tag(option)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            HStack(spacing: 6) {
                Text((fieldTitle ?? title)(value))
                    .font(mono ? ConsoleTheme.mono(12) : ConsoleTheme.sans(12))
                    .foregroundStyle(ConsoleTheme.fg)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ConsoleTheme.fg3)
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? ConsoleTheme.hover : .clear))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
    }
}

/// One option of a segmented control: the active one filled with the text colour and lettered
/// in the ground, the rest plain with a hover. The filled thumb is one view on the control's
/// matched geometry id, so it glides between options (Motion.snappy). The rail's tabs, the
/// Home row and `ConsoleSegments` all draw their options with this.
struct ConsoleSegmentOption: View {
    let title: String
    let on: Bool
    /// The control's namespace: the filled thumb glides between its options.
    let thumb: Namespace.ID
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ConsoleTheme.sans(12, .medium))
                .foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg2)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .frame(height: 28)
                .background {
                    if on {
                        Rectangle().fill(ConsoleTheme.fg).matchedGeometryEffect(id: "thumb", in: thumb)
                    } else if hovering {
                        Rectangle().fill(ConsoleTheme.hover)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: on)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A segmented control over any few values (Settings › Accent, the Memory rail's
/// Live | Forgotten | Archived): one hairline box, dividers between options, the thumb gliding
/// to the pick. Two or three options; more belongs in a `ConsoleMenuField`.
struct ConsoleSegments<Value: Hashable>: View {
    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void
    var accessibilityLabel: String? = nil

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.element) { index, option in
                if index > 0 { Rectangle().fill(ConsoleTheme.hair).frame(width: 1) }
                ConsoleSegmentOption(title: title(option), on: option == value, thumb: thumb) {
                    withAnimation(Motion.snappy) { pick(option) }
                }
            }
        }
        .frame(height: 28)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .animation(Motion.snappy, value: value)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel ?? title(value))
    }
}

/// One short warm line, centred; an optional action under it.
struct ConsoleEmpty<Action: View>: View {
    let text: String
    let action: Action

    init(_ text: String, @ViewBuilder action: () -> Action) {
        self.text = text
        self.action = action()
    }

    var body: some View {
        VStack(spacing: 12) {
            Text(text).font(ConsoleTheme.sans(13)).foregroundStyle(ConsoleTheme.fg2).multilineTextAlignment(.center)
            action
        }
        .frame(maxWidth: .infinity)
        .padding(20)
    }
}

extension ConsoleEmpty where Action == EmptyView {
    init(_ text: String) {
        self.init(text) { EmptyView() }
    }
}

/// The Console's ground: the flat token under a quiet dithered field — ink, a step to raised
/// ink past the middle, the accent as a whisper in the lower-right corner (`Dither.groundStops`;
/// paper → raised paper → paper into the accent in the aqua appearance). Four bands in 2 pt
/// cells, rendered at scale 1 and magnified by nearest, at sizes rounded up to 64 pt and pinned
/// bottom-trailing, so a live resize re-renders only across a 64 pt boundary and the whisper
/// stays in the window's corner. Text reads on every cell (the brightest is #161e35 / #f2f5fd).
/// The header, rails and stream draw no grounds of their own, so they sit on it; the window's
/// own `backgroundColor` stays the flat token for the resize seam.
struct ConsoleGround: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            ConsoleTheme.ground
            DitheredGradient(stops: scheme == .dark ? Dither.groundStops : Dither.paperStops, direction: .diagonal,
                             bands: Dither.groundBands, cellPoints: 2, placeholder: ConsoleTheme.ground,
                             sizeStep: 64, renderScale: 1, anchor: .bottomTrailing)
        }
    }
}

/// The Console's loading indicator: `DitherGlyphs` in the Console's mono 11 and `fg3` — the
/// ASCII ramp stepping through the Bayer ranks at 8 fps, still two-tone under Reduce Motion.
/// 8×1 beside a word ("Reading…", "Searching…"), 16×2 under an empty state's line.
struct ConsoleGlyphs: View {
    var cols = 8
    var rows = 1
    var color: Color = ConsoleTheme.fg3

    init(cols: Int = 8, rows: Int = 1, color: Color = ConsoleTheme.fg3) {
        self.cols = cols
        self.rows = rows
        self.color = color
    }

    var body: some View {
        DitherGlyphs(cols: cols, rows: rows, font: ConsoleTheme.mono(11, .medium), color: color)
    }
}

/// A rule, 1pt unless told otherwise. Structural by default; `.row` inside cards.
/// The two sidebar edges are 2pt (Kevin's call, see the note atop ConsoleTheme);
/// everything else stays 1pt.
struct ConsoleHairline: View {
    enum Weight { case structural, row }
    var vertical = false
    var weight: Weight = .structural
    var thickness: CGFloat = 1

    /// The rule that separates a sidebar from the stream.
    static let sidebarEdge: CGFloat = 2

    var body: some View {
        Rectangle()
            .fill(weight == .structural ? ConsoleTheme.hair : ConsoleTheme.hairRow)
            .frame(width: vertical ? thickness : nil, height: vertical ? nil : thickness)
    }
}

/// The three columns' widths, and the window minimum derived from them so the
/// rails can never be clipped: the root frame and `NSWindow.minSize` both read
/// `minWidth`, which is the exact sum of what the HStack lays out.
enum ConsoleLayout {
    static let agentsRailWidth: CGFloat = 264
    static let rightRailWidth: CGFloat = 296
    /// Wide enough for a delegation card's tool row and a wrapped timeline.
    static let streamMinWidth: CGFloat = 420
    static let minHeight: CGFloat = 520
    static let defaultSize = CGSize(width: 1180, height: 760)

    static var minWidth: CGFloat {
        agentsRailWidth + ConsoleHairline.sidebarEdge + streamMinWidth + ConsoleHairline.sidebarEdge + rightRailWidth
    }
}

/// A left-to-right flow that wraps whole items onto the next line instead of
/// truncating each one, for mono runs (the delegation timeline) that must stay
/// legible when the stream is narrow.
struct ConsoleFlow: Layout {
    var hSpacing: CGFloat = 12
    var vSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let width = rows.flatMap { $0 }.map { $0.frame.maxX }.max() ?? 0
        let height = rows.last.map { row in row.map { $0.frame.maxY }.max() ?? 0 } ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(subviews, width: bounds.width) {
            for item in row {
                subviews[item.index].place(at: CGPoint(x: bounds.minX + item.frame.minX, y: bounds.minY + item.frame.minY),
                                           proposal: ProposedViewSize(item.frame.size))
            }
        }
    }

    private struct Item { let index: Int; let frame: CGRect }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [[Item]] {
        var rows: [[Item]] = [[]]
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for (index, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += rowHeight + vSpacing
                x = 0
                rowHeight = 0
                rows.append([])
            }
            rows[rows.count - 1].append(Item(index: index, frame: CGRect(origin: CGPoint(x: x, y: y), size: size)))
            x += size.width + hSpacing
            rowHeight = max(rowHeight, size.height)
        }
        return rows
    }
}

/// Thin, auto-hiding overlay scrollers on every Console scroll view, whatever the
/// system's "Show scroll bars" setting says. Legacy scrollers reserve a 15pt gutter
/// with a drawn track — a dark column with a grey thumb in dark mode — which is
/// exactly the "sidebar" Kevin asked to make thinner. Attach with `.thinScrollers()`.
struct ConsoleThinScrollers: NSViewRepresentable {
    final class Probe: NSView {
        override var intrinsicContentSize: NSSize { NSSize(width: 0, height: 0) }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { [weak self] in self?.apply() }
        }
        private func apply() {
            guard let scroll = enclosingScrollView else { return }
            scroll.scrollerStyle = .overlay
            scroll.autohidesScrollers = true
            scroll.verticalScroller?.controlSize = .small
            scroll.horizontalScroller?.controlSize = .small
            scroll.verticalScroller?.scrollerStyle = .overlay
            scroll.scrollerKnobStyle = .light
        }
    }
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) {}
}

extension View {
    /// Place inside a ScrollView's content: thin overlay scrollers, no gutter.
    func thinScrollers() -> some View {
        background(alignment: .topLeading) { ConsoleThinScrollers().frame(width: 0, height: 0) }
    }
}

/// Hook the Console's key equivalents up without a menu bar dependency.
enum ConsoleKeyCommand {
    /// ⌘W, ⌘. (AppState.transportStop), ⌘K.
    case close, stop, focusComposer
    /// ⌘P: the transport's Go / Pause (AppState.transportToggle) — go when asleep or
    /// paused, pause in session (the session closes, the conversation is kept).
    case transportToggle
    /// ⌘0: back to Now. ⌘⇧] / ⌘⇧[: the next / previous thread in the rail's order.
    case showNow, nextThread, prevThread
    /// ⌥⌘.: stop the open thread only (`thread.stop`; main parks its turn, the others carry
    /// on). ⌘. stays Stop everything.
    case stopThread
}

/// Which thread's question a confirm row's Allow / Deny answers (`thread.answer`). Set on the
/// environment by a live pane — the Now stream for "main", a ThreadPane for its thread — and
/// read by StepRow's waiting `confirm` row; nil (the default: a ledger day, a past conversation)
/// draws no buttons. The buttons are clicks only: `returnIsAYes` is false and nothing ever binds
/// them to Return — a bare Return in a composer must never be a yes to a pending action.
struct ConsoleConfirm: Equatable {
    let threadId: String
    /// Pinned false for good; read by the strips so the rule is in one place and in run.log.
    static let returnIsAYes = false
}

private struct ConsoleConfirmKey: EnvironmentKey {
    static let defaultValue: ConsoleConfirm? = nil
}

extension EnvironmentValues {
    var consoleConfirm: ConsoleConfirm? {
        get { self[ConsoleConfirmKey.self] }
        set { self[ConsoleConfirmKey.self] = newValue }
    }
}

/// The transport for the composer's Go/Pause: AppState's Transport region behind a
/// closure, installed by ConsoleWindowController, so the composer observes the phase it
/// is handed and not AppState (whose level stream would re-render it at 60 Hz). Stop
/// stays on `ConsoleActions.stop`, which lands in the same place.
struct ConsoleTransport {
    var toggle: () -> Void = {}
}

private struct ConsoleTransportKey: EnvironmentKey {
    static let defaultValue = ConsoleTransport()
}

extension EnvironmentValues {
    var consoleTransport: ConsoleTransport {
        get { self[ConsoleTransportKey.self] }
        set { self[ConsoleTransportKey.self] = newValue }
    }
}
