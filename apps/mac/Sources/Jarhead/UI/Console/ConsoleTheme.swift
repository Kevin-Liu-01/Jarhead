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

    static let voices = ["cedar", "marin", "alloy", "ash", "ballad", "beacon", "bossa", "cinder", "coral", "delta", "echo",
                         "gleam", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow"]
    /// Every brain the contract knows, so whatever the daemon runs is a valid pick.
    static let brains: [BrainKind] = BrainKind.allCases
    static let efforts = ["low", "medium", "high", "xhigh", "max"]

    /// The model to suggest when a brain is picked; "" leaves it to the engine.
    static func defaultBrainModel(_ kind: BrainKind) -> String {
        switch kind {
        case .claudeCode, .anthropicApi: return "claude-opus-5"
        case .openaiResponses: return "gpt-5.6-terra"
        case .auto, .codex, .openaiCompatible: return ""
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

    // MARK: typed problems (Snapshot.problemsTyped) — one solid symbol per kind

    /// The Problems section's glyph for a `ProblemKind`; the triangle for one it does not know.
    static func problemSymbol(_ kind: String) -> String {
        switch kind {
        case "permission.accessibility": return "hand.raised.fill"
        case "permission.screenRecording": return "rectangle.inset.filled.badge.record"
        case "permission.microphone": return "mic.fill"
        case "permission.fullDiskAccess": return "internaldrive.fill"
        case "permission.other": return "lock.fill"
        case "brain.unavailable", "brain.probe": return "brain.fill"
        case "voice.limit": return "waveform.badge.exclamationmark"
        case "voice.connection": return "wifi.exclamationmark"
        case "voice.key": return "key.fill"
        case "hands.helper": return "hand.tap.fill"
        case "disk.low": return "externaldrive.fill.badge.exclamationmark"
        case "daemon": return "gearshape.2.fill"
        case "crash": return "bolt.trianglebadge.exclamationmark.fill"
        default: return "exclamationmark.triangle.fill"
        }
    }

    /// A permission missing is a warning (the hands work less); everything else is an error.
    static func problemTint(_ kind: String) -> Color {
        kind.hasPrefix("permission.") ? speaking : error
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

extension EngineCommand {
    /// A typed problem's remedy command as the wire carries it ({type, …}) → the case the
    /// Console can send; nil for one it does not know, when the caller falls back to
    /// `problem.retry` for the kind.
    init?(remedyJSON o: [String: JSONValue]) {
        guard case .string(let type)? = o["type"] else { return nil }
        func str(_ key: String) -> String? {
            if case .string(let s)? = o[key] { return s }
            return nil
        }
        func bool(_ key: String) -> Bool? {
            if case .bool(let b)? = o[key] { return b }
            return nil
        }
        switch type {
        case "wake": self = .wake
        case "sleep": self = .sleep
        case "mute": self = .mute
        case "unmute": self = .unmute
        case "stop": self = .stop
        case "go": self = .go
        case "pause": self = .pause
        case "resume": self = .resume
        case "interrupt": self = .interrupt(how: str("how") ?? "pressed")
        case "clear-problems": self = .clearProblems
        case "agent.refresh": self = .agentRefresh
        case "daemon.restart": self = .daemonRestart
        case "config.probe": self = .probeSetup
        case "open-console": self = .openConsole
        case "open-ledger": self = .openLedger
        case "ledger.sweep": self = .ledgerSweep
        case "conversation.new": self = .conversationNew
        case "now.clear": self = .nowClear
        case "now.restore": self = .nowRestore
        case "mark.clear": self = .markClear
        case "request-permission":
            guard let which = str("which") else { return nil }
            self = .requestPermission(which)
        case "problem.retry":
            guard let kind = str("kind") else { return nil }
            self = .problemRetry(kind: kind)
        case "agent.hide":
            guard let id = str("agentId") else { return nil }
            self = .agentHide(agentId: id, hidden: bool("hidden") ?? true)
        case "ledger.restore-day":
            guard let day = str("day") else { return nil }
            self = .ledgerRestoreDay(day: day)
        case "ledger.trash-day":
            guard let day = str("day") else { return nil }
            self = .ledgerTrashDay(day: day, what: str("what") ?? "both")
        default:
            return nil
        }
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
        var c1 = [Float](repeating: 0, count: 2), c2 = [Float](repeating: 0, count: 2)
        curve.getControlPoint(at: 1, values: &c1)
        curve.getControlPoint(at: 2, values: &c2)
        return .timingCurve(Double(c1[0]), Double(c1[1]), Double(c2[0]), Double(c2[1]), duration: Motion.seconds(duration))
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
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true }
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
/// `fieldTitle` is the collapsed label when the full title is too long for the field.
struct ConsoleMenuField<Value: Hashable>: View {
    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void
    var mono = false
    var fieldTitle: ((Value) -> String)? = nil

    @State private var hovering = false

    var body: some View {
        Menu {
            Picker("", selection: Binding(get: { value }, set: { pick($0) })) {
                ForEach(options, id: \.self) { option in
                    Text(title(option)).tag(option)
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
