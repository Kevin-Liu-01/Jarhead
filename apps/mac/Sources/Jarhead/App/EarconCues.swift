import Foundation

/// Which moments sound (docs/AUDIO.md § The sounds), as pure rules over the snapshot: the phase edges
/// and the problems. The AppDelegate feeds them and plays what they return through `Earcons`, the one
/// gate (no sound while the session's microphone runs, the drain, the dedupe, the priorities).
/// Compiled by `Scripts/earcon-check.sh` with Model/ and Audio/ (no UI), so it names no UI type.
enum EarconCues {
    struct Cue: Equatable {
        var earcon: Earcon
        /// Seconds after the edge (the night tuck's slip).
        var delay: Double
    }

    /// A phase edge's sound; nil is silence.
    /// - asleep | paused → connecting: `awake`, at once — before `updateAudioActivity()` starts the graph,
    ///   and the wire is held until it has passed (the gate's own `Glass` and this are one sound, deduped).
    /// - a session phase | connecting → paused: `pause` (the graph has stopped; the session is closed).
    /// - a session phase | connecting → asleep: `sleep`, with the tuck (`tuck` = OrbPanelController.sleepTuckDelay).
    ///   Never from paused (pause decaying to sleep changes nothing audible).
    /// - connecting → error: `problem` (a wake that could not open: voice.key, voice.limit, voice.connection).
    /// Session start, reconnects, mute and everything inside a session are silent: the voice speaks there.
    static func edge(from: Phase, to: Phase, tuck: Double) -> Cue? {
        guard from != to else { return nil }
        let wasLive = AppState.inSessionPhases.contains(from) || from == .connecting
        switch to {
        case .connecting where from == .asleep || from == .paused:
            return Cue(earcon: .awake, delay: 0)
        case .paused where wasLive:
            return Cue(earcon: .pause, delay: 0)
        case .asleep where wasLive:
            return Cue(earcon: .sleep, delay: tuck)
        case .error where from == .connecting:
            return Cue(earcon: .problem, delay: 0)
        default:
            return nil
        }
    }

    /// The edge into a phase where the session's microphone runs (`AppState.voiceAudioRuns`) from one where it
    /// does not: `Earcons.enterVoice` runs here, before `updateAudioActivity()` starts the graph.
    static func entersVoice(from: Phase, to: Phase) -> Bool {
        AppState.voiceAudioRuns(in: to) && !AppState.voiceAudioRuns(in: from)
    }

    /// The problem kinds that need Kevin and sound outside a session. `automation.*` stay silent (he was
    /// away; the island has them), and so does everything amber that can wait.
    static func problemSounds(_ kind: String) -> Bool {
        if kind.hasPrefix("voice.") { return true }
        return ["brain.unavailable", "daemon", "crash", "hands.helper", "app.version", "permission.microphone"].contains(kind)
    }

    /// Quiet hours (`Settings.automations.quietHours`, "HH:MM" local, wrapping midnight): the core's `inSpan`.
    static func inQuiet(_ span: ClockSpan?, at date: Date, calendar: Calendar = .current) -> Bool {
        guard let span, let from = minutes(span.from), let to = minutes(span.to), from != to else { return false }
        let c = calendar.dateComponents([.hour, .minute], from: date)
        let m = (c.hour ?? 0) * 60 + (c.minute ?? 0)
        return from < to ? (m >= from && m < to) : (m >= from || m < to)
    }

    private static func minutes(_ clock: String) -> Int? {
        let parts = clock.split(separator: ":")
        guard parts.count == 2, parts[1].count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0...23).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }

    /// A `local.say` that lands while `connecting`. The microphone already runs, so it is not sounded then, and
    /// it is not lost either: the engine holds a fire's lines for the opening session and rings them only when
    /// none opens, and that frame (or an open's tink, or an alarm's re-ring) can overtake the phase's snapshot.
    /// Kept until the phase leaves `connecting`: it plays when the phase lands quiet (asleep, paused, error) and
    /// is dropped when a session opened (the voice has the lines). Older than `maxAge` by then, it is dropped.
    struct LocalSayHold {
        enum Verdict: Equatable {
            /// A quiet phase: ring and speak it now.
            case play
            /// Connecting: kept for `settle`.
            case hold
            /// A session's microphone runs: the voice says the fire's lines.
            case drop
        }

        static let maxAge = 30.0
        private(set) var held: [(message: LocalSayMessage, at: Double)] = []

        mutating func arrive(_ message: LocalSayMessage, phase: Phase, now: Double) -> Verdict {
            if phase == .connecting {
                held.append((message, now))
                return .hold
            }
            return AppState.voiceAudioRuns(in: phase) ? .drop : .play
        }

        /// The phase changed: what was held, to play now (oldest first) — nothing while still connecting, or
        /// when a session opened.
        mutating func settle(phase: Phase, now: Double) -> [LocalSayMessage] {
            guard phase != .connecting else { return [] }
            let out = AppState.voiceAudioRuns(in: phase) ? [] : held.filter { now - $0.at < LocalSayHold.maxAge }.map(\.message)
            held.removeAll()
            return out
        }
    }

    /// The problem sound's own gate: never in the first 15 s after launch (the daemon is still settling and
    /// replays what it had), never in quiet hours, at most once per kind per 10 minutes, and only for a kind
    /// that was not in the last list (a republished snapshot is not a new problem).
    struct ProblemGate: Equatable {
        static let launchQuiet = 15.0
        static let perKind = 600.0

        var launchedAt: Double
        var seen: Set<String> = []
        var soundedAt: [String: Double] = [:]

        init(launchedAt: Double) { self.launchedAt = launchedAt }

        /// The kinds in `problems` that should sound now; remembers the list either way. `quiet`: quiet hours,
        /// or a session runs (a problem raised inside one is the voice's to say, and never sounds later).
        mutating func admit(_ problems: [Problem], now: Double, quiet: Bool) -> [String] {
            let kinds = Set(problems.map(\.kind))
            let fresh = kinds.subtracting(seen)
            seen = kinds
            guard now - launchedAt >= ProblemGate.launchQuiet, !quiet else { return [] }
            var out: [String] = []
            for kind in fresh.sorted() where EarconCues.problemSounds(kind) {
                if let at = soundedAt[kind], now - at < ProblemGate.perKind { continue }
                soundedAt[kind] = now
                out.append(kind)
            }
            return out
        }
    }
}
