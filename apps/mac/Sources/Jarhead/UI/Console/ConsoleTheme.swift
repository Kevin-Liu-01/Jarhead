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

    // MARK: motion — opacity and transform only

    static let motion: Animation = .easeOut(duration: 0.2)
    static let fast: Animation = .easeOut(duration: 0.12)

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
        case .paused: return PhaseMeta(label: "Paused", color: muted, hint: "Mic muted. Session open.")
        case .error: return PhaseMeta(label: "Error", color: error, hint: "Something broke. See problems.")
        }
    }

    static let busyPhases: Set<Phase> = [.speaking, .thinking, .acting]
    static let sessionPhases: Set<Phase> = [.connecting, .listening, .speaking, .thinking, .acting, .muted]
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
    static func gate(_ g: WakeGateState, phrases: [String], auth: WakeAuth, now: Date = Date()) -> GateMeta {
        switch g {
        case .off(let reason):
            // The gate's reason for the plain switch-off is itself "wake word off";
            // the em-dash form would read "Wake word off — wake word off".
            let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = why.isEmpty || why.lowercased() == "wake word off" ? "Wake word off" : "Wake word off — \(why)"
            return GateMeta(symbol: "ear.trianglebadge.exclamationmark", color: titanium, label: label)
        case .listening:
            let phrase = phrases.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "the wake word"
            return GateMeta(symbol: "ear.fill", color: listening, label: "Listening for “\(phrase)”" + (auth == .none ? " — no authentication" : ""))
        case .heard:
            return GateMeta(symbol: "waveform.circle.fill", color: acting, label: "Heard you")
        case .authenticating(let method):
            return GateMeta(symbol: "lock.fill", color: speaking, label: "Waiting for \(method)")
        case .granted:
            return GateMeta(symbol: "waveform.circle.fill", color: acting, label: "Waking…")
        case .denied(let reason):
            return GateMeta(symbol: "xmark.circle.fill", color: error, label: "Not this time — \(reason)")
        case .lockedOut(let until):
            return GateMeta(symbol: "lock.slash.fill", color: error, label: "Locked for \(max(1, Int(until.timeIntervalSince(now).rounded()))) s")
        }
    }

    /// The engine takes a `wake` in these phases (WakeGate.isDormant); anywhere else the gate rests.
    static func gateRests(_ phase: Phase) -> Bool { phase != .asleep && phase != .error }
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
}

// MARK: - Shared controls

/// A status dot; pulses while `live`. The pulse starts and stops with the
/// value (not only on appear) and is absent under reduce motion, so a finished
/// dot never carries a running repeatForever animation.
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

/// A solid SF Symbol on the fixed 20pt icon column.
struct ConsoleIcon: View {
    let name: String
    var tint: Color = ConsoleTheme.titanium
    var size: CGFloat = 13

    var body: some View {
        Image(systemName: name)
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 20, height: 20)
    }
}

/// An agent's status as one glyph on the icon column: a (pulsing) dot for
/// working/idle, a solid symbol for everything else.
struct ConsoleStatusGlyph: View {
    let status: AgentStatus

    var body: some View {
        let meta = ConsoleTheme.status(status)
        Group {
            if let symbol = meta.symbol {
                ConsoleIcon(name: symbol, tint: meta.color)
            } else {
                ConsoleDot(color: meta.color, live: meta.live, size: meta.live ? 7 : 6)
            }
        }
        .frame(width: 20, height: 20)
        .help(status.rawValue)
        .accessibilityLabel(status.rawValue)
    }
}

/// A delegation's status as one glyph: a pulsing dot while live, a symbol once settled.
struct ConsoleDelegationGlyph: View {
    let status: DelegationStatus

    var body: some View {
        let meta = ConsoleTheme.delegation(status)
        Group {
            if meta.live {
                ConsoleDot(color: meta.color, live: true, size: 7)
            } else {
                ConsoleIcon(name: meta.symbol, tint: meta.color)
            }
        }
        .frame(width: 20, height: 20)
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
                Text("\(count)").font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            }
            Spacer(minLength: 0)
            trailing
        }
        .padding(.horizontal, 12)
        .frame(height: 28)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
            .animation(reduceMotion ? nil : ConsoleTheme.fast, value: hovering)
            .animation(reduceMotion ? nil : ConsoleTheme.fast, value: configuration.isPressed)
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

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
            .animation(reduceMotion ? nil : ConsoleTheme.fast, value: error)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
        .animation(reduceMotion ? nil : ConsoleTheme.fast, value: hovering)
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
    case close, stop, focusComposer
}
