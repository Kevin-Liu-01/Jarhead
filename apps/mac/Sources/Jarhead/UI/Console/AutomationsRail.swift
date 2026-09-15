import SwiftUI
import AppKit

// Automations on the Console (design11): what Kevin set while awake and the daemon carries out
// while asleep. Three pieces, all on the kit: `AutomationsSection` — the Now rail's section
// between Circled and Threads (a head with `Add…`, `ConsoleRow`s under `ConsoleGroupHead`s, the
// Trash fold, the honest line, `ConsoleEmpty`); `AutomationRingRow` — the 28 pt line under the
// tabs while a row is `fired` (reads `AppState.ringing`, like `CrashNoticeRow` reads `lastCrash`,
// so the rail's Equatable inputs stay untouched); `AutomationsFold` — Settings › Automations (the
// switch, the unattended chips, quiet hours, the two steppers, the recipes, Open at login), every
// write a `set-settings` patch or one of the twelve `automation.*` / `recipe.*` commands.
// The words: Snooze · Done · Skip · Pause · Resume · Run now · Rename · Move to Trash · Restore ·
// Add… · Add recipe… — no deleting word, no cancelling word on a control, Return never a yes. A resting row
// carries no badge; the exceptional word alone wears one (`snoozed` · `off` · `deferred` · `failed`
// · `billed` · `asks` · `ringing`). Every visible string is on `AutomationWords`, pinned by check-kit.

enum AutomationWords {
    // the section and the fold
    static let section = "Automations"
    static let add = "Add…"
    static let next = "next"
    static let clock = "Clock"
    static let watchers = "Watchers"
    static let trash = "Trash"
    static let restoreInRow = "Restore in the row"
    static let honest = "Nothing fires while Jarhead is quit."
    static let empty = "No automations yet. Say “wake me at 7:10”."
    // the verbs (surfaces: Move to Trash and Restore, never a deleting word)
    static let snooze = "Snooze"
    static let done = "Done"
    static let skip = "Skip"
    static let pause = "Pause"
    static let resume = "Resume"
    static let runNow = "Run now"
    static let rename = "Rename"
    static let moveToTrash = "Move to Trash"
    static let restore = "Restore"
    static let open = "Open"
    static let edit = "Edit"
    static let save = "Save"
    static let addRecipe = "Add recipe…"
    static func more(_ n: Int) -> String { "+\(n)" }
    static func snoozeMinutes(_ n: Int) -> String { "\(n) min" }
    static let snoozeSteps = [5, 10, 30]
    // the card
    static let fires = "fires"
    static let last = "last"
    static let does = "does"
    static let cost = "cost"
    static let nothingBilled = "nothing billed"
    static let never = "never"
    static let opensRow = "Opens its row"
    static let returnKey = "⏎"
    static func brainMinutes(_ perFire: Int, cap: Int) -> String { "≈ \(perFire) brain min per fire · up to \(cap) a day" }
    static func cooldown(_ s: Int) -> String { "cooldown \(s) s" }
    static let neverOverwrites = "never overwrites"
    static let onlyInFront = "only while it is in front"
    static let rejudged = "re-judged every fire"
    // the words a row's meta and value use
    static let today = "today"
    static let tomorrow = "tomorrow"
    static let ends = "ends"
    static let snoozed = "snoozed"
    static let paused = "paused"
    static let missed = "missed"
    static let onAFile = "on a file"
    static let dash = "—"
    static let dot = " · "
    static let plus = " + "
    static let times = "×"
    static let seconds = " s"
    static let openWord = "open"
    static let sayWord = "say"
    // action kinds → the chip / menu word
    static let actionKinds = ["chime", "say", "notify", "open", "file", "run-recipe", "press", "wake-brain"]
    static func actionWord(_ kind: String) -> String {
        switch kind {
        case "run-recipe": return "run recipe"
        case "wake-brain": return "wake brain"
        default: return kind
        }
    }
    static let states = ["armed", "snoozed", "firing", "fired", "deferred", "paused", "done", "failed", "trashed"]
    static func stateWord(_ state: String) -> String { state == "paused" ? ConsoleBadgeWords.off : state }
    // Settings › Automations
    static let fold = "Automations"
    static let enabledRow = "Automations"
    static let enabledHint = "fire while asleep"
    static let whileAsleep = "While asleep"
    static let tierHint = "the run tier · wake brain is billed"
    static let quietHours = "Quiet hours"
    static let quietHint = "alarms still ring"
    static let quietOff = "Off"
    static let arrow = "→"
    static let snoozeRow = "Snooze"
    static let minutesUnit = "min"
    static let brainMinutesRow = "Brain minutes"
    static let perDayUnit = "/day"
    static let brainHint = "billed · per automation"
    static let recipes = "Recipes"
    static let recipesFigure = "re-judged every fire"
    static let asksHint = "a recipe the shell gate would ask about is listed, never armed"
    static let openAtLogin = "Open at login"
    static let openAtLoginHint = "back after a reboot"
    static let recipeName = "name"
    static let recipeCommand = "command"
    static func approve(_ name: String) -> String { "Approve “\(name)” to run unattended" }
    static let keep = "Keep as is"
    static let keepName = "Keep the name"
    static func approved(_ day: String) -> String { "approved \(day)" }
    static let recipeTimeout: Double = 120
    static func armed(_ n: Int) -> String { "\(n) armed" }
    // the Add… form — the When field takes the words the voice takes (core's parseWhen is the one grammar)
    static let nameField = "name"
    static let whenField = "weekdays 09:00 · in 12 min · tomorrow 07:10"
    static let doesField = "Does"
    static let whenRule = "When, in the voice's words: a clock, weekdays · daily · weekends, tomorrow, in 12 min, every 2 h"
    // the echo line the Add… form reads back from Kevin's own words (the brain's echo lives in core)
    static let echoRing = "ring"
    /// The second press of a confirm-tier kind: the word becomes the deed, the question above it is the yes.
    static func arm(_ name: String) -> String { "Arm “\(name)”" }
    static let letGo = "Keep it unarmed"
    static func trashedRecipe(_ day: String) -> String { "trashed \(day)" }
    // ids (fold · tips · fields)
    static let trashFold = "now.automations.trash"
    static let recipeTrashFold = "settings.recipes.trash"
    static let ringTip = "now.ring"
    static let addId = "now.automations.add"
    static let whenId = "now.automations.when"
    static let doesId = "now.automations.does"
    static let enabledId = "settings.automations.enabled"
    static let quietFromId = "settings.automations.quietFrom"
    static let quietToId = "settings.automations.quietTo"
    static let snoozeId = "settings.automations.snooze"
    static let budgetId = "settings.automations.budget"
    static let loginId = "settings.automations.login"
    static let recipeNameId = "settings.recipe.name"
    static let recipeCommandId = "settings.recipe.command"
    static func tip(_ id: String) -> String { "now.automation.\(id)" }
    static func recipeTip(_ name: String) -> String { "settings.recipe.\(name)" }
    static func chipId(_ kind: String) -> String { "settings.automations.chip.\(kind)" }
    // a11y
    static func row(_ name: String, _ kind: String, _ state: String) -> String { "\(kind) \(name), \(state)" }
    static func ring(_ line: String) -> String { "Ringing: \(line)" }
    static let dismissRing = "Done — stops the ring"
    static let enabledLabel = "Automations on or off"
    static let loginLabel = "Open Jarhead at login"
    static let snoozeLabel = "Snooze minutes"
    static let budgetLabel = "Brain minutes a day"
    static func chipLabel(_ kind: String) -> String { "\(actionWord(kind)) while asleep" }
    static let quietFromLabel = "Quiet hours from"
    static let quietToLabel = "Quiet hours to"
}

// MARK: - Formats (pure, check-kit)

extension ConsoleFormat {
    /// `4:12` · `1:02:03` — a timer's remaining time; never negative.
    static func countdown(_ ms: Double) -> String {
        let s = Int(max(0, ms) / 1000)
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        if h > 0 { return "\(h):" + pad2(m) + ":" + pad2(sec) }
        return "\(m):" + pad2(sec)
    }

    private static func pad2(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}

/// One row's words: the glyph, the value at the right, the meta line, the badge, the resting verb.
/// Pure over `Automation` + a clock, so the harness pins them.
enum AutomationFormat {
    static func glyph(_ a: Automation) -> String {
        switch a.kind {
        case .alarm: return "alarm.fill"
        case .timer: return "timer"
        case .reminder: return "bell.fill"
        case .routine: return "repeat"
        case .watcher: return a.when.on?.kind == "recipe.red" ? "terminal.fill" : "eye.fill"
        }
    }

    /// A clock row (its next fire is a time) or a watcher (its next fire is a signal).
    static func isClock(_ a: Automation) -> Bool { a.kind != .watcher }

    static func isTimerRunning(_ a: Automation) -> Bool { a.kind == .timer && a.state == "armed" && a.nextAt != nil }

    /// The exceptional word, or none: `snoozed` · `off` (paused) · `deferred` · `failed` · `ringing` (fired) · `billed`.
    static func badge(_ a: Automation) -> ConsoleBadge.Word? {
        switch a.state {
        case "snoozed": return .snoozed
        case "paused": return .off
        case "deferred": return .deferred
        case "failed": return .failed
        case "fired": return .ringing
        default: return a.isBilled ? .billed : nil
        }
    }

    /// The figure at the right: the next clock, a ticking countdown, a watcher's fires or poll.
    static func value(_ a: Automation, now: Double, remaining: Double?) -> String? {
        if a.kind == .timer, a.state == "armed" {
            if let remaining { return ConsoleFormat.countdown(remaining) }
            if let next = a.nextAt { return ConsoleFormat.countdown(next - now) }
        }
        if a.kind == .watcher {
            if let every = a.when.on?.everySeconds { return "\(Int(every))" + AutomationWords.seconds }
            return "\(a.fires)" + AutomationWords.times
        }
        if a.state == "snoozed", let until = a.snoozedUntil { return ConsoleFormat.clock(until) }
        return a.nextAt.map(ConsoleFormat.clock)
    }

    /// `weekdays` · `12:00` · `today` · `*.pdf` · `build-check` — the first word of the meta line.
    static func whenWord(_ a: Automation, now: Double) -> String {
        switch a.when.kind {
        case "every": return a.when.phrase ?? a.when.every?.kind ?? ""
        case "in": return ConsoleFormat.countdown(a.when.ms ?? 0)
        case "at": return dayWord(a.nextAt ?? a.when.at ?? now, now: now)
        case "on": return triggerWord(a.when.on)
        default: return a.when.kind
        }
    }

    /// `today` · `tomorrow` · `Mon` for a one-shot's day.
    static func dayWord(_ at: Double, now: Double) -> String {
        let cal = Calendar.current
        let day = Date(timeIntervalSince1970: at / 1000), today = Date(timeIntervalSince1970: now / 1000)
        if cal.isDate(day, inSameDayAs: today) { return AutomationWords.today }
        if let next = cal.date(byAdding: .day, value: 1, to: today), cal.isDate(day, inSameDayAs: next) { return AutomationWords.tomorrow }
        return day.formatted(.dateTime.weekday(.abbreviated))
    }

    /// A watcher's signal as one word: its glob, its recipe, its app, else the kind.
    static func triggerWord(_ on: SystemEvent?) -> String {
        guard let on else { return "" }
        if let glob = on.glob { return glob }
        if let recipe = on.recipe { return recipe }
        if let app = on.app { return app }
        return on.kind
    }

    /// `chime + say` · `open Notes` · `file + chime` — the actions in order.
    static func actionsWord(_ a: Automation) -> String {
        a.then.map { act -> String in
            switch act.kind {
            case "open": return [AutomationWords.openWord, act.app ?? act.url ?? act.path].compactMap { $0 }.joined(separator: " ")
            case "run-recipe": return AutomationWords.actionWord(act.kind) + (act.recipe.map { " " + $0 } ?? "")
            default: return AutomationWords.actionWord(act.kind)
            }
        }.joined(separator: AutomationWords.plus)
    }

    /// The meta line's tail: what the state adds — `6 h` to the next fire, `ends 12:00`, `snoozed 10`,
    /// `paused 2d`, the last fire's clock, a failure's detail.
    static func tail(_ a: Automation, now: Double) -> String? {
        switch a.state {
        case "snoozed":
            guard let until = a.snoozedUntil else { return AutomationWords.snoozed }
            return AutomationWords.snoozed + " " + "\(max(1, Int((until - now) / 60_000)))"
        case "paused": return AutomationWords.paused + " " + ConsoleFormat.relative(a.updatedAt, now: now)
        case "failed": return a.lastDetail
        default: break
        }
        if a.kind == .timer, let next = a.nextAt { return AutomationWords.ends + " " + ConsoleFormat.clock(next) }
        if a.kind == .watcher { return a.lastFiredAt.map(ConsoleFormat.clock) }
        if let next = a.nextAt { return untilWord(next - now) }
        return nil
    }

    /// `6 h` · `42 min` · `3 d` — how long until a clock fires.
    static func untilWord(_ ms: Double) -> String {
        let m = Int(max(0, ms) / 60_000)
        if m < 60 { return "\(m) min" }
        let h = m / 60
        if h < 48 { return "\(h) h" }
        return "\(h / 24) d"
    }

    /// `weekdays · chime + say · 6 h` — the row's line 2, truncated by the row with an ellipsis.
    static func meta(_ a: Automation, now: Double) -> String {
        [whenWord(a, now: now), actionsWord(a), tail(a, now: now)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: AutomationWords.dot)
    }

    /// The 58 pt verb drawn at rest: Resume while paused, Skip while snoozed or deferred or failed,
    /// Done while ringing or while a timer runs, Restore in the Trash, else Pause.
    static func restingVerb(_ a: Automation) -> String {
        switch a.state {
        case "paused": return AutomationWords.resume
        case "snoozed", "deferred", "failed": return AutomationWords.skip
        case "fired": return AutomationWords.done
        case "trashed": return AutomationWords.restore
        default: return a.kind == .timer ? AutomationWords.done : AutomationWords.pause
        }
    }

    /// The card's `next` value: `07:10 · tomorrow` for a clock, `— · on a file` for a watcher.
    static func nextWord(_ a: Automation, now: Double) -> String {
        if a.kind == .watcher { return AutomationWords.dash + AutomationWords.dot + (a.when.on?.kind == "folder.file" || a.when.on?.kind == "download.done" ? AutomationWords.onAFile : triggerWord(a.when.on)) }
        guard let next = a.nextAt else { return AutomationWords.dash }
        return ConsoleFormat.clock(next) + AutomationWords.dot + dayWord(next, now: now)
    }

    /// The card's `fires`: the count, and a watcher's cooldown.
    static func firesWord(_ a: Automation) -> String {
        guard a.kind == .watcher else { return "\(a.fires)" }
        let cooldown = Int(a.clauses.cooldown ?? 30)
        return "\(a.fires)" + AutomationWords.dot + AutomationWords.cooldown(cooldown)
    }

    /// The card's `last`: `14:02 · filed invoice.pdf`, or `never`.
    static func lastWord(_ a: Automation) -> String {
        guard let at = a.lastFiredAt else { return AutomationWords.never }
        return [ConsoleFormat.clock(at), a.lastDetail].compactMap { $0 }.joined(separator: AutomationWords.dot)
    }

    /// The card's `does`: the actions and the rail that holds them (`never overwrites` · `only while it is in front`).
    static func doesWord(_ a: Automation) -> String {
        var parts = [actionsWord(a)]
        let kinds = Set(a.then.map(\.kind))
        if kinds.contains("file") { parts.append(AutomationWords.neverOverwrites) }
        if kinds.contains("press") { parts.append(AutomationWords.onlyInFront) }
        if kinds.contains("run-recipe") { parts.append(AutomationWords.rejudged) }
        return parts.joined(separator: AutomationWords.dot)
    }

    /// The card's `cost`: `nothing billed`, or the brain minutes a wake-brain row spends.
    static func costWord(_ a: Automation, cap: Int) -> String {
        guard let wake = a.then.first(where: { $0.kind == "wake-brain" }) else { return AutomationWords.nothingBilled }
        let perFire = max(1, Int(((wake.budget?.seconds ?? 120) / 60).rounded(.up)))
        return AutomationWords.brainMinutes(perFire, cap: cap)
    }

    /// The ring line split for the row: a leading `HH:mm` in mono, the words after it.
    static func ringParts(_ line: String) -> (figure: String?, words: String) {
        guard let range = line.range(of: AutomationWords.dot) else { return (nil, line) }
        let head = String(line[..<range.lowerBound])
        guard head.count == 5, head.dropFirst(2).first == ":" else { return (nil, line) }
        return (head, String(line[range.upperBound...]))
    }

    /// A recipe's line 2: `~/bin/backup.sh · 120 s · approved Sep 12`; in the Trash, `~/bin/backup.sh · trashed Sep 14`.
    static func recipeMeta(_ r: ShellRecipe, home: String = NSHomeDirectory()) -> String {
        var command = r.command
        if command.hasPrefix(home) { command = "~" + command.dropFirst(home.count) }
        if let trashedAt = r.trashedAt {
            return [command, AutomationWords.trashedRecipe(dayWord(trashedAt))].joined(separator: AutomationWords.dot)
        }
        return [command, "\(Int(r.timeoutSeconds))" + AutomationWords.seconds, AutomationWords.approved(dayWord(r.approvedAt))].joined(separator: AutomationWords.dot)
    }

    /// `Sep 12` — the day a stamp fell on.
    static func dayWord(_ at: Double) -> String {
        Date(timeIntervalSince1970: at / 1000).formatted(.dateTime.month(.abbreviated).day())
    }

    /// The clock the section's head and the fold's summary say: the earliest armed clock row.
    static func nextClock(_ rows: [Automation], nextFire: NextFire?) -> String? {
        if let nextFire { return ConsoleFormat.clock(nextFire.at) }
        let next = rows.filter { $0.state == "armed" || $0.state == "snoozed" || $0.state == "deferred" }.compactMap(\.nextAt).min()
        return next.map(ConsoleFormat.clock)
    }

    /// The rows the rails count as set: everything that is not done or in the Trash.
    static func armedCount(_ rows: [Automation]) -> Int { rows.filter { !$0.isTerminal }.count }

    /// The hours a quiet-hours menu lists: Off first, then every hour.
    static let quietOptions: [String] = [""] + (0..<24).map { String(format: "%02d:00", $0) }
    static func quietTitle(_ v: String) -> String { v.isEmpty ? AutomationWords.quietOff : v }

    /// A chip flip keeps the contract's order (`AUTOMATION_ACTION_KINDS`), never Kevin's click order.
    static func toggled(_ unattended: [String], _ kind: String) -> [String] {
        var set = Set(unattended)
        if set.contains(kind) { set.remove(kind) } else { set.insert(kind) }
        return AutomationWords.actionKinds.filter { set.contains($0) }
    }
}

extension ConsoleDisclosureSummary {
    /// `6 armed · next 07:10` · `[off]` when the switch is off · nothing while nothing is set.
    static func automations(armed: Int, next: String?, enabled: Bool = true) -> [Summary] {
        guard enabled else { return [.badge(.off)] }
        guard armed > 0 else { return [] }
        var parts = [AutomationWords.armed(armed)]
        if let next { parts.append(AutomationWords.next + " " + next) }
        return [.mono(parts.joined(separator: ConsoleDisclosureWords.joiner))]
    }
}

extension ConsoleTipCard {
    /// The row's whole story: name · the state word (or `billed`) · the echo line as the sentence ·
    /// next · fires · last · does · cost · `Opens its row ⏎`.
    static func automation(_ a: Automation, now: Double, cap: Int) -> ConsoleTipCard {
        let billed = a.isBilled
        return ConsoleTipCard(title: a.name, badge: billed ? .billed : nil, status: billed ? nil : AutomationWords.stateWord(a.state),
                              lines: [a.echo],
                              foot: [(AutomationWords.next, AutomationFormat.nextWord(a, now: now)),
                                     (AutomationWords.fires, AutomationFormat.firesWord(a)),
                                     (AutomationWords.last, AutomationFormat.lastWord(a)),
                                     (AutomationWords.does, AutomationFormat.doesWord(a)),
                                     (AutomationWords.cost, AutomationFormat.costWord(a, cap: cap))],
                              last: (AutomationWords.opensRow, AutomationWords.returnKey))
    }

    /// The ring row's card when its row is not in the list: the line whole, the calm line, when it rang.
    static func ring(_ r: RingLine) -> ConsoleTipCard {
        ConsoleTipCard(title: r.name, badge: .ringing, lines: [r.line, r.calm ?? ""],
                       foot: [(AutomationWords.last, ConsoleFormat.clock(r.at))])
    }
}

// MARK: - The Now section

/// `Automations 6 · next 07:10 [Add…]` · Clock rows · Watcher rows · the Trash fold · the honest
/// line. Reads AppState (rows, the next fire, the timers' ticks) the way CrashNoticeRow reads it.
struct AutomationsSection: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.consoleActions) private var actions
    @StateObject private var focus = ConsoleListFocus()
    @State private var renamingId: String?
    @State private var adding = false
    @State private var trashOpen = false

    private var rows: [Automation] { state.automations.filter { $0.state != "trashed" } }
    private var trashed: [Automation] { state.automations.filter { $0.state == "trashed" } }
    private var clockRows: [Automation] { rows.filter(AutomationFormat.isClock) }
    private var watcherRows: [Automation] { rows.filter { !AutomationFormat.isClock($0) } }
    private var grouped: Bool { !clockRows.isEmpty && !watcherRows.isEmpty }
    private var settings: AutomationSettings { state.snapshot.settings.automationSettings }
    private var nextClock: String? { AutomationFormat.nextClock(rows, nextFire: state.nextFire) }
    private var ids: [String] { rows.map(\.id) + (trashOpen ? trashed.map(\.id) : []) }

    var body: some View {
        // A daemon before the field lists nothing: no section, no claim.
        if state.snapshot.automations != nil {
            VStack(alignment: .leading, spacing: 0) {
                head
                if adding {
                    AutomationAddForm(settings: settings, asking: state.snapshot.recipesAsking ?? [], localBrain: state.snapshot.settings.brain == .local,
                                      close: { adding = false })
                        .transition(Motion.appear)
                }
                if rows.isEmpty, trashed.isEmpty {
                    ConsoleEmpty(AutomationWords.empty)
                } else {
                    list
                }
                honest
                ConsoleHairline()
            }
            .animation(Motion.gentle, value: rows.map(\.id))
            .animation(Motion.snappy, value: adding)
            .transition(Motion.appear)
        }
    }

    private var head: some View {
        ConsoleSectionHead(AutomationWords.section, count: rows.isEmpty ? nil : AutomationFormat.armedCount(rows)) {
            HStack(spacing: 8) {
                if let nextClock, !rows.isEmpty {
                    Text(AutomationWords.dot.trimmingCharacters(in: .whitespaces) + " " + AutomationWords.next + " " + nextClock)
                        .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
                }
                Spacer(minLength: 4)
                Button(AutomationWords.add) { withAnimation(Motion.snappy) { adding.toggle() } }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .consoleHelp(AutomationWords.whenRule, id: AutomationWords.addId)
            }
        }
    }

    /// The rows tick once a second while a timer runs, else every 30 s (the `6 h` tails).
    private var list: some View {
        let ticking = rows.contains(where: AutomationFormat.isTimerRunning)
        return TimelineView(.periodic(from: .now, by: ticking ? 1 : 30)) { ctx in
            AutomationRowsBody(rows: rows, clockRows: clockRows, watcherRows: watcherRows, grouped: grouped, trashed: trashed,
                               now: ctx.date.timeIntervalSince1970 * 1000, nextClock: nextClock, settings: settings,
                               focus: focus, renamingId: $renamingId, trashOpen: $trashOpen, remaining: state.timerRemaining)
        }
        .consoleListKeys(ConsoleListKeys(focus: focus, ids: ids, typeAhead: true, primary: { ConsoleTip.pin(AutomationWords.tip($0)) }))
    }

    private var honest: some View {
        Text(AutomationWords.honest).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
            .padding(.horizontal, 12)
            .frame(height: 28)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The groups and their rows, then the Trash fold — one body so the timeline's clock reaches every row.
struct AutomationRowsBody: View {
    let rows: [Automation]
    let clockRows: [Automation]
    let watcherRows: [Automation]
    let grouped: Bool
    let trashed: [Automation]
    let now: Double
    let nextClock: String?
    let settings: AutomationSettings
    @ObservedObject var focus: ConsoleListFocus
    @Binding var renamingId: String?
    @Binding var trashOpen: Bool
    let remaining: [String: Double]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if grouped {
                ConsoleGroupHead(title: AutomationWords.clock, count: "\(clockRows.count)", figure: nextClock)
                ForEach(clockRows) { row(for: $0) }
                ConsoleGroupHead(title: AutomationWords.watchers, count: "\(watcherRows.count)")
                ForEach(watcherRows) { row(for: $0) }
            } else {
                ForEach(rows) { row(for: $0) }
            }
            if !trashed.isEmpty { trashFold }
        }
    }

    @ViewBuilder private func row(for a: Automation) -> some View {
        if renamingId == a.id {
            AutomationRenameRow(automation: a) { renamingId = nil }.transition(Motion.appear)
        } else {
            AutomationRow(automation: a, now: now, remaining: remaining[a.id], settings: settings, focus: focus, rename: { renamingId = a.id })
                .transition(Motion.appear)
        }
    }

    /// `› Trash 1 · Restore in the row` — `.group`, the rows sit back with Restore as the verb.
    private var trashFold: some View {
        ConsoleDisclosure(id: AutomationWords.trashFold, title: AutomationWords.trash, count: "\(trashed.count)",
                          summary: [.words(AutomationWords.restoreInRow)], size: .group, open: $trashOpen, focused: focus.ringOn(AutomationWords.trashFold)) {
            VStack(spacing: 0) {
                ForEach(trashed) { a in
                    AutomationRow(automation: a, now: now, remaining: nil, settings: settings, focus: focus, rename: {}).transition(Motion.appear)
                }
            }
        }
    }
}

/// One automation as a `ConsoleRow`: the kind's glyph (acting green while a timer runs), the name,
/// the exceptional badge, the value, the meta line, the resting verb, ⋯ with the whole verb array,
/// the tier-2 card. Every verb is one of the twelve commands; nothing here deletes.
struct AutomationRow: View {
    let automation: Automation
    let now: Double
    let remaining: Double?
    let settings: AutomationSettings
    @ObservedObject var focus: ConsoleListFocus
    let rename: () -> Void

    @Environment(\.consoleActions) private var actions

    private var a: Automation { automation }
    private var id: String { AutomationWords.tip(a.id) }
    private var running: Bool { AutomationFormat.isTimerRunning(a) }
    private var sitsBack: Bool { a.state == "paused" || a.state == "trashed" || a.state == "done" }

    var body: some View {
        ConsoleRow(title: a.name, icon: .glyph(AutomationFormat.glyph(a), tint: running ? ConsoleTheme.acting : ConsoleTheme.titanium),
                   badge: AutomationFormat.badge(a), value: AutomationFormat.value(a, now: now, remaining: remaining),
                   meta: AutomationFormat.meta(a, now: now), trailing: a.state == "trashed" ? ConsoleRow.Trailing.none : .ellipsis(verbs),
                   verb: restingVerb, focused: focus.ringOn(id), sitsBack: sitsBack, id: id,
                   card: ConsoleTipCard.automation(a, now: now, cap: settings.wakeBudgetMinutesPerDay),
                   accessibilityHint: AutomationWords.row(a.name, a.kind.label, AutomationWords.stateWord(a.state)),
                   onHover: { if $0 { focus.hovered(id) } },
                   verbsOpen: focus.verbsOpen == id, closeVerbs: focus.closeVerbs,
                   primary: { focus.set(id, keyboard: false, why: "click"); ConsoleTip.pin(id) })
    }

    private var snoozeMinutes: Int { a.kind == .timer ? 5 : settings.snoozeMinutes }

    private var restingVerb: ConsoleRowVerb {
        let title = AutomationFormat.restingVerb(a)
        return ConsoleRowVerb(title: title, help: help(title)) { run(title) }
    }

    private func help(_ verb: String) -> String {
        switch verb {
        case AutomationWords.resume: return HelpCopy.resumeThread(a.name).hint
        case AutomationWords.skip: return HelpCopy.skip.hint
        case AutomationWords.done: return HelpCopy.done.hint
        case AutomationWords.restore: return HelpCopy.restoreTrash.hint
        default: return HelpCopy.pauseAutomation.hint
        }
    }

    private func run(_ verb: String) {
        switch verb {
        case AutomationWords.resume: actions.send(.automationResume(id: a.id))
        case AutomationWords.skip: actions.send(.automationSkip(id: a.id))
        case AutomationWords.done: actions.send(.automationDone(id: a.id))
        case AutomationWords.restore: actions.send(.automationRestore(id: a.id))
        default: actions.send(.automationPause(id: a.id))
        }
    }

    /// `Run now · Snooze ▸ 5 / 10 / 30 · Skip · Pause|Resume · Rename · — · Move to Trash`.
    private var verbs: [ConsoleVerb] {
        let paused = a.state == "paused"
        let snoozes = AutomationWords.snoozeSteps.map { m in
            ConsoleVerb(id: "snooze.\(m)", title: AutomationWords.snoozeMinutes(m), checked: m == snoozeMinutes) { actions.send(.automationSnooze(id: a.id, minutes: m)) }
        }
        return [ConsoleVerb(id: "run", title: AutomationWords.runNow) { actions.send(.automationRun(id: a.id)) },
                ConsoleVerb(id: "snooze", title: AutomationWords.snooze, children: snoozes),
                ConsoleVerb(id: "skip", title: AutomationWords.skip) { actions.send(.automationSkip(id: a.id)) },
                ConsoleVerb(id: paused ? "resume" : "pause", title: paused ? AutomationWords.resume : AutomationWords.pause) {
                    actions.send(paused ? .automationResume(id: a.id) : .automationPause(id: a.id))
                },
                ConsoleVerb(id: "rename", title: AutomationWords.rename, run: rename),
                ConsoleVerb(id: "trash", title: AutomationWords.moveToTrash, destructive: true, separatorBefore: true) { actions.send(.automationTrash(id: a.id)) }]
    }
}

/// Rename in place: the name in a `.edit` field where the title was; Return commits `automation.rename`,
/// Esc puts the old name back, × keeps it and closes the field.
struct AutomationRenameRow: View {
    let automation: Automation
    let close: () -> Void

    @Environment(\.consoleActions) private var actions
    @State private var draft = ""

    var body: some View {
        HStack(spacing: 8) {
            ConsoleIcon(name: AutomationFormat.glyph(automation))
            ConsoleField(text: $draft, placeholder: automation.name, size: .edit, id: AutomationWords.tip(automation.id) + ".rename",
                         accessibilityLabel: AutomationWords.rename, onCommit: commit)
            Button(action: close) { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 22))
                .consoleHelp(AutomationWords.keepName)
                .accessibilityLabel(AutomationWords.keepName)
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .onAppear { draft = automation.name }
    }

    private func commit() {
        let name = String(draft.trimmingCharacters(in: .whitespaces).prefix(24))
        if !name.isEmpty, name != automation.name { actions.send(.automationRename(id: automation.id, name: name)) }
        close()
    }
}

// MARK: - Add… (the Console form: name · when · does)

/// The When field is Kevin's words, sent as `whenPhrase`: core's `parseWhen` is the one grammar (the
/// voice's tool, the CLI and this form), so the Console parses nothing — the engine refuses with
/// parseWhen's own text as the toast. A confirm-tier kind (run recipe · wake brain) is the two-press
/// idiom: the first press puts the engine's question on screen — mirrored word for word from core's
/// policy (the cost line, the recipe line) — and turns Save into the deed; the second press sends.
/// Nothing is recorded as heard that was not on screen.
enum AutomationForm {
    static let doesKinds = ["chime", "say", "notify", "open", "run-recipe", "wake-brain"]
    /// The kinds the engine confirms: the form shows their question before the second press.
    static let confirmKinds: Set<String> = ["run-recipe", "wake-brain"]
    /// A wake-brain row from the form: 25 steps, two minutes — the cost line says so.
    static let wakeBudget = AutomationBudget(steps: 25, seconds: 120)

    /// The one line the row reads back, from Kevin's own words: `Weekdays 09:00, ring “standup”.` ·
    /// `In 12 min, ring “pasta”.` — nothing parsed, the phrase capitalised.
    static func echo(name: String, phrase: String, kind: String) -> String {
        let verb = kind == "chime" ? AutomationWords.echoRing : AutomationWords.actionWord(kind)
        let words = phrase.trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return "" }
        // Two statements, not one six-term `+` chain of String and Substring (CI's older Swift).
        let capitalised = String(first).uppercased() + String(words.dropFirst())
        return [capitalised, ", ", verb, " “", name, "”."].joined()
    }

    /// The draft `automation.set` sends: Kevin's phrase as `whenPhrase` (no `when`), one action of `kind`
    /// carrying the name — a chime's line, a banner's title, an app to open, a recipe's name, a wake-brain's
    /// prompt — and quiet hours respected unless it is an alarm (a chime on a clock).
    static func draft(name: String, phrase: String, kind: String) -> AutomationDraft {
        let clean = String(name.prefix(24))
        // Named lets, one switch — not six inline ternaries in one init (CI's older Swift).
        var line: String?
        var title: String?
        var app: String?
        var recipe: String?
        var prompt: String?
        var budget: AutomationBudget?
        var speak: Bool?
        switch kind {
        case "notify": title = clean
        case "open": app = clean
        case "run-recipe": recipe = clean
        case "wake-brain":
            prompt = clean
            budget = wakeBudget
            speak = true
        default: line = clean
        }
        let action = AutomationAction(kind: kind, line: line, sound: nil, title: title, body: nil, open: nil, app: app, url: nil, path: nil, into: nil,
                                      recipe: recipe, key: nil, prompt: prompt, budget: budget, speak: speak)
        let clauses = AutomationClauses(window: nil, days: nil, once: nil, cooldown: nil, until: nil, quiet: kind == "chime" ? "override" : "respect")
        return AutomationDraft(name: clean, whenPhrase: phrase, then: [action], clauses: clauses, echo: echo(name: clean, phrase: phrase, kind: kind))
    }

    /// core's `costLine`, word for word — what the engine records as `confirmed.heard` for a wake-brain row,
    /// so what Kevin read is what the ledger says he heard. N = ⌈seconds / 60⌉, M = Brain minutes a day.
    static func costLine(_ budget: AutomationBudget, cap: Int, local: Bool) -> String {
        let n = max(1, Int((budget.seconds / 60).rounded(.up)))
        let minutes = n == 1 ? "brain minute" : "brain minutes"
        let whereWord = local ? "a model warm-up on this Mac" : "on Kevin's plan"
        return "this wakes the brain — not the voice — while Jarhead is asleep: about \(n) \(minutes) per fire \(whereWord), up to \(cap) a day; its one-line answer is spoken by the local speaker / shown as a banner"
    }

    /// core's run-recipe question, word for word: `recipe backup (~/bin/backup.sh) will run unattended, without a yes each time`.
    static func recipeLine(_ recipe: ShellRecipe) -> String {
        let command = recipe.command.count > 80 ? String(recipe.command.prefix(77)) + "…" : recipe.command
        return "recipe \(recipe.name) (\(command)) will run unattended, without a yes each time"
    }

    /// The recipes the form may name: live (not in the Trash) and not rated `asks` by the shell gate.
    static func pickable(_ recipes: [ShellRecipe], asking: [String]) -> [ShellRecipe] {
        let asks = Set(asking.map { $0.lowercased() })
        return recipes.filter { !$0.isTrashed && !asks.contains($0.name.lowercased()) }
    }

    /// The question the engine will ask for this draft — shown before the second press — or nil for a free kind
    /// (and for a recipe the form may not name: then there is nothing to arm).
    static func question(kind: String, name: String, recipes: [ShellRecipe], asking: [String], cap: Int, local: Bool) -> String? {
        switch kind {
        case "wake-brain": return costLine(wakeBudget, cap: cap, local: local)
        case "run-recipe":
            let wanted = name.lowercased()
            return pickable(recipes, asking: asking).first { $0.name.lowercased() == wanted }.map(recipeLine)
        default: return nil
        }
    }

    /// A kind the Does menu offers greyed: wake brain until its chip is on and Brain minutes is above 0;
    /// run recipe until its chip is on and a recipe can be named. Off in Settings is refused by the engine, not asked.
    static func disabled(kind: String, settings: AutomationSettings, asking: [String]) -> Bool {
        switch kind {
        case "wake-brain": return !settings.unattended.contains(kind) || settings.wakeBudgetMinutesPerDay <= 0
        case "run-recipe": return !settings.unattended.contains(kind) || pickable(settings.recipes, asking: asking).isEmpty
        default: return false
        }
    }
}

struct AutomationAddForm: View {
    let settings: AutomationSettings
    /// `snapshot.recipesAsking`: the recipes the gate would question — never named here.
    let asking: [String]
    let localBrain: Bool
    let close: () -> Void

    @Environment(\.consoleActions) private var actions
    @State private var name = ""
    @State private var when = ""
    @State private var kind = "chime"
    @State private var armed = false

    private var cleanName: String { String(name.trimmingCharacters(in: .whitespaces).prefix(24)) }
    private var phrase: String { when.trimmingCharacters(in: .whitespaces) }
    private var needsYes: Bool { AutomationForm.confirmKinds.contains(kind) }
    private var question: String? {
        AutomationForm.question(kind: kind, name: cleanName, recipes: settings.recipes, asking: asking, cap: settings.wakeBudgetMinutesPerDay, local: localBrain)
    }
    /// A name and a phrase; a confirm-tier kind also needs the question it will show (a recipe the form may name).
    private var valid: Bool { !cleanName.isEmpty && !phrase.isEmpty && (!needsYes || question != nil) }
    /// The preview under the fields echoes the phrase as the row will read it back; it computes nothing.
    private var preview: String? { cleanName.isEmpty || phrase.isEmpty ? nil : AutomationForm.echo(name: cleanName, phrase: phrase, kind: kind) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ConsoleField(text: $name, placeholder: AutomationWords.nameField, size: .row, id: AutomationWords.addId + ".name", accessibilityLabel: AutomationWords.nameField)
            ConsoleField(text: $when, placeholder: AutomationWords.whenField, size: .row, mono: true, id: AutomationWords.whenId, accessibilityLabel: AutomationWords.whenRule)
            HStack(spacing: 8) {
                ConsoleMenuField(value: kind, options: AutomationForm.doesKinds, title: AutomationWords.actionWord, pick: { kind = $0 },
                                 id: AutomationWords.doesId, label: AutomationWords.doesField,
                                 badge: { $0 == "wake-brain" ? [.billed] : [] },
                                 disabled: { AutomationForm.disabled(kind: $0, settings: settings, asking: asking) })
                if !armed {
                    Button(AutomationWords.save, action: firstPress)
                        .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 26, small: true))
                        .disabled(!valid)
                        .transition(.opacity)
                }
            }
            if let preview { ConsoleHint(preview, indent: 0).transition(Motion.appear) }
            if armed, let question { deed(question).transition(Motion.appear) }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .animation(Motion.snappy, value: armed)
        // A changed field lets go of the first press: the question on screen must be this draft's.
        .onChange(of: kind) { _, _ in armed = false }
        .onChange(of: name) { _, _ in armed = false }
        .onChange(of: when) { _, _ in armed = false }
    }

    /// Save: a free kind sends at once; a confirm-tier kind puts the question on screen and waits for the second press.
    private func firstPress() {
        guard valid else { return }
        if needsYes { withAnimation(Motion.snappy) { armed = true } } else { send() }
    }

    /// The question the engine will record as heard — on screen, verbatim — and the deed under it with × beside;
    /// left alone it lets go after 8 s. Return is never the yes: a click alone presses it.
    private func deed(_ question: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ConsoleHint(question, tone: ConsoleTheme.speaking, indent: 0)
            HStack(spacing: 4) {
                Button(AutomationWords.arm(cleanName), action: send)
                    .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 26, small: true))
                Button { withAnimation(Motion.snappy) { armed = false } } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 26))
                .consoleHelp(AutomationWords.letGo)
                .accessibilityLabel(AutomationWords.letGo)
            }
        }
        .task {
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            withAnimation(Motion.snappy) { armed = false }
        }
    }

    private func send() {
        guard valid else { return }
        actions.send(.automationSet(AutomationForm.draft(name: cleanName, phrase: phrase, kind: kind)))
        armed = false
        close()
    }
}

// MARK: - The ring row (the CrashNoticeRow slot)

/// `🔔 07:10 · Wake up, Kevin [Snooze] [Done]` — 28 pt under the tabs, on every tab, while a row is
/// `fired`. The bell is amber and breathes (still under Reduce Motion); the presses are the ring's own
/// (`RingLine.presses`) and go to `automation.snooze` / `automation.done` — never a Go, never a yes.
struct AutomationRingRow: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.consoleActions) private var actions
    @State private var breathing = false

    var body: some View {
        ZStack(alignment: .top) {
            if let ring = state.ringing {
                VStack(spacing: 0) {
                    line(ring)
                        .padding(.horizontal, 12)
                        .frame(height: 28)
                        .consoleHelp(id: AutomationWords.ringTip, card: card(ring))
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(AutomationWords.ring(ring.line))
                    ConsoleHairline()
                }
                .transition(Motion.appear)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(Motion.gentle, value: state.ringing == nil)
    }

    /// One Text (the clock in mono, the words sans) so the line truncates as a whole; 4 pt gaps and no
    /// spacer floor keep `07:10 · Wake up, Kevin · Snooze · Done` (≈ 290 pt) inside the 296 rail.
    private func line(_ ring: RingLine) -> some View {
        HStack(spacing: 4) {
            ConsoleIcon(name: "bell.fill", tint: ConsoleTheme.speaking)
                .opacity(breathing ? 0.55 : 1)
                .onAppear(perform: breathe)
            Self.lineText(ring.line).foregroundStyle(ConsoleTheme.fg).lineLimit(1).truncationMode(.tail)
            if ring.more > 0 {
                Text(AutomationWords.more(ring.more)).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
            }
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                ForEach(Array(ring.presses.enumerated()), id: \.offset) { _, press in pressButton(press, ring: ring) }
            }
        }
    }

    static func lineText(_ line: String) -> Text {
        let parts = AutomationFormat.ringParts(line)
        guard let figure = parts.figure else { return Text(line).font(ConsoleTheme.sans(12)) }
        return Text(figure).font(ConsoleTheme.mono(12, .medium)) + Text(AutomationWords.dot + parts.words).font(ConsoleTheme.sans(12))
    }

    /// The pulse is one opacity ease, repeated; Reduce Motion leaves the bell lit and still.
    private func breathe() {
        guard !Motion.reduced else { return }
        withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) { breathing = true }
    }

    @ViewBuilder private func pressButton(_ press: AutomationPress, ring: RingLine) -> some View {
        switch press.kind {
        case "snooze":
            let minutes = press.minutes ?? state.snapshot.settings.automationSettings.snoozeMinutes
            Button(AutomationWords.snooze) { actions.send(.automationSnooze(id: ring.id, minutes: minutes)) }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .consoleHelp(HelpCopy.snooze(minutes))
        case "open":
            Button(AutomationWords.open) { if let target = press.target { actions.open(target) } }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .consoleHelp(NowWords.opens(press.target ?? ""))
        default:
            Button(AutomationWords.done) { actions.send(.automationDone(id: ring.id)) }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .consoleHelp(HelpCopy.done)
        }
    }

    private func card(_ ring: RingLine) -> ConsoleTipCard {
        guard let row = state.automations.first(where: { $0.id == ring.id }) else { return .ring(ring) }
        return .automation(row, now: ConsoleFormat.nowMs, cap: state.snapshot.settings.automationSettings.wakeBudgetMinutesPerDay)
    }
}

// MARK: - Settings › Automations

/// The fold: `Automations [On|Off] fire while asleep` · the eight chips · quiet hours · Snooze ·
/// Brain minutes · Recipes (rows with Edit, `asks` amber) · Open at login. Every write replaces the
/// block through `set-settings` (SettingsPatch.automations); a recipe goes through `recipe.set` /
/// `recipe.trash`. The head's control while open is `Add recipe…`.
struct AutomationsFold: View {
    let settings: Settings

    @EnvironmentObject private var state: AppState
    @Environment(\.consoleActions) private var actions
    @State private var recipeForm: RecipeFormState?

    private var block: AutomationSettings { settings.automationSettings }
    private var armed: Int { AutomationFormat.armedCount(state.automations) }
    private var nextClock: String? { AutomationFormat.nextClock(state.automations.filter { $0.state != "trashed" }, nextFire: state.nextFire) }

    var body: some View {
        ConsoleDisclosure(id: SettingsWords.automationsFold, title: AutomationWords.fold, count: armed > 0 ? "\(armed)" : nil,
                          summary: ConsoleDisclosureSummary.automations(armed: armed, next: nextClock, enabled: block.enabled),
                          size: .section, trailing: addRecipe, siblings: SettingsWords.folds, inset: true) {
            VStack(spacing: 2) {
                switchRow
                chipsRow
                quietRow
                stepperRows
                RecipesList(recipes: block.recipes, asking: state.snapshot.recipesAsking ?? [], form: $recipeForm)
                loginRow
            }
            .animation(Motion.gentle, value: block)
        }
    }

    private func write(_ change: (inout AutomationSettings) -> Void) {
        var next = block
        change(&next)
        var p = SettingsPatch()
        p.automations = next
        actions.send(.setSettings(p))
    }

    private var switchRow: some View {
        ConsoleFormRow(AutomationWords.enabledRow) {
            ConsoleToggle(on: block.enabled, hint: AutomationWords.enabledHint, id: AutomationWords.enabledId, accessibilityLabel: AutomationWords.enabledLabel) { on in
                write { $0.enabled = on }
            }
        }
    }

    /// The eight kinds as chips: selected = may fire while asleep; the three acting chips off by default.
    private var chipsRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            ConsoleFormRow(AutomationWords.whileAsleep, height: 26) {
                ConsoleFlow(hSpacing: 6, vSpacing: 6) {
                    ForEach(AutomationWords.actionKinds, id: \.self) { kind in
                        ConsoleChip(word: AutomationWords.actionWord(kind), on: block.unattended.contains(kind)) {
                            write { $0.unattended = AutomationFormat.toggled($0.unattended, kind) }
                        }
                        .consoleHelp(AutomationWords.chipLabel(kind), id: AutomationWords.chipId(kind))
                    }
                }
                .padding(.vertical, 2)
            }
            ConsoleHint(AutomationWords.tierHint)
        }
    }

    private var quietRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            ConsoleFormRow(AutomationWords.quietHours) {
                HStack(spacing: 6) {
                    quietMenu(block.quietHours?.from ?? "", id: AutomationWords.quietFromId, label: AutomationWords.quietFromLabel) { from in
                        write { $0.quietHours = from.isEmpty ? nil : ClockSpan(from: from, to: $0.quietHours?.to ?? "07:00") }
                    }
                    Text(AutomationWords.arrow).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                    quietMenu(block.quietHours?.to ?? "", id: AutomationWords.quietToId, label: AutomationWords.quietToLabel) { to in
                        write { $0.quietHours = to.isEmpty ? nil : ClockSpan(from: $0.quietHours?.from ?? "23:00", to: to) }
                    }
                }
            }
            ConsoleHint(AutomationWords.quietHint)
        }
    }

    private func quietMenu(_ value: String, id: String, label: String, pick: @escaping (String) -> Void) -> some View {
        ConsoleMenuField(value: value, options: AutomationFormat.quietOptions, title: AutomationFormat.quietTitle, pick: pick, mono: true, id: id, label: label,
                         fieldQuiet: { $0.isEmpty }, width: 220)
            // 80: `23:00` mono 12 + the chevron inside the field's padding; two of them and the arrow fill the 182 column.
            .frame(width: 80)
    }

    private var stepperRows: some View {
        VStack(alignment: .leading, spacing: 2) {
            ConsoleFormRow(AutomationWords.snoozeRow) {
                ConsoleStepper(value: block.snoozeMinutes, unit: AutomationWords.minutesUnit, range: 1...60, id: AutomationWords.snoozeId, accessibilityLabel: AutomationWords.snoozeLabel) { m in
                    write { $0.snoozeMinutes = m }
                }
            }
            ConsoleFormRow(AutomationWords.brainMinutesRow) {
                ConsoleStepper(value: block.wakeBudgetMinutesPerDay, unit: AutomationWords.perDayUnit, range: 0...120, id: AutomationWords.budgetId, accessibilityLabel: AutomationWords.budgetLabel) { m in
                    write { $0.wakeBudgetMinutesPerDay = m }
                }
            }
            ConsoleHint(AutomationWords.brainHint)
        }
    }

    private var loginRow: some View {
        ConsoleFormRow(AutomationWords.openAtLogin) {
            ConsoleToggle(on: block.openAtLogin, hint: AutomationWords.openAtLoginHint, id: AutomationWords.loginId, accessibilityLabel: AutomationWords.loginLabel) { on in
                write { $0.openAtLogin = on }
            }
        }
        .padding(.top, 6)
    }

    private var addRecipe: AnyView {
        AnyView(Button(AutomationWords.addRecipe) { withAnimation(Motion.snappy) { recipeForm = recipeForm == nil ? RecipeFormState() : nil } }
            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
            .consoleHelp(HelpCopy.addRecipe))
    }
}

/// What the recipe form holds: a new recipe, or one being edited (its old name, so Save replaces it).
struct RecipeFormState: Equatable {
    var editing: String? = nil
    var name = ""
    var command = ""
}

/// `Recipes 3 · re-judged every fire`, a row per recipe, the `asks` hint, and the form when one is
/// being added or edited.
struct RecipesList: View {
    let recipes: [ShellRecipe]
    /// `snapshot.recipesAsking`: the names the shell gate would question now (the `asks` badge, never pickable).
    let asking: [String]
    @Binding var form: RecipeFormState?

    @Environment(\.consoleActions) private var actions
    @State private var trashOpen = false

    private var asks: Set<String> { Set(asking) }
    /// The rows: live recipes above, the Trash fold under them (a trashed recipe is never a pick, never a target).
    private var live: [ShellRecipe] { recipes.filter { !$0.isTrashed } }
    private var trashed: [ShellRecipe] { recipes.filter(\.isTrashed) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ConsoleGroupHead(title: AutomationWords.recipes, count: live.isEmpty ? nil : "\(live.count)", figure: AutomationWords.recipesFigure)
                .padding(.horizontal, -12)
                .padding(.top, 6)
            if let form { RecipeForm(state: form, save: save).transition(Motion.appear) }
            ForEach(live) { r in
                RecipeRow(recipe: r, asks: asks.contains(r.name), edit: { self.form = RecipeFormState(editing: r.name, name: r.name, command: r.command) },
                          trash: { actions.send(.recipeTrash(name: r.name)) })
                    .padding(.horizontal, -12)
                    .transition(Motion.appear)
            }
            if live.contains(where: { asks.contains($0.name) }) { ConsoleHint(AutomationWords.asksHint).padding(.top, 4) }
            if !trashed.isEmpty { trashFold.padding(.horizontal, -12).padding(.top, 4) }
        }
        .animation(Motion.gentle, value: recipes.map { $0.name + ($0.isTrashed ? "†" : "") })
        .animation(Motion.snappy, value: form)
    }

    /// `› Trash 1 · Restore in the row` — `.group`; the rows sit back with Restore as the verb, sending `recipe.restore`.
    private var trashFold: some View {
        ConsoleDisclosure(id: AutomationWords.recipeTrashFold, title: AutomationWords.trash, count: "\(trashed.count)",
                          summary: [.words(AutomationWords.restoreInRow)], size: .group, open: $trashOpen) {
            VStack(spacing: 0) {
                ForEach(trashed) { r in
                    RecipeRow(recipe: r, asks: false, edit: {}, trash: {}, restore: { actions.send(.recipeRestore(name: r.name)) })
                        .transition(Motion.appear)
                }
            }
        }
    }

    /// Save is the yes: `recipe.set` with Kevin's press as `approvedAt`; a rename trashes the old name first.
    private func save(_ s: RecipeFormState) {
        let name = String(s.name.trimmingCharacters(in: .whitespaces).prefix(24))
        let command = s.command.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !command.isEmpty else { return }
        if let old = s.editing, old != name { actions.send(.recipeTrash(name: old)) }
        actions.send(.recipeSet(ShellRecipe(name: name, command: command, cwd: nil, timeoutSeconds: AutomationWords.recipeTimeout, approvedAt: ConsoleFormat.nowMs)))
        form = nil
    }
}

/// `⌨ backup [Edit] ⋯` with `~/bin/backup.sh · 120 s · approved Sep 12` under it; `asks` amber sits back 0.62.
/// In the Trash the row sits back with Restore as its one verb and no ⋯ (nothing to edit, nothing to pick).
struct RecipeRow: View {
    let recipe: ShellRecipe
    let asks: Bool
    let edit: () -> Void
    let trash: () -> Void
    var restore: (() -> Void)? = nil

    var body: some View {
        if let restore, recipe.isTrashed {
            // Restore is the row's one verb, pressed on its button (the automations Trash fold's idiom): a click
            // on the row itself does nothing — a deed is never a click that landed anywhere.
            ConsoleRow(title: recipe.name, icon: .glyph("terminal.fill", tint: ConsoleTheme.titanium), meta: AutomationFormat.recipeMeta(recipe),
                       trailing: ConsoleRow.Trailing.none, verb: ConsoleRowVerb(title: AutomationWords.restore, help: HelpCopy.restoreTrash.hint, run: restore),
                       mono: true, sitsBack: true, id: AutomationWords.recipeTip(recipe.name), primary: {})
        } else {
            liveRow
        }
    }

    private var liveRow: some View {
        ConsoleRow(title: recipe.name, icon: .glyph("terminal.fill", tint: ConsoleTheme.titanium), badge: asks ? .asks : nil,
                   meta: AutomationFormat.recipeMeta(recipe),
                   trailing: .ellipsis([ConsoleVerb(id: "edit", title: AutomationWords.edit, run: edit),
                                        ConsoleVerb(id: "trash", title: AutomationWords.moveToTrash, destructive: true, separatorBefore: true, run: trash)]),
                   verb: ConsoleRowVerb(title: AutomationWords.edit, help: asks ? HelpCopy.asksRecipe.hint : nil, run: edit),
                   mono: true, sitsBack: asks, id: AutomationWords.recipeTip(recipe.name),
                   card: asks ? ConsoleTipCard(title: recipe.name, badge: .asks, lines: [HelpCopy.asksRecipe.hint, recipe.command]) : nil,
                   primary: edit)
    }
}

/// name · command (`.row`, mono) and a primary Save that is the two-press idiom: the first press
/// turns the word into the deed — *Approve “backup” to run unattended* — with × beside it; the
/// second press sends `recipe.set`; left alone it lets go after 8 s.
struct RecipeForm: View {
    let state: RecipeFormState
    let save: (RecipeFormState) -> Void

    @State private var name = ""
    @State private var command = ""
    @State private var armed = false

    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !command.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ConsoleField(text: $name, placeholder: AutomationWords.recipeName, size: .row, mono: true, id: AutomationWords.recipeNameId, accessibilityLabel: AutomationWords.recipeName)
            ConsoleField(text: $command, placeholder: AutomationWords.recipeCommand, size: .row, mono: true, id: AutomationWords.recipeCommandId, accessibilityLabel: AutomationWords.recipeCommand)
            HStack(spacing: 4) {
                if armed { approve } else { saveButton }
            }
            .animation(Motion.snappy, value: armed)
        }
        .padding(.top, 6)
        .padding(.bottom, 6)
        .onAppear { name = state.name; command = state.command }
    }

    private var saveButton: some View {
        Button(AutomationWords.save) { withAnimation(Motion.snappy) { armed = true } }
            .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 26, small: true))
            .disabled(!valid)
            .transition(.opacity)
    }

    private var approve: some View {
        HStack(spacing: 4) {
            Button(AutomationWords.approve(String(name.trimmingCharacters(in: .whitespaces).prefix(24)))) {
                withAnimation(Motion.snappy) { armed = false }
                save(RecipeFormState(editing: state.editing, name: name, command: command))
            }
            .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 26, small: true))
            Button { withAnimation(Motion.snappy) { armed = false } } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
            }
            .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 26))
            .consoleHelp(AutomationWords.keep)
            .accessibilityLabel(AutomationWords.keep)
        }
        .transition(.opacity)
        .task {
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            withAnimation(Motion.snappy) { armed = false }
        }
    }
}
