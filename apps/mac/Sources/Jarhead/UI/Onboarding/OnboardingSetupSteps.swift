import SwiftUI

// Permissions and Wake. Permissions shows AppState's list of every permission (read
// by this process, re-read while the step is up) and asks through the
// PermissionsCenter: one sweep, or one row at a time. Wake edits `WakeSettings` as a
// whole block and shows the gate's live "heard" line so Kevin can check it hears him.

// MARK: - Permissions

/// Every permission Jarhead can use, in sweep order: the seven it needs, then the
/// rest. One button asks for all of them one dialog at a time (the sweep,
/// PermissionsCenter; a ghost, the footer's Continue is the step's one filled button);
/// each row can ask alone. The list is AppState's, read by this process — the one TCC
/// keys the grants on — and re-read while the step is up.
struct OnboardingPermissionsStep: View, Equatable {
    let permissions: [PermissionInfo]
    let sweep: PermissionSweepProgress?
    let actions: OnboardingActions

    static func == (a: OnboardingPermissionsStep, b: OnboardingPermissionsStep) -> Bool {
        a.permissions == b.permissions && a.sweep == b.sweep
    }

    private var required: [PermissionInfo] { permissions.filter(\.required) }
    private var optional: [PermissionInfo] { permissions.filter { !$0.required } }
    private var running: Bool { sweep?.running ?? false }
    private var granted: Int { permissions.filter { $0.grant == .granted }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            OnboardingHead("Permissions",
                           "Everything Jarhead can use, asked for one dialog at a time — the seven it needs first. Full Disk Access has no dialog: System Settings opens on the right pane and the app is revealed for dragging in. Grants made in System Settings show up here on their own.") {
                if !running {
                    Button("Ask for everything") { actions.permissions.requestAll() }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                        .help("Required kinds first, then the rest; each dialog is awaited before the next")
                        .disabled(permissions.isEmpty)
                        .transition(.opacity)
                }
            }
            if let sweep {
                sweepBox(sweep).transition(Motion.appear)
            }
            group("required · \(required.filter { $0.grant == .granted }.count) of \(required.count) granted", required)
            group("more it can use · \(optional.filter { $0.grant == .granted }.count) of \(optional.count) granted", optional)
            // Grants are re-read from a fresh process every few seconds and the hands
            // helper restarts itself when one appears, so nothing here needs a relaunch.
            OnboardingNote("Switches take effect here within a few seconds — no relaunch. \(granted) of \(max(permissions.count, 1)) granted.")
            if permissions.contains(where: { ($0.kind == .accessibility || $0.kind == .screenRecording) && $0.grant != .granted }) {
                OnboardingNote("Already switched on in System Settings but still not ready here? That row was made by an earlier build: remove Jarhead from the list with the − button, press Request, and switch the new row on.")
                    .transition(Motion.appear)
            }
        }
        // A grant landing (the list is re-read every 2 s): the row's button drops away and
        // the dot turns; the sweep box arrives and leaves with the sweep.
        .animation(Motion.gentle, value: permissions)
        .animation(Motion.gentle, value: sweep)
    }

    /// A titled box of rows.
    private func group(_ title: String, _ rows: [PermissionInfo]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(ConsoleTheme.titanium)
                .padding(.leading, 2)
                .contentTransition(.opacity)
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.kind) { i, info in
                    if i > 0 { ConsoleHairline(weight: .row) }
                    row(info)
                }
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        }
    }

    /// The sweep's one line and its controls; while a step waits on the user (a dialog
    /// that returned at once, a System Settings pane), what to do and the Open Settings /
    /// Next buttons on their own row (the line is long there).
    private func sweepBox(_ sweep: PermissionSweepProgress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: onboardingIconGap) {
                ZStack {
                    if sweep.running {
                        ConsoleDot(color: ConsoleTheme.accent, live: true, size: 7).transition(.opacity)
                    } else {
                        ConsoleIcon(name: "checkmark.circle.fill", tint: ConsoleTheme.acting).transition(.opacity)
                    }
                }
                .frame(width: 20, height: 20)
                Text(sweep.line).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 20, alignment: .leading)
                    .contentTransition(.opacity)
                Spacer(minLength: 8)
                if sweep.running {
                    Button("Cancel") { actions.permissions.sweepCancel() }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                }
            }
            if sweep.stage == .settings || sweep.stage == .waiting, let kind = sweep.current {
                let waiting = sweep.stage == .waiting
                HStack(alignment: .top, spacing: onboardingIconGap) {
                    Spacer().frame(width: 20)
                    Text(OnboardingPermissionsStep.instruction(sweep, kind))
                        .font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                    Spacer(minLength: 8)
                    Button { actions.permissions.openSettings(kind) } label: { Label(waiting ? "Open Settings" : "Open again", systemImage: "gearshape.fill") }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .help(waiting ? "Open the System Settings pane" : "Open that System Settings pane again")
                    Button("Next") { actions.permissions.sweepNext() }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .help(waiting ? "Skip it for now" : "On to the next pane")
                }
            }
            if sweep.dryRun {
                Text("dry run · nothing is asked, only logged").font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg3)
                    .padding(.leading, 20 + onboardingIconGap)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .animation(Motion.fade, value: sweep.line)
        .accessibilityElement(children: .combine)
    }

    /// What to do while the sweep waits: the dialog that returned at once (Screen Recording
    /// and Input Monitoring offer to quit the app when switched on — Later keeps the sweep
    /// alive), Full Disk Access's drag-in, a pane shared by several kinds, or one switch.
    static func instruction(_ sweep: PermissionSweepProgress, _ kind: PermissionKind) -> String {
        if sweep.stage == .waiting {
            let later = kind == .screenRecording || kind == .inputMonitoring ? " (choose Later if it offers to quit)" : ""
            return "allow it in the dialog, or switch Jarhead on in the pane\(later); this moves on by itself — or press Next to skip"
        }
        if kind == .fullDiskAccess {
            return "drag Jarhead.app from the Finder window into the list and switch it on; come back and this moves on by itself — or press Next"
        }
        if sweep.group.count > 1 {
            return "switch Jarhead on for each of them, come back, and this moves on by itself — or press Next"
        }
        return "switch Jarhead on, come back, and this moves on by itself — or press Next"
    }

    /// Icon · label (+ required badge) / why / detail · Request or Open Settings · status dot.
    private func row(_ info: PermissionInfo) -> some View {
        let meta = ConsoleTheme.grant(info.grant)
        let asking = sweep?.running == true && sweep?.current == info.kind
        let opensSettings = info.ask == .settings || (info.grant == .denied && info.kind != .automation)
        return HStack(alignment: .top, spacing: onboardingIconGap) {
            ConsoleIcon(name: OnboardingPermissionsStep.symbol(info.kind))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(info.label).font(ConsoleTheme.sans(13)).foregroundStyle(ConsoleTheme.fg)
                    if info.required {
                        Text("required").font(ConsoleTheme.mono(9)).foregroundStyle(ConsoleTheme.fg3)
                            .padding(.horizontal, 5).frame(height: 15)
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
                            .accessibilityLabel("required")
                    }
                }
                .frame(height: 20)
                Text(info.why).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = info.detail, !detail.isEmpty {
                    Text(detail).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg3)
                        .lineLimit(2).truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .transition(.opacity)
                }
            }
            Spacer(minLength: 8)
            if info.grant != .granted {
                Button { actions.permissions.request(info.kind) } label: {
                    if opensSettings {
                        Label("Open Settings", systemImage: "gearshape.fill")
                    } else {
                        Text("Request")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .disabled(running)
                .help(opensSettings ? "Open System Settings on the pane\(info.kind == .fullDiskAccess ? " and reveal Jarhead.app for dragging in" : "")"
                      : "Ask for \(info.label.lowercased()) access")
                .frame(height: 20)
                .transition(ConsoleMotion.arriveLeave)
            }
            ConsoleDot(color: meta.color, live: asking, size: 6)
                .frame(width: 20, height: 20)
                .help(asking ? "asking…" : meta.label)
                .accessibilityLabel(asking ? "asking" : meta.label)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    /// Solid SF Symbol per kind (the Console rail's table says the same).
    static func symbol(_ kind: PermissionKind) -> String {
        switch kind {
        case .microphone: return "mic.fill"
        case .speechRecognition: return "captions.bubble.fill"
        case .screenRecording: return "rectangle.inset.filled.badge.record"
        case .accessibility: return "hand.raised.fill"
        case .inputMonitoring: return "keyboard.fill"
        case .automation: return "applescript.fill"
        case .fullDiskAccess: return "internaldrive.fill"
        case .notifications: return "bell.fill"
        case .camera: return "camera.fill"
        case .contacts: return "person.crop.circle.fill"
        case .calendars: return "calendar"
        case .reminders: return "checklist"
        case .localNetwork: return "network"
        case .filesDesktop: return "desktopcomputer"
        case .filesDocuments: return "doc.fill"
        case .filesDownloads: return "arrow.down.circle.fill"
        }
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
                                    .transition(.opacity)
                            }
                        }
                        // The verdict under the field fades in and rises; a rejection reads in red.
                        if let e = passphraseError {
                            Text(e).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.error)
                                .transition(Motion.appear)
                        } else if passphraseSet {
                            Text("Set. Say it or type it when asked.").font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                                .transition(Motion.appear)
                        }
                    }
                    .animation(Motion.gentle, value: passphraseError)
                    .animation(Motion.gentle, value: passphraseSet)
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
        // The gate's state crossfades (the dot and the glyph, the words); the heard line
        // itself never animates — Kevin is watching his words land.
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: onboardingIconGap) {
                ZStack {
                    if g.live {
                        ConsoleDot(color: g.color, live: true, size: 7).frame(width: 20, height: 20)
                            .transition(.opacity)
                    } else {
                        ConsoleIcon(name: g.symbol, tint: g.color)
                            .transition(.opacity)
                    }
                }
                .frame(width: 20, height: 20)
                Text(g.text).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg)
                    .contentTransition(.opacity)
                if let d = g.detail, !d.isEmpty {
                    Text(d).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1).truncationMode(.tail)
                        .contentTransition(.opacity)
                        .transition(.opacity)
                }
                Spacer(minLength: 0)
            }
            .animation(Motion.fade, value: g.text)
            .animation(Motion.fade, value: g.detail)
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
