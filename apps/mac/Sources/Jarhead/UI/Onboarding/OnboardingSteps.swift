import SwiftUI

// Welcome, Voice, Brain, Agents, Done. Each step is a plain value view over its
// slice of `OnboardingModel`, Equatable on that slice (never on `actions`) so a
// snapshot that changes nothing it shows costs nothing. Drafts (a key being
// typed, a model id) are local `@State`; while they differ from what the engine
// has, the step registers them with the session so Continue / Back / the rail
// send them instead of dropping them. No secret is ever read back: the snapshot
// only says whether a key is on file.

// MARK: - Welcome

struct OnboardingWelcomeStep: View, Equatable {
    let connected: Bool
    let daemonDetail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            OnboardingHead("Welcome",
                           "Jarhead is a voice assistant for this Mac. Asleep it costs nothing and nothing leaves the machine. Wake it and prove it's you, and it can talk, think and use the computer.")
            OnboardingStatusLine(color: connected ? ConsoleTheme.acting : ConsoleTheme.muted,
                                 text: connected ? "Daemon connected" : "Daemon not connected",
                                 detail: daemonDetail)
            OnboardingNote("Seven short steps. Everything here is also in the status menu under Set Up…")
        }
    }
}

// MARK: - Voice

/// The OpenAI key that runs GPT-Live-1. Save sends it once to the engine, which
/// writes ~/.jarhead/env and probes; the result comes back in `setup.openaiKey`.
struct OnboardingVoiceStep: View, Equatable {
    let setup: SetupStatus
    let actions: OnboardingActions

    static func == (a: OnboardingVoiceStep, b: OnboardingVoiceStep) -> Bool { a.setup == b.setup }

    @State private var key = ""
    @State private var pending = false
    @State private var pendingToken = 0
    @FocusState private var keyFocused: Bool

    private var draft: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !draft.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            OnboardingHead("Voice",
                           "GPT-Live-1 does the listening and talking. It needs an OpenAI key; you pay only while Jarhead is awake.")
            VStack(alignment: .leading, spacing: 10) {
                OnboardingFormRow("OpenAI key") {
                    HStack(spacing: 8) {
                        SecureField("sk-…", text: $key)
                            .consoleField(mono: true, height: onboardingRowHeight, focused: keyFocused)
                            .focused($keyFocused)
                            .onSubmit(save)
                            .accessibilityLabel("OpenAI API key")
                        Button("Save & check", action: save)
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost))
                            .disabled(!canSave)
                    }
                }
                OnboardingFormRow("") {
                    HStack(spacing: 14) {
                        if setup.secrets.openai {
                            OnboardingNote("A key is on file.")
                                .transition(Motion.appear)
                        }
                        Button {
                            actions.openURL(URL(string: "https://platform.openai.com/api-keys")!)
                        } label: {
                            HStack(spacing: 4) {
                                Text("Get a key")
                                Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .semibold))
                            }
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: .plain, height: 22, small: true))
                        .help("platform.openai.com/api-keys")
                    }
                }
            }
            status
        }
        // The saved key's note arrives with the probe's answer (OnboardingStatusLine fades itself).
        .animation(Motion.gentle, value: setup.secrets.openai)
        .onChange(of: setup) { pending = false }
        // A typed key is a draft: Continue saves it rather than dropping it.
        .onChange(of: canSave) { actions.draft(canSave, canSave ? save : nil) }
        .task(id: pendingToken) { await OnboardingPending.expire($pending) }
    }

    private var status: some View {
        let s = statusMeta
        return OnboardingStatusLine(color: s.color, live: s.live, text: s.text, id: s.id, detail: s.detail)
    }

    private struct Meta { let color: Color; let live: Bool; let text: String; var id: String? = nil; var detail: String? = nil }

    private var statusMeta: Meta {
        if pending { return Meta(color: ConsoleTheme.thinking, live: true, text: "Saving and checking…") }
        switch setup.openaiKey {
        case .ok: return Meta(color: ConsoleTheme.acting, live: false, text: "Key works", id: setup.liveModel)
        case .invalid: return Meta(color: ConsoleTheme.error, live: false, text: "OpenAI rejected that key", detail: "Paste a fresh one and save again.")
        case .missing: return Meta(color: ConsoleTheme.speaking, live: false, text: "No key yet")
        case .unchecked:
            return setup.secrets.openai
                ? Meta(color: ConsoleTheme.thinking, live: true, text: "Checking…")
                : Meta(color: ConsoleTheme.titanium, live: false, text: "Not checked yet")
        }
    }

    private func save() {
        let k = draft
        guard !k.isEmpty else { return }
        actions.send(.setSecrets(["OPENAI_API_KEY": k]))
        key = ""
        pending = true
        pendingToken += 1
        keyFocused = false
    }
}

// MARK: - Brain

/// Which brain thinks and acts. The kind is picked from the same menu field the
/// Console's Settings use (six kinds fit at any window size), its `needs` line
/// sits under it, then the fields that kind wants, then Apply. Apply sends only
/// what changed — the settings patch, the one secret the kind takes (named by
/// `BrainKind.secretKey`) — and asks for a probe; `setup.brain` and
/// `brainDetail` answer live.
struct OnboardingBrainStep: View, Equatable {
    let setup: SetupStatus
    let brain: BrainKind
    let brainModel: String
    let brainBaseUrl: String?
    let actions: OnboardingActions

    static func == (a: OnboardingBrainStep, b: OnboardingBrainStep) -> Bool {
        a.setup == b.setup && a.brain == b.brain && a.brainModel == b.brainModel && a.brainBaseUrl == b.brainBaseUrl
    }

    /// What the engine has, as one value. The drafts are dirty when they differ
    /// from the copy they were loaded from, not from whatever just arrived — so
    /// a change made elsewhere (the Console's Settings) reloads clean drafts.
    struct Saved: Equatable {
        var kind: BrainKind
        var model: String
        var baseUrl: String
    }

    private var saved: Saved { Saved(kind: brain, model: brainModel, baseUrl: brainBaseUrl ?? "") }

    @State private var kind: BrainKind = .auto
    @State private var model = ""
    @State private var baseUrl = ""
    @State private var secret = ""
    @State private var loadedFrom: Saved?
    @State private var pending = false
    @State private var pendingToken = 0
    @FocusState private var focus: Field?

    private enum Field: Hashable { case model, baseUrl, secret }

    /// The model to suggest when a kind is picked; "" leaves it to the engine.
    static func defaultModel(_ kind: BrainKind) -> String {
        switch kind {
        case .claudeCode, .anthropicApi: return "claude-opus-5"
        case .openaiResponses: return "gpt-5.6-terra"
        case .auto, .codex, .openaiCompatible: return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            OnboardingHead("Brain", "The brain thinks and acts. Pick whatever you have; swap any time.")
            VStack(alignment: .leading, spacing: 6) {
                OnboardingFormRow("Brain") {
                    VStack(alignment: .leading, spacing: 5) {
                        ConsoleMenuField(value: kind, options: BrainKind.allCases, title: { $0.label }, pick: choose)
                            .frame(height: onboardingRowHeight)
                            .accessibilityLabel("Brain: \(kind.label)")
                        OnboardingNote(kind.needs)
                            .contentTransition(.opacity)
                    }
                }
                // The fields a kind wants arrive and leave with the pick (Motion.appear); the
                // Apply row below them moves to make room.
                fields
                    .transition(Motion.appear)
                OnboardingFormRow("") {
                    Button("Apply", action: apply)
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost))
                }
            }
            .animation(Motion.gentle, value: kind)
            status
        }
        .onAppear { if loadedFrom == nil { load() } }
        .onChange(of: setup) { pending = false }
        .onChange(of: saved) { if !dirty { load() } }
        .onChange(of: dirty) { actions.draft(dirty, dirty ? apply : nil) }
        .task(id: pendingToken) { await OnboardingPending.expire($pending) }
    }

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The drafts differ from what they were loaded from (or a key was typed).
    private var dirty: Bool {
        guard let from = loadedFrom else { return false }
        return kind != from.kind
            || trimmed(model) != from.model
            || (kind == .openaiCompatible && trimmed(baseUrl) != from.baseUrl)
            || !trimmed(secret).isEmpty
    }

    private func load() {
        let s = saved
        kind = s.kind
        model = s.model
        baseUrl = s.baseUrl
        loadedFrom = s
    }

    private func choose(_ k: BrainKind) {
        guard k != kind else { return }
        kind = k
        model = k == brain ? brainModel : OnboardingBrainStep.defaultModel(k)
        secret = ""
        if k == .openaiCompatible, baseUrl.isEmpty { baseUrl = brainBaseUrl ?? "" }
    }

    /// The secret this kind takes as its own; OpenAI reuses the voice key, so none here.
    private var secretKey: String? { kind == .openaiResponses ? nil : kind.secretKey }

    private var secretOnFile: Bool {
        switch secretKey {
        case "ANTHROPIC_API_KEY": return setup.secrets.anthropic
        case "JARHEAD_BRAIN_API_KEY": return setup.secrets.brainApiKey
        case "OPENAI_API_KEY": return setup.secrets.openai
        default: return false
        }
    }

    @ViewBuilder
    private var fields: some View {
        switch kind {
        case .auto:
            loginRow("Picks a signed-in Codex or Claude Code; otherwise the OpenAI key from the Voice step.")
        case .codex:
            loginRow("Uses your ChatGPT / Codex login on this Mac. Not signed in? Run `codex` once in a terminal.")
        case .claudeCode:
            loginRow("Uses your Claude login on this Mac. Not signed in? Run `claude` once in a terminal.")
        case .anthropicApi:
            secretRow("Anthropic key", placeholder: "sk-ant-…")
            modelRow
        case .openaiResponses:
            modelRow
            OnboardingFormRow("Key") {
                OnboardingNote(setup.secrets.openai ? "Uses the voice key from the previous step." : "Uses the voice key — set one in the Voice step.")
            }
        case .openaiCompatible:
            OnboardingFormRow("Base URL") {
                VStack(alignment: .leading, spacing: 5) {
                    TextField("http://localhost:11434", text: $baseUrl)
                        .consoleField(mono: true, height: onboardingRowHeight, focused: focus == .baseUrl)
                        .focused($focus, equals: .baseUrl)
                        .onSubmit(apply)
                        .accessibilityLabel("Base URL")
                    OnboardingNote("The server root, with or without /v1. OpenRouter: https://openrouter.ai/api")
                }
            }
            modelRow
            secretRow("Key", placeholder: "optional")
        }
    }

    private func loginRow(_ text: String) -> some View {
        OnboardingFormRow("Login") { OnboardingNote(text) }
    }

    private func secretRow(_ label: String, placeholder: String) -> some View {
        OnboardingFormRow(label) {
            SecureField(secretOnFile ? "a key is on file · paste to replace" : placeholder, text: $secret)
                .consoleField(mono: true, height: onboardingRowHeight, focused: focus == .secret)
                .focused($focus, equals: .secret)
                .onSubmit(apply)
                .accessibilityLabel("\(label) (secret)")
        }
    }

    private var modelRow: some View {
        OnboardingFormRow("Model") {
            TextField("model id", text: $model)
                .consoleField(mono: true, height: onboardingRowHeight, focused: focus == .model)
                .focused($focus, equals: .model)
                .onSubmit(apply)
                .accessibilityLabel("Model id")
        }
    }

    private var status: some View {
        let s = statusMeta
        return OnboardingStatusLine(color: s.color, live: s.live, text: s.text, id: s.id, detail: s.detail)
    }

    private struct Meta { let color: Color; let live: Bool; let text: String; var id: String? = nil; var detail: String? = nil }

    /// Live only while something is actually in flight: our own Apply (capped at
    /// 10 s) or the engine saying `unchecked`, which it does while it restarts.
    private var statusMeta: Meta {
        if pending { return Meta(color: ConsoleTheme.thinking, live: true, text: "Starting \(kind.label)…") }
        let name = OnboardingReport.brainName(brain, resolved: setup.brainResolved)
        let id = OnboardingReport.brainModelId(brainModel, detail: setup.brainDetail)
        switch setup.brain {
        case .ok: return Meta(color: ConsoleTheme.acting, live: false, text: "\(name) ready", id: id, detail: setup.brainDetail)
        case .unavailable: return Meta(color: ConsoleTheme.error, live: false, text: "\(name) unavailable", detail: setup.brainDetail)
        case .unchecked: return Meta(color: ConsoleTheme.thinking, live: true, text: "Checking \(name)…", detail: setup.brainDetail)
        }
    }

    /// Send what differs from the engine's copy, then a probe. Nothing changed →
    /// just the probe, and no spinner: the engine would not restart anything.
    private func apply() {
        let from = loadedFrom ?? saved
        let m = trimmed(model)
        let u = trimmed(baseUrl)
        let s = trimmed(secret)
        var patch = SettingsPatch()
        var changed = false
        if kind != from.kind { patch.brain = kind; changed = true }
        if m != from.model { patch.brainModel = m; changed = true }
        var sentBaseUrl = from.baseUrl
        if kind == .openaiCompatible, u != from.baseUrl {
            patch.brainBaseUrl = .some(u.isEmpty ? nil : u)
            sentBaseUrl = u
            changed = true
        }
        if changed { actions.send(.setSettings(patch)) }
        if let key = secretKey, !s.isEmpty {
            actions.send(.setSecrets([key: s]))
            changed = true
        }
        actions.send(.probeSetup)

        secret = ""
        focus = nil
        // The drafts now match what was sent; the engine's echo reloads them clean.
        loadedFrom = Saved(kind: kind, model: m, baseUrl: sentBaseUrl)
        if changed {
            pending = true
            pendingToken += 1
        }
    }
}

// MARK: - Agents

/// Read-only: what the connectors found, grouped by connector.
struct OnboardingAgentsStep: View, Equatable {
    let agents: [AgentInfo]
    let connectors: [ConnectorHealth]
    let actions: OnboardingActions

    static func == (a: OnboardingAgentsStep, b: OnboardingAgentsStep) -> Bool { a.agents == b.agents && a.connectors == b.connectors }

    @State private var refreshSpin = 0.0

    private struct Group: Identifiable {
        let kind: AgentKind
        let connector: ConnectorHealth?
        let count: Int
        var id: String { kind.rawValue }
    }

    private var groups: [Group] {
        var seen = Set<AgentKind>()
        var out: [Group] = []
        let kinds = ConsoleTheme.kindOrder + agents.map(\.kind).filter { !ConsoleTheme.kindOrder.contains($0) }
        for kind in kinds where !seen.contains(kind) {
            seen.insert(kind)
            let connector = connectors.first { $0.kind == kind }
            let count = agents.filter { $0.kind == kind }.count
            if connector == nil && count == 0 { continue }
            out.append(Group(kind: kind, connector: connector, count: count))
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            OnboardingHead("Agents",
                           "Jarhead finds your Claude Code and Codex sessions on this Mac and can continue them.") {
                Button {
                    actions.send(.agentRefresh)
                    // One turn of the arrow per press (Motion.gentle); none under Reduce Motion.
                    if !Motion.reduced { withAnimation(Motion.gentle) { refreshSpin += 360 } }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold))
                            .rotationEffect(.degrees(refreshSpin))
                        Text("Refresh")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                .accessibilityLabel("Refresh agents")
            }
            // Groups arriving with a refresh fade in and rise; the count rolls its digits.
            if !groups.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                        if index > 0 { ConsoleHairline(weight: .row) }
                        row(group).transition(Motion.appear)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
                .transition(Motion.appear)
            }
            if agents.isEmpty {
                // The connectors are there; the sessions are not. Say what to do, once.
                OnboardingNote("No sessions on this Mac right now. Start one in a terminal and refresh.")
                    .transition(Motion.appear)
            } else {
                HStack(spacing: 6) {
                    Text("\(agents.count)").font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg)
                        .contentTransition(ConsoleMotion.numeric)
                    Text(agents.count == 1 ? "agent found" : "agents found").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                        .contentTransition(.opacity)
                }
                .transition(Motion.appear)
            }
        }
        .animation(Motion.gentle, value: agents.map(\.id))
        .animation(Motion.gentle, value: connectors)
    }

    private func row(_ group: Group) -> some View {
        let ok = group.connector?.ok ?? true
        return HStack(spacing: onboardingIconGap) {
            ConsoleIcon(name: ConsoleTheme.kindSymbol(group.kind), tint: ok ? ConsoleTheme.titanium : ConsoleTheme.error)
            Text(ConsoleTheme.kindTitle(group.kind)).font(ConsoleTheme.sans(13)).foregroundStyle(ConsoleTheme.fg)
            Text("\(group.count)").font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            Spacer(minLength: 8)
            if let detail = group.connector?.detail, !detail.isEmpty {
                Text(detail).font(ConsoleTheme.sans(12)).foregroundStyle(ok ? ConsoleTheme.fg3 : ConsoleTheme.error)
                    .lineLimit(1).truncationMode(.tail)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Done

/// The four lines of the report, then Finish (in the footer). Lines wrap (three
/// at most) so the part that says what to do is never the part that gets cut.
struct OnboardingDoneStep: View, Equatable {
    let report: OnboardingReport

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            OnboardingHead("Done", "Here is where things stand. Finish closes this window; anything amber can be fixed later from the status menu.")
            VStack(spacing: 0) {
                row("waveform.circle.fill", "Voice", report.voice)
                ConsoleHairline(weight: .row)
                row("brain.fill", "Brain", report.brain)
                ConsoleHairline(weight: .row)
                row("lock.shield.fill", "Permissions", report.permissions)
                ConsoleHairline(weight: .row)
                row("ear.fill", "Wake", report.wake)
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            OnboardingNote("Say the wake word, or click the orb, and Jarhead is listening.")
        }
    }

    /// A line whose verdict changes while the page is up (a grant landing, a probe
    /// answering) crossfades: the dot's colour and the words.
    private func row(_ symbol: String, _ name: String, _ line: OnboardingReport.Line) -> some View {
        HStack(alignment: .top, spacing: onboardingIconGap) {
            ConsoleIcon(name: symbol)
            Text(name).font(ConsoleTheme.sans(13)).foregroundStyle(ConsoleTheme.fg)
                .frame(width: 92, height: 20, alignment: .leading)
            Circle().fill(OnboardingMarkStyle.color(line.mark)).frame(width: 6, height: 6)
                .frame(height: 20)
            OnboardingLine.text(line.text, id: line.id, detail: line.detail, color: ConsoleTheme.fg2)
                .lineLimit(3).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 20, alignment: .leading)
                .contentTransition(.opacity)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 36)
        .animation(Motion.fade, value: line)
        .accessibilityElement(children: .combine)
    }
}
