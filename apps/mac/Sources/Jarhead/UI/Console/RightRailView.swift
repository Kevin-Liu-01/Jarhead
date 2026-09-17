import SwiftUI
import AVFoundation

// MARK: - Words (every literal the rail shows; `check-kit` pins the ones the mocks show)

/// The Settings tab: the controls' ids (the harness opens and focuses them by name — `menuOpen:`,
/// `focus:`, `fold:`), the seven heads' fold ids, the row keys, the hints and the tips.
enum SettingsWords {
    // ids
    static let voice = "settings.voice"
    static let mic = "settings.mic"
    static let backend = "settings.backend"
    static let effort = "settings.effort"
    static let auth = "settings.auth"
    static let wakeWord = "settings.wakeWord"
    static let autoWake = "settings.autoWake"
    static let remember = "settings.remember"
    static let check = "settings.check"
    static let idle = "settings.idle"
    static let modelField = "settings.modelField"
    static let server = "settings.server"
    static let phrases = "settings.phrases"
    static let passphrase = "settings.passphrase"
    static let voiceKey = "settings.voiceKey"
    static let brainKey = "settings.brainKey"
    static let ledgerRetention = "settings.ledgerRetention"
    static let shotsRetention = "settings.shotsRetention"
    static let learnedTip = "settings.learned"
    static let heardTip = "settings.heard"
    /// design12: the Recording toggle and the two route rows (the cards hang from the row ids).
    static let recording = "settings.recording"
    static let hearsRow = "settings.hears"
    static let speaksRow = "settings.speaks"
    static func leavesRow(_ what: String) -> String { "settings.leaves.\(what)" }
    // the seven heads (folds remembered per id)
    static let audioFold = "settings.audio"
    static let brainFold = "settings.brain"
    static let leavesFold = "settings.leaves"
    static let sessionFold = "settings.session"
    static let memoryFold = "settings.memory"
    static let retentionFold = "settings.retention"
    static let wakeFold = "settings.wake"
    /// Automations (design11): the eighth head, after Session.
    static let automationsFold = "settings.automations"
    static let folds = [audioFold, brainFold, leavesFold, sessionFold, automationsFold, memoryFold, retentionFold, wakeFold]
    // row keys
    static let voiceKeyLabel = "Voice"
    static let language = "Language"
    static let accent = "Accent"
    static let micLabel = "Mic"
    static let hears = "Hears"
    static let speaks = "Speaks"
    static let recordingRow = "Recording"
    static let voiceKeyRow = "Voice key"
    static let model = "Model"
    static let serverRow = "Server"
    static let key = "Key"
    static let effortLabel = "Effort"
    static let status = "Status"
    static let idleSleep = "Idle sleep"
    static let autoWakeRow = "Auto-wake"
    static let home = "Home"
    static let rememberRow = "Remember"
    static let matching = "Matching"
    static let known = "Known"
    static let ledger = "Ledger"
    static let screenshots = "Screenshots"
    static let trash = "Trash"
    static let wakeWordRow = "Wake word"
    static let phrasesRow = "Phrases"
    static let authRow = "Auth"
    static let passphraseRow = "Passphrase"
    // toggles' hints (≤ 4 words: the consequence, not the label; ≤ 112 pt at sans 11 — the room
    // beside a 60 pt toggle in the 182 pt control column; check-kit measures them)
    static let wakeHint = "listens on-device"
    static let autoWakeHint = "wakes on launch"
    static let rememberHint = "learns while on"
    static let recordingHint = "shares the mic"
    // words on the rows
    static let minutes = "min"
    static let notch = "Notch"
    static let free = "Free"
    static let either = "Either"
    static let keepForever = "keep forever"
    static let forever = "forever"
    static let onFile = "on file"
    static let rejected = "rejected"
    static let missing = "missing"
    static let set = "Set"
    static let phraseSet = "set"
    static let aPhrase = "a phrase"
    static let tooShort = "Two words or more."
    static let openAIKey = "OPENAI_API_KEY"
    static let skPlaceholder = "sk-…"
    static let skAntPlaceholder = "sk-ant-…"
    static let serverKeyPlaceholder = "server key"
    static let serverPlaceholder = "http://localhost:11434/v1"
    static let phrasesPlaceholder = "jarhead, jar head"
    static let heard = "heard"
    static let ellipsis = "…"
    static let dash = "—"
    static let period = "."
    static let systemDefaultPrefix = "system default"
    static let pickAModel = "pick a model"
    static let backendDefault = "backend default"
    static let gateRests = "Awake — the gate rests until the session ends"
    static let switchNow = "Switch now"
    static let learnNow = "Learn now"
    static let sweepNow = "Sweep now"
    static let sweepArmed = "Move older days to Trash"
    static let revealInFinder = "Reveal in Finder"
    static let setUpAgain = "Set up again…"
    static let checkVerb = "Check"
    static let ready = "Ready"
    static let unavailable = "Unavailable"
    static let checking = "Checking…"
    static func readyWith(_ resolved: String) -> String { "\(resolved) ready" }
    static let notLearned = "not learned yet"
    static func learned(_ ago: String) -> String { "learned \(ago) ago" }
    static func learnedShort(_ ago: String) -> String { "learned \(ago)" }
    static func live(_ n: Int) -> String { "\(n) live" }
    static func hiddenCounts(forgotten: Int, archived: Int) -> String { "\(forgotten) forgotten · \(archived) archived" }
    static func waiting(_ n: Int) -> String { "\(n) waiting" }
    static let lastRun = "Last run"
    static let noRun = "No run yet"
    static let extractor = "extractor"
    static let added = "added"
    static let updated = "updated"
    static let same = "same"
    static let refused = "refused"
    static let took = "took"
    static let notRead = "Not read yet."
    // hints
    static let memoryOff = "Off: nothing is learned or used. What was remembered stays."
    /// design12: under the Recording toggle while On (the `memoryOff` idiom).
    static let recordingOn = "No Apple unit. Jarhead holds the wire while he speaks; a word over him opens it."
    /// `Shared with QuickTime Player.` · two names, then `+ n`; appended under Speaks, never alone.
    static func sharedWith(_ names: [String]) -> String {
        let shown = names.prefix(2).joined(separator: ", ")
        let more = names.count > 2 ? " + \(names.count - 2)" : ""
        return "Shared with \(shown)\(more)."
    }
    // the route rows' words (design12): one state word on line 2, the figure as `48 kHz`
    static let echoCancelled = "echo cancelled"
    static let echoGuarded = "echo guarded"
    static let echoNone = "no echo cancellation"
    /// The hover card's route row and the status line — a sentence, so never on line 2.
    static let followsDefault = "follows the system default"
    static let fullQuality = "full quality"
    static let narrowed = "narrowed"
    static func kHz(_ hz: Double) -> String { "\(Int((hz / 1000).rounded())) kHz" }
    static let routeDot = "·"
    static let routeJoiner = " · "
    /// The hover card's foot keys and route words.
    static let uidKey = "uid"
    static let routeKey = "route"
    static let rungKey = "rung"
    static let duckKey = "ducking"
    /// The unit's `AUVoiceIOOtherAudioDuckingLevel` as a word; nil (unit off) is `none`.
    static func duckWord(_ level: Double?) -> String {
        guard let level else { return "none" }
        switch level {
        case 0: return "default"
        case 10: return "min"
        case 20: return "mid"
        case 30: return "max"
        default: return "\(Int(level))"
        }
    }
    static let rateKey = "rate"
    static let ranked = "ranked"
    static let explicit = "explicit"
    static let defaultOutput = "default output"
    static let recordingBadge = ConsoleDisclosureWords.recording
    static let retentionHint = "Older days move to the trash, never out of it. Pinned conversations keep their days."
    static let trashHint = "Nothing is deleted here; the trash is emptied in Finder."
    static let anyoneWakes = "Anyone who says the word wakes it."
    static let phrasesHint = "Any of these wakes it; comma-separated"
    static let notchHint = "Lives in the notch; floats free when the main display has none."
    static let freeHint = "Floats free; stays where it last worked."
    // tips (verb first, ≤ 60, no full stop)
    static let languageTip = "Speaks English whatever language it hears"
    static let accentTip = "How the English sounds — best-effort on the voice's side"
    static let switchNowTip = "Pause, then resume on the new voice — refused while work runs"
    static let notchTip = "The orb lives and sleeps in the notch"
    static let freeTip = "The orb floats free and stays where it last worked"
    static let learnNowTip = "Read what has not been read yet, now"
    static let memoryIsOff = "Memory is off"
    static let pendingTip = "Conversations that ended and are not read yet"
    static let sweepTip = "Move the days past retention to the trash — asks first"
    static let sweepNothing = "Both keep forever — nothing would move"
    static let sweepGoTip = "Move them now — each comes back with Restore"
    static let keepAll = "Keep everything where it is"
    static let cancelSweep = "Cancel the sweep"
    static let ledgerTip = "Days a day's conversations stay before the sweep"
    static let shotsTip = "Days a day's screenshots stay before the sweep"
    static let revealTrashTip = "Show the trash in Finder — emptying it happens there"
    static let noTrash = "No trash folder yet"
    static let setUpAgainTip = "Open the setup wizard"
    static let noKeyTip = "No OpenAI key"
    static let uncheckedTip = "Not checked yet"
    static func keyWorks(_ model: String) -> String { "Works with \(model)" }
    static let keyRejected = "Rejected by OpenAI — paste a fresh one"
    static let nothingHeard = "Nothing heard yet"
    // mic
    static let micAuto = "Auto"
    static let micAutoGroup = "Auto"
    static let micRanked = "Ranked"
    static let micConnected = "Connected"
    static let micRankedBadge = "ranked"
    static let micActive = "active"
    static let micVirtual = "virtual"
    static let micGone = "gone"
    static let micUnavailable = "Unavailable"
    static let micNoun = "microphones"
    static let micFoot = "Ranks the connected microphones: the pick, the built-in, the one used last, the system default"
    static func using(_ name: String) -> String { "Using \(name)" }
    static let systemDefault = "system default (echo cancellation)"
    static func echoFollows(active: String, wanted: String) -> String {
        "Using \(active). Echo cancellation follows the system default; make \(wanted) the default in Sound settings to use it."
    }
    // matching
    static let matchOpenAI = "Item text goes to OpenAI for matching (the voice key); nothing else leaves"
    static func matchLocal(_ model: String) -> String { "Item text goes to \(model) on this Mac; nothing leaves for memory" }
    static let matchLocalUnnamed = "Item text goes to a model on this Mac; nothing leaves for memory"
    static let matchKeyword = "Keyword matching: nothing leaves the Mac. Add the OpenAI key or pull an embedding model for closer matches."
    // a11y
    static let modelId = "Model id"
    static let serverURL = "Server base URL"
    static let localServerRoot = "Local server root"
    static let wakePhrasesLabel = "Wake phrases, comma separated"
    static let wakePassphraseLabel = "Wake passphrase"
    static let autoWakeLabel = "Auto-wake on launch"
    static let rememberLabel = "Remember across sessions"
    static let recordingLabel = "Recording a demo: hand the mic back, guard the echo"
    static let idleLabel = "Idle sleep, minutes"
    static func orbHome(_ notch: Bool) -> String { "Orb home: \(notch ? SettingsWords.notch : SettingsWords.free)" }
    static func accentLabel(_ accent: String) -> String { "Accent: \(accent)" }
    static func languageLabel(_ language: String) -> String { "Language: \(language)" }
    static func retentionLabel(_ what: String, _ title: String) -> String { "\(what) retention: \(title)" }
    static func heardLabel(_ heard: String) -> String { "Heard: \(heard)" }
    static let panel = "Panel"
}

/// Builder B's name for the ids, kept as an alias so its lit sites read the same.
typealias SettingsMenuIds = SettingsWords

/// The Now tab and the rail's frame: the phase block, the sections, their fold ids, the rows' words.
enum NowWords {
    static let session = "Session"
    static let billed = "Billed"
    static let today = "Today"
    static let expires = "Expires"
    static let context = "Context"
    static let expiresIn = "in "
    static let noSession = "No session. Nothing billed."
    static let elapsed = "Elapsed"
    static let audio = "Audio"
    static let input = "Input"
    static let output = "Output"
    static let circled = "Circled"
    static let clear = "Clear"
    static let clearAll = "Clear all"
    static let circleSomething = "Circle something…"
    static let forgetCircles = "Forget the circled regions"
    static let forgetCircle = "Forget this circle"
    static let threads = "Threads"
    static func running(_ n: Int) -> String { "\(n) running" }
    static let stop = "Stop"
    static let memory = "Memory"
    static let usedThisTurn = "used this turn"
    static let usedTip = "The lines the brain was given for the last request"
    static let brain = "Brain"
    static let hands = "Hands"
    static let handsReady = "see + click"
    static let handsNeed = "needs permissions"
    static let ready = "ready"
    static let notReady = "not ready"
    static let local = "local"
    static let askAll = "Ask all"
    static let askAllTip = "Ask for every permission — one dialog at a time"
    static let request = "Request"
    static let openSettings = "Open"
    static let copy = "Copy"
    static let ask = "Ask"
    static let copyTip = "Copy the command — it runs by hand, never here"
    static func requestTip(_ label: String) -> String { "Ask for \(label.lowercased()) access" }
    static let openSettingsTip = "Open the System Settings pane"
    static let openSettingsDragTip = "Open the System Settings pane — drag Jarhead.app in"
    static let none = "None."
    static let retry = "Retry"
    static func sends(_ type: String) -> String { "Sends \(type)" }
    static func opens(_ target: String) -> String { "Opens \(target)" }
    static let checkAgain = "Check this again"
    static let since = "since"
    /// A folded kind head shows this much of its first line.
    static let headLineMax = 26
    /// A granted area's head names this many; the rest is `+n`.
    static let namesShown = 2
    static func more(_ n: Int) -> String { "+\(n)" }
    static func engine(_ n: Int) -> String { "\(n) engine" }
    static let details = "Details"
    static let detailsTip = "Show the crash report in Finder"
    static let dismiss = "Dismiss the crash notice"
    static let relaunched = "relaunched"
    static let notRelaunched = "not relaunched — three crashes in ten minutes"
    static let loading = "Loading…"
    static let dot = " · "
    // fold ids (remembered)
    static let readyFold = "now.ready"
    static let permissionsFold = "now.permissions"
    static let sensesFold = "now.permissions.senses"
    static let handsFold = "now.permissions.hands"
    static let filesFold = "now.permissions.files"
    static let problemsFold = "now.problems"
    static let grantsFold = "now.problems.grants"
    static let engineFold = "now.problems.engine"
    // tip ids
    static let crashTip = "now.crash"
    static func threadTip(_ id: String) -> String { "now.thread.\(id)" }
    static func markTip(_ id: String) -> String { "now.mark.\(id)" }
    // a11y
    static func thread(_ name: String, _ status: String) -> String { "Thread \(name), \(status)" }
    static func openThread(_ name: String) -> String { "Open \(name)" }
    static func stopThread(_ name: String) -> String { "Stop \(name)" }
    static func problem(_ text: String, _ remedy: String) -> String { "Problem: \(text). \(remedy)" }
    static func granted(_ n: Int, of total: Int) -> String { "\(n) of \(total) permissions granted" }
}

/// The Ledger tab: the filter, the month heads, the day rows, the day's figures.
enum LedgerWords {
    static let days = "Days"
    static let filterDays = "Filter days"
    static let listId = "ledger.days"
    static func monthFold(_ id: String) -> String { "ledger.\(id)" }
    static let openFolder = "Open the ledger folder"
    static let openFolderLabel = "Open ledger folder"
    static let noLedger = "No ledger yet."
    static let reading = "Reading…"
    static let sessions = "Sessions"
    static let utterances = "Utterances"
    static let delegations = "Delegations"
    static let billed = "Billed"
    static let unread = "—"
    /// The filter appears past this many days.
    static let filterPast = 8
    static let filterLabel = "Filter the days"
}

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
    /// Jarhead's threads in the rail's order (AppState.orderedThreads, kept from events with the
    /// five-minute linger).
    var threads: [WorkThread] = []

    @EnvironmentObject private var session: ConsoleSession

    static func == (a: RightRail, b: RightRail) -> Bool {
        a.snapshot == b.snapshot && a.ledgerDays == b.ledgerDays && a.ledgerDay == b.ledgerDay
            && a.ledgerLoading == b.ledgerLoading && a.ledgerStats == b.ledgerStats && a.tab == b.tab
            && a.wake == b.wake && a.threads == b.threads
    }

    var body: some View {
        VStack(spacing: 0) {
            ConsoleSegments(value: tab, options: Array(ConsoleSession.Tab.allCases), title: { $0.rawValue },
                            pick: { picked in session.select(picked) },
                            accessibilityLabel: SettingsWords.panel, size: .rail, id: "rail.tabs")
                .padding(.horizontal, railInset)
                .frame(height: 40)
            ConsoleHairline()
            CrashNoticeRow()
            // A ringing automation's line (AppState.ringing): the same slot, on every tab, until Done.
            AutomationRingRow()
            ScrollView(.vertical) {
                // The three panels switch behind the curtain (Motion.curtain) as the tab's thumb
                // glides: the panel swaps at once and the ground-coloured cells over it go rank
                // by rank. (A masked wipe here cost the main thread 0.5 s a switch — measured.)
                ZStack(alignment: .top) {
                    switch tab {
                    case .now:
                        NowPanel(phase: snapshot.phase, sessionInfo: snapshot.session, pause: snapshot.pause, usageToday: snapshot.usageToday,
                                 permissions: snapshot.permissions,
                                 problems: snapshot.problems, brainReady: snapshot.brainReady, handsReady: snapshot.handsReady,
                                 settings: snapshot.settings, setup: snapshot.setup, marks: snapshot.marks,
                                 memory: snapshot.memory, threads: threads,
                                 openThread: { [session] id in withAnimation(Motion.wipeAnimation) { session.openThread(id) } })
                            .transition(.identity)
                    case .settings:
                        SettingsPanel(settings: snapshot.settings, setup: snapshot.setup, phase: snapshot.phase, gate: wake, trash: snapshot.trash,
                                      sessionInfo: snapshot.session, memory: snapshot.memory)
                            .transition(.identity)
                    case .ledger:
                        LedgerPanel(days: ledgerDays, picked: ledgerDay, loading: ledgerLoading, stats: ledgerStats)
                            .transition(.identity)
                    }
                    Color.clear
                        .allowsHitTesting(false)
                        .id(tab)
                        .transition(Motion.curtain(ConsoleTheme.ground))
                }
                .frame(maxWidth: .infinity)
                .animation(Motion.wipeAnimation, value: tab)
                .thinScrollers()
            }
        }
    }
}

/// The previous run's crash (AppState.lastCrash, set from the crash guard's report at
/// launch): one 28pt line under the tabs, on every tab, until dismissed — when, why,
/// Details (the report in Finder), ×. Reads AppState itself, like AudioMeters, so the
/// rail's Equatable inputs stay as they are; the row owns its bottom rule.
struct CrashNoticeRow: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ZStack(alignment: .top) {
            if let crash = state.lastCrash {
                VStack(spacing: 0) {
                    HStack(spacing: iconGap) {
                        ConsoleIcon(name: "exclamationmark.triangle.fill", tint: ConsoleTheme.error)
                        // "2 min ago" ticks; the reason is one line, the tooltip has it whole.
                        TimelineView(.periodic(from: .now, by: 30)) { ctx in
                            Text(crash.line(now: ctx.date))
                                .font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
                                .lineLimit(1).truncationMode(.tail)
                        }
                        Spacer(minLength: 4)
                        Button(NowWords.details) { state.revealCrash() }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                            .consoleHelp(NowWords.detailsTip)
                        Button { withAnimation(Motion.gentle) { state.dismissCrash() } } label: {
                            Image(systemName: ConsoleGlyph.dismiss).font(.system(size: 14, weight: .semibold))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 22))
                        .accessibilityLabel(NowWords.dismiss)
                    }
                    .padding(.horizontal, railInset)
                    .frame(height: 28)
                    // The reason whole, the report's path and whether the guard relaunched: one card.
                    .consoleHelp(id: NowWords.crashTip, card: CrashNoticeRow.card(crash))
                    ConsoleHairline()
                }
                .transition(Motion.appear)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(Motion.gentle, value: state.lastCrash == nil)
    }

    /// `Crashed · 2 min ago / the reason / report <path>` — the guard's word as the status when it relaunched.
    static func card(_ crash: CrashNotice) -> ConsoleTipCard {
        var card = ConsoleTipCard.crash(reason: crash.reason, at: CrashNotice.ago(crash.at), report: crash.fileURL.path)
        card.lines.append(crash.relaunched ? NowWords.relaunched : NowWords.notRelaunched)
        return card
    }
}


/// A section: head, content, and the section's own bottom rule. Shared with the Local brain's
/// "Leaves the Mac" section (LocalBrainRows.swift), so it is not private to this file.
struct RailSection<Trailing: View, Content: View>: View {
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

extension KV where V == MonoFigure {
    init(_ key: String, _ mono: String) {
        self.init(key) { MonoFigure(mono) }
    }
}

private func monoValue(_ s: String) -> Text {
    Text(s).font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg2)
}

/// A mono figure whose digits roll as it changes (the meter, the counts): `monoValue`
/// with a numeric content transition under Motion.snappy.
private struct MonoFigure: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        monoValue(text)
            .contentTransition(ConsoleMotion.numeric)
            .animation(Motion.snappy, value: text)
    }
}

private struct Reading: View {
    let text: String
    var body: some View {
        HStack(spacing: 8) {
            ConsoleGlyphs(cols: 8, rows: 1)
            Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
        }
        .frame(height: 24)
    }
}

// MARK: - Now

struct NowPanel: View {
    let phase: Phase
    let sessionInfo: SessionInfo?
    /// While paused: the session the pause closed and when it decays to sleep (Snapshot.pause).
    let pause: PauseInfo?
    /// Today's billed total, for the meter (Snapshot.usageToday); hidden when nothing was billed.
    let usageToday: UsageToday?
    let permissions: Permissions
    /// The problems with their kind and remedy (Snapshot.problems), newest last.
    let problems: [Problem]
    let brainReady: Bool
    let handsReady: Bool
    /// The brain setting and its model (Snapshot.settings), for the Ready row's detail.
    let settings: Settings
    /// The last probe (Snapshot.setup): what `auto` or a fallback resolved to, the local server's pick.
    let setup: SetupStatus
    /// What Kevin circled (Snapshot.marks); context for the next delegation.
    let marks: [ScreenMark]
    /// What Jarhead remembers (Snapshot.memory); `lastUsedIds` is what the last delegation was given.
    var memory: MemorySummary? = nil
    /// Jarhead's threads in the rail's order; [] draws no section.
    var threads: [WorkThread] = []
    /// A thread row's click: open its pane (ConsoleSession.openThread, filled in by the rail).
    var openThread: (String) -> Void = { _ in }

    @Environment(\.consoleActions) private var actions

    /// The Threads section is drawn: the engine lists at least one thread.
    private var showsThreads: Bool { !threads.isEmpty }

    /// The ids the last delegation's memory block carried, while memory is on; [] hides the section.
    private var usedIds: [String] { NowPanel.usedIds(memory) }

    /// Memory off hides the section even when a summary still names ids (the store stays, the
    /// switch says nothing is used — so the rail must not claim something was); no summary, nothing.
    static func usedIds(_ memory: MemorySummary?) -> [String] {
        guard let memory, memory.enabled else { return [] }
        return memory.lastUsedIds ?? []
    }

    /// The Ready row's detail for the brain. Under `local` it is the model that runs: the saved
    /// id, or the engine's best-fit pick while the id is empty — and when the local brain could
    /// not start, the kind the engine fell back to (`openai-responses`), so a paid fallback is
    /// never quiet. Every other kind names itself.
    static func readyBrainDetail(brain: BrainKind, brainModel: String, setup: SetupStatus) -> String {
        guard brain == .local else { return brain.rawValue }
        if setup.brainResolved == .local {
            if !brainModel.isEmpty { return brainModel }
            if let picked = setup.local.picked, !picked.isEmpty { return picked }
            return "local"
        }
        if let resolved = setup.brainResolved { return resolved.rawValue }
        return "local"
    }

    private var readyBrainDetail: String { NowPanel.readyBrainDetail(brain: settings.brain, brainModel: settings.brainModel, setup: setup) }

    /// The command Kevin runs himself (`remedy.copy`), when the engine named one — the Problems
    /// row offers it as a Copy chip; nil draws no chip.
    static func problemCopy(_ problem: Problem) -> String? {
        guard let copy = problem.remedy?.copy, !copy.isEmpty else { return nil }
        return copy
    }

    /// Which of the three meter blocks is up; a change crossfades them (Motion.swap).
    private var meterKey: String {
        if sessionInfo != nil { return "session" }
        if phase == .paused, pause != nil { return "paused" }
        return "asleep"
    }

    /// How many of the two Ready rows are not ready (the folded head's badge; the fold opens itself on one).
    private var notReady: Int { (brainReady ? 0 : 1) + (handsReady ? 0 : 1) }

    var body: some View {
        VStack(spacing: 0) {
            NowPhaseBlock(phase: phase, sessionInfo: sessionInfo, pause: pause, usageToday: usageToday, meterKey: meterKey)
            ConsoleHairline()

            RailSection(NowWords.audio) { AudioMeters() }
            circled
            // What Kevin set to fire while asleep (AppState.automations): between Circled and Threads,
            // both "what Jarhead is holding for you".
            AutomationsSection()
            if !threads.isEmpty { threadsSection.transition(Motion.appear) }
            // What the last delegation was given from Jarhead's memory of Kevin — the rows, not
            // the counts — so a misheard "fact" steering the voice is seen the turn it happens.
            // The section arrives with the first turn that used memory and leaves with a fresh session.
            if !usedIds.isEmpty {
                RailSection(NowWords.memory, count: usedIds.count, trailing: {
                    Text(NowWords.usedThisTurn).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                        .consoleHelp(NowWords.usedTip)
                }) {
                    MemoryUsedList(ids: usedIds)
                }
                .transition(Motion.appear)
            }
            ready
            PermissionsRailList(permissions: permissions)
            ProblemsRailList(problems: problems, remedy: remedy)
        }
        // The Threads and Memory sections arriving or leaving reflow the panel under them.
        .animation(Motion.gentle, value: showsThreads)
        .animation(Motion.gentle, value: usedIds.isEmpty)
    }

    // MARK: sections

    /// What Kevin circled on screen, newest last, and the way to circle more. A mark
    /// arriving fades and rises in; the row reflows around it.
    private var circled: some View {
        RailSection(NowWords.circled, count: marks.isEmpty ? nil : marks.count, trailing: {
            if !marks.isEmpty {
                Button(NowWords.clear) { actions.send(.markClear) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .consoleHelp(NowWords.forgetCircles)
                    .transition(.opacity)
            }
        }) {
            VStack(alignment: .leading, spacing: 8) {
                if !marks.isEmpty {
                    ConsoleFlow(hSpacing: 6, vSpacing: 6) {
                        ForEach(marks) { mark in
                            MarkThumb(mark: mark).transition(Motion.appear)
                        }
                    }
                    .padding(.top, 2)
                }
                Button { actions.beginMarkMode() } label: { Label(NowWords.circleSomething, systemImage: ConsoleGlyph.circle) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                    .consoleHelp(HelpCopy.circle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .animation(Motion.gentle, value: marks.map(\.id))
    }

    /// Jarhead's threads, one 40 pt row each: the status glyph, the name (a click opens its
    /// pane) with the `asks` badge, the status word and `00:12 · background · 7 steps` in mono
    /// under it, Stop drawn at rest while it is live. The section arrives with the first thread
    /// and keeps a finished one five minutes; a row rises in and drops out on its own ink.
    private var threadsSection: some View {
        RailSection(NowWords.threads, count: threads.count, inset: false, trailing: {
            let busy = threads.filter { $0.status.isBusy }.count
            if busy > 0 {
                Text(NowWords.running(busy)).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                    .contentTransition(ConsoleMotion.numeric)
                    .transition(.opacity)
            }
        }) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(threads) { t in
                    ThreadRailRow(thread: t, open: { openThread(t.id) }, stop: { actions.send(.threadStop(threadId: t.id)) })
                        .transition(Motion.appear)
                }
            }
            .animation(Motion.gentle, value: threads.map(\.id))
        }
    }

    /// Ready, folded: `Ready 2 · [all ok]`; it opens itself when a part stops being ready.
    private var ready: some View {
        ConsoleDisclosure(id: NowWords.readyFold, title: ConsoleDisclosureWords.ready, count: "2",
                          summary: ConsoleDisclosureSummary.ready(notReady: notReady), size: .section, defaultOpen: notReady > 0, inset: true) {
            VStack(spacing: 0) {
                readyRow("brain.fill", NowWords.brain, brainReady, readyBrainDetail)
                readyRow("hand.raised.fill", NowWords.hands, handsReady, handsReady ? NowWords.handsReady : NowWords.handsNeed)
            }
        }
        .onChange(of: notReady) { if notReady > 0 { ConsoleFoldStore.set(NowWords.readyFold, true) } }
    }

    /// The remedy button: its command when the engine gave one the Console can send, its
    /// URL or path when it named a place, else `problem.retry` for the kind — the engine
    /// re-checks and clears the line when it is fixed.
    private func remedy(_ p: Problem) {
        if let json = p.remedy?.command, let cmd = EngineCommand(remedyJSON: json) {
            actions.send(cmd)
        } else if let target = p.remedy?.open, !target.isEmpty {
            actions.open(target)
        } else {
            actions.send(.problemRetry(kind: p.kind))
        }
    }

    /// The glyph swaps (ConsoleIcon) and the detail crossfades as a part comes ready; the state
    /// word is the glyph's label, spoken — nothing hides in a hover.
    private func readyRow(_ symbol: String, _ name: String, _ ok: Bool, _ detail: String) -> some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol)
            Text(name).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
            Text(detail).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1).truncationMode(.tail)
                .contentTransition(.opacity)
                .animation(Motion.fade, value: detail)
            Spacer(minLength: 4)
            ConsoleIcon(name: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill", tint: ok ? ConsoleTheme.acting : ConsoleTheme.speaking)
                .accessibilityLabel(ok ? NowWords.ready : NowWords.notReady)
        }
        .frame(height: 28)
    }
}

/// The phase block: the dot and the word, the elapsed clock, and the meter — a session open:
/// what this one has billed and today's total; paused: the session is closed, the conversation
/// kept, the pause decaying to sleep (the line ticks); asleep: today's total, when there is one.
/// The three blocks crossfade; every figure rolls. The session id is whole (182 pt holds it).
private struct NowPhaseBlock: View {
    let phase: Phase
    let sessionInfo: SessionInfo?
    let pause: PauseInfo?
    let usageToday: UsageToday?
    let meterKey: String

    var body: some View {
        let meta = ConsoleTheme.phase(phase)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: iconGap) {
                ConsoleDot(color: meta.color, live: ConsoleTheme.livePhases.contains(phase), size: 8)
                    .frame(width: 20, height: 20)
                Text(meta.label).font(ConsoleTheme.sans(15, .medium)).foregroundStyle(ConsoleTheme.fg)
                    .contentTransition(.opacity)
                    .animation(Motion.fade, value: phase)
                Spacer(minLength: 8)
                if let s = sessionInfo { NowElapsed(startedAt: s.startedAt).transition(.opacity) }
            }
            .frame(height: 28)
            .consoleHelp(meta.hint)
            .animation(Motion.fade, value: sessionInfo == nil)
            ZStack(alignment: .topLeading) {
                if let s = sessionInfo {
                    NowSessionMeter(session: s, usageToday: usageToday).transition(Motion.swap)
                } else if phase == .paused, let p = pause {
                    NowPausedMeter(pause: p, usageToday: usageToday).transition(Motion.swap)
                } else {
                    NowAsleepMeter(usageToday: usageToday).transition(Motion.swap)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(Motion.gentle, value: meterKey)
        }
        .padding(EdgeInsets(top: 6, leading: railInset, bottom: 10, trailing: railInset))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// mm:ss, the seconds rolling.
private struct NowElapsed: View {
    let startedAt: Double
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let elapsed = ConsoleFormat.duration((ctx.date.timeIntervalSince1970 * 1000 - startedAt) / 1000)
            Text(elapsed)
                .font(ConsoleTheme.mono(13)).monospacedDigit().foregroundStyle(ConsoleTheme.fg2)
                .contentTransition(ConsoleMotion.numeric)
                .animation(Motion.snappy, value: elapsed)
        }
        .consoleHelp(NowWords.elapsed)
        .accessibilityLabel(NowWords.elapsed)
    }
}

private struct NowSessionMeter: View {
    let session: SessionInfo
    let usageToday: UsageToday?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            KV(NowWords.session) { monoValue(session.id).lineLimit(1).truncationMode(.middle) }
            KV(NowWords.billed, ConsoleFormat.billed(session.usageSeconds))
            if let today = usageToday, today.seconds > 0 { KV(NowWords.today, ConsoleFormat.billed(today.seconds)) }
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                KV(NowWords.expires, NowWords.expiresIn + ConsoleFormat.duration(max(0, (session.expiresAt - ctx.date.timeIntervalSince1970 * 1000) / 1000)))
            }
            if let ratio = session.contextRatio {
                KV(NowWords.context) {
                    HStack(spacing: 8) {
                        ConsoleBar(fraction: ratio).animation(Motion.gentle, value: ratio)
                        Text("\(Int((ratio * 100).rounded()))%")
                            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                            .contentTransition(ConsoleMotion.numeric)
                            .animation(Motion.snappy, value: ratio)
                    }
                }
            }
        }
        .padding(.leading, 20 + iconGap)
    }
}

private struct NowPausedMeter: View {
    let pause: PauseInfo
    let usageToday: UsageToday?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let line = ConsoleFormat.pausedLine(pause, now: ctx.date)
                Text(line)
                    .font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                    .lineLimit(3).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 22, alignment: .leading)
                    .padding(.bottom, 2)
                    .contentTransition(ConsoleMotion.numeric)
                    .animation(Motion.snappy, value: line)
            }
            KV(NowWords.session) { monoValue(pause.sessionId).lineLimit(1).truncationMode(.middle) }
            KV(NowWords.billed, ConsoleFormat.billed(pause.usageSeconds))
            if let today = usageToday, today.seconds > 0 { KV(NowWords.today, ConsoleFormat.billed(today.seconds)) }
        }
        .padding(.leading, 20 + iconGap)
    }
}

private struct NowAsleepMeter: View {
    let usageToday: UsageToday?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(NowWords.noSession).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).frame(height: 22)
            if let today = usageToday, today.seconds > 0 { KV(NowWords.today, ConsoleFormat.billed(today.seconds)) }
        }
        .padding(.leading, 20 + iconGap)
    }
}

/// The Problems section, folded: `Problems 2 · [1 missing] 1 engine` — Kevin's grants apart from
/// the engine's, each kind a group whose closed head carries its first line. A row is 40:
/// the kind's solid symbol (a missing grant in the warning tint, the rest in red), the line on
/// up to two lines, `since 10:08 · Request` in mono under it, and the remedy as the row's ghost
/// verb — "Open pane", "Request", "Retry", "Restart daemon", or a plain "Retry" when the engine
/// named none. A remedy that carries a command for Kevin to run (`remedy.copy`: `ollama pull …`)
/// gets a Copy in the trailing zone — the app never runs it. Newest first.
struct ProblemsRailList: View {
    let problems: [Problem]
    let remedy: (Problem) -> Void

    @Environment(\.consoleActions) private var actions

    /// A problem about one of Kevin's grants (`permission.*`); everything else is the engine's.
    static func isGrant(_ p: Problem) -> Bool { p.kind.hasPrefix("permission.") }

    /// The folded head's words: `[n missing]` for the grants (amber), `n engine` for the rest.
    static func summary(_ problems: [Problem]) -> [ConsoleDisclosureSummaryItem] {
        let grants = problems.filter(isGrant).count
        let engine = problems.count - grants
        var out: [ConsoleDisclosureSummaryItem] = []
        if grants > 0 { out.append(.badge(.missing(grants))) }
        if engine > 0 { out.append(.words(NowWords.engine(engine))) }
        return out
    }

    /// `since 10:08 · Request` — when it was first seen and the remedy's word.
    static func meta(_ p: Problem) -> String {
        [NowWords.since + " " + ConsoleFormat.time(p.since), p.remedy?.label ?? NowWords.retry].joined(separator: NowWords.dot)
    }

    /// The remedy's tip: what it sends, what it opens, or the re-check.
    static func remedyTip(_ p: Problem) -> String {
        if let json = p.remedy?.command, case .string(let type)? = json["type"] { return NowWords.sends(type) }
        if let target = p.remedy?.open, !target.isEmpty { return NowWords.opens(ConsoleFormat.truncPath(target, max: 40)) }
        return NowWords.checkAgain
    }

    private var grants: [Problem] { problems.reversed().filter(Self.isGrant) }
    private var engine: [Problem] { problems.reversed().filter { !Self.isGrant($0) } }

    var body: some View {
        ConsoleDisclosure(id: NowWords.problemsFold, title: ConsoleDisclosureWords.problems, count: problems.isEmpty ? nil : "\(problems.count)",
                          summary: Self.summary(problems), size: .section, trailing: clearAll) {
            if problems.isEmpty {
                Text(NowWords.none).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).frame(height: 22).padding(.horizontal, railInset)
                    .transition(.opacity)
            } else {
                VStack(spacing: 0) {
                    group(NowWords.grantsFold, ConsoleDisclosureWords.grants, grants)
                    group(NowWords.engineFold, ConsoleDisclosureWords.engine, engine)
                }
                .transition(.opacity)
            }
        }
        .animation(Motion.gentle, value: problems.map(\.id))
    }

    private var clearAll: AnyView? {
        guard !problems.isEmpty else { return nil }
        return AnyView(Button(NowWords.clearAll) { actions.send(.clearProblems) }
            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
            .consoleHelp(NowWords.clearAll))
    }

    /// The folded kind head's line: the first problem, capped so the head's title keeps its width
    /// (`ConsoleDisclosureHead` gives the summary the priority; the row under it has the line whole).
    static func headLine(_ first: String?) -> String? {
        guard let first else { return nil }
        return first.count > NowWords.headLineMax ? String(first.prefix(NowWords.headLineMax)) + SettingsWords.ellipsis : first
    }

    /// A kind's group, open by default (a problem is what is wrong); an empty kind draws nothing.
    @ViewBuilder private func group(_ id: String, _ title: String, _ rows: [Problem]) -> some View {
        if !rows.isEmpty {
            ConsoleDisclosure(id: id, title: title, count: "\(rows.count)", summary: ConsoleDisclosureSummary.problemGroup(first: Self.headLine(rows.first?.text)),
                              size: .group, defaultOpen: true) {
                ForEach(rows) { p in ProblemRailRow(problem: p, act: { remedy(p) }).transition(Motion.appear) }
            }
        }
    }
}

/// One problem as a `ConsoleRow` 40 (see `ProblemsRailList`).
struct ProblemRailRow: View {
    let problem: Problem
    let act: () -> Void

    /// Copy in the trailing zone when the remedy carries a command for Kevin to run.
    static func copyVerb(_ copy: String?) -> ConsoleRow.Trailing {
        guard let copy else { return .none }
        return .verb(NowWords.copy, { CopyChip.copy(copy) })
    }

    /// The remedy as one word in the row's 58 pt verb slot: `Request` → `Ask`, else the label's
    /// first word (`Reveal shots` → `Reveal`); the meta line and the tip keep the label whole.
    static func verbWord(_ label: String?) -> String {
        guard let label, !label.isEmpty else { return NowWords.retry }
        if label == NowWords.request { return NowWords.ask }
        return String(label.split(separator: " ").first ?? Substring(label))
    }

    var body: some View {
        let look = ConsoleTheme.problem(problem.kind)
        let label = problem.remedy?.label ?? NowWords.retry
        ConsoleRow(title: problem.text, lines: 2, icon: .symbol(look.symbol, tint: look.tint), meta: ProblemsRailList.meta(problem),
                   trailing: Self.copyVerb(NowPanel.problemCopy(problem)),
                   verb: ConsoleRowVerb(title: Self.verbWord(label), help: label + NowWords.dot + ProblemsRailList.remedyTip(problem), run: act),
                   accessibilityHint: NowWords.problem(problem.text, label), primary: act)
    }
}

/// One thread as a `ConsoleRow` 40: the status glyph on the icon column; the name (the row opens
/// its pane) with the `asks` badge while it waits on Kevin; the status word and `00:03 · background
/// · 2 steps` in mono under them, the seconds rolling until it settles; Stop drawn at rest while
/// it is live. Stop sends `thread.stop` for this thread alone — never `transportStop`: the other
/// threads, the main brain and the meter carry on (for main it parks the turn). The brief is the
/// row's card (`ConsoleTipCard.thread`, the same card wherever the thread is hovered).
struct ThreadRailRow: View {
    let thread: WorkThread
    let open: () -> Void
    let stop: () -> Void

    private var meta: ConsoleTheme.ThreadMeta { ConsoleTheme.thread(thread.status) }
    private var isMain: Bool { thread.id == "main" }
    private var asks: Bool { thread.status == .waitingKevin }

    /// Line 1's word beside the name: the status, unless the `asks` badge says it.
    static func word(_ t: WorkThread) -> String? { t.status == .waitingKevin ? nil : ConsoleTheme.thread(t.status).label }

    /// Line 2: `00:03 · background · 2 steps`.
    static func line(_ t: WorkThread, now: Double) -> String { ConsoleFormat.threadMeta(t, now: now) }

    var body: some View {
        Group {
            if thread.status.isLive {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in row(now: ctx.date.timeIntervalSince1970 * 1000) }
            } else {
                row(now: thread.doneAt ?? thread.updatedAt)
            }
        }
        .animation(Motion.gentle, value: thread.status.isLive)
        .consoleHelp(id: NowWords.threadTip(thread.id), card: ConsoleTipCard.thread(thread))
    }

    private func row(now: Double) -> some View {
        ConsoleRow(title: thread.name, icon: .view(AnyView(ConsoleThreadGlyph(status: thread.status))), badge: asks ? .asks : nil,
                   value: Self.word(thread), meta: Self.line(thread, now: now), verb: stopVerb, sitsBack: !thread.status.isLive,
                   accessibilityHint: NowWords.thread(thread.name, meta.label), primary: open)
    }

    private var stopVerb: ConsoleRowVerb? {
        guard thread.status.isLive, thread.canStop else { return nil }
        let entry = isMain ? HelpCopy.stop : HelpCopy.stopThread(thread.name)
        return ConsoleRowVerb(title: NowWords.stop, help: HelpCopy.spoken(entry), run: stop)
    }
}

/// The Permissions section, folded: `Permissions 12 of 16 · [1 missing]` (or `[all ok]`); open,
/// three areas — Senses / Hands / Files — each a group whose closed head says what is missing
/// (`[1 missing] Input Monitoring`) or names what is granted. A row is 40: the kind's glyph, its
/// label, the *why* under it, Request or Settings as the row's verb while not granted, the
/// state glyph trailing. Both verbs go through `request-permission <kind>`, which the app answers
/// in-process; the sweep runs in the app too (`request-permission all`).
struct PermissionsRailList: View {
    let permissions: Permissions

    @Environment(\.consoleActions) private var actions

    enum Area: String, CaseIterable {
        case senses, hands, files

        var id: String {
            switch self {
            case .senses: return NowWords.sensesFold
            case .hands: return NowWords.handsFold
            case .files: return NowWords.filesFold
            }
        }

        var title: String {
            switch self {
            case .senses: return ConsoleDisclosureWords.senses
            case .hands: return ConsoleDisclosureWords.hands
            case .files: return ConsoleDisclosureWords.files
            }
        }
    }

    /// Which area a kind lives in: what Jarhead senses with, what its hands use, what it may read.
    static func area(_ kind: PermissionKind) -> Area {
        switch kind {
        case .microphone, .speechRecognition, .screenRecording, .camera, .notifications, .localNetwork: return .senses
        case .accessibility, .inputMonitoring, .automation: return .hands
        case .fullDiskAccess, .filesDesktop, .filesDocuments, .filesDownloads, .contacts, .calendars, .reminders: return .files
        }
    }

    /// The area's rows, in the engine's order.
    static func rows(_ all: [PermissionInfo], in area: Area) -> [PermissionInfo] { all.filter { Self.area($0.kind) == area } }

    /// `[1 missing] Input Monitoring` · `Desktop · Documents +5` — two granted names, the rest a count,
    /// so the head's title keeps its width.
    static func summary(_ rows: [PermissionInfo]) -> [ConsoleDisclosureSummaryItem] {
        let missing = rows.filter { $0.grant != .granted }.map(\.label)
        let granted = rows.filter { $0.grant == .granted }.map(\.label)
        var out = ConsoleDisclosureSummary.permissionGroup(missing: missing, granted: Array(granted.prefix(NowWords.namesShown)))
        if missing.isEmpty, granted.count > NowWords.namesShown { out.append(.mono(NowWords.more(granted.count - NowWords.namesShown))) }
        return out
    }

    /// The section's folded word: `[all ok]`, or `[n missing]`.
    static func headSummary(_ all: [PermissionInfo]) -> [ConsoleDisclosureSummaryItem] {
        let missing = all.filter { $0.grant != .granted }.count
        return missing > 0 ? [.badge(.missing(missing))] : [.badge(.allOk)]
    }

    private var all: [PermissionInfo] { permissions.all }
    private var granted: Int { all.filter { $0.grant == .granted }.count }

    var body: some View {
        ConsoleDisclosure(id: NowWords.permissionsFold, title: ConsoleDisclosureWords.permissions,
                          count: all.isEmpty ? nil : ConsoleDisclosureWords.ofTotal(granted, all.count),
                          summary: Self.headSummary(all), size: .section, trailing: askAll) {
            VStack(spacing: 0) {
                ForEach(Area.allCases, id: \.rawValue) { area in group(area) }
            }
        }
        .animation(Motion.gentle, value: permissions)
        .accessibilityLabel(NowWords.granted(granted, of: all.count))
    }

    private var askAll: AnyView {
        AnyView(Button(NowWords.askAll) { actions.send(.requestPermission("all")) }
            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
            .consoleHelp(NowWords.askAllTip))
    }

    @ViewBuilder private func group(_ area: Area) -> some View {
        let rows = Self.rows(all, in: area)
        if !rows.isEmpty {
            ConsoleDisclosure(id: area.id, title: area.title, count: ConsoleDisclosureWords.ofTotal(rows.filter { $0.grant == .granted }.count, rows.count),
                              summary: Self.summary(rows), size: .group) {
                ForEach(rows) { info in PermissionRailRow(info: info) { actions.send(.requestPermission(info.kind.rawValue)) } }
            }
        }
    }

    /// Solid SF Symbol per kind (the Setup step's table says the same; the Console preview
    /// compiles without the Permissions module, so the table lives here too).
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

/// One kind as a `ConsoleRow` 40: glyph · label / the why (and Automation's targets, a folder) ·
/// the verb while not granted · the state glyph.
struct PermissionRailRow: View {
    let info: PermissionInfo
    let request: () -> Void

    /// System Settings is the only way for these (or a denied one, Automation apart).
    static func opensSettings(_ info: PermissionInfo) -> Bool {
        info.ask == .settings || (info.grant == .denied && info.kind != .automation)
    }

    /// The why, then the detail, on one line under the label.
    static func meta(_ info: PermissionInfo) -> String? {
        let line = [info.why, info.detail ?? ""].filter { !$0.isEmpty }.joined(separator: NowWords.dot)
        return line.isEmpty ? nil : line
    }

    private var verb: ConsoleRowVerb? {
        guard info.grant != .granted else { return nil }
        if Self.opensSettings(info) {
            return ConsoleRowVerb(title: NowWords.openSettings, help: info.kind == .fullDiskAccess ? NowWords.openSettingsDragTip : NowWords.openSettingsTip, run: request)
        }
        return ConsoleRowVerb(title: NowWords.request, help: NowWords.requestTip(info.label), run: request)
    }

    var body: some View {
        let state = ConsoleTheme.grant(info.grant)
        ConsoleRow(title: info.label, icon: .symbol(PermissionsRailList.symbol(info.kind)), meta: Self.meta(info),
                   trailing: .glyph(state.symbol, state.color), verb: verb, accessibilityHint: state.label,
                   primary: { if info.grant != .granted { request() } })
            .animation(Motion.gentle, value: info.grant)
    }
}

/// One circled region (or captured window): the engine's crop of it, 80pt wide, in the frame
/// weight; a placeholder with the region's size while the crop is still on its way. Dimmed once
/// a delegation has used it. Click opens the full crop; hovering shows a × that forgets it
/// (`mark.remove`). The caption is `ComposerWords.markCaption` — the notch's tooltip reads the same.
private struct MarkThumb: View {
    let mark: ScreenMark

    @Environment(\.consoleActions) private var actions
    @Environment(\.colorScheme) private var scheme
    @EnvironmentObject private var session: ConsoleSession
    @State private var hovering = false

    /// Three across with 6pt gaps is 252pt: inside the section's 272 even while
    /// the panel's first layout still reserves a 15pt legacy scroller.
    private static let width: CGFloat = 80

    private var caption: String { ComposerWords.markCaption(mark, now: Date()) }

    /// The × at the top-right corner while hovering: this one mark leaves, the others stay.
    private var forgetButton: some View {
        Button { actions.send(.markRemove(id: mark.id)) } label: {
            Image(systemName: ConsoleGlyph.cross).font(.system(size: 9, weight: .bold)).foregroundStyle(ConsoleTheme.fg)
                .frame(width: 16, height: 16)
                .background(ConsoleTheme.ground.opacity(0.94))
                .overlay(Rectangle().stroke(ConsoleTheme.hairFrame, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .consoleHelp(NowWords.forgetCircle)
        .accessibilityLabel(NowWords.forgetCircle)
        .padding(2)
        .opacity(hovering ? 1 : 0)
        .animation(ConsoleMotion.hover, value: hovering)
    }

    /// The tier-3 preview: the crop whole under the caption, `time · size` from the file.
    @ViewBuilder private func preview(_ url: URL) -> some View {
        ConsoleTipPreview(title: caption, url: url, meta: ConsoleTipPreview.fileMeta(url))
    }

    var body: some View {
        Group {
            if let path = mark.screenshotPath, !path.isEmpty {
                let url = actions.screenshotURL(path)
                ScreenshotThumb(url: url, onTap: {
                    session.lightbox = ConsoleLightboxItem(url: url, caption: caption)
                }, width: Self.width)
                // The crop whole, the caption readable: a preview, not a hover line.
                .consoleHelp(id: NowWords.markTip(mark.id), spoken: caption) { preview(url) }
            } else {
                // No screenshot yet: the dithered skeleton (ground → raised) under the scope and the size.
                ZStack {
                    DitheredGradient(stops: scheme == .dark ? Dither.skeletonStopsDark : Dither.skeletonStopsLight,
                                     direction: .horizontal, bands: 2, cellPoints: 2)
                    VStack(spacing: 3) {
                        Image(systemName: "scope").font(.system(size: 12, weight: .medium)).foregroundStyle(ConsoleTheme.fg3)
                        Text("\(Int(mark.rect.w.rounded()))×\(Int(mark.rect.h.rounded()))")
                            .font(ConsoleTheme.mono(10)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                    }
                }
                .aspectRatio(max(0.6, min(2.2, mark.rect.h > 0 ? mark.rect.w / mark.rect.h : 1.6)), contentMode: .fit)
                .frame(width: Self.width)
                .overlay(Rectangle().stroke(ConsoleTheme.hairFrame, lineWidth: 1))
                .consoleHelp(caption)
            }
        }
        .opacity(mark.consumed ? 0.5 : 1)
        .animation(Motion.fade, value: mark.consumed)
        .overlay(alignment: .topTrailing) { forgetButton }
        .onHover { hovering = $0 }
        .accessibilityLabel(caption)
    }
}

/// The meter: the banded, cell-aligned `DitheredBar` — track one ground step, fill in the
/// second text step, the fill's leading edge falling through the Bayer thresholds over one
/// period. 6 pt (`DitheredBar.height`: four rows of 1.5 pt cells; 3 pt is rows 2).
struct ConsoleBar: View {
    let fraction: Double
    var body: some View {
        DitheredBar(fraction: fraction, fill: ConsoleTheme.fg2, track: ConsoleTheme.active)
    }
}

/// The only view in the Console that observes the high-frequency `levels`.
struct AudioMeters: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let l = state.levels
        VStack(spacing: 0) {
            meter("mic.fill", NowWords.input, l.input, ConsoleTheme.listening)
            meter("speaker.wave.2.fill", NowWords.output, l.output, ConsoleTheme.speaking)
        }
    }

    private func meter(_ symbol: String, _ label: String, _ value: Double, _ tint: Color) -> some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol, tint: tint).consoleHelp(label).accessibilityLabel(label)
            // One 20 Hz tick to the next (the fill steps per cell); still under reduce motion.
            ConsoleBar(fraction: value).animation(reduceMotion ? nil : .linear(duration: Motion.meter), value: value)
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

/// What the voice engine says about the microphones (Audio/AudioEngine.swift `MicRoute`,
/// posted as `jarhead.micRoute`; asked for with `jarhead.micRoute.request` when the panel
/// appears): the ranked order, the active one, what the choice follows. Plain strings, so
/// this file still compiles in the Console harness, which carries no audio code.
struct MicRouteInfo: Equatable {
    static let notificationName = Notification.Name("jarhead.micRoute")
    static let requestName = Notification.Name("jarhead.micRoute.request")

    /// Device UIDs, best first: the pick, the built-in, the one used last, the default, the rest; virtual last.
    var ranked: [String] = []
    var names: [String: String] = [:]
    var virtual: Set<String> = []
    var active = ""
    var systemDefault = ""
    /// "explicit" | "ranked" | "system default (echo cancellation)" | "off".
    var follows = ""
    /// Transport word per uid ("built-in", "bluetooth", …), in the ranked order.
    var transports: [String: String] = [:]
    // design12: the graph's read-back as plain values — the Hears / Speaks rows and the `Shared with` hint.
    /// What the graph listens to (empty while the graph is down) and its nominal rate in Hz (0 unknown).
    var hearsName = ""
    var hearsRate = 0.0
    /// `echo cancelled` | `echo guarded` | `no echo cancellation` | `off`.
    var hearsState = ""
    /// The default output and its rate — the hands-free tell.
    var speaksName = ""
    var speaksRate = 0.0
    /// `full quality` | `narrowed` | "".
    var speaksState = ""
    /// Other processes running input on the mic (bundle ids or `pid:<n>`); nil = the HAL cannot say (the key is absent).
    var shared: [String]? = nil
    /// `shared` as app names (`processName`), mapped once here when the notification lands — never in a view body.
    var sharedNames: [String] = []
    /// The ladder rung that came up (0 while stopped) and the unit's ducking level (nil while the unit is off).
    var rung = 0
    var duckLevel: Double? = nil
    var hearsUid = ""
    var speaksUid = ""

    init() {}

    init?(_ userInfo: [AnyHashable: Any]?) {
        guard let info = userInfo, let ids = info["ids"] as? [String], let names = info["names"] as? [String] else { return nil }
        ranked = ids
        for (i, id) in ids.enumerated() where i < names.count { self.names[id] = names[i] }
        let transportWords = info["transports"] as? [String] ?? []
        for (i, id) in ids.enumerated() where i < transportWords.count { transports[id] = transportWords[i] }
        virtual = Set(info["virtual"] as? [String] ?? [])
        active = info["active"] as? String ?? ""
        systemDefault = info["default"] as? String ?? ""
        follows = info["follows"] as? String ?? ""
        hearsName = info["hearsName"] as? String ?? ""
        hearsRate = (info["hearsRate"] as? NSNumber)?.doubleValue ?? 0
        hearsState = info["hearsState"] as? String ?? ""
        speaksName = info["speaksName"] as? String ?? ""
        speaksRate = (info["speaksRate"] as? NSNumber)?.doubleValue ?? 0
        speaksState = info["speaksState"] as? String ?? ""
        shared = info["shared"] as? [String]
        sharedNames = shared?.map(MicRouteInfo.processName) ?? []
        rung = (info["rung"] as? NSNumber)?.intValue ?? 0
        duckLevel = (info["duckLevel"] as? NSNumber)?.doubleValue
        hearsUid = info["hearsUid"] as? String ?? ""
        speaksUid = info["speaksUid"] as? String ?? ""
    }

    /// The graph has read itself back (the Hears / Speaks rows have something to say).
    var hasReadback: Bool { !hearsName.isEmpty }
    /// The route word for the card: `follows the system default` | `ranked` | `explicit` | the engine's own word.
    var routeWord: String {
        if follows.hasPrefix(SettingsWords.systemDefaultPrefix) { return SettingsWords.followsDefault }
        return follows
    }

    /// A bundle id → the running app's name (`NSRunningApplication`), `pid:<n>` → that process's; the id itself when
    /// nothing is running under it. The same mapping the app uses before the `audio-state` frame leaves. A process-table
    /// lookup: called once per route notification (`init?`), not per render.
    static func processName(_ id: String) -> String {
        if id.hasPrefix("pid:"), let pid = Int32(id.dropFirst(4)) {
            return NSRunningApplication(processIdentifier: pid)?.localizedName ?? id
        }
        return NSRunningApplication.runningApplications(withBundleIdentifier: id).first?.localizedName ?? id
    }
}

/// Settings as an index: seven closed heads that carry their summary (`Audio  Cedar · British` ·
/// `Brain  Local · qwen3.5:27b [Ready]` · `Leaves the Mac  2 cloud · 2 mac` · `Session  Notch ·
/// 10 min` · `Memory 7 [learned 12m]` · `Retention  forever · 30 d` · `Wake [off]`), the folds
/// remembered per id (`ConsoleFoldStore`), ⌥-click for one at a time. Every control is the kit's:
/// dropdowns lit per site, `On | Off` toggles with a hint, one stepper, `ConsoleField(.row)` for
/// the fields, `ConsoleSecretRow` for the keys and the passphrase.
struct SettingsPanel: View {
    let settings: Settings
    let setup: SetupStatus
    let phase: Phase
    let gate: WakeGateInputs
    /// What the trash holds (Snapshot.trash); nil from a daemon that has none.
    var trash: TrashInfo? = nil
    /// The open session, with the voice and accent it opened on (Snapshot.session): a pick
    /// that differs is heard at the next wake — or now, with Switch now.
    var sessionInfo: SessionInfo? = nil
    /// What Jarhead remembers (Snapshot.memory); nil from a daemon that has no memory.
    var memory: MemorySummary? = nil

    @Environment(\.consoleActions) private var actions
    @State private var mics: [MicDevice] = []
    /// The voice engine's ranking (empty until it has published once).
    @State private var route = MicRouteInfo()

    // Brain: the three fields go out as one patch, so the drafts are kept together.
    struct BrainDraft: Equatable {
        var kind: BrainKind
        var model: String
        var server: String
    }
    @State private var modelDraft = ""
    @State private var serverDraft = ""
    /// The last patch sent and not yet echoed by the daemon; a field's commit and its blur
    /// must not send the same patch twice.
    @State private var brainSent: BrainDraft?

    // Wake
    @State private var phrasesDraft = ""
    @State private var phrasesSent: [String]?
    /// "Sweep now" pressed once: the head asks before whole days move (they come back one at a
    /// time with Restore, but there is no Undo on the sweep itself). Lets go on its own.
    @State private var sweepArmed = false

    private func patch(_ p: SettingsPatch) { actions.send(.setSettings(p)) }

    private var brainSaved: BrainDraft {
        BrainDraft(kind: settings.brain, model: settings.brainModel, server: settings.brainBaseUrl ?? "")
    }

    /// The brain on screen: the pick just sent, until the daemon echoes it.
    private var kind: BrainKind { brainSent?.kind ?? settings.brain }

    private var wake: WakeSettings { settings.wake }

    private var voiceOptions: [String] {
        ConsoleTheme.voices + (ConsoleTheme.voices.contains(settings.voice) ? [] : [settings.voice])
    }

    /// A voice or accent picked while a session is open is not what that session speaks
    /// (`session.update` cannot change a voice): offer Switch now — pause, then resume on the
    /// new pick, Kevin's press only, never on the pick itself (browsing voices must not churn
    /// paid starts). Shown while awake and the pick differs from what the session opened on.
    /// Never while paused or connecting: the engine refuses both, and there is nothing to
    /// switch. Never when the session did not say its voice: a daemon from before
    /// SessionInfo.voice predates `voice.reopen` too, so the button would press nothing.
    static func needsSwitch(settings: Settings, session: SessionInfo?, phase: Phase) -> Bool {
        guard let session, AppState.inSessionPhases.contains(phase) else { return false }
        guard let voice = session.voice else { return false }
        return voice != settings.voice || (session.accent ?? settings.accent) != settings.accent
    }

    private var needsSwitch: Bool { Self.needsSwitch(settings: settings, session: sessionInfo, phase: phase) }

    private var effortOptions: [String] {
        ConsoleTheme.efforts + (ConsoleTheme.efforts.contains(settings.effort) ? [] : [settings.effort])
    }

    // MARK: mic (the dropdown's closures: Auto / Ranked / Connected, `active · virtual · gone`, the ranking foot)

    private var micSelection: String {
        guard let id = settings.micDeviceId, !id.isEmpty else { return "" }
        return id
    }

    /// Auto first, then the microphones in the voice engine's ranked order (the enumeration
    /// order until it has published), then a saved pick that is not connected.
    private var micOptions: [String] {
        var ids = [""] + (route.ranked.isEmpty ? mics.map(\.id) : route.ranked)
        for m in mics where !ids.contains(m.id) { ids.append(m.id) }
        let current = micSelection
        if !current.isEmpty, !ids.contains(current) { ids.append(current) }
        return ids
    }

    private func micName(_ id: String) -> String? {
        route.names[id] ?? mics.first(where: { $0.id == id })?.name
    }

    /// The row's title: `Auto`, the device's name, or `Unavailable · <id>` for a saved pick gone.
    private func micTitle(_ id: String) -> String {
        if id.isEmpty { return SettingsWords.micAuto }
        return micName(id) ?? (SettingsWords.micUnavailable + NowWords.dot + ConsoleFormat.shortId(id, 10))
    }

    /// `active` on the one in use, `virtual` on an aggregate, `gone` on a saved pick not connected.
    static func micBadges(id: String, active: String, virtual: Bool, connected: Bool) -> [ConsoleBadge.Word] {
        guard !id.isEmpty else { return [] }
        var out: [ConsoleBadge.Word] = []
        if id == active { out.append(.word(SettingsWords.micActive)) }
        if virtual { out.append(.word(SettingsWords.micVirtual)) }
        if !connected { out.append(.word(SettingsWords.micGone)) }
        return out
    }

    private func micBadges(_ id: String) -> [ConsoleBadge.Word] {
        Self.micBadges(id: id, active: route.active, virtual: route.virtual.contains(id), connected: micName(id) != nil)
    }

    /// Auto / Ranked (the engine's order) / Connected (found, not ranked yet) / Saved, not listed.
    static func micGroup(id: String, ranked: Bool, connected: Bool) -> String {
        if id.isEmpty { return SettingsWords.micAutoGroup }
        if ranked { return SettingsWords.micRanked }
        return connected ? SettingsWords.micConnected : ConsoleMenuWords.savedHead
    }

    private func micGroup(_ id: String) -> String {
        Self.micGroup(id: id, ranked: route.ranked.contains(id), connected: micName(id) != nil)
    }

    // MARK: the index

    var body: some View {
        VStack(spacing: 0) {
            audio
            brain
            LeavesSection(paths: setup.dataPaths)
            sessionSection
            AutomationsFold(settings: settings)
            memorySection
            retention
            wakeSection
            // The words do the work; the gear means System Settings elsewhere in this window.
            Button(SettingsWords.setUpAgain) { actions.openOnboarding() }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                .consoleHelp(SettingsWords.setUpAgainTip)
                .padding(EdgeInsets(top: 12, leading: railInset, bottom: 20, trailing: railInset))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear {
            mics = MicDevice.enumerate()
            // The voice engine answers with its ranked route (`jarhead.micRoute`).
            NotificationCenter.default.post(name: MicRouteInfo.requestName, object: nil)
            modelDraft = settings.brainModel
            serverDraft = settings.brainBaseUrl ?? ""
            phrasesDraft = wake.phrases.joined(separator: ", ")
        }
        // The daemon's echo: a draft that still says the old value follows; one mid-edit stays.
        .onChange(of: brainSaved) { old, new in
            brainSent = nil
            if modelDraft == old.model || modelDraft == brainSent?.model { modelDraft = new.model }
            if serverDraft == old.server { serverDraft = new.server }
        }
        .onChange(of: wake.phrases) { old, new in
            phrasesSent = nil
            if phrasesDraft == old.joined(separator: ", ") { phrasesDraft = new.joined(separator: ", ") }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("AVCaptureDeviceWasConnectedNotification"))) { _ in mics = MicDevice.enumerate() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("AVCaptureDeviceWasDisconnectedNotification"))) { _ in mics = MicDevice.enumerate() }
        .onReceive(NotificationCenter.default.publisher(for: MicRouteInfo.notificationName)) { note in
            if let r = MicRouteInfo(note.userInfo) { route = r }
        }
    }

    // MARK: Audio

    private var audio: some View {
        ConsoleDisclosure(id: SettingsWords.audioFold, title: ConsoleDisclosureWords.audio,
                          summary: ConsoleDisclosureSummary.audio(voice: VoiceWords.name(settings.voice), accent: ConsoleTheme.accentLabel(settings.accent),
                                                                  recording: settings.audioSettings.recording),
                          size: .section, siblings: SettingsWords.folds, inset: true) {
            VStack(spacing: 2) {
                // The kit's dropdown: the name alone (Language is its own row), Default / Also / All
                // voices, `default` on Ballad, a filter over the 22, a saved id outside the list kept.
                ConsoleFormRow(SettingsWords.voiceKeyLabel) {
                    ConsoleMenuField(value: settings.voice, options: voiceOptions, title: VoiceWords.name,
                                     pick: { patch(SettingsPatch(voice: $0)) },
                                     id: SettingsWords.voice, label: VoiceWords.label, fieldBadge: VoiceWords.fieldBadge, badge: VoiceWords.badges,
                                     detail: VoiceWords.detail, group: VoiceWords.group, filter: true, filterNoun: VoiceWords.noun)
                }
                // One language today: a value, not a menu with one row. The menu appears
                // when a second language exists (ConsoleTheme.languages).
                ConsoleFormRow(SettingsWords.language) {
                    Text(ConsoleTheme.languageLabel(settings.language))
                        .font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
                        .frame(height: 26)
                        .consoleHelp(SettingsWords.languageTip)
                        .accessibilityLabel(SettingsWords.languageLabel(ConsoleTheme.languageLabel(settings.language)))
                }
                ConsoleFormRow(SettingsWords.accent) {
                    ConsoleSegments(value: settings.accent, options: ConsoleTheme.accents.map(\.id), title: ConsoleTheme.accentLabel,
                                    pick: { patch(SettingsPatch(accent: $0)) },
                                    accessibilityLabel: SettingsWords.accentLabel(ConsoleTheme.accentLabel(settings.accent)), size: .row)
                        .consoleHelp(SettingsWords.accentTip)
                }
                switchNow
                ConsoleFormRow(SettingsWords.micLabel) {
                    ConsoleMenuField(value: micSelection, options: micOptions, title: micTitle,
                                     pick: { patch(SettingsPatch(micDeviceId: .some($0.isEmpty ? nil : $0))) },
                                     id: SettingsWords.mic, label: SettingsWords.micLabel,
                                     fieldBadge: { $0.isEmpty ? .word(SettingsWords.micRankedBadge) : nil }, badge: micBadges,
                                     group: micGroup, foot: { $0.isEmpty ? SettingsWords.micFoot : nil }, filterNoun: SettingsWords.micNoun)
                }
                routeRows
                recordingRows
            }
        }
    }

    // MARK: Audio · the route (design12)

    /// Hears / Speaks: the graph's own figures, only once it has read itself back; then the one sentence the
    /// old mic hint was written for (echo cancellation follows the system default and the ranking disagrees),
    /// and `Shared with …` while another process reads the mic.
    @ViewBuilder private var routeRows: some View {
        if route.hasReadback {
            ConsoleFormRow(SettingsWords.hears, height: 40) {
                ConsoleRouteValue(line: hearsLine, id: SettingsWords.hearsRow, card: hearsCard)
            }
            if !route.speaksName.isEmpty {
                ConsoleFormRow(SettingsWords.speaks, height: 40) {
                    ConsoleRouteValue(line: speaksLine, id: SettingsWords.speaksRow, card: speaksCard)
                }
            }
        }
        if let echoHint { hint(echoHint) }
        if let sharedHint { hint(sharedHint).transition(Motion.appear) }
    }

    /// The Recording toggle (the whole audio block through `set-settings`; the snapshot's echo flips the cells)
    /// and, while On, what it means — the `memoryOff` idiom.
    @ViewBuilder private var recordingRows: some View {
        ConsoleFormRow(SettingsWords.recordingRow) {
            ConsoleToggle(on: settings.audioSettings.recording, hint: SettingsWords.recordingHint, id: SettingsWords.recording,
                          accessibilityLabel: SettingsWords.recordingLabel) { on in
                var a = settings.audioSettings
                a.recording = on
                var p = SettingsPatch()
                p.setAudio(a)
                patch(p)
            }
        }
        if settings.audioSettings.recording { hint(SettingsWords.recordingOn).transition(Motion.appear) }
    }

    private var hearsLine: ConsoleRouteLine { ConsoleRouteLine.from(name: route.hearsName, rate: route.hearsRate, state: route.hearsState) }
    private var speaksLine: ConsoleRouteLine { ConsoleRouteLine.from(name: route.speaksName, rate: route.speaksRate, state: route.speaksState) }

    /// The tier-2 card: the device's name, the state word, `uid` and `route · transport · rate` in the foot.
    private var hearsCard: ConsoleTipCard {
        let uid = route.active
        let routeLine = [route.routeWord, route.transports[uid] ?? "", hearsLine.figures].filter { !$0.isEmpty }.joined(separator: SettingsWords.routeJoiner)
        var foot: [(String, String)] = []
        if !uid.isEmpty { foot.append((SettingsWords.uidKey, uid)) }
        foot.append((SettingsWords.routeKey, routeLine))
        if route.rung > 0 { foot.append((SettingsWords.rungKey, "\(route.rung)")) }
        foot.append((SettingsWords.duckKey, SettingsWords.duckWord(route.duckLevel)))
        return ConsoleTipCard(title: route.hearsName, status: route.hearsState, foot: foot)
    }

    private var speaksCard: ConsoleTipCard {
        let routeLine = [SettingsWords.defaultOutput, speaksLine.figures].filter { !$0.isEmpty }.joined(separator: SettingsWords.routeJoiner)
        return ConsoleTipCard(title: route.speaksName, status: route.speaksState, foot: [(SettingsWords.routeKey, routeLine)])
    }

    /// `echoFollows`, only in the case it was written for: echo cancellation is on (so the unit follows the
    /// system default) and the microphone Kevin wants — his pick, else the ranking's first — is another one.
    private var echoHint: String? {
        guard route.hasReadback, route.hearsState == SettingsWords.echoCancelled, !route.active.isEmpty else { return nil }
        let wantedId = micSelection.isEmpty ? (route.ranked.first ?? "") : micSelection
        guard !wantedId.isEmpty, wantedId != route.active, let wanted = micName(wantedId) else { return nil }
        return SettingsWords.echoFollows(active: micName(route.active) ?? route.hearsName, wanted: wanted)
    }

    /// `Shared with QuickTime Player.` from the HAL's process list (names mapped when the route landed); nothing while nobody shares.
    private var sharedHint: String? {
        guard !route.sharedNames.isEmpty else { return nil }
        return SettingsWords.sharedWith(route.sharedNames)
    }

    /// The promise, and when a pick lands. Switch now closes the session and reopens it on the
    /// new voice (one paid start); it rises in only while a pick is waiting and a session is open.
    private var switchNow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            hint(ConsoleTheme.languageHint)
            if needsSwitch {
                Button(SettingsWords.switchNow) { actions.send(.voiceReopen) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .layoutPriority(1)
                    .consoleHelp(SettingsWords.switchNowTip)
                    .transition(Motion.appear)
            }
        }
        .animation(Motion.gentle, value: needsSwitch)
    }

    // MARK: Brain

    /// The folded head's model word: under Local the id that runs (the saved id, else the engine's pick).
    static func brainModelWord(kind: BrainKind, model: String, local: LocalServerStatus) -> String? {
        if kind == .local, model.isEmpty { return local.picked.flatMap { $0.isEmpty ? nil : $0 } }
        return model.isEmpty ? nil : model
    }

    /// The folded head's kind word: `Local` stays (the id alone does not say where it runs); a cloud
    /// model's id names its vendor, so the kind is dropped and the head fits the rail's 182 pt.
    static func brainKindWord(kind: BrainKind, model: String?) -> String {
        kind == .local || model == nil ? kind.shortLabel : ""
    }

    private var brainModelWord: String? { Self.brainModelWord(kind: kind, model: settings.brainModel, local: setup.local) }

    private var brainReadyWord: Bool? {
        switch setup.brain {
        case .ok: return true
        case .unavailable: return false
        case .unchecked: return nil
        }
    }

    private var brain: some View {
        ConsoleDisclosure(id: SettingsWords.brainFold, title: ConsoleDisclosureWords.brain,
                          summary: ConsoleDisclosureSummary.brain(kind: Self.brainKindWord(kind: kind, model: brainModelWord), model: brainModelWord, ready: brainReadyWord),
                          size: .section, siblings: SettingsWords.folds, inset: true) {
            VStack(spacing: 2) {
                // The OpenAI key that runs the GPT-Live-1 voice; the dot is the last probe.
                // The engine probes on its own after it saves a key, so Save sends one command.
                ConsoleFormRow(SettingsWords.voiceKeyRow) {
                    SettingsSecretRow(placeholder: SettingsWords.skPlaceholder, onFile: setup.secrets.openai, envVar: SettingsWords.openAIKey,
                                      status: voiceKeyStatus, id: SettingsWords.voiceKey,
                                      save: { key in actions.send(.setSecrets([SettingsWords.openAIKey: key])) })
                }
                ConsoleFormRow(BrainWords.label) {
                    // The menu spells the long ones out with every kind's `needs` on line 2 and in the
                    // foot; the field carries the short word and one badge (`this Mac` · `no key`).
                    ConsoleMenuField(value: kind, options: ConsoleTheme.brains, title: { $0.label },
                                     pick: { commitBrain(kind: $0) },
                                     fieldTitle: { $0.shortLabel },
                                     id: SettingsWords.backend, label: BrainWords.label, fieldBadge: BrainWords.fieldBadge, badge: BrainWords.badge,
                                     meta: BrainWords.needs, metaMono: false, foot: BrainWords.needs, width: 260)
                }
                hint(kind.needs)
                modelRow
                serverRow
                keyRow
                ConsoleFormRow(SettingsWords.effortLabel) {
                    ConsoleMenuField(value: settings.effort, options: effortOptions, title: { $0 },
                                     pick: { patch(SettingsPatch(effort: $0)) }, mono: true,
                                     id: SettingsWords.effort, label: SettingsWords.effortLabel, foot: HelpCopy.effort)
                }
                ConsoleFormRow(SettingsWords.status) { brainStatus }
            }
            .animation(Motion.gentle, value: kind)
            .animation(Motion.gentle, value: SettingsPanel.serverRowShown(kind: kind, local: setup.local, pin: serverDraft))
        }
    }

    /// Local: a menu over what the server lists (a pick commits at once, like every menu here);
    /// every other kind types an id. The compatible kind refuses to start without one, so its
    /// placeholder asks for it. An empty id means the backend's default, so an empty commit clears.
    private var modelRow: some View {
        ConsoleFormRow(SettingsWords.model) {
            if SettingsPanel.modelRowIsMenu(kind) {
                LocalModelMenu(status: setup.local, saved: modelDraft, pick: { id in modelDraft = id; commitBrain() })
            } else {
                ConsoleField(text: $modelDraft, placeholder: SettingsPanel.modelPlaceholder(kind), size: .row, mono: true,
                             commit: ConsoleField.Commit(emptyClears: true), id: SettingsWords.modelField, accessibilityLabel: SettingsWords.modelId,
                             onCommit: { commitBrain() })
            }
        }
    }

    /// The rows a backend wants arrive and leave with the pick (Motion.appear). The Local server
    /// row is drawn only when discovery found nothing or a root is pinned.
    @ViewBuilder private var serverRow: some View {
        if kind == .openaiCompatible {
            ConsoleFormRow(SettingsWords.serverRow) {
                ConsoleField(text: $serverDraft, placeholder: SettingsWords.serverPlaceholder, size: .row, mono: true,
                             commit: ConsoleField.Commit(emptyClears: true), id: SettingsWords.server, accessibilityLabel: SettingsWords.serverURL,
                             onCommit: { commitBrain() })
            }
            .transition(Motion.appear)
        } else if SettingsPanel.serverRowShown(kind: kind, local: setup.local, pin: serverDraft) {
            ConsoleFormRow(SettingsWords.serverRow) {
                ConsoleField(text: $serverDraft, placeholder: LocalBrainWords.serverPlaceholder(setup.local), size: .row, mono: true,
                             commit: ConsoleField.Commit(emptyClears: true), id: SettingsWords.server, accessibilityLabel: SettingsWords.localServerRoot,
                             onCommit: { commitBrain() })
            }
            .transition(Motion.appear)
        }
    }

    /// The OpenAI brain reuses the voice key above; logins and the local server need no key at all.
    @ViewBuilder private var keyRow: some View {
        if let secret = kind.secretKey, SettingsPanel.keyRowShown(kind) {
            ConsoleFormRow(SettingsWords.key) {
                SettingsSecretRow(placeholder: kind == .openaiCompatible ? SettingsWords.serverKeyPlaceholder : SettingsWords.skAntPlaceholder,
                                  onFile: kind == .anthropicApi ? setup.secrets.anthropic : setup.secrets.brainApiKey, envVar: secret,
                                  status: nil, id: SettingsWords.brainKey,
                                  save: { key in actions.send(.setSecrets([secret: key])) })
                    // One row for two secrets: the identity keeps a key typed for one
                    // backend from being saved under the other's name after a switch.
                    .id(secret)
            }
            .transition(Motion.appear)
        }
    }

    // MARK: Session

    private var sessionSection: some View {
        ConsoleDisclosure(id: SettingsWords.sessionFold, title: ConsoleDisclosureWords.session,
                          summary: ConsoleDisclosureSummary.session(home: settings.livesInNotch ? SettingsWords.notch : SettingsWords.free, idleMinutes: Int(settings.idleSleepMinutes.rounded())),
                          size: .section, siblings: SettingsWords.folds, inset: true) {
            VStack(spacing: 2) {
                ConsoleFormRow(SettingsWords.idleSleep) {
                    ConsoleStepper(value: Int(settings.idleSleepMinutes.rounded()), unit: SettingsWords.minutes, range: 1...240,
                                   id: SettingsWords.idle, accessibilityLabel: SettingsWords.idleLabel) { patch(SettingsPatch(idleSleepMinutes: Double($0))) }
                }
                ConsoleFormRow(SettingsWords.autoWakeRow) {
                    ConsoleToggle(on: settings.autoWake, hint: SettingsWords.autoWakeHint, id: SettingsWords.autoWake,
                                  accessibilityLabel: SettingsWords.autoWakeLabel) { patch(SettingsPatch(autoWake: $0)) }
                }
                // Where the orb lives: floating free (it stays where it last worked), or in
                // the MacBook notch (it drops out for the work and flies back up).
                ConsoleFormRow(SettingsWords.home) {
                    ConsoleSegments(value: settings.livesInNotch, options: [false, true], title: { $0 ? SettingsWords.notch : SettingsWords.free },
                                    pick: { notch in patch(SettingsPatch(orbHome: notch ? "notch" : "free")) },
                                    accessibilityLabel: SettingsWords.orbHome(settings.livesInNotch), size: .row)
                        .consoleHelp(settings.livesInNotch ? SettingsWords.notchTip : SettingsWords.freeTip)
                }
                hint(settings.livesInNotch ? SettingsWords.notchHint : SettingsWords.freeHint)
            }
        }
    }

    // MARK: Memory

    /// Memory: a durable record of Kevin, learned after a conversation ends (never while a paid
    /// session is open; never through Codex) and given back quietly per turn. The rows under the
    /// counts are the record itself — Edit, Forget, Restore; Forget hides, nothing deletes. The
    /// folded head carries `learned 12m`; open, the learned word (its card has the run's figures)
    /// and Learn now come back.
    private var memorySection: some View {
        ConsoleDisclosure(id: SettingsWords.memoryFold, title: ConsoleDisclosureWords.memory, count: (memory?.count ?? 0) > 0 ? "\(memory?.count ?? 0)" : nil,
                          summary: ConsoleDisclosureSummary.memory(enabled: settings.memory, learnedAgo: memory?.lastRunAt.map { ConsoleFormat.relative($0) }),
                          size: .section, trailing: memoryTrailing, siblings: SettingsWords.folds, inset: true) {
            VStack(spacing: 2) {
                ConsoleFormRow(SettingsWords.rememberRow) {
                    ConsoleToggle(on: settings.memory, hint: SettingsWords.rememberHint, id: SettingsWords.remember,
                                  accessibilityLabel: SettingsWords.rememberLabel) { patch(SettingsPatch(memory: $0)) }
                }
                if !settings.memory { hint(SettingsWords.memoryOff).transition(Motion.appear) }
                ConsoleFormRow(SettingsWords.matching) {
                    Text(ConsoleTheme.memoryMatching(memory))
                        .font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg)
                        .frame(height: 26)
                        .contentTransition(.opacity)
                        .animation(Motion.fade, value: ConsoleTheme.memoryMatching(memory))
                }
                hint(SettingsPanel.matchingHelp(memory))
                ConsoleFormRow(SettingsWords.known) { memoryCounts }
                hint(ConsoleTheme.memoryBudgetHint)
                MemoryRailList(summary: memory, enabled: settings.memory)
                    .padding(.top, 6)
            }
            .animation(Motion.gentle, value: settings.memory)
        }
    }

    private var memoryTrailing: AnyView {
        AnyView(Button(SettingsWords.learnNow) { actions.send(.memoryRun) }
            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
            .disabled(!settings.memory || memory == nil)
            .consoleHelp(settings.memory ? SettingsWords.learnNowTip : SettingsWords.memoryIsOff))
    }

    // MARK: Retention

    /// Retention is a mover, not a deleter: older days MOVE to the trash by the sweep and come
    /// back with Restore; the trash is emptied in Finder, by Kevin, never here.
    private var retention: some View {
        ConsoleDisclosure(id: SettingsWords.retentionFold, title: ConsoleDisclosureWords.retention,
                          summary: ConsoleDisclosureSummary.retention(ledgerDays: settings.ledgerRetentionDays > 0 ? settings.ledgerRetentionDays : nil, trashDays: settings.shotsRetentionDays),
                          size: .section, trailing: AnyView(sweep), siblings: SettingsWords.folds, inset: true) {
            VStack(spacing: 2) {
                ConsoleFormRow(SettingsWords.ledger) {
                    ConsoleMenuField(value: settings.ledgerRetentionDays, options: retentionOptions(ConsoleTheme.ledgerRetentionOptions, current: settings.ledgerRetentionDays),
                                     title: { ConsoleTheme.retentionTitle($0, forever: SettingsWords.keepForever) },
                                     pick: { days in var p = SettingsPatch(); p.ledgerRetentionDays = days; patch(p) }, mono: true,
                                     id: SettingsWords.ledgerRetention, label: SettingsWords.ledger)
                        .consoleHelp(SettingsWords.ledgerTip)
                }
                ConsoleFormRow(SettingsWords.screenshots) {
                    ConsoleMenuField(value: settings.shotsRetentionDays, options: retentionOptions(ConsoleTheme.shotsRetentionOptions, current: settings.shotsRetentionDays),
                                     title: { ConsoleTheme.retentionTitle($0, forever: SettingsWords.forever) },
                                     pick: { days in var p = SettingsPatch(); p.shotsRetentionDays = days; patch(p) }, mono: true,
                                     id: SettingsWords.shotsRetention, label: SettingsWords.screenshots)
                        .consoleHelp(SettingsWords.shotsTip)
                }
                hint(SettingsWords.retentionHint)
                ConsoleFormRow(SettingsWords.trash) { TrashRow(trash: trash) }
                hint(SettingsWords.trashHint)
            }
        }
    }

    /// Two presses: the sweep moves whole day files and has no Undo of its own, so the head asks
    /// first, in place — the word becomes the deed, and × is the way out.
    @ViewBuilder private var sweep: some View {
        let nothing = settings.ledgerRetentionDays == 0 && settings.shotsRetentionDays == 0
        if sweepArmed {
            HStack(spacing: 4) {
                Button(SettingsWords.sweepArmed) {
                    withAnimation(Motion.snappy) { sweepArmed = false }
                    actions.cleanup(.sweep)
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .consoleHelp(SettingsWords.sweepGoTip)
                Button { withAnimation(Motion.snappy) { sweepArmed = false } } label: {
                    Image(systemName: ConsoleGlyph.cross).font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 22))
                .consoleHelp(SettingsWords.keepAll)
                .accessibilityLabel(SettingsWords.cancelSweep)
            }
            .transition(.opacity)
            .task {
                // Left alone, the question goes away.
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                withAnimation(Motion.snappy) { sweepArmed = false }
            }
        } else {
            Button(SettingsWords.sweepNow) { withAnimation(Motion.snappy) { sweepArmed = true } }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .disabled(nothing)
                .consoleHelp(nothing ? SettingsWords.sweepNothing : SettingsWords.sweepTip)
                .transition(.opacity)
        }
    }

    // MARK: Wake

    private var wakeSection: some View {
        ConsoleDisclosure(id: SettingsWords.wakeFold, title: ConsoleDisclosureWords.wake,
                          summary: ConsoleDisclosureSummary.wake(enabled: wake.enabled, phrases: wake.phrases.count),
                          size: .section, siblings: SettingsWords.folds, inset: true) {
            VStack(spacing: 2) {
                ConsoleFormRow(SettingsWords.wakeWordRow) {
                    ConsoleToggle(on: wake.enabled, hint: SettingsWords.wakeHint, id: SettingsWords.wakeWord, accessibilityLabel: SettingsWords.wakeWordRow) { on in
                        var w = wake; w.enabled = on; patch(SettingsPatch(wake: w))
                    }
                }
                ConsoleFormRow(SettingsWords.phrasesRow) {
                    // The stock list is wider than the field, so it wraps rather than clipping mid-word.
                    ConsoleField(text: $phrasesDraft, placeholder: SettingsWords.phrasesPlaceholder, size: .row, mono: true, grows: true,
                                 id: SettingsWords.phrases, accessibilityLabel: SettingsWords.wakePhrasesLabel, onCommit: commitPhrases)
                }
                hint(SettingsWords.phrasesHint)
                ConsoleFormRow(SettingsWords.authRow) {
                    // The menu spells every option out; the field is too narrow for "Touch ID or passphrase".
                    ConsoleMenuField(value: wake.auth, options: WakeAuth.allCases, title: { $0.label },
                                     pick: { auth in var w = wake; w.auth = auth; patch(SettingsPatch(wake: w)) },
                                     fieldTitle: { $0 == .either ? SettingsWords.either : $0.label },
                                     id: SettingsWords.auth, label: SettingsWords.authRow)
                }
                if wake.auth == .none { hint(SettingsWords.anyoneWakes).transition(Motion.appear) }
                ConsoleFormRow(SettingsWords.passphraseRow) { WakePassphraseRow(set: gate.passphraseSet) }
                ConsoleFormRow(SettingsWords.status) { WakeGateReadout(phase: phase, wake: wake, gate: gate.gate, heard: gate.heard) }
            }
            .animation(Motion.gentle, value: wake.auth)
        }
    }

    /// The menu's options with the saved value added when it is not one of them (a hand-edited settings file).
    private func retentionOptions(_ options: [Int], current: Int) -> [Int] {
        options.contains(current) ? options : options + [current]
    }

    // MARK: brain

    /// The Model row is a menu for the Local brain (the server lists what there is); a field for every other kind.
    static func modelRowIsMenu(_ kind: BrainKind) -> Bool { kind == .local }

    /// The Model field's placeholder: the kind's suggested id, "pick a model" for the compatible
    /// server (compatible.ts refuses to start without one), "backend default" elsewhere.
    static func modelPlaceholder(_ kind: BrainKind) -> String {
        let fallback = ConsoleTheme.defaultBrainModel(kind)
        if !fallback.isEmpty { return fallback }
        return kind == .openaiCompatible ? SettingsWords.pickAModel : SettingsWords.backendDefault
    }

    /// The Local Server row is drawn only when discovery found nothing or a root is pinned; the
    /// compatible kind draws its own field; no other kind has one.
    static func serverRowShown(kind: BrainKind, local: LocalServerStatus, pin: String) -> Bool {
        guard kind == .local else { return false }
        return LocalBrainWords.serverRowShown(status: local, pin: pin)
    }

    /// The Key row: a kind with its own secret, except OpenAI (the voice key above). Logins and the local server have none.
    static func keyRowShown(_ kind: BrainKind) -> Bool { kind.secretKey != nil && kind != .openaiResponses }

    /// The Matching row's hint: where item text goes for matching.
    static func matchingHelp(_ memory: MemorySummary?) -> String {
        switch memory?.embeddings {
        case "openai": return SettingsWords.matchOpenAI
        case "local":
            if let model = memory?.embeddingModel, !model.isEmpty { return SettingsWords.matchLocal(model) }
            return SettingsWords.matchLocalUnnamed
        default: return SettingsWords.matchKeyword
        }
    }

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

    /// The last probe of the voice key, as the dot and word beside the field.
    private var voiceKeyStatus: SettingsSecretRow.Status {
        switch setup.openaiKey {
        case .ok: return SettingsSecretRow.Status(color: ConsoleTheme.acting, text: SettingsWords.onFile, help: SettingsWords.keyWorks(setup.liveModel))
        case .invalid: return SettingsSecretRow.Status(color: ConsoleTheme.error, text: SettingsWords.rejected, help: SettingsWords.keyRejected)
        case .missing: return SettingsSecretRow.Status(color: ConsoleTheme.speaking, text: SettingsWords.missing, help: SettingsWords.noKeyTip)
        case .unchecked: return SettingsSecretRow.Status(color: ConsoleTheme.titanium, text: SettingsWords.onFile, help: SettingsWords.uncheckedTip)
        }
    }

    /// Dot + one line from the last probe; Check runs it again. The Backend row already names
    /// the brain, so the line is the state — plus, for Automatic, the brain it resolved to.
    private var brainStatus: some View {
        let resolved: String? = kind == .auto ? setup.brainResolved.flatMap { $0 == .auto ? nil : $0.label } : nil
        let detail = setup.brainDetail.trimmingCharacters(in: .whitespacesAndNewlines)
        return BrainStatusRow(state: setup.brain, resolved: resolved, detail: detail.isEmpty || detail == "ok" ? nil : detail,
                              name: ConsoleTheme.brainName(kind, resolved: setup.brainResolved)) { actions.send(.probeSetup) }
    }

    // MARK: memory

    /// The counts, the digits rolling: "142 live" on the value line, "3 forgotten · 1 archived"
    /// under it, "2 waiting" when conversations wait for a quiet moment (the extractor runs only
    /// while no paid session is open), and "learned 12m ago" ticking — its card has the run's
    /// figures. Short mono lines: the value column is 182 pt.
    private var memoryCounts: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(memory.map { SettingsWords.live($0.count) } ?? SettingsWords.dash)
                .font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg)
                .lineLimit(1)
                .frame(height: 26, alignment: .leading)
                .contentTransition(ConsoleMotion.numeric)
                .animation(Motion.snappy, value: memory?.count)
            if let memory {
                Text(SettingsPanel.hiddenCountsLine(memory))
                    .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                    .lineLimit(1)
                    .contentTransition(ConsoleMotion.numeric)
                    .animation(Motion.snappy, value: SettingsPanel.hiddenCountsLine(memory))
                if memory.pending > 0 {
                    Text(SettingsPanel.pendingLine(memory))
                        .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                        .lineLimit(1)
                        .contentTransition(ConsoleMotion.numeric)
                        .consoleHelp(SettingsWords.pendingTip)
                        .transition(Motion.appear)
                }
                LearnedWord(memory: memory)
            }
        }
        .padding(.bottom, 4)
        .animation(Motion.gentle, value: (memory?.pending ?? 0) > 0)
    }

    /// "learned 12m ago" (the head, beside Learn now) · "not learned yet".
    static func learnedLine(_ m: MemorySummary, now: Double) -> String {
        guard let at = m.lastRunAt else { return SettingsWords.notLearned }
        return SettingsWords.learned(ConsoleFormat.relative(at, now: now))
    }

    /// The open head's short form beside Learn now: "learned 12m" · "not learned yet" (the rail is 260 wide).
    static func learnedWord(_ m: MemorySummary, now: Double) -> String {
        guard let at = m.lastRunAt else { return SettingsWords.notLearned }
        return SettingsWords.learnedShort(ConsoleFormat.relative(at, now: now))
    }

    /// "3 forgotten · 1 archived" — the items out of the prompts, restorable.
    static func hiddenCountsLine(_ m: MemorySummary) -> String { SettingsWords.hiddenCounts(forgotten: m.forgotten, archived: m.archived) }

    /// "2 waiting" — conversations queued for extraction.
    static func pendingLine(_ m: MemorySummary) -> String { SettingsWords.waiting(m.pending) }

    /// The last run as one mono line: "responses · +3 · ~1 · 4 same · 1 refused · 1.8 s".
    static func lastRunLine(_ r: MemorySummary.LastRun) -> String {
        "\(r.extractor) · +\(r.added) · ~\(r.updated) · \(r.noop) \(SettingsWords.same) · \(r.refused) \(SettingsWords.refused) · \(ConsoleFormat.ms(r.ms))"
    }

    /// The learned word's card: the run's figures as foot rows, mono.
    static func lastRunCard(_ m: MemorySummary, now: Double) -> ConsoleTipCard {
        guard let r = m.lastRun else { return ConsoleTipCard(title: SettingsWords.lastRun, status: SettingsWords.noRun) }
        return ConsoleTipCard(title: SettingsWords.lastRun, status: learnedLine(m, now: now),
                              foot: [(SettingsWords.extractor, r.extractor), (SettingsWords.added, "+\(r.added)"), (SettingsWords.updated, "~\(r.updated)"),
                                     (SettingsWords.same, "\(r.noop)"), (SettingsWords.refused, "\(r.refused)"), (SettingsWords.took, ConsoleFormat.ms(r.ms))])
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

    /// One titanium line under a control, aligned to the control column (the kit's `ConsoleHint`).
    private func hint(_ text: String) -> some View { ConsoleHint(text).padding(.bottom, 4) }
}

/// "learned 12m ago" ticking under the counts; its card has the last run's figures.
private struct LearnedWord: View {
    let memory: MemorySummary

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            let now = ctx.date.timeIntervalSince1970 * 1000
            Text(SettingsPanel.learnedLine(memory, now: now))
                .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                .lineLimit(1)
                .contentTransition(ConsoleMotion.numeric)
                .consoleHelp(id: SettingsWords.learnedTip, card: SettingsPanel.lastRunCard(memory, now: now))
        }
    }
}

/// The Status row: the dot and the word (`Ready` · `Claude Code ready` · `Unavailable` ·
/// `Checking…`), Check at the right, and the probe's detail whole on two mono lines under them —
/// nothing truncates into a hover. A probe's answer fades in.
private struct BrainStatusRow: View {
    let state: SetupStatus.BrainState
    let resolved: String?
    let detail: String?
    let name: String
    let check: () -> Void

    private var color: Color {
        switch state {
        case .ok: return ConsoleTheme.acting
        case .unavailable: return ConsoleTheme.error
        case .unchecked: return ConsoleTheme.thinking
        }
    }

    private var text: String {
        switch state {
        case .ok: return resolved.map(SettingsWords.readyWith) ?? SettingsWords.ready
        case .unavailable: return SettingsWords.unavailable
        case .unchecked: return SettingsWords.checking
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                HStack(spacing: iconGap) {
                    ConsoleDot(color: color, live: state == .unchecked).frame(width: 20, height: 20)
                    Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1).truncationMode(.tail)
                        .contentTransition(.opacity)
                }
                .accessibilityLabel("\(name) \(text)")
                Spacer(minLength: 4)
                Button(SettingsWords.checkVerb, action: check)
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .layoutPriority(1)
                    .consoleHelp(HelpCopy.check, id: SettingsWords.check)
            }
            .frame(height: 26)
            if let detail {
                Text(detail).font(ConsoleTheme.mono(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.titanium)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 20 + iconGap)
                    .padding(.bottom, 4)
                    .contentTransition(.opacity)
                    .transition(Motion.appear)
            }
        }
        .animation(Motion.fade, value: text)
        .animation(Motion.gentle, value: detail)
    }
}

/// A secret that is written, never read back — the kit's `ConsoleSecretRow` (field + Save ·
/// Saving… · `●` on file + Change, the env var printed under the on-file face) with the
/// "sent, not yet echoed" state kept here: the snapshot normally flips `onFile` within a round
/// trip; if it never does, the field comes back after eight seconds.
private struct SettingsSecretRow: View {
    struct Status {
        let color: Color
        let text: String
        let help: String
    }

    let placeholder: String
    let onFile: Bool
    let envVar: String
    /// The dot's meaning while on file; nil is plain presence.
    let status: Status?
    var id: String? = nil
    let save: (String) -> Void

    @State private var pending = false

    var body: some View {
        ConsoleSecretRow(placeholder: placeholder, onFile: onFile, saving: pending && !onFile, envVar: envVar,
                         statusColor: status?.color ?? ConsoleTheme.acting, statusText: status?.text ?? SettingsWords.onFile,
                         id: id, accessibilityLabel: status?.help, save: commit)
            .consoleHelp(status?.help ?? SettingsWords.onFile)
            .onChange(of: onFile) { pending = false }
    }

    private func commit(_ key: String) {
        save(key)
        pending = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            pending = false
        }
    }
}

/// The trash's figures whole, its path as the row's mono detail, and the way to Finder under them.
private struct TrashRow: View {
    let trash: TrashInfo?

    @Environment(\.consoleActions) private var actions

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(trash.map { ConsoleFormat.trashLine($0) } ?? SettingsWords.dash)
                .font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg)
                .lineLimit(1)
                .frame(height: 26, alignment: .leading)
                .contentTransition(ConsoleMotion.numeric)
                .animation(Motion.snappy, value: trash)
            if let trash {
                Text(ConsoleFormat.truncPath(trash.path, max: 48)).font(ConsoleTheme.mono(10)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
                Button { actions.open(trash.path) } label: { Label(SettingsWords.revealInFinder, systemImage: "folder.fill") }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .consoleHelp(SettingsWords.revealTrashTip)
            }
        }
    }
}

/// The wake passphrase as the kit's secret row: a field and Set until one is enrolled, then
/// `● set` with Change and Clear. Only the gate ever sees the text; a rejection (too short)
/// turns the ring red with the hint `Two words or more.` under it, the words kept for a second try.
private struct WakePassphraseRow: View {
    /// A passphrase is enrolled (AppState.wakePassphraseSet, sliced by the root).
    let set: Bool

    @Environment(\.consoleActions) private var actions
    @State private var draft = ""
    @State private var rejected = false
    /// Bumped on a successful Set so the row leaves its editing face.
    @State private var generation = 0

    var body: some View {
        ConsoleSecretRow(placeholder: SettingsWords.aPhrase, onFile: set, statusText: SettingsWords.phraseSet, verb: SettingsWords.set,
                         error: rejected ? SettingsWords.tooShort : nil, id: SettingsWords.passphrase, accessibilityLabel: SettingsWords.wakePassphraseLabel,
                         draft: $draft, clear: { actions.clearWakePassphrase(); draft = "" }, save: submit)
            .id(generation)
            .onChange(of: set) { if !set { rejected = false } }
    }

    private func submit(_ text: String) {
        if actions.setWakePassphrase(text) {
            draft = ""
            rejected = false
            generation += 1
        } else {
            // Too short: the gate has toasted why. The ring turns red, the words stay.
            rejected = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 700_000_000)
                rejected = false
            }
        }
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

    /// The gate's states as the readout tells them apart, so a change crossfades the
    /// line (the lockout's countdown ticks inside one state).
    private var stateKey: String {
        if ConsoleTheme.gateRests(phase) { return "rests" }
        switch gate {
        case .off: return "off"
        case .listening: return "listening"
        case .heard: return "heard"
        case .authenticating: return "authenticating"
        case .granted: return "granted"
        case .denied: return "denied"
        case .lockedOut: return "locked"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if ConsoleTheme.gateRests(phase) {
                // The status menu's "not listening" glyph, dimmed: the ear is off duty, not asleep.
                line(symbol: "ear.trianglebadge.exclamationmark", tint: ConsoleTheme.titanium, text: SettingsWords.gateRests, color: ConsoleTheme.titanium)
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
                    heardLine.transition(Motion.appear)
                }
            }
        }
        .animation(Motion.gentle, value: stateKey)
    }

    private func gateLine(now: Date) -> some View {
        // Paused: the gate listens for the word to resume, unauthenticated (WakeGate.isPaused).
        let meta = ConsoleTheme.gate(gate, phrases: wake.phrases, auth: wake.auth, now: now, paused: phase == .paused)
        return line(symbol: meta.symbol, tint: meta.color, text: meta.label, color: ConsoleTheme.fg)
    }

    /// The glyph swaps (ConsoleIcon) and the words crossfade as the gate's state turns;
    /// a countdown's digits roll. The line is whole (three lines), so it carries no tip.
    private func line(symbol: String, tint: Color, text: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: iconGap) {
            ConsoleIcon(name: symbol, tint: tint).frame(height: 26)
            Text(text).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(color)
                .lineLimit(3).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 26, alignment: .leading)
                .contentTransition(ConsoleMotion.numeric)
                .animation(Motion.snappy, value: text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// `heard  hey jarhead` — the newest words win, so it truncates from the left; the card has them whole.
    private var heardLine: some View {
        HStack(spacing: 8) {
            Text(SettingsWords.heard).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg3)
            Text(heard.isEmpty ? SettingsWords.ellipsis : heard).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                .lineLimit(1).truncationMode(.head)
        }
        .padding(.leading, 20 + iconGap)
        .padding(.bottom, 4)
        .consoleHelp(id: SettingsWords.heardTip, card: ConsoleTipCard(title: SettingsWords.heard, lines: [heard.isEmpty ? SettingsWords.nothingHeard : heard]))
        .accessibilityLabel(heard.isEmpty ? SettingsWords.nothingHeard : SettingsWords.heardLabel(heard))
    }
}

/// The rail section "Leaves the Mac", folded to `2 cloud · 2 mac`: the four rows the engine
/// computed (SetupStatus.dataPaths), so the Console and `pnpm jarhead doctor` say the same
/// thing — each a `ConsoleRow` 40 with the destination as a badge (`cloud` · `mac`) and the
/// detail in mono under the name; the card has the detail whole. A row whose destination
/// moves (the brain going local) crossfades.
struct LeavesSection: View {
    let paths: [DataPath]

    /// `2 cloud · 2 mac` — the rows by destination.
    static func counts(_ paths: [DataPath]) -> (cloud: Int, mac: Int) {
        (paths.filter { $0.where == "cloud" }.count, paths.filter { $0.where == "mac" }.count)
    }

    var body: some View {
        let counts = Self.counts(paths)
        ConsoleDisclosure(id: SettingsWords.leavesFold, title: ConsoleDisclosureWords.leaves,
                          summary: ConsoleDisclosureSummary.leaves(cloud: counts.cloud, mac: counts.mac),
                          size: .section, siblings: SettingsWords.folds) {
            VStack(spacing: 0) {
                if paths.isEmpty {
                    Text(SettingsWords.notRead).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).frame(height: 22).padding(.horizontal, railInset)
                        .transition(.opacity)
                }
                ForEach(paths) { path in
                    ConsoleRow(title: ConsoleTheme.dataPathName(path.what), icon: .symbol(ConsoleTheme.dataPathSymbol(path.what)),
                               badge: .word(path.where), meta: path.detail, accessibilityHint: LocalBrainWords.whereWord(path.where), primary: {})
                        .consoleHelp(id: SettingsWords.leavesRow(path.what), card: ConsoleTipCard.path(title: ConsoleTheme.dataPathName(path.what), path: path.detail))
                        .transition(Motion.appear)
                }
            }
            .animation(Motion.gentle, value: paths.map(\.what))
        }
    }
}

// MARK: - Ledger

/// The Ledger tab: `Filter days` past eight days, the days folded by month (`September 4 ·
/// 62 min · $3.10` — the head sums the days read so far), one 28 pt row per day with `›` and
/// its figures once that day has been read (`ConsoleSession.ledgerDayStats`; `—` until then),
/// the picked day's bar gliding, ↑↓ ⏎ over the days and the month heads (`ConsoleListKeys`).
struct LedgerPanel: View {
    let days: [String]?
    let picked: String?
    let loading: Bool
    let stats: LedgerStats?

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession
    /// The picked day's highlight, one view for the list so it glides between rows.
    @Namespace private var selection
    @StateObject private var focus = ConsoleListFocus()
    @State private var query = ""
    @FocusState private var filterFocused: Bool
    /// Bumped when a month folds, so the keyboard's ids follow the folds.
    @State private var folds = 0

    /// The day's figures on its row: `17.0 min · $0.85` once read, `—` until then.
    static func figures(_ day: String, in cache: [String: LedgerStats]) -> String {
        cache[day].map { ConsoleFormat.billed($0.billedSeconds) } ?? LedgerWords.unread
    }

    /// The days whose words or date contain the query (`sep`, `thu`, `2026-08`).
    static func filtered(_ days: [String], query: String, now: Date = Date()) -> [String] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return days }
        return days.filter { $0.contains(q) || ConsoleFormat.day($0, now: now).lowercased().contains(q) }
    }

    private var shown: [String] { Self.filtered(days ?? [], query: query) }
    private var months: [ConsoleListModel.Month] { ConsoleListModel.ledgerMonths(shown) }
    private var showsFilter: Bool { (days?.count ?? 0) > LedgerWords.filterPast }

    /// The keyboard's rows: every month head, and the days of the open months.
    private var ids: [String] {
        months.enumerated().flatMap { index, month -> [String] in
            let id = LedgerWords.monthFold(month.id)
            return [id] + (ConsoleFoldStore.isOpen(id, default: index == 0) ? month.days : [])
        }
    }

    private var heads: Set<String> { Set(months.map { LedgerWords.monthFold($0.id) }) }

    var body: some View {
        VStack(spacing: 0) {
            RailSection(LedgerWords.days, count: days?.count, inset: false, trailing: { folder }) {
                VStack(spacing: 0) {
                    if showsFilter { filter }
                    list
                }
            }
            if let picked { dayFigures(picked).transition(Motion.appear) }
        }
        .animation(Motion.gentle, value: picked)
        .onAppear { actions.loadLedgerDays() }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleFoldStore.changed)) { _ in folds += 1 }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification), perform: preview)
    }

    private var folder: some View {
        Button { actions.send(.openLedger) } label: {
            Image(systemName: "folder.fill").font(.system(size: 12, weight: .medium))
        }
        .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
        .consoleHelp(LedgerWords.openFolder)
        .accessibilityLabel(LedgerWords.openFolderLabel)
    }

    private var filter: some View {
        ConsoleFilterField(text: $query, placeholder: LedgerWords.filterDays,
                           count: ConsoleListModel.countWord(shown: shown.count, of: days?.count ?? 0, typing: !query.isEmpty),
                           focus: $filterFocused, accessibilityLabel: LedgerWords.filterLabel,
                           onMove: { if $0 == .down { move(to: ids.first(where: { !heads.contains($0) })) } },
                           onSubmit: { if let first = shown.first { pick(first) } },
                           onExit: { query = "" })
            .padding(.horizontal, railInset)
            .padding(.bottom, 6)
    }

    /// "Loading…" and the months that answer it crossfade.
    private var list: some View {
        ZStack(alignment: .topLeading) {
            if let days {
                if days.isEmpty {
                    Text(LedgerWords.noLedger).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                        .padding(.horizontal, railInset).frame(height: 22)
                        .transition(.opacity)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(months.enumerated()), id: \.element.id) { index, month in monthGroup(month, first: index == 0) }
                    }
                    .consoleListKeys(ConsoleListKeys(focus: focus, ids: ids, heads: heads, title: { ConsoleFormat.day($0) }, typeAhead: !showsFilter,
                                                     primary: primary, fold: { ConsoleFoldStore.set($0, $1) }, escape: { query = "" }))
                    .transition(.opacity)
                }
            } else {
                Reading(text: NowWords.loading).padding(.horizontal, railInset)
                    .transition(.opacity)
            }
        }
        .animation(Motion.fade, value: days == nil)
        .animation(Motion.snappy, value: picked)
    }

    /// A month: its head with the read days' figures, the days inside (the first month open).
    private func monthGroup(_ month: ConsoleListModel.Month, first: Bool) -> some View {
        let id = LedgerWords.monthFold(month.id)
        let sum = ConsoleSession.monthStats(month.days, in: session.ledgerDayStats)
        return ConsoleDisclosure(id: id, title: month.title, count: "\(month.days.count)",
                                 summary: ConsoleDisclosureSummary.ledgerMonth(read: sum.read, billedSeconds: sum.billedSeconds),
                                 size: .group, defaultOpen: first, focused: focus.ringOn(id)) {
            ForEach(month.days, id: \.self) { day in
                ConsoleRow(title: ConsoleFormat.day(day), value: Self.figures(day, in: session.ledgerDayStats), trailing: .chevron,
                           selected: day == picked, focused: focus.ringOn(day), selection: selection, accessibilityHint: day,
                           onHover: { if $0 { focus.hovered(day) } }, primary: { pick(day) })
            }
        }
    }

    /// The day's figures arrive under their head once read; "Reading…" gives way to them.
    private func dayFigures(_ picked: String) -> some View {
        RailSection(ConsoleFormat.day(picked)) {
            ZStack(alignment: .topLeading) {
                if let stats, !loading {
                    VStack(alignment: .leading, spacing: 0) {
                        KV(LedgerWords.sessions, "\(stats.sessions)")
                        KV(LedgerWords.utterances, "\(stats.utterances)")
                        KV(LedgerWords.delegations, "\(stats.delegations)")
                        KV(LedgerWords.billed, ConsoleFormat.billed(stats.billedSeconds))
                    }
                    .transition(Motion.appear)
                } else {
                    Reading(text: LedgerWords.reading).transition(.opacity)
                }
            }
            .animation(Motion.gentle, value: stats == nil || loading)
        }
    }

    private func pick(_ day: String) {
        focus.set(day, keyboard: focus.keyboard, why: "pick")
        withAnimation(Motion.snappy) { actions.pickLedgerDay(day) }
    }

    /// Return on a head folds or opens it (the first month is open by default, as `ids` and the
    /// disclosure seed it — so the first Return on a never-toggled first head folds it); on a day, picks it.
    private func primary(_ id: String) {
        guard heads.contains(id) else { pick(id); return }
        let first = months.first.map { LedgerWords.monthFold($0.id) } == id
        ConsoleFoldStore.set(id, !ConsoleFoldStore.isOpen(id, default: first))
    }

    private func move(to id: String?) {
        guard let id else { return }
        filterFocused = false
        focus.set(id, keyboard: true, why: "filter ↓")
        focus.claim()
    }

    /// `focus:ledger.days` gives the list the keyboard (on the picked day); `highlight:<day>` moves it.
    private func preview(_ note: Notification) {
        if note.userInfo?[ConsolePreviewKey.focus] as? String == LedgerWords.listId { move(to: picked ?? ids.first) }
        if let id = note.userInfo?[ConsolePreviewKey.highlight] as? String, ids.contains(id) { move(to: id) }
    }
}
