import Foundation

// The hands-win decision harness (W2-4: RF-9, RAIL-13). Compiled with the helper's own
// HandsWin.swift by check.sh and run headless: the session is a clock this file moves and a
// count it keeps. No CGEvent is posted, no AX is read, no window opens.

/// A login session as the decisions see it: a clock, and per kind the count from every source and
/// the time of the newest event. Our own posts are counted when `countsOwn` (the window server does),
/// `lag` posts late (still in flight), or never (no Accessibility drops them).
final class FakeSession {
    var t: TimeInterval = 100
    var counts: [Int64] = [0, 0, 0]
    var newest: [TimeInterval?] = [nil, nil, nil]
    var countsOwn = true
    var lag = 0
    private var inFlight: [InputKind] = []

    /// Someone else pressed a key, clicked or scrolled now.
    func foreign(_ kind: InputKind) {
        land(kind)
    }

    /// Our post of `kind` now: noted in the ledger first, as noteOwnPost does, then seen by the session.
    func own(_ kind: InputKind, _ ledger: inout HandsLedger) {
        ledger.noteOwnPost(kind, at: t)
        guard countsOwn else { return }
        inFlight.append(kind)
        while inFlight.count > lag { land(inFlight.removeFirst()) }
    }

    /// Every post still in flight lands.
    func drain() {
        while !inFlight.isEmpty { land(inFlight.removeFirst()) }
    }

    func advance(ms: Double) {
        t += ms / 1000
    }

    private func land(_ kind: InputKind) {
        counts[kind.rawValue] += 1
        newest[kind.rawValue] = t
    }

    var clock: EventClock {
        return EventClock(now: { self.t }, read: { kind in
            let ages = self.newest[kind.rawValue].map { [(self.t - $0) * 1000] } ?? []
            return KindReading(count: self.counts[kind.rawValue], msAgo: ages)
        })
    }
}

/// Where the fake keystrokes land: the front pid and the focused element, both settable. It reads the
/// way the helper's focusMark does: the focused element first, and the window and role only when the
/// element is not the watched one. `failing` is an app that cannot say (hung: every read times out).
final class FakeFocus {
    var pid: Int32? = 100
    var mark: FocusMark? = FocusMark(element: "body", window: "compose", takesText: true)
    var failing = false
    /// Focused-element reads, and the window and role reads that follow one only when the element changed.
    var elementReads = 0
    var detailReads = 0

    func read(_ base: FocusMark?) -> FocusMark? {
        elementReads += 1
        guard !failing, let mark else { return nil }
        if let base, base.element == mark.element { return base }
        detailReads += 1
        return mark
    }

    func watch(expect pid: Int32?) -> FrontWatch {
        return FrontWatch(pid: pid, focus: mark, readPid: { self.pid }, readFocus: { self.read($0) })
    }
}

var passed = 0
var failed = 0

func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
    if ok {
        passed += 1
        print("ok - \(name)")
    } else {
        failed += 1
        print("not ok - \(name): \(detail())")
    }
}

/// A type of `text` through the helper's own loop: every grapheme an own key post, `stepMs` apart;
/// `after(typed)` runs once each grapheme has gone out (Kevin's hands, a moved focus).
func typeRun(_ text: String, session s: FakeSession, ledger: inout HandsLedger, watch: inout TypeWatch, stepMs: Double = 4, stopped: @escaping () -> Bool = { false }, after: (Int) -> Void = { _ in }) -> GraphemeRun {
    var typed = 0
    return runGraphemes(text, cancel: {
        watch.cancelReason(stopped: stopped(), ledger: &ledger, clock: s.clock)
    }, post: { _ in
        s.own(.key, &ledger)
        typed += 1
        s.advance(ms: stepMs)
        after(typed)
        return true
    })
}

let longText = String(repeating: "a", count: 200)

// 1. A foreign key 200 ms ago gives busy; a quiet session gives nothing.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    check("a quiet session is free", ledger.busyMs(s.clock) == nil)
    s.foreign(.key)
    s.advance(ms: 200)
    let busy = ledger.busyMs(s.clock)
    check("a foreign key 200 ms ago gives busy", busy == 200, "busyMs \(String(describing: busy))")
    s.advance(ms: 1300)
    check("1.5 s after it the machine is free", ledger.busyMs(s.clock) == nil)
}

// 2. An own post after a foreign key does not mask it.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    s.foreign(.key)
    s.advance(ms: 5)
    s.own(.key, &ledger)
    s.advance(ms: 5)
    check("by time alone the newest key reads as ours (the mask)", ledger.isOwn(.key, eventAt: s.t - 0.005))
    check("by count the foreign key still shows: busy", ledger.busyMs(s.clock) != nil)
    s.advance(ms: 1040)
    let later = ledger.busyMs(s.clock)
    check("1.05 s after the foreign key a guard is still held", later != nil, "busyMs \(String(describing: later))")
    s.advance(ms: 500)
    check("past the quiet window after the last post it is free", ledger.busyMs(s.clock) == nil)
}

// 3. The skeptic's model, through the type loop: ⌘A, then 200 graphemes 4 ms apart, Kevin's key
//    after the 50th. The type stops there as busy with 50 characters landed, and the Return step's
//    guard 1.05 s after his key is still held.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    check("the guard at the select-all is free", ledger.busyMs(s.clock) == nil)
    s.own(.key, &ledger)
    s.advance(ms: 10)
    check("the guard at the type's start is free", ledger.busyMs(s.clock) == nil)
    let focus = FakeFocus()
    var watch = TypeWatch(busyCheck: true, front: focus.watch(expect: 100))
    let run = typeRun(longText, session: s, ledger: &ledger, watch: &watch, after: { typed in
        if typed == 50 { s.foreign(.key) }
    })
    check("Kevin's key mid-type stops it as busy with 50 characters landed", run == .cancelled(typed: 50, reason: .busy), "\(run)")
    s.advance(ms: 1050 - 4)
    check("the next op's guard 1.05 s after his key is held", ledger.busyMs(s.clock) != nil)
}

// 4. A click or a scroll of his mid-type stops it the same way.
for kind in [InputKind.click, .scroll] {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    var watch = TypeWatch(busyCheck: true, front: FakeFocus().watch(expect: 100))
    let run = typeRun(longText, session: s, ledger: &ledger, watch: &watch, after: { typed in
        if typed == 7 { s.foreign(kind) }
    })
    check("a foreign \(kind) mid-type stops it as busy after 7", run == .cancelled(typed: 7, reason: .busy), "\(run)")
}

// 5. Our own posts never read as Kevin's: 500 graphemes, the session two posts behind, then drained.
do {
    let s = FakeSession()
    s.lag = 2
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    var watch = TypeWatch(busyCheck: true, front: FakeFocus().watch(expect: 100))
    let run = typeRun(String(repeating: "b", count: 500), session: s, ledger: &ledger, watch: &watch)
    check("500 own posts counted late never stop the type", run == .done(typed: 500), "\(run)")
    s.drain()
    s.advance(ms: 2)
    check("once they land nothing reads as foreign", ledger.busyMs(s.clock) == nil)
    s.advance(ms: 2000)
    check("nor later", ledger.busyMs(s.clock) == nil)
}

// 6. A foreign key hidden behind own posts still in flight is never lost: it is found by the
//    first read after they land (the next op's guard), never counted as ours.
do {
    let s = FakeSession()
    s.lag = 1
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    var watch = TypeWatch(busyCheck: true, front: FakeFocus().watch(expect: 100))
    _ = typeRun(String(repeating: "d", count: 40), session: s, ledger: &ledger, watch: &watch, after: { typed in
        if typed == 20 { s.foreign(.key) }
    })
    s.drain()
    s.advance(ms: 1)
    check("with own posts in flight a foreign key is found once they land", ledger.busyMs(s.clock) != nil)
}

// 7. Posts the session never counted (Accessibility was off) re-base once they settle, so once
//    posts land again a foreign key among them is still found.
do {
    let s = FakeSession()
    s.countsOwn = false
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    for _ in 0..<100 {
        s.own(.key, &ledger)
        s.advance(ms: 4)
    }
    s.advance(ms: 600)
    check("dropped posts are not foreign", ledger.busyMs(s.clock) == nil)
    s.countsOwn = true
    var watch = TypeWatch(busyCheck: true, front: FakeFocus().watch(expect: 100))
    let run = typeRun(longText, session: s, ledger: &ledger, watch: &watch, after: { typed in
        if typed == 20 { s.foreign(.key) }
    })
    check("after the re-base a foreign key mid-type stops it as busy", run == .cancelled(typed: 20, reason: .busy), "\(run)")
}

// 8. Before the first read is history: a key 10 s ago holds nothing.
do {
    let s = FakeSession()
    s.foreign(.key)
    s.advance(ms: 10_000)
    var ledger = HandsLedger()
    check("a key long before the first read holds nothing", ledger.busyMs(s.clock) == nil)
}

// 9. A focus element change gives focus_moved with N characters landed.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    let focus = FakeFocus()
    var watch = TypeWatch(busyCheck: true, front: focus.watch(expect: 100))
    // 60 ms a grapheme: every one is past the 50 ms re-read, so the count is exact.
    let run = typeRun(longText, session: s, ledger: &ledger, watch: &watch, stepMs: 60, after: { typed in
        if typed == 12 { focus.mark = FocusMark(element: "save-name", window: "save-sheet", takesText: true) }
    })
    check("the focus moving to a sheet stops the type as focus_moved with 12 landed", run == .cancelled(typed: 12, reason: .focusMoved), "\(run)")
}

// 10. At typing speed the focus is re-read every 50 ms: the count says how far it really got.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    let focus = FakeFocus()
    var watch = TypeWatch(busyCheck: true, front: focus.watch(expect: 100))
    let run = typeRun(longText, session: s, ledger: &ledger, watch: &watch, after: { typed in
        if typed == 30 { focus.mark = FocusMark(element: "suggestions", window: "compose", takesText: false) }
    })
    let ok: Bool
    if case .cancelled(let typed, .focusMoved) = run { ok = typed >= 30 && typed <= 30 + 13 } else { ok = false }
    check("the focus leaving text entry stops the type within one 50 ms re-read", ok, "\(run)")
}

// 11. What is not a move: the same element; a new text element in the same window (a code box
//     advancing, a block re-made); a read that failed. What is: another window; out of text entry.
do {
    let base = FocusMark(element: "box1", window: "w", takesText: true)
    check("the same element has not moved", !focusHasMoved(from: base, to: FocusMark(element: "box1", window: "w", takesText: true)))
    check("a new text element in the same window has not moved", !focusHasMoved(from: base, to: FocusMark(element: "box2", window: "w", takesText: true)))
    check("a text element in another window has moved", focusHasMoved(from: base, to: FocusMark(element: "box2", window: "sheet", takesText: true)))
    check("a list in the same window has moved", focusHasMoved(from: base, to: FocusMark(element: "list", window: "w", takesText: false)))
    let grid = FocusMark(element: "table", window: "w", takesText: false)
    check("a grid's cell editor taking over (into text entry) has not moved", !focusHasMoved(from: grid, to: FocusMark(element: "editor", window: "w", takesText: true)))
    let focus = FakeFocus()
    var front = focus.watch(expect: 100)
    focus.mark = nil
    check("a focus read that failed is not a move", !front.check(now: 1))
}

// 12. The front app: another pid, or nothing in front, is a move (as before).
do {
    let focus = FakeFocus()
    var front = focus.watch(expect: 100)
    check("the expected app in front is no move", !front.check(now: 1))
    focus.pid = 200
    check("another app within 50 ms is not re-read yet", !front.check(now: 1.02))
    check("another app in front is a move", front.check(now: 1.06))
    let none = FakeFocus()
    var empty = none.watch(expect: 100)
    none.pid = nil
    check("nothing in front is a move", empty.check(now: 1))
}

// 13. A separator moves the focus on purpose: the watch re-bases and the type goes on.
do {
    let focus = FakeFocus()
    var front = focus.watch(expect: 100)
    check("before the Return", !front.check(now: 1))
    focus.mark = FocusMark(element: "reply", window: "thread", takesText: true)
    front.rebase(focus.mark)
    check("after the Return, the new place is the one watched", !front.check(now: 1.1))
}

// 14. Dictation (ownDriver): Kevin is the one typing; his keys do not stop his words.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    var watch = TypeWatch(busyCheck: false, front: FakeFocus().watch(expect: 100))
    let run = typeRun(String(repeating: "c", count: 40), session: s, ledger: &ledger, watch: &watch, after: { typed in
        if typed % 10 == 0 { s.foreign(.key) }
    })
    check("dictation types through Kevin's keys", run == .done(typed: 40), "\(run)")
}

// 15. The client's stop comes first, whatever else is true.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    s.foreign(.key)
    let focus = FakeFocus()
    var watch = TypeWatch(busyCheck: true, front: focus.watch(expect: 100))
    focus.pid = 300
    check("a stop wins over busy and a moved focus", watch.cancelReason(stopped: true, ledger: &ledger, clock: s.clock) == .stop)
    check("then busy over a moved focus", watch.cancelReason(stopped: false, ledger: &ledger, clock: s.clock) == .busy)
}

// 16. An op that skips the busy check still reads the ledger. Kevin's key 10 s before a dictation
//     (nothing read since), then the dictation's 50 keys (ownDriver: its guard and every grapheme
//     only observe), then the next op's guard: his key is 10 s old, not timed at the dictation's last post.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    s.advance(ms: 1000)
    s.foreign(.key)
    s.advance(ms: 10_000)
    ledger.observe(s.clock)
    var watch = TypeWatch(busyCheck: false, front: FakeFocus().watch(expect: 100))
    let run = typeRun(String(repeating: "e", count: 50), session: s, ledger: &ledger, watch: &watch)
    check("a dictation after Kevin's key types all 50", run == .done(typed: 50), "\(run)")
    s.advance(ms: 50)
    let after = ledger.busyMs(s.clock)
    check("the guard after a dictation is not held by Kevin's key from 10 s before", after == nil, "busyMs \(String(describing: after))")
}

// 17. The same for a mouse up between his click and our next one: read there, his click is timed
//     at his click, so our click 50 ms later is not held by it.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    s.foreign(.click)
    s.advance(ms: 5000)
    ledger.observe(s.clock)
    s.own(.click, &ledger)
    s.advance(ms: 50)
    let after = ledger.busyMs(s.clock)
    check("a mouse up's read times Kevin's click at his click, not at our next post", after == nil, "busyMs \(String(describing: after))")
}

// 18. The premise check: an event found by count while the newest of its kind is our own post is
//     told to the debug hook (Kevin's event masked, or the session counting our posts twice). A plain
//     foreign event is told too, not as behind our own; our own posts counted once tell nothing.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    var told: [(InputKind, Int64, Bool)] = []
    ledger.onCountedForeign = { told.append(($0, $1, $2)) }
    _ = ledger.busyMs(s.clock)
    for _ in 0..<20 {
        s.own(.key, &ledger)
        s.advance(ms: 4)
        _ = ledger.busyMs(s.clock)
    }
    check("our own posts counted once tell the hook nothing", told.isEmpty, "\(told)")
    // Past the own-post slack: a key 4 ms after ours is ours by time, by design.
    s.advance(ms: 100)
    s.foreign(.key)
    s.advance(ms: 3)
    _ = ledger.busyMs(s.clock)
    check("a foreign key is told, not as behind our own", told.count == 1 && told[0].1 == 1 && told[0].2 == false, "\(told)")
    let d = FakeSession()
    var doubled = HandsLedger()
    var behind: [Bool] = []
    doubled.onCountedForeign = { _, _, b in behind.append(b) }
    _ = doubled.busyMs(d.clock)
    d.own(.click, &doubled)
    d.foreign(.click)
    d.advance(ms: 200)
    _ = doubled.busyMs(d.clock)
    check("a count found behind our own post is told as such", behind == [true], "\(behind)")
}

// 19. An unmoved focus costs one element read per re-read: the window and role are read only when
//     the element changed.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    let focus = FakeFocus()
    var watch = TypeWatch(busyCheck: true, front: focus.watch(expect: 100))
    let run = typeRun(String(repeating: "f", count: 100), session: s, ledger: &ledger, watch: &watch, stepMs: 60)
    check("an unmoved focus is re-read with the element alone", run == .done(typed: 100) && focus.elementReads >= 99 && focus.detailReads == 0, "\(run) element \(focus.elementReads) detail \(focus.detailReads)")
}

// 20. A hung app cannot say where its focus is: after two reads that time out the focus is not read
//     again this type, so it is not slowed to the AX timeout per grapheme. The front app check stays.
do {
    let s = FakeSession()
    var ledger = HandsLedger()
    _ = ledger.busyMs(s.clock)
    let focus = FakeFocus()
    var watch = TypeWatch(busyCheck: true, front: focus.watch(expect: 100))
    focus.failing = true
    let run = typeRun(longText, session: s, ledger: &ledger, watch: &watch, stepMs: 60, after: { typed in
        if typed == 150 { focus.pid = 200 }
    })
    check("a focus that cannot be read twice running is not read again", focus.elementReads == focusMissLimit, "reads \(focus.elementReads)")
    check("the front app check stays on after the misses", run == .cancelled(typed: 150, reason: .focusMoved), "\(run)")
}

// 21. One read that could not say is not the end of the watch: the next good read resets the count.
do {
    let focus = FakeFocus()
    var front = focus.watch(expect: 100)
    focus.failing = true
    check("a miss is not a move", !front.check(now: 1))
    focus.failing = false
    check("the next read is good", !front.check(now: 1.1))
    focus.failing = true
    check("a miss again", !front.check(now: 1.2))
    focus.failing = false
    focus.mark = FocusMark(element: "sheet-field", window: "sheet", takesText: true)
    check("and the watch still sees a move", front.check(now: 1.3))
}

print("hands-win: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
