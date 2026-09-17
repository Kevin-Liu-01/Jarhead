import SwiftUI
import AppKit

// The Console's fold: a head that IS the summary while closed (figures and ids mono titanium,
// words sans fg3, a state as one badge), its own control back while open, the content arriving
// with 6 pt of air. `.section` (28) replaces a `RailSection` head; `.group` (24) a fold or group
// head inside a list (Archived · Trash · Hidden, a tool's agents, a ledger month, a permission
// area). The open state is remembered per id (`ConsoleFoldStore`, `console.fold.<id>`); a list
// may hand a binding instead (the rail's `session.trashOpen`). ⌥-click folds the siblings.
// `ConsoleDisclosureSummary` builds the closed heads' words once, pinned by `check-kit`.

enum ConsoleDisclosureWords {
    static let audio = "Audio"
    static let brain = "Brain"
    static let leaves = "Leaves the Mac"
    static let session = "Session"
    static let memory = "Memory"
    static let retention = "Retention"
    static let wake = "Wake"
    static let permissions = "Permissions"
    static let problems = "Problems"
    static let ready = "Ready"
    static let senses = "Senses"
    static let hands = "Hands"
    static let files = "Files"
    static let grants = "Grants"
    static let engine = "Engine"
    static let archived = "Archived"
    static let trash = "Trash"
    static let hidden = "Hidden"
    static let pinned = "Pinned"
    static let on = "on"
    /// design12: the Audio head's one badge while Recording is on — titanium, the resting `[Ready]` idiom, not amber.
    static let recording = "recording"
    static let keepForever = "forever"
    static let fold = "Fold"
    static let unfold = "Open"
    static func ofTotal(_ n: Int, _ total: Int) -> String { "\(n) of \(total)" }
    static func cloudMac(cloud: Int, mac: Int) -> String { "\(cloud) cloud · \(mac) mac" }
    static func learned(_ ago: String) -> String { "learned \(ago)" }
    static func days(_ n: Int) -> String { "\(n) d" }
    static func minutes(_ n: Int) -> String { "\(n) min" }
    static func working(_ n: Int) -> String { "\(n) working" }
    static func idle(_ n: Int) -> String { "\(n) idle" }
    static func done(_ n: Int) -> String { "\(n) done" }
    /// The rail's one head for every day before yesterday.
    static let older = "Older"
    /// The sub-head inside a tool group holding its over rows (a place, capitalised).
    static let ended = "Ended"
    /// The all-over summary's word on a folded tool head (a state, lowercase): `ended · 40m`.
    static let endedWord = "ended"
    /// `4 ended` — the tip's and AX's spelling.
    static func ended(_ n: Int) -> String { "\(n) ended" }
    /// `since Aug 2` — the Older head's figure.
    static func since(_ shortDay: String) -> String { "since \(shortDay)" }
    static func phrases(_ n: Int) -> String { n == 1 ? "1 phrase" : "\(n) phrases" }
    static let joiner = " · "
}

// MARK: - The fold store

/// Where a fold is remembered: `UserDefaults` `console.fold.<id>`, and a memory the harness
/// uses alone (`persists = false`, so a previous run's folds never leak into a shot). Every change
/// is posted, so a sibling folded by ⌥-click and the harness's `fold:<id>:<open|closed>` reach a
/// mounted disclosure.
enum ConsoleFoldStore {
    nonisolated(unsafe) static var persists = true
    /// Ids remembered in memory alone (this window, this launch): a day head's `rail.day.<date>` —
    /// "Yesterday open" remembered today is a different day tomorrow, and a key per day would litter.
    nonisolated(unsafe) static var transientPrefixes: [String] = ["rail.day."]
    nonisolated(unsafe) private static var memory: [String: Bool] = [:]
    static let changed = Notification.Name("jarhead.console.fold.changed")
    static let idKey = "id", openKey = "open"

    static func key(_ id: String) -> String { "console.fold.\(id)" }

    static func isOpen(_ id: String, default fallback: Bool) -> Bool {
        if let v = memory[id] { return v }
        if persists, let v = UserDefaults.standard.object(forKey: key(id)) as? Bool { return v }
        return fallback
    }

    static func set(_ id: String, _ open: Bool) {
        memory[id] = open
        if persists && !transientPrefixes.contains(where: { id.hasPrefix($0) }) { UserDefaults.standard.set(open, forKey: key(id)) }
        NotificationCenter.default.post(name: changed, object: nil, userInfo: [idKey: id, openKey: open])
    }

    /// ⌥-click: the siblings fold, the clicked one stays (an accordion when Kevin wants one).
    static func foldSiblings(_ ids: [String], keeping id: String) {
        for s in ids where s != id { set(s, false) }
    }
}

// MARK: - The disclosure

/// 28 for a section head, 24 for a group head inside a list.
enum ConsoleDisclosureSize { case section, group }

/// One piece of a closed head's summary.
enum ConsoleDisclosureSummaryItem: Equatable {
    /// Figures and ids: mono 11 titanium.
    case mono(String)
    /// Words: sans 11 fg3.
    case words(String)
    /// A state, as one badge.
    case badge(ConsoleBadge.Word)
}

struct ConsoleDisclosure<Content: View>: View {
    typealias Size = ConsoleDisclosureSize
    typealias Summary = ConsoleDisclosureSummaryItem

    let id: String
    let title: String
    var count: String? = nil
    var summary: [Summary] = []
    var size: Size = .group
    /// The head's own control while open (Learn now · Sweep now · Clear all · the trash folder).
    var trailing: AnyView? = nil
    /// The ids ⌥-click folds.
    var siblings: [String] = []
    /// The list draws the ring for its focused head.
    var focused = false
    /// Content inset like `RailSection` (12); a list's groups run to the edge.
    var inset = false
    private let external: Binding<Bool>?
    private let content: () -> Content
    /// What an unbound head shows while the store holds nothing for its id — read live, so a default that
    /// follows the data (a tool open iff a row of its asks or works) moves the head the moment the rail's
    /// `isFoldOpen` moves; the two never disagree.
    private let defaultOpen: Bool
    /// The last state the store posted for this id: written so the body re-reads the store.
    @State private var applied: Bool

    init(id: String, title: String, count: String? = nil, summary: [Summary] = [], size: Size = .group, defaultOpen: Bool = false,
         open: Binding<Bool>? = nil, trailing: AnyView? = nil, siblings: [String] = [], focused: Bool = false, inset: Bool = false,
         @ViewBuilder content: @escaping () -> Content) {
        self.id = id
        self.title = title
        self.count = count
        self.summary = summary
        self.size = size
        self.trailing = trailing
        self.siblings = siblings
        self.focused = focused
        self.inset = inset
        self.external = open
        self.content = content
        self.defaultOpen = defaultOpen
        _applied = State(initialValue: open?.wrappedValue ?? ConsoleFoldStore.isOpen(id, default: defaultOpen))
    }

    /// The binding, else the store with the live default — the same read the rail's `isFoldOpen` makes.
    private var isOpen: Bool { external?.wrappedValue ?? ConsoleFoldStore.isOpen(id, default: defaultOpen) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ConsoleDisclosureHead(title: title, count: count, summary: summary, size: size, open: isOpen, focused: focused, trailing: trailing,
                                  toggle: { toggle(option: NSApp.currentEvent?.modifierFlags.contains(.option) ?? false) },
                                  set: { set($0) })
            if isOpen {
                content()
                    .padding(.horizontal, inset ? 12 : 0)
                    .padding(.top, 6)
                    .padding(.bottom, size == .section ? 10 : 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(Motion.appear)
            }
            if size == .section { ConsoleHairline() }
        }
        .animation(Motion.snappy, value: isOpen)
        .onReceive(NotificationCenter.default.publisher(for: ConsoleFoldStore.changed)) { note in
            guard note.userInfo?[ConsoleFoldStore.idKey] as? String == id, let open = note.userInfo?[ConsoleFoldStore.openKey] as? Bool else { return }
            apply(open)
        }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            guard note.userInfo?[ConsolePreviewKey.fold] as? String == id, let open = note.userInfo?[ConsolePreviewKey.foldOpen] as? Bool else { return }
            set(open)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel([title, count].compactMap { $0 }.joined(separator: " "))
    }

    private func toggle(option: Bool) {
        let next = !isOpen
        set(next)
        if option, next { ConsoleFoldStore.foldSiblings(siblings, keeping: id) }
    }

    /// The one write: the store (remembered, posted), then the state or the binding.
    private func set(_ open: Bool) {
        ConsoleFoldStore.set(id, open)
        apply(open)
    }

    private func apply(_ open: Bool) {
        withAnimation(Motion.snappy) {
            if let external { external.wrappedValue = open } else { applied = open }
        }
    }
}

/// `[12][chevron 9][6][title sans 12 medium titanium — fg2 open][6][count mono 11]…[summary][control][12]`,
/// 28 or 24 tall; hover `hover`; → opens, ← folds while it has focus.
struct ConsoleDisclosureHead: View {
    let title: String
    var count: String? = nil
    var summary: [ConsoleDisclosureSummaryItem] = []
    let size: ConsoleDisclosureSize
    let open: Bool
    var focused = false
    var trailing: AnyView? = nil
    let toggle: () -> Void
    var set: (Bool) -> Void = { _ in }

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: toggle) { line.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .onKeyPress(.rightArrow) { set(true); return .handled }
                .onKeyPress(.leftArrow) { set(false); return .handled }
                .accessibilityLabel([title, count].compactMap { $0 }.joined(separator: " "))
                .accessibilityValue(open ? "" : ConsoleDisclosureSummary.text(summary))
                .accessibilityHint(open ? ConsoleDisclosureWords.fold : ConsoleDisclosureWords.unfold)
                .accessibilityAddTraits(open ? .isSelected : [])
            if open, let trailing { trailing.transition(Motion.swap) }
        }
        .padding(.horizontal, 12)
        .frame(height: size == .section ? 28 : 24)
        .background(hovering ? ConsoleTheme.hover : Color.clear)
        .modifier(ConsoleFocusRing(on: focused))
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: open)
    }

    private var line: some View {
        HStack(spacing: 6) {
            Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
                .rotationEffect(.degrees(open ? 90 : 0))
                .frame(width: 12, height: 12)
            Text(title).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(open ? ConsoleTheme.fg2 : ConsoleTheme.titanium).lineLimit(1)
            if let count {
                Text(count).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
                    .contentTransition(ConsoleMotion.numeric)
            }
            Spacer(minLength: 4)
            if !open { ConsoleDisclosureSummaryView(summary: summary).transition(Motion.swap) }
        }
    }
}

/// The closed head's right-hand words, ` · `-spaced: mono titanium · sans fg3 · one badge.
struct ConsoleDisclosureSummaryView: View {
    let summary: [ConsoleDisclosureSummaryItem]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(summary.enumerated()), id: \.offset) { _, item in
                switch item {
                case .mono(let s): Text(s).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
                case .words(let s): Text(s).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
                case .badge(let w): ConsoleBadge(word: w)
                }
            }
        }
        .layoutPriority(1)
    }
}

// MARK: - The summaries (pure, check-kit)

/// The words a folded head carries, built once per site so the seven Settings heads, the
/// Permissions areas, the Problems kinds, a tool's agents and a ledger month read alike.
enum ConsoleDisclosureSummary {
    typealias Summary = ConsoleDisclosureSummaryItem

    /// `Cedar · 🇬🇧 British` (the caller hands the accent with its flag, `AccentWords.title(_, short: false)`;
    /// design13) · `… · [recording]` while Recording is on (design12).
    static func audio(voice: String, accent: String, recording: Bool = false) -> [Summary] {
        var out: [Summary] = [.words(voice), .words(accent)]
        if recording { out.append(.badge(.word(ConsoleDisclosureWords.recording))) }
        return out
    }

    /// `Local · qwen3.5:27b [Ready]`; `ready` nil draws no badge.
    static func brain(kind: String, model: String?, ready: Bool?) -> [Summary] {
        var out: [Summary] = [.mono([kind, model].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ConsoleDisclosureWords.joiner))]
        if let ready { out.append(.badge(ready ? .ready : .failed)) }
        return out
    }

    /// `2 cloud · 2 mac`
    static func leaves(cloud: Int, mac: Int) -> [Summary] { [.mono(ConsoleDisclosureWords.cloudMac(cloud: cloud, mac: mac))] }

    /// `Notch · 10 min`
    static func session(home: String, idleMinutes: Int) -> [Summary] {
        [.mono([home, ConsoleDisclosureWords.minutes(idleMinutes)].joined(separator: ConsoleDisclosureWords.joiner))]
    }

    /// `[learned 12m]` · `[off]`
    static func memory(enabled: Bool, learnedAgo: String?) -> [Summary] {
        guard enabled else { return [.badge(.off)] }
        return learnedAgo.map { [.badge(.word(ConsoleDisclosureWords.learned($0)))] } ?? []
    }

    /// `forever · 30 d`
    static func retention(ledgerDays: Int?, trashDays: Int) -> [Summary] {
        let ledger = ledgerDays.map(ConsoleDisclosureWords.days) ?? ConsoleDisclosureWords.keepForever
        return [.mono([ledger, ConsoleDisclosureWords.days(trashDays)].joined(separator: ConsoleDisclosureWords.joiner))]
    }

    /// `[off]` · `on · 2 phrases`
    static func wake(enabled: Bool, phrases: Int) -> [Summary] {
        enabled ? [.words(ConsoleDisclosureWords.on), .mono(ConsoleDisclosureWords.phrases(phrases))] : [.badge(.off)]
    }

    /// A permission area: `[1 missing] Input Monitoring`, or the granted names as words.
    static func permissionGroup(missing: [String], granted: [String]) -> [Summary] {
        if !missing.isEmpty { return [.badge(.missing(missing.count)), .words(missing.joined(separator: ConsoleDisclosureWords.joiner))] }
        return granted.isEmpty ? [] : [.words(granted.joined(separator: ConsoleDisclosureWords.joiner))]
    }

    /// A problem kind's head: the first problem's line, whole (the row truncates it).
    static func problemGroup(first: String?) -> [Summary] { first.map { [.words($0)] } ?? [] }

    /// `Ready 2 · [all ok]` · `[1 missing]`
    static func ready(notReady: Int) -> [Summary] { notReady > 0 ? [.badge(.missing(notReady))] : [.badge(.allOk)] }

    /// A tool's agents: how many ask as one `[1 asks]` badge (amber), then ONE resting item — `2 working`,
    /// else `3 idle`, else (nothing alive) the word `ended` with the newest over row's age: `ended · 40m`.
    static func agents(asks: Int, working: Int, idle: Int, ended: Int, newestEndedAge: String?) -> [Summary] {
        var out: [Summary] = []
        if asks > 0 { out.append(.badge(.asks(asks))) }
        if working > 0 { out.append(.words(ConsoleDisclosureWords.working(working))) }
        else if idle > 0 { out.append(.words(ConsoleDisclosureWords.idle(idle))) }
        else if ended > 0 {
            out.append(.words(ConsoleDisclosureWords.endedWord))
            if let newestEndedAge { out.append(.mono(newestEndedAge)) }
        }
        return out
    }

    /// Archived: the count and what those conversations billed — `2 · 15 min`.
    static func chains(count: Int, billedSeconds: Double) -> [Summary] {
        [.mono([String(count), ConsoleFormat.billedShort(billedSeconds)].joined(separator: ConsoleDisclosureWords.joiner))]
    }

    /// A folded day: what it billed — `26 min`.
    static func day(billedSeconds: Double) -> [Summary] { [.mono(ConsoleFormat.billedShort(billedSeconds))] }

    /// The folded Older head: the oldest day inside — `since Aug 2`.
    static func older(since day: String) -> [Summary] { [.mono(ConsoleDisclosureWords.since(ConsoleFormat.shortDay(day)))] }

    /// A ledger month: the read days' figures summed (`62 min · $3.10`), nothing until one is read.
    static func ledgerMonth(read: Int, billedSeconds: Double) -> [Summary] {
        read > 0 ? [.mono(ConsoleFormat.billed(billedSeconds))] : []
    }

    /// Archived · Trash · Hidden: what is inside (`3 days · 129 MB`).
    static func fold(inside: String?) -> [Summary] { inside.map { [.mono($0)] } ?? [] }

    /// The summary as one line (`Local · qwen3.5:27b · [Ready]`) — the AX value and the harness's pin.
    static func text(_ summary: [Summary]) -> String {
        summary.map { item -> String in
            switch item {
            case .mono(let s), .words(let s): return s
            case .badge(let w): return "[\(ConsoleBadge.text(w))]"
            }
        }.joined(separator: ConsoleDisclosureWords.joiner)
    }
}
