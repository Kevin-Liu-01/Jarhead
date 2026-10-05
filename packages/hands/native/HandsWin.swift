import Foundation

// MARK: - Kevin's hands win: the decisions, apart from the window server
//
// The helper never acts while Kevin's hands are on the machine (`busy`), and a `type` stops part way
// when they land on it or when the place its keystrokes land moves. Those judgments live here as pure
// code over an injected event clock. The helper feeds them CGEventSource and AX (Input.swift); the
// headless harness (harness/hands-win/main.swift, built and run by harness/hands-win/check.sh) feeds
// them a clock it moves and posts nothing.
//
// The session is read two ways per kind of input (a key press, a click, a scroll; a pointer move is
// not one, a resting hand jitters):
// - By time. The newest event of the kind is someone else's when it is not within `ownPostSlackSec` of
//   this process's last post of that kind. Our next post is newer, so by time alone Kevin's key is lost
//   the moment we type again.
// - By count. The session counts every event of the kind from every source; this process counts its
//   own posts. Whatever the session counted beyond ours is someone else's, however many of our posts
//   came after it. That is what a later own post cannot mask.
//
// Every read attributes what was counted since the one before it. So an op that skips the busy
// check (dictation, a mouse up) still reads the ledger: otherwise Kevin's key from long before is
// found by count at the next read and timed at our newest post, and holds the next op for nothing.

/// Kevin's last key, click or scroll this recent means his hands are on the machine.
let kevinQuietMs: Double = 1500
/// The session stamps our own post within this of the moment we noted it.
let ownPostSlackSec: TimeInterval = 0.030
/// An own post the session has not counted yet is in flight for at most this long. A count still short
/// of ours after it means posts the session never saw (without Accessibility they are dropped), and the
/// balance re-bases, so those posts never hide a later foreign one.
let ownPostSettleSec: TimeInterval = 0.5
/// How often a `type` re-reads the front app and the focused element between graphemes.
let frontCheckSec: TimeInterval = 0.050
/// After this many focus reads in a row that could not say (a hung app times out each one), a `type`
/// stops re-reading the focus and keeps only the front app check, so it is never slowed to the AX
/// timeout per grapheme.
let focusMissLimit = 2

/// The kinds of input that hold the hands.
enum InputKind: Int, CaseIterable {
    case key = 0
    case click = 1
    case scroll = 2
}

/// One kind as the session reports it right now.
struct KindReading {
    /// Events of the kind the session has counted from every source (summed over its event types).
    var count: Int64
    /// Milliseconds since the newest event of each of the kind's event types the session has seen.
    var msAgo: [Double]

    init(count: Int64, msAgo: [Double]) {
        self.count = count
        self.msAgo = msAgo
    }
}

/// The window server as the decisions read it: CGEventSource in the helper, a moved clock in the harness.
struct EventClock {
    let now: () -> TimeInterval
    let read: (InputKind) -> KindReading
}

/// What this process posted, and what the session counted beyond it.
struct HandsLedger {
    private var own: [Int64] = [0, 0, 0]
    private var lastOwnAt: [TimeInterval] = [-1, -1, -1]
    /// The session's count minus ours at its high-water mark, per kind; nil before the first read.
    private var balance: [Int64?] = [nil, nil, nil]
    /// The newest moment a foreign event found by count can have happened; -1 when none was.
    private(set) var lastCountedForeignAt: TimeInterval = -1
    /// Told each time the session counted more of a kind than we posted: how many, and whether the
    /// newest event of the kind is a post of ours by time. That case is Kevin's event masked by our
    /// next post, or the premise failing (our posts counted twice, or late): the helper logs it.
    var onCountedForeign: ((InputKind, Int64, Bool) -> Void)?

    init() {}

    /// Called immediately before each post of a kind.
    mutating func noteOwnPost(_ kind: InputKind, at t: TimeInterval) {
        own[kind.rawValue] += 1
        lastOwnAt[kind.rawValue] = t
    }

    /// Is an event of `kind` at `eventAt` ours by time (within the slack of our last post of the kind)?
    func isOwn(_ kind: InputKind, eventAt: TimeInterval) -> Bool {
        let last = lastOwnAt[kind.rawValue]
        return last >= 0 && abs(eventAt - last) <= ownPostSlackSec
    }

    /// Reads the session once and returns the newest moment someone else pressed a key, clicked or
    /// scrolled, by time or by count; nil when nobody has since the first read.
    mutating func newestForeign(_ clock: EventClock) -> TimeInterval? {
        let now = clock.now()
        var newest = lastCountedForeignAt
        for kind in InputKind.allCases {
            let i = kind.rawValue
            let reading = clock.read(kind)
            var newestOfKind: TimeInterval? = nil
            for ms in reading.msAgo {
                let at = now - ms / 1000
                if !isOwn(kind, eventAt: at) { newest = max(newest, at) }
                newestOfKind = max(newestOfKind ?? at, at)
            }
            let b = reading.count - own[i]
            guard let seen = balance[i] else {
                // The first read: what came before it is history, judged by time alone.
                balance[i] = b
                continue
            }
            if b > seen {
                // The session counted more than we posted since the last read: someone else's, and no
                // older than the newest event of the kind (which may be a post of ours that came after it).
                let at = newestOfKind ?? now
                lastCountedForeignAt = max(lastCountedForeignAt, at)
                newest = max(newest, at)
                balance[i] = b
                onCountedForeign?(kind, b - seen, isOwn(kind, eventAt: at))
            } else if b < seen {
                let last = lastOwnAt[i]
                if last < 0 || now - last >= ownPostSettleSec { balance[i] = b }
            }
        }
        return newest >= 0 ? newest : nil
    }

    /// Reads the session without judging it, for an op that skips the busy check: what the session
    /// counted beyond our posts so far is attributed now, so the posts that follow are not counted against it.
    mutating func observe(_ clock: EventClock) {
        _ = newestForeign(clock)
    }

    /// Milliseconds since the newest foreign key press, click or scroll; nil when there was none.
    mutating func foreignMs(_ clock: EventClock) -> Double? {
        guard let at = newestForeign(clock) else { return nil }
        return max(0, (clock.now() - at) * 1000)
    }

    /// Kevin's last key, click or scroll in ms when it is inside the quiet window; nil when the machine is free to act on.
    mutating func busyMs(_ clock: EventClock) -> Int? {
        guard let ms = foreignMs(clock), ms < kevinQuietMs else { return nil }
        return Int(ms.rounded())
    }
}

// MARK: - Where a type lands

/// Why a `type` stopped part way.
enum TypeCancelReason: String {
    /// The client's stop.
    case stop
    /// Kevin pressed a key, clicked or scrolled after the type began.
    case busy
    /// The front app changed, or the focus moved to another window or out of text entry.
    case focusMoved = "focus_moved"
}

/// Where keystrokes land, as the decisions compare it: tokens for the focused element and its window,
/// and whether the element takes text. The helper makes them from AX elements; the harness, from strings.
struct FocusMark {
    let element: AnyHashable
    let window: AnyHashable?
    let takesText: Bool

    init(element: AnyHashable, window: AnyHashable?, takesText: Bool) {
        self.element = element
        self.window = window
        self.takesText = takesText
    }
}

/// Has the place keystrokes land moved off `base`? Yes when the focus is in another window (a sheet, a
/// dialog), or when it left text entry (onto a list, a button). A new element in the same window that
/// still takes text has not moved: a code box advancing to the next, an editor block the app re-made as
/// it was typed into. Kevin's own click or key is not judged here; it is a foreign event, so `busy`.
func focusHasMoved(from base: FocusMark, to now: FocusMark) -> Bool {
    if now.element == base.element { return false }
    if let a = base.window, let b = now.window, a != b { return true }
    return base.takesText && !now.takesText
}

/// Reads where keystrokes land now. It is handed the mark being watched (nil for a first read): when the
/// focused element is still that one, it returns the mark as it is, one AX read instead of four.
typealias FocusReader = (FocusMark?) -> FocusMark?

/// The front app and the focused element during a `type`, re-read at most every `frontCheckSec`
/// between graphemes. A switch mid-word lands the rest of the text nowhere, not in the new place.
struct FrontWatch {
    /// The pid the caller judged the type against (`expectFront`); nil when it gave none.
    let pid: Int32?
    /// Where the keystrokes land; nil when accessibility could not say.
    private(set) var focus: FocusMark?
    private let readPid: () -> Int32?
    private let readFocus: FocusReader
    private var lastCheckAt: TimeInterval = -1
    /// Focus reads in a row that could not say; at `focusMissLimit` the focus is no longer re-read.
    private(set) var focusMisses = 0
    private(set) var moved = false

    init(pid: Int32?, focus: FocusMark?, readPid: @escaping () -> Int32?, readFocus: @escaping FocusReader) {
        self.pid = pid
        self.focus = focus
        self.readPid = readPid
        self.readFocus = readFocus
    }

    /// A separator key (Return, Tab) moved the focus on purpose: where it landed is the place to watch now.
    mutating func rebase(_ focus: FocusMark?) {
        self.focus = focus
    }

    mutating func check(now: TimeInterval) -> Bool {
        if moved { return true }
        if pid == nil && focus == nil { return false }
        if lastCheckAt >= 0, now - lastCheckAt < frontCheckSec { return false }
        lastCheckAt = now
        if let pid {
            guard let front = readPid(), front == pid else {
                moved = true
                return true
            }
        }
        guard let base = focus, focusMisses < focusMissLimit else { return false }
        guard let mark = readFocus(base) else {
            focusMisses += 1
            return false
        }
        focusMisses = 0
        if focusHasMoved(from: base, to: mark) {
            moved = true
            return true
        }
        return false
    }
}

/// One `type` op's stop decision.
struct TypeWatch {
    /// False for dictation (`ownDriver`): Kevin is the one typing, so his keys are no reason to stop.
    let busyCheck: Bool
    var front: FrontWatch

    init(busyCheck: Bool, front: FrontWatch) {
        self.busyCheck = busyCheck
        self.front = front
    }

    /// Why to stop now, if at all: the client's stop, then Kevin's hands, then the place the keystrokes
    /// land. The op's guard passed before its first post, so a foreign event inside the quiet window now
    /// came after the op began (or raced its start). Without the busy check the ledger is still read,
    /// once per grapheme, so his keys are attributed as they come and not at the next op's guard.
    mutating func cancelReason(stopped: Bool, ledger: inout HandsLedger, clock: EventClock) -> TypeCancelReason? {
        if stopped { return .stop }
        if busyCheck {
            if ledger.busyMs(clock) != nil { return .busy }
        } else {
            ledger.observe(clock)
        }
        if front.check(now: clock.now()) { return .focusMoved }
        return nil
    }
}

/// How a run of graphemes ended.
enum GraphemeRun: Equatable {
    /// Every grapheme went out.
    case done(typed: Int)
    /// Stopped before grapheme `typed`: that many landed.
    case cancelled(typed: Int, reason: TypeCancelReason)
    /// The events for grapheme `typed` could not be made: that many landed before it.
    case postFailed(typed: Int)
}

/// Types `text` one grapheme cluster at a time: `cancel` is asked before each, `post` sends one and
/// says whether its events could be made.
func runGraphemes(_ text: String, cancel: () -> TypeCancelReason?, post: (Character) -> Bool) -> GraphemeRun {
    var typed = 0
    for cluster in text {
        if let why = cancel() { return .cancelled(typed: typed, reason: why) }
        guard post(cluster) else { return .postFailed(typed: typed) }
        typed += 1
    }
    return .done(typed: typed)
}
