import SwiftUI
import AVFoundation

// Right rail: a segmented Now / Settings / Ledger control in a 40pt row that
// owns its bottom rule, then one scroll region. A section is a 28pt head, its
// rows (28pt, icon column left, status glyph right) and the section's own
// bottom rule; rows inside a section draw no rule.

private let railInset: CGFloat = 12
private let iconGap: CGFloat = 8
private let keyWidth: CGFloat = 80

/// The wake word gate as the rail sees it: AppState's three published gate values,
/// sliced by the root so the Settings tab stays a plain value and only a gate
/// change (not a level tick) reaches it.
struct WakeGateInputs: Equatable {
    let gate: WakeGateState
    let heard: String
    let passphraseSet: Bool
}

struct RightRail: View, Equatable {
    let snapshot: Snapshot
    let ledgerDays: [String]?
    let ledgerDay: String?
    let ledgerLoading: Bool
    let ledgerStats: LedgerStats?
    let tab: ConsoleSession.Tab
    let wake: WakeGateInputs

    @EnvironmentObject private var session: ConsoleSession

    static func == (a: RightRail, b: RightRail) -> Bool {
        a.snapshot == b.snapshot && a.ledgerDays == b.ledgerDays && a.ledgerDay == b.ledgerDay
            && a.ledgerLoading == b.ledgerLoading && a.ledgerStats == b.ledgerStats && a.tab == b.tab
            && a.wake == b.wake
    }

    var body: some View {
        VStack(spacing: 0) {
            RailTabs(selected: tab) { session.select($0) }
            ConsoleHairline()
            ScrollView(.vertical) {
                Group {
                    switch tab {
                    case .now:
                        NowPanel(phase: snapshot.phase, sessionInfo: snapshot.session, permissions: snapshot.permissions,
                                 problems: snapshot.problems, brainReady: snapshot.brainReady, handsReady: snapshot.handsReady,
                                 brain: snapshot.settings.brain)
                    case .settings:
                        SettingsPanel(settings: snapshot.settings, setup: snapshot.setupStatus, phase: snapshot.phase, gate: wake)
                    case .ledger:
                        LedgerPanel(days: ledgerDays, picked: ledgerDay, loading: ledgerLoading, stats: ledgerStats)
                    }
                
                }
                .thinScrollers()
            }
        }
    }
}

/// Segmented control: one hairline box, dividers between options, the active
/// option filled with the text colour and lettered in the ground.
private struct RailTabs: View {
    let selected: ConsoleSession.Tab
    let select: (ConsoleSession.Tab) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(ConsoleSession.Tab.allCases.enumerated()), id: \.element.id) { index, tab in
                if index > 0 { Rectangle().fill(ConsoleTheme.hair).frame(width: 1) }
                SegOption(title: tab.rawValue, on: tab == selected) { select(tab) }
            }
        }
        .frame(height: 28)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .padding(.horizontal, railInset)
        .frame(height: 40)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Panel")
    }
}

private struct SegOption: View {
    let title: String
    let on: Bool
    let action: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ConsoleTheme.sans(12, .medium))
                .foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg2)
                .frame(maxWidth: .infinity)
                .frame(height: 28)
                .background(on ? ConsoleTheme.fg : (hovering ? ConsoleTheme.hover : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(reduceMotion ? nil : ConsoleTheme.fast, value: hovering)
        .animation(reduceMotion ? nil : ConsoleTheme.fast, value: on)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A section: head, content, and the section's own bottom rule.
private struct RailSection<Trailing: View, Content: View>: View {
    let title: String
    let count: Int?
    let inset: Bool
    let trailing: Trailing
    let content: Content

    init(_ title: String, count: Int? = nil, inset: Bool = true,
         @ViewBuilder trailing: () -> Trailing, @ViewBuilder content: () -> Content) {
        self.title = title
        self.count = count
        self.inset = inset
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ConsoleSectionHead(title, count: count) { trailing }
            content
                .padding(.horizontal, inset ? railInset : 0)
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            ConsoleHairline()
        }
    }
}

extension RailSection where Trailing == EmptyView {
    init(_ title: String, count: Int? = nil, inset: Bool = true, @ViewBuilder content: () -> Content) {
        self.init(title, count: count, inset: inset, trailing: { EmptyView() }, content: content)
    }
}

/// A key on the left, a value on the right; 22pt.
private struct KV<V: View>: View {
    let key: String
    let value: V

    init(_ key: String, @ViewBuilder value: () -> V) {
        self.key = key
        self.value = value()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(key).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.titanium)
                .frame(width: keyWidth, alignment: .leading)
            value.frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 22)
    }
}

extension KV where V == Text {
    init(_ key: String, _ mono: String) {
        self.init(key) { monoValue(mono) }
    }
}

private func monoValue(_ s: String) -> Text {
    Text(s).font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg2)
}

private struct Reading: View {
    let text: String
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
        }
        .frame(height: 24)
    }
}

// MARK: - Now

struct NowPanel: View {
    let phase: Phase
    let sessionInfo: SessionInfo?
    let permissions: Permissions
    let problems: [String]
    let brainReady: Bool
    let handsReady: Bool
    let brain: BrainKind

    @Environment(\.consoleActions) private var actions

    var body: some View {
        let meta = ConsoleTheme.phase(phase)
        VStack(spacing: 0) {
            // The phase block owns its bottom rule.
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: iconGap) {
                    ConsoleDot(color: meta.color, live: ConsoleTheme.livePhases.contains(phase), size: 8)
                        .frame(width: 20, height: 20)
                    Text(meta.label).font(ConsoleTheme.sans(15, .medium)).foregroundStyle(ConsoleTheme.fg)
                    Spacer(minLength: 8)
                    if let s = sessionInfo {
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Text(ConsoleFormat.duration((ctx.date.timeIntervalSince1970 * 1000 - s.startedAt) / 1000))
                                .font(ConsoleTheme.mono(13)).monospacedDigit().foregroundStyle(ConsoleTheme.fg2)
                        }
                        .help("Elapsed")
                        .accessibilityLabel("Elapsed")
                    }
                }
                .frame(height: 28)
                .help(meta.hint)

                if let s = sessionInfo {
                    VStack(alignment: .leading, spacing: 0) {
                        KV("Session") { monoValue(ConsoleFormat.shortId(s.id, 12)).help(s.id) }
                        KV("Billed", ConsoleFormat.minutes(s.usageSeconds))
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            KV("Expires", "in " + ConsoleFormat.duration(max(0, (s.expiresAt - ctx.date.timeIntervalSince1970 * 1000) / 1000)))
                        }
                        if let ratio = s.contextRatio {
                            KV("Context") {
                                HStack(spacing: 8) {
                                    ConsoleBar(fraction: ratio)
                                    Text("\(Int((ratio * 100).rounded()))%")
                                        .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                                }
                            }
                        }
                    }
                    .padding(.leading, 20 + iconGap)
                } else {
                    Text("No session. Nothing billed.").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                        .padding(.leading, 20 + iconGap)
                        .frame(height: 22)
                }
            }
            .padding(EdgeInsets(top: 6, leading: railInset, bottom: 10, trailing: railInset))
            .frame(maxWidth: .infinity, alignment: .leading)
            ConsoleHairline()

            RailSection("Audio") { AudioMeters() }

            RailSection("Ready") {
                VStack(spacing: 0) {
                    readyRow("brain.fill", "Brain", brainReady, brain.rawValue)
                    readyRow("hand.raised.fill", "Hands", handsReady, handsReady ? "see + click" : "needs permissions")
                }
            }

            RailSection("Permissions") {
                VStack(spacing: 0) {
                    permRow("microphone", "Microphone", permissions.microphone, "mic.fill")
                    permRow("screenRecording", "Screen recording", permissions.screenRecording, "rectangle.inset.filled.badge.record")
                    permRow("accessibility", "Accessibility", permissions.accessibility, "accessibility.fill")
                }
            }

            RailSection("Problems", count: problems.isEmpty ? nil : problems.count, trailing: {
                if !problems.isEmpty {
                    Button("Clear") { actions.send(.clearProblems) }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .help("Clear problems")
                }
            }) {
                if problems.isEmpty {
                    Text("None.").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).frame(height: 22)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(problems.reversed().enumerated()), id: \.offset) { _, p in
                            HStack(alignment: .firstTextBaseline, spacing: iconGap) {
                                ConsoleIcon(name: "exclamationmark.triangle.fill", tint: ConsoleTheme.error)
                                Text(p).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
        }
    }

    private func readyRow(_ symbol: String, _ name: String, _ ok: Bool, _ detail: String) -> some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol)
            Text(name).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
            Text(detail).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            ConsoleIcon(name: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill", tint: ok ? ConsoleTheme.acting : ConsoleTheme.speaking)
                .help(ok ? "ready" : "not ready")
                .accessibilityLabel(ok ? "ready" : "not ready")
        }
        .frame(height: 28)
    }

    /// The app answers `request-permission microphone` itself (TCC prompt when
    /// undetermined, System Settings when denied); the other two go to the daemon.
    private func permRow(_ which: String, _ name: String, _ grant: Grant, _ symbol: String) -> some View {
        let meta = ConsoleTheme.grant(grant)
        let opensSettings = which == "microphone" && grant == .denied
        return HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol)
            Text(name).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
            Spacer(minLength: 4)
            if grant != .granted {
                Button { actions.send(.requestPermission(which)) } label: {
                    if opensSettings {
                        Label("Open Settings", systemImage: "gearshape.fill").lineLimit(1)
                    } else {
                        Text("Request")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                // Sized before the name and the spacer, so the label is never squeezed to "Open Settin…".
                .layoutPriority(1)
                .help(opensSettings ? "Open System Settings › Privacy › Microphone" : "Ask for \(name.lowercased()) access. Already on in System Settings? That row belongs to an earlier build: remove Jarhead there, press this, and switch the new row on. Takes effect within seconds, no relaunch.")
            }
            ConsoleIcon(name: meta.symbol, tint: meta.color)
                .help(meta.label)
                .accessibilityLabel(meta.label)
        }
        .frame(height: 28)
    }
}

/// A 3pt meter: track one ground step, fill in the second text step.
struct ConsoleBar: View {
    let fraction: Double
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Rectangle().fill(ConsoleTheme.active)
                Rectangle().fill(ConsoleTheme.fg2).frame(width: max(0, min(1, fraction)) * g.size.width)
            }
        }
        .frame(height: 3)
    }
}

/// The only view in the Console that observes the high-frequency `levels`.
struct AudioMeters: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let l = state.levels
        VStack(spacing: 0) {
            meter("mic.fill", "Input", l.input, ConsoleTheme.listening)
            meter("speaker.wave.2.fill", "Output", l.output, ConsoleTheme.speaking)
        }
    }

    private func meter(_ symbol: String, _ label: String, _ value: Double, _ tint: Color) -> some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol, tint: tint).help(label).accessibilityLabel(label)
            // One 20 Hz tick to the next; still under reduce motion.
            ConsoleBar(fraction: value).animation(reduceMotion ? nil : .linear(duration: 0.06), value: value)
            Text(String(format: "%.2f", value)).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                .frame(width: 32, alignment: .trailing)
        }
        .frame(height: 24)
    }
}

// MARK: - Settings

struct MicDevice: Identifiable, Equatable {
    let id: String
    let name: String

    static func enumerate() -> [MicDevice] {
        let session = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified)
        return session.devices.map { MicDevice(id: $0.uniqueID, name: $0.localizedName) }
    }
}

struct SettingsPanel: View {
    let settings: Settings
    let setup: SetupStatus
    let phase: Phase
    let gate: WakeGateInputs

    @Environment(\.consoleActions) private var actions
    @State private var mics: [MicDevice] = []

    private enum Field: Hashable { case model, server, phrases }
    @FocusState private var focus: Field?

    // Brain: the three fields go out as one patch, so the drafts are kept together.
    private struct BrainDraft: Equatable {
        var kind: BrainKind
        var model: String
        var server: String
    }
    @State private var modelDraft = ""
    @State private var serverDraft = ""
    /// The last patch sent and not yet echoed by the daemon; Return commits and then
    /// drops focus, and the focus change must not send the same patch again.
    @State private var brainSent: BrainDraft?

    // Wake
    @State private var phrasesDraft = ""
    @State private var phrasesSent: [String]?

    private func patch(_ p: SettingsPatch) { actions.send(.setSettings(p)) }

    private var brainSaved: BrainDraft {
        BrainDraft(kind: settings.brain, model: settings.brainModel, server: settings.brainBaseUrl ?? "")
    }

    /// The brain on screen: the pick just sent, until the daemon echoes it.
    private var kind: BrainKind { brainSent?.kind ?? settings.brain }

    private var wake: WakeSettings { settings.wakeSettings }

    private var voiceOptions: [String] {
        ConsoleTheme.voices + (ConsoleTheme.voices.contains(settings.voice) ? [] : [settings.voice])
    }

    private var effortOptions: [String] {
        ConsoleTheme.efforts + (ConsoleTheme.efforts.contains(settings.effort) ? [] : [settings.effort])
    }

    private var micSelection: String {
        guard let id = settings.micDeviceId, !id.isEmpty else { return "" }
        return id
    }

    private var micOptions: [String] {
        var ids = [""] + mics.map(\.id)
        let current = micSelection
        if !current.isEmpty, !ids.contains(current) { ids.append(current) }
        return ids
    }

    private func micTitle(_ id: String) -> String {
        if id.isEmpty { return "System default" }
        if let m = mics.first(where: { $0.id == id }) { return m.name }
        return "Unavailable · \(ConsoleFormat.shortId(id, 10))"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Section heads name the group, not the first row, so no word appears twice.
            RailSection("Audio") {
                VStack(spacing: 2) {
                    formRow("Voice") {
                        ConsoleMenuField(value: settings.voice, options: voiceOptions, title: { $0 },
                                         pick: { patch(SettingsPatch(voice: $0)) })
                    }
                    formRow("Mic") {
                        ConsoleMenuField(value: micSelection, options: micOptions, title: micTitle,
                                         pick: { patch(SettingsPatch(micDeviceId: .some($0.isEmpty ? nil : $0))) })
                    }
                }
            }
            RailSection("Brain") {
                VStack(spacing: 2) {
                    // The OpenAI key that runs the GPT-Live-1 voice; the dot is the last probe.
                    // The engine probes on its own after it saves a key, so Save sends one command.
                    formRow("Voice key") {
                        SecretField(placeholder: "sk-…", onFile: setup.secrets.openai, status: voiceKeyStatus,
                                    save: { key in actions.send(.setSecrets(["OPENAI_API_KEY": key])) })
                    }
                    .help("The OpenAI key for the voice (\(setup.liveModel))")
                    formRow("Backend") {
                        // The menu spells the long one out; the hint under the field already says "server".
                        ConsoleMenuField(value: kind, options: ConsoleTheme.brains, title: { $0.label },
                                         pick: { commitBrain(kind: $0) },
                                         fieldTitle: { $0 == .openaiCompatible ? "OpenAI-compatible" : $0.label })
                            .accessibilityLabel("Backend: \(kind.label)")
                    }
                    .help(kind.label)
                    hint(kind.needs)
                    formRow("Model") {
                        let fallback = ConsoleTheme.defaultBrainModel(kind)
                        TextField(fallback.isEmpty ? "backend default" : fallback, text: $modelDraft)
                            .consoleField(mono: true, height: 26, focused: focus == .model)
                            .focused($focus, equals: .model)
                            .onSubmit { commitBrain(); focus = nil }
                            .accessibilityLabel("Model id")
                    }
                    if kind == .openaiCompatible {
                        formRow("Server") {
                            TextField("http://localhost:11434/v1", text: $serverDraft)
                                .consoleField(mono: true, height: 26, focused: focus == .server)
                                .focused($focus, equals: .server)
                                .onSubmit { commitBrain(); focus = nil }
                                .accessibilityLabel("Server base URL")
                        }
                    }
                    // The OpenAI brain reuses the voice key above; logins need no key at all.
                    if let secret = kind.secretKey, kind != .openaiResponses {
                        formRow("Key") {
                            SecretField(placeholder: kind == .openaiCompatible ? "server key" : "sk-ant-…",
                                        onFile: kind == .anthropicApi ? setup.secrets.anthropic : setup.secrets.brainApiKey,
                                        status: nil,
                                        save: { key in actions.send(.setSecrets([secret: key])) })
                                // One row for two secrets: the identity keeps a key typed for one
                                // backend from being saved under the other's name after a switch.
                                .id(secret)
                        }
                        .help(secret)
                    }
                    formRow("Effort") {
                        ConsoleMenuField(value: settings.effort, options: effortOptions, title: { $0 },
                                         pick: { patch(SettingsPatch(effort: $0)) }, mono: true)
                    }
                    formRow("Status") { brainStatus }
                }
            }
            RailSection("Session") {
                VStack(spacing: 2) {
                    formRow("Idle sleep") {
                        HStack(spacing: 6) {
                            Text("\(Int(settings.idleSleepMinutes.rounded())) min")
                                .font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg)
                                .frame(width: 56, alignment: .leading)
                            Button { step(-1) } label: { Image(systemName: "minus").font(.system(size: 11, weight: .semibold)) }
                                .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 24))
                                .disabled(settings.idleSleepMinutes <= 1)
                                .accessibilityLabel("Less idle time")
                            Button { step(1) } label: { Image(systemName: "plus").font(.system(size: 11, weight: .semibold)) }
                                .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 24))
                                .disabled(settings.idleSleepMinutes >= 240)
                                .accessibilityLabel("More idle time")
                            Spacer(minLength: 0)
                        }
                    }
                    formRow("Auto-wake") {
                        Toggle("", isOn: Binding(get: { settings.autoWake }, set: { patch(SettingsPatch(autoWake: $0)) }))
                            .toggleStyle(.switch).controlSize(.small).labelsHidden()
                            .tint(ConsoleTheme.accent)
                            .help(wake.enabled ? "Wake on launch (the wake word gate owns waking while it is on)" : "Wake on launch")
                            .accessibilityLabel("Auto-wake on launch")
                    }
                }
            }
            RailSection("Wake") {
                VStack(spacing: 2) {
                    formRow("Wake word") {
                        Toggle("", isOn: Binding(get: { wake.enabled }, set: { on in var w = wake; w.enabled = on; patch(SettingsPatch(wake: w)) }))
                            .toggleStyle(.switch).controlSize(.small).labelsHidden()
                            .tint(ConsoleTheme.accent)
                            .help("Listen on-device for the wake word while asleep")
                            .accessibilityLabel("Wake word")
                    }
                    formRow("Phrases") {
                        // The stock list is wider than the field, so it wraps (up to three lines) rather than clipping mid-word.
                        TextField("jarhead, jar head", text: $phrasesDraft, axis: .vertical)
                            .lineLimit(1...3)
                            .consoleField(mono: true, height: 26, focused: focus == .phrases, grows: true)
                            .focused($focus, equals: .phrases)
                            .onSubmit { commitPhrases(); focus = nil }
                            .help("Any of these wakes it; comma-separated")
                            .accessibilityLabel("Wake phrases, comma separated")
                    }
                    formRow("Auth") {
                        // The menu spells every option out; the field is too narrow for "Touch ID or passphrase".
                        ConsoleMenuField(value: wake.auth, options: WakeAuth.allCases, title: { $0.label },
                                         pick: { auth in var w = wake; w.auth = auth; patch(SettingsPatch(wake: w)) },
                                         fieldTitle: { $0 == .either ? "Either" : $0.label })
                            .help(wake.auth.label)
                            .accessibilityLabel("Authentication: \(wake.auth.label)")
                    }
                    if wake.auth == .none { hint("Anyone who says the word wakes it.") }
                    formRow("Passphrase") { WakePassphraseRow(set: gate.passphraseSet) }
                    formRow("Status") { WakeGateReadout(phase: phase, wake: wake, gate: gate.gate, heard: gate.heard) }
                }
            }
            // The words do the work; the gear means System Settings elsewhere in this window.
            Button("Set up again…") { actions.openOnboarding() }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                .help("Open the setup wizard")
                .padding(EdgeInsets(top: 12, leading: railInset, bottom: 20, trailing: railInset))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear {
            mics = MicDevice.enumerate()
            modelDraft = settings.brainModel
            serverDraft = settings.brainBaseUrl ?? ""
            phrasesDraft = wake.phrases.joined(separator: ", ")
        }
        .onChange(of: brainSaved) {
            brainSent = nil
            if focus != .model { modelDraft = settings.brainModel }
            if focus != .server { serverDraft = settings.brainBaseUrl ?? "" }
        }
        .onChange(of: wake.phrases) {
            phrasesSent = nil
            if focus != .phrases { phrasesDraft = wake.phrases.joined(separator: ", ") }
        }
        // Focus starts a new edit (a retry may resend); blur commits, once.
        .onChange(of: focus) { old, new in
            switch new {
            case .model, .server: brainSent = nil
            case .phrases: phrasesSent = nil
            case nil: break
            }
            switch old {
            case .model, .server: commitBrain()
            case .phrases: commitPhrases()
            case nil: break
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("AVCaptureDeviceWasConnectedNotification"))) { _ in mics = MicDevice.enumerate() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("AVCaptureDeviceWasDisconnectedNotification"))) { _ in mics = MicDevice.enumerate() }
    }

    private func step(_ delta: Int) {
        let next = min(240, max(1, Int(settings.idleSleepMinutes.rounded()) + delta))
        patch(SettingsPatch(idleSleepMinutes: Double(next)))
    }

    // MARK: brain

    /// Backend, model and server go out together, once per edit: the snapshot's
    /// value lags the daemon round trip, so the guard also remembers what was just
    /// sent. A newly picked backend takes its own default model unless the model
    /// on screen is one Kevin typed.
    private func commitBrain(kind picked: BrainKind? = nil) {
        let before = kind
        let next = picked ?? before
        var model = modelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if next != before, model.isEmpty || model == ConsoleTheme.defaultBrainModel(before) {
            model = ConsoleTheme.defaultBrainModel(next)
            modelDraft = model
        }
        let server = serverDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let draft = BrainDraft(kind: next, model: model, server: server)
        guard draft != brainSaved, draft != brainSent else { return }
        brainSent = draft
        patch(SettingsPatch(brain: next, brainModel: model, brainBaseUrl: .some(server.isEmpty ? nil : server)))
    }

    /// The last probe of the voice key, as the dot beside the field.
    private var voiceKeyStatus: SecretField.Status {
        switch setup.openaiKey {
        case .ok: return SecretField.Status(color: ConsoleTheme.acting, text: "on file", help: "Key works with \(setup.liveModel)")
        case .invalid: return SecretField.Status(color: ConsoleTheme.error, text: "rejected", help: "OpenAI rejected the key — paste a fresh one")
        case .missing: return SecretField.Status(color: ConsoleTheme.speaking, text: "missing", help: "No OpenAI key")
        case .unchecked: return SecretField.Status(color: ConsoleTheme.titanium, text: "on file", help: "Not checked yet")
        }
    }

    /// Dot + one line from the last probe; Check runs it again. The Backend row
    /// already names the brain, so the line is the state — plus, for Automatic,
    /// the brain it resolved to.
    private var brainStatus: some View {
        let resolved: String? = kind == .auto ? setup.brainResolved.flatMap { $0 == .auto ? nil : $0.label } : nil
        let color: Color
        let live: Bool
        let text: String
        switch setup.brain {
        case .ok: color = ConsoleTheme.acting; live = false; text = resolved.map { "\($0) ready" } ?? "Ready"
        case .unavailable: color = ConsoleTheme.error; live = false; text = "Unavailable"
        case .unchecked: color = ConsoleTheme.thinking; live = true; text = "Checking…"
        }
        let detail = setup.brainDetail.trimmingCharacters(in: .whitespacesAndNewlines)
        let showDetail = !detail.isEmpty && detail != "ok"
        let name = ConsoleTheme.brainName(kind, resolved: setup.brainResolved)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                HStack(spacing: iconGap) {
                    ConsoleDot(color: color, live: live).frame(width: 20, height: 20)
                    Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1).truncationMode(.tail)
                }
                .help(detail.isEmpty || detail == "ok" ? "\(name): \(text.lowercased())" : "\(name): \(detail)")
                .accessibilityLabel("\(name) \(text)")
                Spacer(minLength: 4)
                Button("Check") { actions.send(.probeSetup) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .layoutPriority(1)
                    .help("Re-check the voice key and the brain")
            }
            .frame(height: 26)
            if showDetail {
                Text(detail).font(ConsoleTheme.mono(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.titanium)
                    .lineLimit(2).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 20 + iconGap)
                    .padding(.bottom, 4)
                    .help(detail)
            }
        }
    }

    // MARK: wake

    /// Comma-separated → lowercase, trimmed, single-spaced, no empties, no repeats.
    static func parsePhrases(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(separator: ",").compactMap { part in
            let words = part.lowercased().split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            let phrase = words.joined(separator: " ")
            guard !phrase.isEmpty, !seen.contains(phrase) else { return nil }
            seen.insert(phrase)
            return phrase
        }
    }

    /// Sends the whole wake block, once per edit. An empty list is a mistake, not a
    /// setting (the toggle is how it turns off): the draft goes back to what is saved.
    private func commitPhrases() {
        let phrases = SettingsPanel.parsePhrases(phrasesDraft)
        guard !phrases.isEmpty else { phrasesDraft = (phrasesSent ?? wake.phrases).joined(separator: ", "); return }
        guard phrases != wake.phrases, phrases != phrasesSent else { return }
        phrasesSent = phrases
        var w = wake
        w.phrases = phrases
        patch(SettingsPatch(wake: w))
    }

    // MARK: rows

    private func formRow<C: View>(_ label: String, @ViewBuilder control: () -> C) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.titanium)
                .frame(width: keyWidth, alignment: .leading)
                .frame(height: 28)
            control().frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 28)
        }
    }

    /// One titanium line under a control, aligned to the control column.
    private func hint(_ text: String) -> some View {
        Text(text).font(ConsoleTheme.sans(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.titanium)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, keyWidth + 10)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A secret that is written, never read back: a SecureField and Save until a key is
/// on file (the empty field is the "none" state; no dot beside it), then a dot and
/// "on file" with Change. The value is sent once and dropped.
private struct SecretField: View {
    struct Status {
        let color: Color
        let text: String
        let help: String
    }

    let placeholder: String
    let onFile: Bool
    /// The dot's meaning while on file; nil is plain presence.
    let status: Status?
    let save: (String) -> Void

    @State private var text = ""
    @State private var editing = false
    /// Sent, not yet reflected by the snapshot.
    @State private var pending = false
    @FocusState private var focused: Bool

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var meta: Status { status ?? Status(color: ConsoleTheme.acting, text: "on file", help: "A key is on file") }

    var body: some View {
        HStack(spacing: 6) {
            if pending && !onFile {
                ConsoleDot(color: ConsoleTheme.thinking, live: true).frame(width: 20, height: 20)
                Text("Saving…").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                Spacer(minLength: 0)
            } else if editing || !onFile {
                SecureField(placeholder, text: $text)
                    .consoleField(mono: true, height: 26, focused: focused)
                    .focused($focused)
                    .onSubmit(commit)
                    .onExitCommand(perform: cancel)
                    .onChange(of: focused) { if !focused, !hasText { cancel() } }
                    .help(editing ? "Paste the new key; Esc keeps the old one" : "Paste the key; it is written to ~/.jarhead/env and never shown again")
                Button("Save", action: commit)
                    .buttonStyle(ConsoleButtonStyle(kind: hasText ? .primary : .ghost, height: 26, small: true))
                    .disabled(!hasText)
            } else {
                ConsoleDot(color: meta.color).frame(width: 20, height: 20)
                Text(meta.text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(meta.help)
                    .accessibilityLabel(meta.help)
                Button("Change") { editing = true; focused = true }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .layoutPriority(1)
                    .help("Replace the key")
            }
        }
        .frame(height: 26)
        .onChange(of: onFile) { pending = false }
    }

    private func commit() {
        let k = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty else { return }
        save(k)
        text = ""
        editing = false
        focused = false
        pending = true
        // The snapshot normally flips `onFile` within a round trip; if it never does, fall back to the field.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            pending = false
        }
    }

    private func cancel() {
        text = ""
        editing = false
        focused = false
    }
}

/// The wake passphrase: a SecureField and Set until one is enrolled, then a masked
/// mark with Change and Clear. Only the gate ever sees the text; a rejection (too
/// short) shakes the field and tints its ring red, keeping focus.
private struct WakePassphraseRow: View {
    /// A passphrase is enrolled (AppState.wakePassphraseSet, sliced by the root).
    let set: Bool

    @Environment(\.consoleActions) private var actions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var text = ""
    @State private var editing = false
    @State private var rejected = false
    @State private var shakes: CGFloat = 0
    @FocusState private var focused: Bool

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(spacing: 6) {
            if editing || !set {
                SecureField("a phrase", text: $text)
                    .consoleField(mono: true, height: 26, focused: focused, error: rejected)
                    .modifier(ConsoleShake(shakes: shakes))
                    .focused($focused)
                    .onSubmit(submit)
                    .onExitCommand(perform: cancel)
                    .onChange(of: focused) { if !focused, !hasText, set { cancel() } }
                    .help("Two words or more; said or typed when asked" + (set ? ". Esc keeps the old one" : ""))
                    .accessibilityLabel("Wake passphrase")
                Button("Set", action: submit)
                    .buttonStyle(ConsoleButtonStyle(kind: hasText ? .primary : .ghost, height: 26, small: true))
                    .disabled(!hasText)
            } else {
                // No Spacer: its 6pt of stack spacing is what pushes "Change" into "Chan…" in the rail.
                Text("••••••").font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg2)
                    .fixedSize()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help("A passphrase is set (kept as a hash; never shown)")
                    .accessibilityLabel("Passphrase set")
                Button("Change") { editing = true; focused = true }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .layoutPriority(1)
                    .help("Replace the passphrase")
                Button("Clear") { actions.clearWakePassphrase(); cancel() }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .layoutPriority(1)
                    .help("Forget the passphrase")
            }
        }
        .frame(height: 26)
        .onChange(of: set) { if !set { editing = false } }
    }

    private func submit() {
        guard hasText else { return }
        if actions.setWakePassphrase(text) {
            text = ""
            editing = false
            rejected = false
            focused = false
        } else {
            // Too short: the gate has toasted why. Shake, tint, keep the words and the focus.
            rejected = true
            focused = true
            if !reduceMotion { withAnimation(.linear(duration: 0.35)) { shakes += 1 } }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 700_000_000)
                rejected = false
            }
        }
    }

    private func cancel() {
        text = ""
        editing = false
        rejected = false
        focused = false
    }
}

/// The gate's state as a solid icon and the status menu's words, and — while it
/// listens — the last words the on-device recogniser heard, so Kevin can say the
/// word and watch it land. A plain value like everything else in the rail: the
/// root slices `gate` and `heard` out of AppState, so a partial transcript
/// re-evaluates the rail, not a level tick.
private struct WakeGateReadout: View {
    let phase: Phase
    let wake: WakeSettings
    let gate: WakeGateState
    let heard: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if ConsoleTheme.gateRests(phase) {
                // The status menu's "not listening" glyph, dimmed: the ear is off duty, not asleep.
                line(symbol: "ear.trianglebadge.exclamationmark", tint: ConsoleTheme.titanium, text: "Awake — the gate rests until the session ends", color: ConsoleTheme.titanium)
            } else {
                switch gate {
                case .lockedOut:
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        gateLine(now: ctx.date)
                    }
                default:
                    gateLine(now: Date())
                }
                if gate.isListening || gate.isAuthenticating {
                    heardLine
                }
            }
        }
    }

    private func gateLine(now: Date) -> some View {
        let meta = ConsoleTheme.gate(gate, phrases: wake.phrases, auth: wake.auth, now: now)
        return line(symbol: meta.symbol, tint: meta.color, text: meta.label, color: ConsoleTheme.fg)
    }

    private func line(symbol: String, tint: Color, text: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: iconGap) {
            ConsoleIcon(name: symbol, tint: tint).frame(height: 26)
            Text(text).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(color)
                .lineLimit(3).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 26, alignment: .leading)
                .help(text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// `heard  hey jarhead` — the newest words win, so it truncates from the left.
    private var heardLine: some View {
        HStack(spacing: 8) {
            Text("heard").font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg3)
            Text(heard.isEmpty ? "…" : heard).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                .lineLimit(1).truncationMode(.head)
                .help(heard.isEmpty ? "Nothing heard yet" : heard)
        }
        .padding(.leading, 20 + iconGap)
        .padding(.bottom, 4)
        .accessibilityLabel(heard.isEmpty ? "Nothing heard yet" : "Heard: \(heard)")
    }
}

// MARK: - Ledger

struct LedgerPanel: View {
    let days: [String]?
    let picked: String?
    let loading: Bool
    let stats: LedgerStats?

    @Environment(\.consoleActions) private var actions

    var body: some View {
        VStack(spacing: 0) {
            RailSection("Days", inset: false, trailing: {
                Button { actions.send(.openLedger) } label: {
                    Image(systemName: "folder.fill").font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
                .help("Open the ledger folder")
                .accessibilityLabel("Open ledger folder")
            }) {
                if let days = days {
                    if days.isEmpty {
                        Text("No ledger yet.").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                            .padding(.horizontal, railInset).frame(height: 22)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(days, id: \.self) { day in
                                DayRow(day: day, on: day == picked) { actions.pickLedgerDay(day) }
                            }
                        }
                    }
                } else {
                    Reading(text: "Loading…").padding(.horizontal, railInset)
                }
            }
            if let picked = picked {
                RailSection(ConsoleFormat.day(picked)) {
                    if let stats = stats, !loading {
                        VStack(alignment: .leading, spacing: 0) {
                            KV("Sessions", "\(stats.sessions)")
                            KV("Utterances", "\(stats.utterances)")
                            KV("Delegations", "\(stats.delegations)")
                            KV("Billed", ConsoleFormat.minutes(stats.billedSeconds))
                        }
                    } else {
                        Reading(text: "Reading…")
                    }
                }
            }
        }
        .onAppear { actions.loadLedgerDays() }
    }
}

/// 28pt: the day, its date, the accent bar while it is the one on screen.
private struct DayRow: View {
    let day: String
    let on: Bool
    let pick: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: pick) {
            HStack(spacing: iconGap) {
                ConsoleIcon(name: "calendar", tint: on ? ConsoleTheme.fg : ConsoleTheme.titanium)
                Text(ConsoleFormat.day(day))
                    .font(ConsoleTheme.sans(12, on ? .medium : .regular))
                    .foregroundStyle(on ? ConsoleTheme.fg : ConsoleTheme.fg2)
                Spacer(minLength: 4)
                Text(day).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            }
            .padding(.horizontal, railInset)
            .frame(height: 28)
            .frame(maxWidth: .infinity)
            .background(on ? ConsoleTheme.active : (hovering ? ConsoleTheme.hover : Color.clear))
            .overlay(alignment: .leading) {
                if on { Rectangle().fill(ConsoleTheme.accent).frame(width: 2).padding(.vertical, 4) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(reduceMotion ? nil : ConsoleTheme.fast, value: hovering)
        .accessibilityLabel(ConsoleFormat.day(day) + ", " + day)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
