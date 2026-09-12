import SwiftUI

// The capsule beside the blob and the status pill over its foot, in the house
// system (Prototemplate, translated to a Mac panel): ink or paper ground by
// appearance, text as white/ink alpha steps 1.0 / 0.72 / 0.48, titanium for meta,
// hairlines drawn once, exactly one accent for the one primary action, 6pt radius,
// solid SF Symbols on a fixed 20pt column, mono for timings. The phase colour stays
// on the blob; in here it is a 6pt dot and an icon tint, never a wash.

/// What the capsule reads. Fed from AppState by the controller with removeDuplicates so
/// the 30–60 Hz level stream never re-evaluates these views.
@MainActor
final class OrbCapsuleModel: ObservableObject {
    @Published var snapshot: Snapshot = .empty
    @Published var connected = false
    @Published var daemonDetail = "starting"
    /// True while the capsule is on screen; the timers tick only then.
    @Published var shown = false
    // The wake word gate, mirrored from AppState (distinct values only).
    @Published var wakeGate: WakeGateState = .off(reason: "starting")
    @Published var wakePassphraseSet = false
    /// The recogniser's last words, for the ear in the gate row; fed only while shown.
    @Published var wakeHeard = ""
    /// Bumped when the panel stops being key: the passphrase field drops its focus ring.
    @Published var keyLost = 0
    /// Bumped on every Stop pressed on the capsule or the menu: the Stop button flashes red for the press.
    @Published var stopFlash = 0
    /// The blob sits on the capsule's right (the capsule grew leftward from a blob near
    /// the screen's right edge): the capsule pops open from that side.
    @Published var blobOnRight = false

    var phase: Phase { snapshot.phase }
    var lastKevin: TranscriptItem? { snapshot.transcript.last { $0.speaker == .kevin } }
    var lastJarhead: TranscriptItem? { snapshot.transcript.last { $0.speaker == .jarhead } }
    var activeDelegation: Delegation? { snapshot.delegations.last { $0.status == .running || $0.status == .awaitingConfirmation } }
    var isAwake: Bool { phase != .asleep && phase != .error }
    var paused: Bool { phase == .paused }
    /// The gate holds the microphone wherever the voice engine does not: dormant (asleep,
    /// error) and paused — WakeGate.listens(in:), spelled through Model because Wake/ is
    /// not compiled into the orb preview.
    var gateListens: Bool { !AppState.voiceAudioRuns(in: phase) }
    /// The gate block shows while the gate listens and the wake word is on — the same
    /// rule as the status menu's row. Paused included: the word resumes.
    var showsGate: Bool { gateListens && snapshot.settings.wakeSettings.enabled }
}

struct OrbPill: Equatable {
    var text: String
    var tone: Toast.Tone
    /// A solid SF Symbol in place of the tone dot (the gate's lock); tinted by tone.
    var icon: String? = nil
    /// Counting down to this moment: drawn as "<text> · N s", redrawn once a second.
    var until: Date? = nil
    /// A one-click action the pill offers (the way back to the notch): the pill becomes
    /// a button, with the accent word `actionTitle` at its end.
    var action: (() -> Void)? = nil
    var actionTitle: String = "Notch"

    static func == (a: OrbPill, b: OrbPill) -> Bool {
        a.text == b.text && a.tone == b.tone && a.icon == b.icon && a.until == b.until && (a.action == nil) == (b.action == nil) && a.actionTitle == b.actionTitle
    }
}

/// The small pill under the blob: first problem, else the latest toast.
@MainActor
final class OrbStatusModel: ObservableObject {
    @Published var pill: OrbPill?
    /// True while the panel is on screen; the lockout countdown ticks only then.
    @Published var shown = false
}

struct OrbCapsuleActions {
    /// Go / Pause — the transport's one button (`AppState.transportToggle`): go when asleep
    /// or paused, pause in session, stop while connecting. Wire it. Until the controller
    /// does, the view falls back to the retired `toggleAwake` / `togglePause` by phase
    /// (`OrbCapsuleView.pressTransport`), so the button keeps working across the change.
    var transportToggle: (() -> Void)? = nil
    /// Retired: the capsule has one Go/Pause now. Kept so the controller's memberwise init
    /// still compiles; the view reads them only as the fallback above.
    var toggleAwake: () -> Void = {}
    var toggleMute: () -> Void = {}
    var togglePause: () -> Void = {}
    /// Stop — `AppState.transportStop` (the command, the stop-pressed notification, the
    /// overlay clear, the toast); the controller adds only the capsule's red flash (`stopFlash`).
    var stop: () -> Void = {}
    var openConsole: () -> Void = {}
    var collapse: () -> Void = {}
    /// The typed passphrase (answers an open prompt, or wakes directly).
    var submitPassphrase: (String) -> Void = { _ in }
    var cancelAuth: () -> Void = {}
    /// The passphrase field took or gave up focus; the panel holds key status only in between.
    var fieldFocus: (Bool) -> Void = { _ in }
    /// Where the passphrase field is, in the capsule's own space (`OrbCapsuleView.space`:
    /// y down from the capsule's top-left); nil when the row is gone. The controller
    /// uses it to tell a click into the field from any other click.
    var fieldFrame: (CGRect?) -> Void = { _ in }
}

// MARK: - Tokens

/// The four colours plus one accent, resolved for the appearance. Dark is a token
/// remap: paper collapses onto raised ink, ink flips to white, hairline alphas rise.
struct OrbTheme {
    let dark: Bool

    static let ink = Color(red: 0x07 / 255, green: 0x07 / 255, blue: 0x07 / 255)
    static let inkRaised = Color(red: 0x10 / 255, green: 0x10 / 255, blue: 0x10 / 255)
    static let titanium = Color(red: 0x8a / 255, green: 0x8f / 255, blue: 0x98 / 255)
    static let paper = Color.white
    static let accentLight = Color(red: 0x2f / 255, green: 0x5c / 255, blue: 0xe0 / 255)
    static let accentDark = Color(red: 0x5b / 255, green: 0x82 / 255, blue: 0xff / 255)

    static let radius: CGFloat = 6
    static let iconColumn: CGFloat = 20
    static let rowHeight: CGFloat = 28
    /// A hover being felt (`Motion.instant`).
    static var motion: Animation { .easeOut(duration: Motion.seconds(Motion.instant)) }

    private var fg: Color { dark ? .white : Self.ink }
    var ground: Color { dark ? Self.inkRaised : Self.paper }
    var text: Color { fg }
    var text2: Color { fg.opacity(0.72) }
    var text3: Color { fg.opacity(0.48) }
    var titanium: Color { Self.titanium }
    /// Structural hairline: the capsule's edge and the header's rule.
    var hair: Color { dark ? Color.white.opacity(0.22) : Self.ink.opacity(0.18) }
    /// Row hairline: a row owns its bottom rule; the last row in a run drops it.
    var hairRow: Color { dark ? Color.white.opacity(0.10) : Self.ink.opacity(0.09) }
    /// Hover: the ground one alpha step.
    var hover: Color { dark ? Color.white.opacity(0.06) : Self.ink.opacity(0.05) }
    var accent: Color { dark ? Self.accentDark : Self.accentLight }
    /// A field's ground: ink under raised ink, paper on paper (the hairline is the seam).
    var field: Color { dark ? Self.ink : Self.paper }
    var error: Color { OrbStyle.color(.error) }
}

enum OrbStyle {
    static func color(_ phase: Phase) -> Color {
        let c = OrbPalette.color(for: phase)
        return Color(red: c.r, green: c.g, blue: c.b)
    }

    static func label(_ phase: Phase) -> String {
        switch phase {
        case .asleep: return "Asleep"
        case .connecting: return "Connecting"
        case .listening: return "Listening"
        case .speaking: return "Speaking"
        case .thinking: return "Thinking"
        case .acting: return "Acting"
        case .muted: return "Muted"
        case .paused: return "Paused"
        case .error: return "Error"
        }
    }

    static func mmss(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60) }
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    // MARK: wake gate — the same words and symbols as the status menu's row
    // (App/StatusItem.gateLabel / gateSymbol). App/ is not compiled into the orb
    // preview, so they are mirrored here; change both or neither.

    /// `auth` is named when it is `.none`, so a gate that opens the session on the word
    /// alone never looks like one that authenticates. While `paused` the gate listens for
    /// the word to *resume*, unauthenticated (WakeGate.isPaused), and the row says so.
    static func gateLabel(_ g: WakeGateState, phrases: [String], auth: WakeAuth = .either, now: Date = Date(), paused: Bool = false) -> String {
        switch g {
        case .off(let reason): return "Wake word off — \(reason)"
        case .listening:
            let phrase = phrases.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "the wake word"
            if paused { return "paused · say “\(phrase)” or press Go" }
            return "Listening for “\(phrase)”" + (auth == .none ? " — no authentication" : "")
        case .heard: return "Heard you"
        case .authenticating(let method): return "Waiting for \(method)"
        case .granted: return paused ? "Resuming…" : "Waking…"
        case .denied(let reason): return "Not this time — \(reason)"
        case .lockedOut(let until): return "Locked for \(max(1, Int(until.timeIntervalSince(now).rounded()))) s"
        }
    }

    static func gateSymbol(_ g: WakeGateState) -> String {
        switch g {
        case .off: return "ear.trianglebadge.exclamationmark"
        case .listening: return "ear.fill"
        case .heard, .granted: return "waveform.circle.fill"
        case .authenticating: return "lock.fill"
        case .denied: return "xmark.circle.fill"
        case .lockedOut: return "lock.slash.fill"
        }
    }

    /// The gate icon's tint: quiet while it only listens, a step up while it asks (it is
    /// status, not the primary action — the accent stays on the blob and the Wake
    /// button), red for a refusal, titanium while locked.
    static func gateTint(_ g: WakeGateState, theme: OrbTheme) -> Color {
        switch g {
        case .off, .listening: return theme.text3
        case .heard, .granted: return color(.listening)
        case .authenticating: return theme.text2
        case .denied: return theme.error
        case .lockedOut: return theme.titanium
        }
    }

    /// The gate's method (WakeGate.currentMethod) written down. LocalAuth names the
    /// owner fallback "your password" for the spoken prompt; on a label the word alone
    /// will do, and it starts with a capital like "Touch ID" and "Apple Watch" do:
    /// "Password", "Passphrase", "Password or passphrase".
    static func gateMethodLabel(_ method: String) -> String {
        let m = method.replacingOccurrences(of: "your password", with: "Password")
        return m.prefix(1).uppercased() + m.dropFirst()
    }

    /// The pill's text while the gate waits: what the spoken prompt asked for.
    /// "passphrase" → "Password?" (the prompt's own word); "Touch ID" → "Touch ID?";
    /// "Touch ID or passphrase" stays as it is ("your password or passphrase" → "Password or passphrase").
    static func gatePrompt(method: String) -> String {
        let m = gateMethodLabel(method)
        if m.contains(" or ") { return m }
        if m == "Passphrase" { return "Password?" }
        return m + "?"
    }

    /// The capsule row's words: the status menu's, except while authenticating, where
    /// the lock already says "waiting" and "Waiting for Touch ID or passphrase" does
    /// not fit beside Cancel — the method alone. The full wording stays in the tooltip.
    static func gateRowLabel(_ g: WakeGateState, phrases: [String], auth: WakeAuth = .either, now: Date = Date(), paused: Bool = false) -> String {
        if case .authenticating(let method) = g { return gateMethodLabel(method) }
        return gateLabel(g, phrases: phrases, auth: auth, now: now, paused: paused)
    }
}

// MARK: - Capsule

/// Header (phase, timers) over its own rule; the last exchange and the running
/// delegation as icon rows; the actions as icon buttons. One filled button at most.
///
/// Motion: the capsule pops open from the blob's side on `Motion.bouncy` the moment
/// `model.shown` flips, its rows staggering in behind the frame (`Motion.stagger`
/// apart, each a fade and a 6 pt rise); closing, the content fades and draws in over
/// `Motion.quick` and the controller shrinks the panel once it has. The transport's
/// icons crossfade when they swap, the meter's digits roll (`numericText`), and every
/// hover is `OrbTheme.motion`. Plain fades under Reduce Motion.
struct OrbCapsuleView: View {
    @ObservedObject var model: OrbCapsuleModel
    let actions: OrbCapsuleActions
    @Environment(\.colorScheme) private var scheme
    /// Stop was just pressed: the button wears the danger fill for 300 ms whatever is running.
    @State private var stopFlashing = false
    /// The capsule is open on screen (follows `model.shown`, animated).
    @State private var revealed = false

    /// The capsule's coordinate space (its top-left, y down): what `fieldFrame` reports in.
    static let space = "OrbCapsule"
    static let stopFlashSeconds = 0.3

    var body: some View {
        let theme = OrbTheme(dark: scheme == .dark)
        // A second while shown; effectively never while the host is hidden, so a
        // collapsed orb does not run SwiftUI layout once a second for nobody.
        TimelineView(.periodic(from: .now, by: model.shown ? 1 : 86_400)) { timeline in
            content(now: timeline.date, theme: theme)
        }
        .background(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).fill(theme.ground))
        .overlay(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).strokeBorder(theme.hair, lineWidth: 1))
        // The one sanctioned shadow in chrome: the capsule floats over other apps.
        .shadow(color: .black.opacity(theme.dark ? 0.45 : 0.18), radius: 14, y: 6)
        // The frame morphs open from the blob's side with a little life, and folds
        // back toward it as the content fades; a plain fade under Reduce Motion.
        .scaleEffect(revealed || Motion.reduced ? 1 : 0.88, anchor: model.blobOnRight ? .trailing : .leading)
        .opacity(revealed ? 1 : 0)
        .animation(revealed ? Motion.bouncy : .easeIn(duration: Motion.seconds(Motion.quick)), value: revealed)
        .coordinateSpace(name: Self.space)
        .onAppear { revealed = model.shown }
        .onChange(of: model.shown) { revealed = model.shown }
        .onChange(of: model.stopFlash) {
            stopFlashing = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(Self.stopFlashSeconds * 1_000_000_000))
                stopFlashing = false
            }
        }
    }

    @ViewBuilder
    private func content(now: Date, theme: OrbTheme) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(now: now, theme: theme)
                .frame(height: 30)
                .padding(.horizontal, 10)
                .staggered(revealed, index: 0)
            // The header owns its bottom rule.
            Rectangle().fill(theme.hair).frame(height: 1)
                .staggered(revealed, index: 0)

            // Each row owns its bottom rule (row weight); the last row in the run
            // drops it, so two wrapped lines never read as one four-line block.
            let delegation = model.activeDelegation
            let gate = model.showsGate
            // The typed passphrase only while dormant: paused resumes on the word or Go alone.
            let field = gate && model.wakePassphraseSet && !model.paused
            let pause = model.paused ? model.snapshot.pause : nil
            VStack(alignment: .leading, spacing: 0) {
                if model.lastKevin == nil, model.lastJarhead == nil {
                    row(icon: "mic.fill", tint: theme.text3, text: nil, empty: "Nothing heard yet.", theme: theme)
                        .ruled(pause != nil || delegation != nil || gate, theme: theme)
                        .staggered(revealed, index: 1)
                } else {
                    row(icon: "mic.fill", tint: theme.text3, text: model.lastKevin?.text, empty: "—", theme: theme)
                        .ruled(true, theme: theme)
                        .staggered(revealed, index: 1)
                    row(icon: "speaker.wave.2.fill", tint: theme.text3, text: model.lastJarhead?.text, empty: "—", theme: theme)
                        .ruled(pause != nil || delegation != nil || gate, theme: theme)
                        .staggered(revealed, index: 2)
                }
                // Paused: the session line — the meter stopped, the conversation kept, the
                // decay to sleep counting down (this view already ticks once a second while shown).
                if let p = pause {
                    row(icon: "pause.fill", tint: theme.text3, text: TransportFormat.pausedLine(p, now: now), empty: "—", theme: theme)
                        .ruled(delegation != nil || gate, theme: theme)
                        .staggered(revealed, index: 3)
                }
                if let d = delegation {
                    delegationRow(d, now: now, theme: theme)
                        .ruled(gate, theme: theme)
                        .staggered(revealed, index: 3)
                }
                // Asleep with the wake word on: what the gate is doing, and the typed way in.
                // The gate row draws no rule: it is either the last row, or the field's own
                // hairline box below it is the seam — one owner per edge.
                if gate {
                    gateRow(now: now, theme: theme)
                        .staggered(revealed, index: 3)
                    if field {
                        passphraseRow(theme: theme)
                            .staggered(revealed, index: 4)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 2)

            Spacer(minLength: 6)

            // The actions arrive with the last row, never later: they are what the capsule is for.
            actionRow(theme: theme)
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
                .staggered(revealed, index: 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func header(now: Date, theme: OrbTheme) -> some View {
        let phase = model.phase
        return HStack(spacing: 8) {
            Circle().fill(OrbStyle.color(phase))
                .frame(width: 6, height: 6)
                .frame(width: OrbTheme.iconColumn)
            Text(OrbStyle.label(phase))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(theme.text)
            Spacer(minLength: 4)
            // The meter. A session open: elapsed, and what it has billed at the list price
            // ("2.3 min · $0.12"; the word "billed" lives in the tooltip — the header is
            // ~255pt and label + elapsed + meter must share it). Paused: what the closed
            // session billed over today's total, two short lines. Asleep: today's total
            // when there is one, else the plain "no session".
            let today = TransportFormat.today(model.snapshot.usageToday)
            if let s = model.snapshot.session {
                let elapsed = OrbStyle.mmss(now.timeIntervalSince1970 - s.startedAt / 1000)
                let billed = TransportFormat.billed(s.usageSeconds)
                Text(elapsed)
                    .font(.system(size: 12, design: .monospaced).monospacedDigit())
                    .foregroundStyle(theme.text2)
                    .metered(elapsed)
                    .help("Elapsed")
                Text(billed)
                    .font(.system(size: 11, design: .monospaced).monospacedDigit())
                    .foregroundStyle(theme.titanium)
                    .lineLimit(1)
                    .metered(billed)
                    .help("Billed this session: " + billed + (today.map { " · " + $0 } ?? ""))
            } else if model.paused, let p = model.snapshot.pause {
                VStack(alignment: .trailing, spacing: 1) {
                    let billed = TransportFormat.billed(p.usageSeconds)
                    Text(billed)
                        .font(.system(size: 11, design: .monospaced).monospacedDigit())
                        .foregroundStyle(theme.titanium)
                        .lineLimit(1)
                        .metered(billed)
                    if let today {
                        Text(today)
                            .font(.system(size: 10, design: .monospaced).monospacedDigit())
                            .foregroundStyle(theme.text3)
                            .lineLimit(1)
                    }
                }
                .help("Billed by the paused session — the meter stopped when it closed" + (today.map { " · " + $0 } ?? ""))
            } else if model.connected, let today {
                Text(today)
                    .font(.system(size: 11, design: .monospaced).monospacedDigit())
                    .foregroundStyle(theme.titanium)
                    .lineLimit(1)
                    .help("Billed today, every session")
            } else {
                Text(model.connected ? "no session" : model.daemonDetail)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.titanium)
                    .lineLimit(1)
            }
        }
    }

    /// Fixed icon column, text that truncates into a tooltip instead of wrapping on.
    private func row(icon: String, tint: Color, text: String?, empty: String, theme: OrbTheme) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: OrbTheme.iconColumn)
            if let text, !text.isEmpty {
                Text(text)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.text)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .help(text)
            } else {
                Text(empty)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.text3)
            }
        }
        .padding(.vertical, 4)
        .frame(minHeight: OrbTheme.rowHeight, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The running delegation: status as the icon and its tint, the latest step as the
    /// text, elapsed as a right-aligned mono timestamp.
    private func delegationRow(_ d: Delegation, now: Date, theme: OrbTheme) -> some View {
        let waiting = d.status == .awaitingConfirmation
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: waiting ? "hand.raised.fill" : "gearshape.2.fill")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(OrbStyle.color(waiting ? .speaking : .acting))
                .frame(width: OrbTheme.iconColumn)
            Text(latestStepText(d))
                .font(.system(size: 12))
                .foregroundStyle(theme.text2)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(d.request)
            Spacer(minLength: 4)
            let elapsed = OrbStyle.mmss(now.timeIntervalSince1970 - d.timings.delegatedAt / 1000)
            Text(elapsed)
                .font(.system(size: 11, design: .monospaced).monospacedDigit())
                .foregroundStyle(theme.titanium)
                .metered(elapsed)
        }
        .padding(.vertical, 4)
        .frame(minHeight: OrbTheme.rowHeight, alignment: .leading)
    }

    /// The gate's state as one row: its symbol on the icon column, the status menu's
    /// words, the recogniser's last words in mono on the right (the ear), and — while a
    /// prompt is open — a ghost Cancel.
    private func gateRow(now: Date, theme: OrbTheme) -> some View {
        let gate = model.wakeGate
        let settings = model.snapshot.settings.wakeSettings
        let full = OrbStyle.gateLabel(gate, phrases: settings.phrases, auth: settings.auth, now: now, paused: model.paused)
        let label = OrbStyle.gateRowLabel(gate, phrases: settings.phrases, auth: settings.auth, now: now, paused: model.paused)
        return HStack(alignment: .center, spacing: 8) {
            Image(systemName: OrbStyle.gateSymbol(gate))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(OrbStyle.gateTint(gate, theme: theme))
                .frame(width: OrbTheme.iconColumn)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(theme.text2)
                .lineLimit(1)
                .truncationMode(.tail)
                // Ahead of the ear, which yields to it. Cancel is fixed-size (OrbTextButton)
                // and is measured first, so the label truncates before the button does.
                .layoutPriority(1)
                .help(full)
            Spacer(minLength: 4)
            if gate.isAuthenticating {
                OrbTextButton(title: "Cancel", theme: theme, action: actions.cancelAuth)
            } else if !model.wakeHeard.isEmpty {
                // The ear: the last words heard, head-truncated so the newest stay; it
                // yields to the label, never the other way round.
                Text(model.wakeHeard)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.titanium)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .frame(maxWidth: 88, alignment: .trailing)
                    .help("What the on-device recogniser hears")
            }
        }
        .padding(.vertical, 4)
        .frame(minHeight: OrbTheme.rowHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// The typed passphrase: a key on the icon column and a SecureField that submits
    /// on Return and clears itself.
    private func passphraseRow(theme: OrbTheme) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "key.fill")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(theme.text3)
                .frame(width: OrbTheme.iconColumn)
            OrbPassphraseField(theme: theme, keyLost: model.keyLost, submit: actions.submitPassphrase, focus: actions.fieldFocus, frame: actions.fieldFrame)
        }
        .padding(.vertical, 4)
        .frame(minHeight: OrbTheme.rowHeight, alignment: .leading)
    }

    /// The transport: Go/Pause is the one filled accent button, and only while asleep
    /// (`play.fill`; a ghost play while paused, `pause.fill` in session, a quiet "…" while
    /// connecting where the press stops — AppState.transportLabel); Mute is enabled only in
    /// session; Stop fills red while the snapshot holds a running or waiting delegation and
    /// for the 300 ms after a press — nothing local keeps it hot once the snapshot lets go —
    /// and it is never disabled: a Stop must land in every phase. Everything else is a ghost.
    private func actionRow(theme: OrbTheme) -> some View {
        let phase = model.phase
        let muted = phase == .muted
        let inSession = AppState.inSessionPhases.contains(phase)
        // A delegation left "running" by a snapshot that says asleep or paused cannot be
        // running: the session that carried it is closed.
        let running = (model.activeDelegation != nil && phase != .asleep && phase != .paused) || stopFlashing
        let look = AppState.transportLabel(for: phase)
        return HStack(spacing: 6) {
            OrbIconButton(icon: look.symbol, help: look.help + " (⌥⇧Space)",
                          style: AppState.transportFilled(for: phase) ? .accent : .ghost,
                          dim: phase == .connecting, theme: theme, action: pressTransport)
            OrbIconButton(icon: muted ? "mic.slash.fill" : "mic.fill", help: muted ? "Unmute" : "Mute", selected: muted, enabled: inSession, theme: theme, action: actions.toggleMute)
            OrbIconButton(icon: "stop.fill", help: "Stop — close the session, sleep (⌥⎋)", style: running ? .danger : .ghost, theme: theme, action: actions.stop)
            Spacer(minLength: 0)
            OrbIconButton(icon: "rectangle.3.group.fill", help: "Console", theme: theme, action: actions.openConsole)
        }
    }

    /// Go/Pause pressed: `actions.transportToggle` (AppState.transportToggle). Transitional
    /// fallback while the controller still wires the retired closures: the same decision
    /// table (AppState.transportPress) dispatched onto them — pause / resume through
    /// `togglePause`, wake through `toggleAwake`, and a stop while connecting.
    private func pressTransport() {
        if let toggle = actions.transportToggle {
            toggle()
            return
        }
        switch AppState.transportPress(for: model.phase) {
        case .go: if model.paused { actions.togglePause() } else { actions.toggleAwake() }
        case .pause: actions.togglePause()
        case .stop: actions.stop()
        }
    }

    private func latestStepText(_ d: Delegation) -> String {
        if let step = d.steps.last {
            if let t = step.text, !t.isEmpty { return t }
            if let tool = step.tool { return tool.name + (tool.input.map { " " + $0.compact } ?? "") }
            if step.screenshotPath != nil { return "screenshot" }
        }
        return d.request
    }
}

private extension View {
    /// The row weight's 1pt bottom rule, drawn by the row itself and only when
    /// another row follows (the last row's edge is closed by the gap above the actions).
    @ViewBuilder
    func ruled(_ on: Bool, theme: OrbTheme) -> some View {
        if on {
            overlay(alignment: .bottom) { Rectangle().fill(theme.hairRow).frame(height: 1) }
        } else {
            self
        }
    }

    /// A row of the capsule arriving: a fade and a 6 pt rise (`Motion.appear`'s
    /// shape) on `Motion.gentle`, `index × Motion.stagger` behind the frame; leaving,
    /// every row fades together over `Motion.quick`, ahead of the frame shrinking.
    func staggered(_ shown: Bool, index: Int) -> some View {
        modifier(Staggered(shown: shown, index: index))
    }

    /// Digits that count (the meter, a row's elapsed): each changed digit rolls; a plain fade under Reduce Motion.
    func metered(_ value: String) -> some View {
        contentTransition(Motion.reduced ? .opacity : .numericText())
            .animation(Motion.fade, value: value)
    }
}

private struct Staggered: ViewModifier {
    let shown: Bool
    let index: Int

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || Motion.reduced ? 0 : 6)
            .animation(shown ? Motion.gentle.delay(Double(index) * Motion.stagger) : .easeIn(duration: Motion.seconds(Motion.quick)), value: shown)
    }
}

/// A 30×28 icon button: ghost with a structural hairline, or the one accent fill, or red.
/// Hover moves the ground one alpha step over 120 ms; the tooltip carries the word.
/// `dim` sits the glyph back (the transport's "…" while connecting); `enabled: false`
/// greys it and takes no clicks (Mute outside a session).
private struct OrbIconButton: View {
    enum Style { case ghost, accent, danger }

    let icon: String
    let help: String
    var style: Style = .ghost
    var selected = false
    var dim = false
    var enabled = true
    let theme: OrbTheme
    let action: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            // The glyph crossfades when it swaps (Go ↔ Pause, Mute ↔ Unmute) instead of
            // cutting; the fill and the ring follow the state on `Motion.snappy`.
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(foreground)
                .contentTransition(.opacity)
                .animation(Motion.fade, value: icon)
                .opacity(dim ? 0.55 : 1)
                .frame(width: 30, height: 28)
                .background(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).fill(background))
                .overlay(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).strokeBorder(border, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous))
                .animation(Motion.snappy, value: style)
                .animation(Motion.snappy, value: selected)
                .animation(Motion.snappy, value: enabled)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .help(help)
        .accessibilityLabel(help)
        .onHover { over in
            withAnimation(reduceMotion ? nil : OrbTheme.motion) { hovering = over && enabled }
        }
    }

    private var foreground: Color {
        guard enabled else { return theme.text3 }
        switch style {
        case .accent, .danger: return .white
        case .ghost: return selected ? theme.accent : (hovering ? theme.text : theme.text2)
        }
    }

    private var background: Color {
        switch style {
        case .accent: return hovering ? theme.accent.opacity(0.88) : theme.accent
        case .danger: return hovering ? OrbStyle.color(.error).opacity(0.88) : OrbStyle.color(.error)
        case .ghost: return hovering ? theme.hover : .clear
        }
    }

    private var border: Color {
        switch style {
        case .accent, .danger: return .clear
        case .ghost: return selected ? theme.accent : theme.hair
        }
    }
}

/// A small ghost text button (the gate's Cancel): 11pt, 22 high, hairline, hover one step.
private struct OrbTextButton: View {
    let title: String
    let theme: OrbTheme
    let action: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(hovering ? theme.text : theme.text2)
                .padding(.horizontal, 8)
                .frame(height: 22)
                .background(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).fill(hovering ? theme.hover : .clear))
                .overlay(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).strokeBorder(theme.hair, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous))
        }
        .buttonStyle(.plain)
        // Its ideal size whatever the row offers: beside a higher-priority label the stack
        // handed it only its padding (18pt), leaving no face to click.
        .fixedSize()
        .onHover { over in
            withAnimation(reduceMotion ? nil : OrbTheme.motion) { hovering = over }
        }
    }
}

/// The passphrase field: mono, 24 high, hairline at rest, the accent ring while it holds
/// focus. Return submits the trimmed text, clears the field and lets go of focus (which
/// hands key status back to the app Kevin was in); Escape just lets go. The panel is
/// never key unless Kevin clicked in here — see OrbPanel.
private struct OrbPassphraseField: View {
    let theme: OrbTheme
    let keyLost: Int
    let submit: (String) -> Void
    let focus: (Bool) -> Void
    let frame: (CGRect?) -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        // The hint at text3, where the capsule's other empty states sit; the system
        // placeholder colour lands between text and text2 and reads as a filled field.
        // (foregroundColor, not foregroundStyle: the AppKit-backed field reads only the
        // former off the prompt.)
        SecureField("Wake passphrase", text: $text, prompt: Text("passphrase").foregroundColor(theme.text3))
            .textFieldStyle(.plain)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(theme.text)
            .tint(theme.accent)
            .focused($focused)
            .onSubmit {
                let phrase = text.trimmingCharacters(in: .whitespacesAndNewlines)
                text = ""
                focused = false
                if !phrase.isEmpty { submit(phrase) }
            }
            .onExitCommand { text = ""; focused = false }
            .onChange(of: focused) { focus(focused) }
            .onChange(of: keyLost) { focused = false }
            .padding(.horizontal, 8)
            .frame(height: 24)
            .background(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).fill(theme.field))
            .overlay(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).strokeBorder(focused ? theme.accent : theme.hair, lineWidth: 1))
            .background(GeometryReader { g in
                let r = g.frame(in: .named(OrbCapsuleView.space))
                Color.clear
                    .onAppear { frame(r) }
                    .onChange(of: r) { frame(r) }
                    .onDisappear { frame(nil) }
            })
            .accessibilityLabel("Wake passphrase")
    }
}

// MARK: - Pill

/// The small pill over the blob's foot for the first problem, the wake gate's question
/// or verdict, or the latest toast: ground, hairline, a 5pt tone dot for warn/error or
/// the gate's solid symbol. Transparent otherwise; the blob itself is an NSView beneath it.
struct OrbPillView: View {
    @ObservedObject var status: OrbStatusModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let theme = OrbTheme(dark: scheme == .dark)
        ZStack(alignment: .bottom) {
            Color.clear.allowsHitTesting(false)
            if let pill = status.pill {
                pillBody(pill, theme: theme)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).fill(theme.ground.opacity(0.94)))
                    .overlay(RoundedRectangle(cornerRadius: OrbTheme.radius, style: .continuous).strokeBorder(theme.hair, lineWidth: 1))
                    .padding(.bottom, 2)
                    .help(pill.text)
                    // Arrives with a fade and a small rise, leaves with a fade (`Motion.appear`).
                    .transition(Motion.appear)
                    // A counting pill keeps its identity: the number changes in place, the pill does not re-enter.
                    .id(pill.text)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(Motion.gentle, value: status.pill)
    }

    @ViewBuilder
    private func pillBody(_ pill: OrbPill, theme: OrbTheme) -> some View {
        if let until = pill.until {
            // Once a second, only while a countdown is showing (at most a minute) and the
            // panel is on screen; ordered out, it ticks once a day, i.e. never.
            TimelineView(.periodic(from: .now, by: status.shown ? 1 : 86_400)) { timeline in
                let remaining = max(1, Int(until.timeIntervalSince(timeline.date).rounded()))
                label(pill, text: "\(pill.text) · \(remaining) s", theme: theme)
            }
        } else {
            label(pill, text: pill.text, theme: theme)
        }
    }

    private func label(_ pill: OrbPill, text: String, theme: OrbTheme) -> some View {
        HStack(spacing: 5) {
            if let icon = pill.icon {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(iconTint(pill.tone, theme: theme))
            } else if pill.tone != .info {
                Circle().fill(OrbStyle.color(pill.tone == .error ? .error : .speaking))
                    .frame(width: 5, height: 5)
            }
            Text(text)
                .font(.system(size: 11).monospacedDigit())
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(theme.text2)
                // The count changes in place, no transition: rolling the digits
                // (.numericText) re-rasterised the pill through interpolated display lists
                // every second and cost more than the whole blob for the lockout minute — in
                // the one gate state where the blob deliberately holds still.
            if let action = pill.action {
                // The one-click way back: the accent word, a button.
                Button(action: action) {
                    Text(pill.actionTitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(theme.accent)
                        .padding(.leading, 3)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(pill.actionTitle)
            }
        }
    }

    /// The gate's symbol: a step up while it asks (status — the accent is the blob's while
    /// the question is open), red for a refusal, titanium while locked.
    private func iconTint(_ tone: Toast.Tone, theme: OrbTheme) -> Color {
        switch tone {
        case .info: return theme.text2
        case .warn: return theme.titanium
        case .error: return theme.error
        }
    }
}
