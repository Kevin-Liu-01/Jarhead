import SwiftUI

// Permissions and Wake. Permissions reads TCC through the probe the root polls;
// the mic request goes through the engine command the app answers itself, the
// other three call the system directly. Wake edits `WakeSettings` as a whole
// block and shows the gate's live "heard" line so Kevin can check it hears him.

// MARK: - Permissions

struct OnboardingPermissionsStep: View, Equatable {
    let permissions: OnboardingPermissions
    let actions: OnboardingActions

    static func == (a: OnboardingPermissionsStep, b: OnboardingPermissionsStep) -> Bool { a.permissions == b.permissions }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            OnboardingHead("Permissions",
                           "Three for the hands and ears, one for the wake word. Grants made in System Settings show up here on their own.")
            VStack(spacing: 0) {
                row("mic.fill", "Microphone", "so it can hear you", permissions.microphone) {
                    actions.send(.requestPermission("microphone"))
                }
                ConsoleHairline(weight: .row)
                row("rectangle.inset.filled.badge.record", "Screen Recording", "so the hands can see the screen", permissions.screenRecording) {
                    actions.system.requestScreenRecording()
                }
                ConsoleHairline(weight: .row)
                row("hand.raised.fill", "Accessibility", "so the hands can click and read", permissions.accessibility) {
                    actions.system.requestAccessibility()
                }
                ConsoleHairline(weight: .row)
                row("captions.bubble.fill", "Speech Recognition", "for the wake word, on device", permissions.speech) {
                    actions.system.requestSpeech()
                }
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            // Grants are re-read from a fresh process every few seconds and the hands
            // helper restarts itself when one appears, so nothing here needs a relaunch.
            OnboardingNote("Switches take effect here within a few seconds — no relaunch.")
            if permissions.accessibility != .granted || permissions.screenRecording != .granted {
                OnboardingNote("Already switched on in System Settings but still not ready here? That row was made by an earlier build: remove Jarhead from the list with the − button, press Request, and switch the new row on.")
            }
        }
    }

    private func row(_ symbol: String, _ name: String, _ why: String, _ grant: Grant, request: @escaping () -> Void) -> some View {
        let meta = ConsoleTheme.grant(grant)
        return HStack(spacing: onboardingIconGap) {
            ConsoleIcon(name: symbol)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(ConsoleTheme.sans(13)).foregroundStyle(ConsoleTheme.fg)
                Text(why).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
            }
            Spacer(minLength: 8)
            if grant != .granted {
                Button(action: request) {
                    if grant == .denied {
                        Label("Open Settings", systemImage: "gearshape.fill")
                    } else {
                        Text("Request")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .help(grant == .denied ? "Open System Settings › Privacy" : "Ask for \(name.lowercased()) access")
            }
            ConsoleIcon(name: meta.symbol, tint: meta.color)
                .help(meta.label)
                .accessibilityLabel(meta.label)
        }
        .padding(.horizontal, 10)
        .frame(height: 44)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Wake

struct OnboardingWakeStep: View, Equatable {
    let wake: WakeSettings
    let gate: WakeGateState
    let heard: String
    let passphraseSet: Bool
    let actions: OnboardingActions

    static func == (a: OnboardingWakeStep, b: OnboardingWakeStep) -> Bool {
        a.wake == b.wake && a.gate == b.gate && a.heard == b.heard && a.passphraseSet == b.passphraseSet
    }

    @State private var phrasesDraft = ""
    @State private var passphrase = ""
    @State private var passphraseError: String?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case phrases, passphrase }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            OnboardingHead("Wake",
                           "A phrase wakes Jarhead without a click. It then asks you to prove it's you before the paid session opens.")
            VStack(alignment: .leading, spacing: 6) {
                OnboardingFormRow("Wake word") {
                    HStack(spacing: 10) {
                        Toggle("", isOn: Binding(get: { wake.enabled }, set: { on in patch { $0.enabled = on } }))
                            .toggleStyle(.switch).controlSize(.small).labelsHidden()
                            .tint(ConsoleTheme.accent)
                            .accessibilityLabel("Wake word")
                        Text(wake.enabled ? "On" : "Off").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                    }
                }
                OnboardingFormRow("Phrases") {
                    TextField("jarhead, hey jarhead", text: $phrasesDraft)
                        .consoleField(mono: true, height: onboardingRowHeight, focused: focus == .phrases)
                        .focused($focus, equals: .phrases)
                        .onSubmit { commitPhrases(); focus = nil }
                        .onChange(of: focus) { if focus != .phrases { commitPhrases() } }
                        .accessibilityLabel("Wake phrases, comma separated")
                }
                OnboardingFormRow("Prove it's you") {
                    // Segments when they fit the row; the Console's menu field when the window is narrow.
                    ViewThatFits(in: .horizontal) {
                        OnboardingSegments(value: wake.auth, options: WakeAuth.allCases, title: OnboardingWakeStep.shortAuth,
                                           pick: { auth in patch { $0.auth = auth } })
                        ConsoleMenuField(value: wake.auth, options: WakeAuth.allCases, title: { $0.label },
                                         pick: { auth in patch { $0.auth = auth } })
                    }
                    .accessibilityLabel("Authentication: \(wake.auth.label)")
                }
                OnboardingFormRow("Passphrase") {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            SecureField(passphraseSet ? "set · replace" : "words you can say", text: $passphrase)
                                .consoleField(mono: true, height: onboardingRowHeight, focused: focus == .passphrase)
                                .focused($focus, equals: .passphrase)
                                .onSubmit(setPassphrase)
                                .accessibilityLabel("Wake passphrase")
                            Button("Set", action: setPassphrase)
                                .buttonStyle(ConsoleButtonStyle(kind: .ghost))
                                .disabled(passphraseDraft.isEmpty)
                            if passphraseSet {
                                Button("Clear") { actions.clearPassphrase(); passphraseError = nil }
                                    .buttonStyle(ConsoleButtonStyle(kind: .ghost))
                            }
                        }
                        if let e = passphraseError {
                            Text(e).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.error)
                        } else if passphraseSet {
                            Text("Set. Say it or type it when asked.").font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                        }
                    }
                }
            }
            heardBox
        }
        .onAppear { phrasesDraft = wake.phrases.joined(separator: ", ") }
        .onChange(of: wake.phrases) { if focus != .phrases { phrasesDraft = wake.phrases.joined(separator: ", ") } }
        // Half-typed phrases or a passphrase not yet set go out with Continue instead of vanishing.
        .onChange(of: dirty) { actions.draft(dirty, dirty ? commitAll : nil) }
    }

    private var passphraseDraft: String { passphrase.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var dirty: Bool {
        OnboardingWakeStep.parsePhrases(phrasesDraft) != wake.phrases || !passphraseDraft.isEmpty
    }

    private func commitAll() {
        commitPhrases()
        if !passphraseDraft.isEmpty { setPassphrase() }
    }

    /// The "does it hear me?" test: the gate's state as icon + words, and the last
    /// words the recogniser heard in mono.
    private var heardBox: some View {
        let g = gateMeta
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: onboardingIconGap) {
                if g.live {
                    ConsoleDot(color: g.color, live: true, size: 7).frame(width: 20, height: 20)
                } else {
                    ConsoleIcon(name: g.symbol, tint: g.color)
                }
                Text(g.text).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg)
                if let d = g.detail, !d.isEmpty {
                    Text(d).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: onboardingIconGap) {
                ConsoleIcon(name: "quote.opening", tint: ConsoleTheme.fg3, size: 11)
                Text(heard.isEmpty ? (gate.isListening ? "say something…" : "—") : heard)
                    .font(ConsoleTheme.mono(12))
                    .foregroundStyle(heard.isEmpty ? ConsoleTheme.fg3 : ConsoleTheme.fg)
                    .lineLimit(1).truncationMode(.head)
                    .animation(nil, value: heard)
                    .accessibilityLabel(heard.isEmpty ? "Nothing heard yet" : "Heard: \(heard)")
                Spacer(minLength: 0)
            }
            OnboardingNote("Listening happens only while Jarhead is asleep, on this Mac; nothing it hears is sent anywhere.")
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
    }

    private struct GateMeta { let symbol: String; let color: Color; let live: Bool; let text: String; let detail: String? }

    private var gateMeta: GateMeta {
        switch gate {
        case .off(let reason): return GateMeta(symbol: "moon.zzz.fill", color: ConsoleTheme.titanium, live: false, text: "Not listening", detail: reason)
        case .listening: return GateMeta(symbol: "ear.fill", color: ConsoleTheme.listening, live: true, text: "Listening for the wake word", detail: nil)
        case .heard: return GateMeta(symbol: "ear.fill", color: ConsoleTheme.speaking, live: false, text: "Heard it", detail: nil)
        case .authenticating(let method): return GateMeta(symbol: "lock.fill", color: ConsoleTheme.thinking, live: true, text: "Authenticating", detail: method)
        case .granted: return GateMeta(symbol: "checkmark.circle.fill", color: ConsoleTheme.acting, live: false, text: "Authenticated, waking", detail: nil)
        case .denied(let reason): return GateMeta(symbol: "xmark.circle.fill", color: ConsoleTheme.error, live: false, text: "Denied", detail: reason)
        case .lockedOut(let until):
            return GateMeta(symbol: "lock.slash.fill", color: ConsoleTheme.error, live: false, text: "Locked out",
                            detail: "until " + until.formatted(date: .omitted, time: .shortened))
        }
    }

    /// Segment titles: `.label` except the long one, which sits between its two halves and reads as "Either".
    static func shortAuth(_ auth: WakeAuth) -> String {
        auth == .either ? "Either" : auth.label
    }

    private func patch(_ change: (inout WakeSettings) -> Void) {
        var w = wake
        change(&w)
        guard w != wake else { return }
        actions.send(.setSettings(SettingsPatch(wake: w)))
    }

    /// "Jarhead, Hey  Jarhead" → ["jarhead", "hey jarhead"]
    static func parsePhrases(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(separator: ",").compactMap { part -> String? in
            let words = part.lowercased().split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
            guard !words.isEmpty, !seen.contains(words) else { return nil }
            seen.insert(words)
            return words
        }
    }

    private func commitPhrases() {
        let phrases = OnboardingWakeStep.parsePhrases(phrasesDraft)
        phrasesDraft = phrases.joined(separator: ", ")
        patch { $0.phrases = phrases }
    }

    private func setPassphrase() {
        let p = passphraseDraft
        guard !p.isEmpty else { return }
        if actions.setPassphrase(p) {
            passphrase = ""
            passphraseError = nil
            focus = nil
        } else {
            passphraseError = "Too short. Use a few words you can say out loud."
        }
    }
}
