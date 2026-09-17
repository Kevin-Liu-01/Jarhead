import SwiftUI

// design13 (§ Voices): one menu, two doors. The composer's `🇬🇧 Ballad ⌄` chip and Settings › Audio's
// Voice field are the same `ConsoleMenuField` over the 22 voices with the same popup — the Accent
// segments in its head, `default` / `saved` badges, `speaking` on the open session's voice, a foot
// that says what a pick does in THIS phase. A pick is ALWAYS free (`set-settings`); hearing it is
// one explicit press — **Switch now**, the one filled verb beside the chip while awake and idle —
// or Kevin asking aloud. Never a paid start from ⏎, a row click or a modifier (Return is never a
// paid yes). Asleep, a pick just works at the next Go and nothing waits. The flag is the Accent's
// (`AccentWords`), never a voice's.

/// Every literal the voice switch says: the chip, the foot, the Settings line, the stream's switch
/// row, the toast the engine spells the same way. Pinned by `check-kit`.
enum VoiceSwitchWords {
    static let switchNow = "Switch now"
    static let waits = ConsoleMenuWords.waits
    static let accentHead = "Accent"
    static let oneRestart = "one restart"
    static let dot = " · "
    static let arrow = "voice → "
    /// Setup › Voice's hint under the long-word segments.
    static let setupHint = "English at all times · heard at the first Go"
    /// The tips ride on `HelpCopy` (check-copy pins them); spelled here so every site says the same.
    static let switchTip = HelpCopy.switchVoice.hint
    static let switchTipBusy = HelpCopy.switchVoiceBusy.hint

    /// The composer chip's words: `🇬🇧 Ballad` · `Ballad` when the accent is None. Pinned.
    static func chip(name: String, flag: String?) -> String {
        guard let flag else { return name }
        return "\(flag) \(name)"
    }

    /// `Marin 🇬🇧` — the name with the accent's flag after it (the stream row, the toast, the status menu).
    static func named(_ name: String, flag: String?) -> String {
        guard let flag else { return name }
        return "\(name) \(flag)"
    }

    /// The popup foot for the highlighted row in THIS phase (idle · busy · paused · asleep · connecting). Pinned.
    static func foot(name: String, phase: Phase, busy: Bool) -> String {
        switch phase {
        case .paused: return "\(name) — heard when the session resumes"
        case .connecting: return "\(name) — heard at the next wake"
        case .asleep, .error: return "\(name) — heard at the next Go"
        case .listening, .speaking, .thinking, .acting, .muted:
            return busy ? "\(name) — busy · heard at the next wake" : "\(name) — ⏎ picks · Switch now hears it · one restart"
        }
    }

    /// Under Accent while a pick waits: `one restart · Ballad until you switch`. Pinned.
    static func waitsLine(current: String) -> String { "\(oneRestart)\(dot)\(current) until you switch" }

    /// The stream's mono meta row: `voice → Marin 🇬🇧 · one restart · 0.7 s` (the figure only when the row carries it). Pinned.
    static func switched(name: String, flag: String?, ms: Double?) -> String {
        var parts = [arrow + named(name, flag: flag), oneRestart]
        if let ms, ms.isFinite, ms >= 0 { parts.append(String(format: "%.1f s", ms / 1000)) }
        return parts.joined(separator: dot)
    }

    /// The toast on a pick while awake: `Marin 🇬🇧 at the next wake · Switch now`. Pinned.
    static func toast(name: String, flag: String?) -> String { "\(named(name, flag: flag)) at the next wake\(dot)\(switchNow)" }
}

/// The composer chip's ids and measures (the harness opens it by `stream.voice`, clicks `stream.switch`).
enum VoiceChipWords {
    static let id = "stream.voice"
    static let switchId = "stream.switch"
    static let tipId = "stream.voice.tip"
    static let accentId = "voice.accent"
    static let settingsSwitchId = "settings.switch"
    static let popupWidth: CGFloat = 256
    static let settingsPopupWidth: CGFloat = 258
    static let height: CGFloat = 32
    static let accentCell: CGFloat = 50
}

/// The rule, pure: when a pick waits, what the line under Accent reads, whether the reopen would land.
enum VoiceSwitch {
    /// The saved voice or accent differs from what the open session speaks — awake only, and only
    /// when the session said its voice (a daemon from before `voice.reopen` did not, so nothing to press).
    static func waits(voice: String, accent: String, session: SessionInfo?, phase: Phase) -> Bool {
        guard let session, AppState.inSessionPhases.contains(phase), let spoken = session.voice else { return false }
        return spoken != voice || (session.accent ?? accent) != accent
    }

    /// The line under Accent and the verb beside the chip: at rest nothing waits; `.waits` carries
    /// whether Switch now is enabled (the engine refuses the reopen while work runs).
    enum Line: Equatable { case rest, waits(enabled: Bool) }
    static func line(waits: Bool, busy: Bool) -> Line { waits ? .waits(enabled: !busy) : .rest }

    /// Work runs: a delegation running or waiting on a confirmation while the session is up, or a live thread not idle.
    static func busy(delegations: [Delegation], threads: [WorkThread], phase: Phase) -> Bool {
        let delegation = phase != .asleep && delegations.contains { $0.status == .running || $0.status == .awaitingConfirmation }
        return delegation || threads.contains { $0.status.isBusy }
    }

    static func tip(enabled: Bool) -> String { enabled ? VoiceSwitchWords.switchTip : VoiceSwitchWords.switchTipBusy }
}

// MARK: - The chip

/// What the chip shows, sliced from the snapshot so the view is Equatable and the 20 Hz level
/// tick re-evaluates nothing below `VoiceChipSlot`.
struct VoiceChipInputs: Equatable {
    var voice: String
    var accent: String
    var phase: Phase
    var session: SessionInfo?
    var busy: Bool

    var waits: Bool { VoiceSwitch.waits(voice: voice, accent: accent, session: session, phase: phase) }
    var line: VoiceSwitch.Line { VoiceSwitch.line(waits: waits, busy: busy) }
    /// The 22, plus a saved id outside them (JARHEAD_VOICE) under `Saved, not listed`.
    var options: [String] { ConsoleTheme.voices + (ConsoleTheme.voices.contains(voice) ? [] : [voice]) }
}

/// The composer's door: `🇬🇧 Ballad ⌄` in a 32 tile between Mute and the field; `waits` while a pick
/// differs from the session's voice; Switch now (primary 32) beside it while awake and a pick waits,
/// disabled with the busy tip while work runs. The popup opens above the composer (no room below),
/// `x = chip.minX`, 256 wide.
struct VoiceChip: View, Equatable {
    let inputs: VoiceChipInputs
    /// Which face the chip wears and whether Switch now keeps its word — the composer's arithmetic on its
    /// own width (`ComposerFit.cluster(width:)`), never a measure of the faces (a `ViewThatFits` here
    /// cost the pick a 0.4 s layout stall).
    var cluster = ComposerFit.Cluster()
    let pickVoice: (String) -> Void
    let pickAccent: (String) -> Void
    let switchNow: () -> Void

    static func == (a: VoiceChip, b: VoiceChip) -> Bool { a.inputs == b.inputs && a.cluster == b.cluster }

    var body: some View {
        HStack(spacing: 8) {
            ConsoleMenuField(value: inputs.voice, options: inputs.options, title: VoiceWords.name, pick: pickVoice,
                             id: VoiceChipWords.id, label: VoiceWords.label, badge: VoiceWords.badges, detail: detail, group: VoiceWords.group,
                             foot: foot, filter: true, filterNoun: VoiceWords.noun, width: VoiceChipWords.popupWidth, height: VoiceChipWords.height,
                             head: head, trigger: face, hugs: true)
                .consoleHelp(HelpCopy.voiceChip, id: VoiceChipWords.tipId)
            if case .waits(let enabled) = inputs.line {
                VoiceSwitchButton(enabled: enabled, word: cluster.word, id: VoiceChipWords.switchId, action: switchNow)
                    .transition(Motion.appear)
            }
        }
        .animation(Motion.gentle, value: inputs.line)
    }

    private func detail(_ id: String) -> String { VoiceWords.detail(id, speaking: inputs.session?.voice) }
    private func foot(_ id: String) -> String? { VoiceSwitchWords.foot(name: VoiceWords.name(id), phase: inputs.phase, busy: inputs.busy) }
    private func head() -> AnyView { AnyView(VoicePopupHead(accent: inputs.accent, pick: pickAccent)) }
    private func face(_ open: Bool) -> AnyView {
        AnyView(VoiceChipFace(name: VoiceWords.name(inputs.voice), flag: AccentWords.flag(inputs.accent), waits: inputs.waits, open: open, tier: cluster.chip))
    }
}

/// `[8] 🇬🇧 [5] Ballad sans 12 medium fg [6 · waits] [8] chevron 9 fg3 [8]` — the style pads the 8s.
/// Three faces, widest first; the composer picks one from its own width (`ComposerFit.cluster`: the
/// field is held at its floor, then the chip gives its badge, then its name, then Switch now gives
/// its word; only then does the field shrink). The accessibility value is the whole chip whatever face is drawn.
struct VoiceChipFace: View {
    let name: String
    let flag: String?
    let waits: Bool
    let open: Bool
    var tier: Tier = .full

    /// The faces: `🇬🇧 Ballad waits ⌄` · `🇬🇧 Ballad ⌄` · `🇬🇧 ⌄` (the name stays when the accent has no flag).
    enum Tier: CaseIterable { case full, name, flag }

    /// What a face draws — pure, pinned by `check-kit`.
    static func shows(_ tier: Tier, flag: String?, waits: Bool) -> (flag: Bool, name: Bool, waits: Bool) {
        switch tier {
        case .full: return (flag != nil, true, waits)
        case .name: return (flag != nil, true, false)
        case .flag: return (flag != nil, flag == nil, false)
        }
    }

    var body: some View {
        let shows = Self.shows(tier, flag: flag, waits: waits)
        HStack(spacing: 0) {
            if shows.flag, let flag { Text(flag).font(ConsoleTheme.sans(12)).padding(.trailing, shows.name ? 5 : 0) }
            if shows.name {
                Text(name).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
                    .contentTransition(.opacity)
            }
            if shows.waits { ConsoleBadge(word: .word(VoiceSwitchWords.waits)).padding(.leading, 6).transition(Motion.appear) }
            Image(systemName: ConsoleGlyph.picker)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(open ? ConsoleTheme.fg : ConsoleTheme.fg3)
                .padding(.leading, 8)
        }
        // The chip keeps its words at this tier: the composer's arithmetic, not the field, decides the tier.
        .fixedSize(horizontal: true, vertical: false)
        .animation(Motion.snappy, value: waits)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(VoiceWords.label)
        .accessibilityValue(waits ? "\(VoiceSwitchWords.chip(name: name, flag: flag)) · \(VoiceSwitchWords.waits)" : VoiceSwitchWords.chip(name: name, flag: flag))
    }
}

/// The popup's head: `Accent   🇺🇸 US | 🇬🇧 UK | None` — one clause for all 22 voices, so a strip, not a
/// row; segments `.toggle` 22, cells 50, right-aligned. A saved accent outside the three is kept.
struct VoicePopupHead: View {
    let accent: String
    let pick: (String) -> Void

    private var options: [String] {
        let ids = ConsoleTheme.accents.map(\.id)
        return ids.contains(accent) ? ids : ids + [accent]
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(VoiceSwitchWords.accentHead).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(ConsoleTheme.titanium)
            Spacer(minLength: 8)
            ConsoleSegments(value: accent, options: options, title: { AccentWords.title($0, short: true) }, pick: pick,
                            accessibilityLabel: SettingsWords.accentLabel(AccentWords.title(accent, short: false)),
                            size: .toggle, id: VoiceChipWords.accentId, cellWidth: VoiceChipWords.accentCell)
                .consoleHelp(SettingsWords.accentTip)
        }
        .padding(.horizontal, 12)
        .frame(height: ConsoleMenuPopupLayout.stripHeight)
    }
}

/// Switch now — the one paid restart, behind an explicit press: `pause({quiet})` + `connect("voice
/// change")` on the engine (`EngineCommand.voiceReopen`). Primary 32 beside the chip; the rail's
/// verb size in Settings. Disabled (.45) with the busy tip while the engine would refuse it. The word,
/// or — when the composer is too narrow for it beside the flag-alone chip (`ComposerFit.cluster`) —
/// the one filled glyph (`ConsoleGlyph.switchVoice`); the tip and the accessibility label say the verb either way.
struct VoiceSwitchButton: View {
    let enabled: Bool
    var word = true
    var height: CGFloat = VoiceChipWords.height
    var kind: ConsoleButtonStyle.Kind = .primary
    var small = false
    let id: String
    let action: () -> Void

    var body: some View {
        Group {
            if word {
                Button(VoiceSwitchWords.switchNow, action: action)
                    .buttonStyle(ConsoleButtonStyle(kind: kind, height: height, small: small))
            } else {
                Button(action: action) { Image(systemName: ConsoleGlyph.switchVoice).font(.system(size: 13, weight: .semibold)) }
                    .buttonStyle(ConsoleButtonStyle(kind: kind, iconOnly: true, height: height, small: small))
            }
        }
        .disabled(!enabled)
        // One line, one width: the field beside it gives, never the verb.
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
        .consoleHelp(VoiceSwitch.tip(enabled: enabled), id: id)
        .accessibilityLabel(VoiceSwitchWords.switchNow)
    }
}

/// The composer's slot: the one leaf that reads `AppState` (the root slices everything else — a
/// follow-up hands the chip its inputs from `ConsoleRootView` and this observer goes). It slices
/// to `VoiceChipInputs` and the chip is `.equatable()`, so a level tick redraws nothing under it.
struct VoiceChipSlot: View {
    /// The composer's word on the room (`ComposerFit.cluster(width:)`).
    var cluster = ComposerFit.Cluster()
    @EnvironmentObject private var state: AppState
    @Environment(\.consoleActions) private var actions

    var body: some View {
        VoiceChip(inputs: Self.inputs(state), cluster: cluster,
                  pickVoice: { actions.send(.setSettings(SettingsPatch(voice: $0))) },
                  pickAccent: { actions.send(.setSettings(SettingsPatch(accent: $0))) },
                  switchNow: { actions.send(.voiceReopen) })
            .equatable()
    }

    static func inputs(_ state: AppState) -> VoiceChipInputs {
        let s = state.snapshot
        return VoiceChipInputs(voice: s.settings.voice, accent: s.settings.accent, phase: s.phase, session: s.session,
                               busy: VoiceSwitch.busy(delegations: s.delegations, threads: Array(state.threads.values), phase: s.phase))
    }
}

// MARK: - The status menu's rows (pure; App/StatusItem.swift draws them as NSMenuItems)

/// One row of `Voice ▸`: Switch now first (awake, a pick waits; disabled while busy), Ballad
/// `default` / Cedar / Marin, the 19 alphabetical, then the three accents with flags.
struct VoiceMenuRow: Equatable {
    enum Kind: Equatable { case switchNow, voice(String), accent(String), separator }
    let kind: Kind
    let title: String
    var on = false
    var enabled = true

    static let separator = VoiceMenuRow(kind: .separator, title: "")
}

enum VoiceMenuWords {
    static let voice = "Voice"
    static let tagJoiner = " · "
}

enum VoiceMenuModel {
    /// `Marin 🇬🇧` — the value after the `Voice` key on the menu row.
    static func value(voice: String, accent: String) -> String {
        VoiceSwitchWords.named(VoiceWords.name(voice), flag: AccentWords.flag(accent))
    }

    /// `Ballad · default` · `Marin · speaking` · `Cedar`.
    static func voiceTitle(_ id: String, speaking: String?) -> String {
        var tags: [String] = []
        if id == VoiceWords.defaultId { tags.append(ConsoleBadgeWords.default) }
        if id == speaking { tags.append(ConsoleMenuWords.speaking) }
        return ([VoiceWords.name(id)] + tags).joined(separator: VoiceMenuWords.tagJoiner)
    }

    static func rows(voice: String, accent: String, session: SessionInfo?, phase: Phase, busy: Bool) -> [VoiceMenuRow] {
        var out: [VoiceMenuRow] = []
        if VoiceSwitch.waits(voice: voice, accent: accent, session: session, phase: phase) {
            out.append(VoiceMenuRow(kind: .switchNow, title: VoiceSwitchWords.switchNow, enabled: !busy))
            out.append(.separator)
        }
        func row(_ id: String) -> VoiceMenuRow { VoiceMenuRow(kind: .voice(id), title: voiceTitle(id, speaking: session?.voice), on: id == voice) }
        out += ConsoleTheme.voices.prefix(3).map(row)
        out.append(.separator)
        out += ConsoleTheme.voices.dropFirst(3).map(row)
        out.append(.separator)
        out += ConsoleTheme.accents.map { VoiceMenuRow(kind: .accent($0.id), title: AccentWords.title($0.id, short: false), on: $0.id == accent) }
        return out
    }
}
