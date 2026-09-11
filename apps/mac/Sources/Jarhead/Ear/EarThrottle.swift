import Foundation

/// The ear's send throttle: at most one message per `minInterval` (20 a second), the
/// newest partial of a segment replacing an older one still waiting, so nothing stale
/// is ever sent. Finals do not wait: a final ends a recognition task, so finals cannot
/// burst, and the engine fires a reflex the moment a final arrives — holding one for
/// the interval would be a direct 0–50 ms cost on the most decisive message. The hold
/// timer is a strict `DispatchSourceTimer` with 1 ms leeway (`asyncAfter` overshoots by
/// 5–40 ms on a busy machine; a coalesced timer source by 5–10 ms).
///
/// Single-threaded: every call runs on `queue`, and `send` is called on `queue`.
/// `now` is injectable so a harness can drive the clock.
final class EarThrottle {
    struct Item: Equatable {
        var text: String
        var isFinal: Bool
        var segment: Int
        var atMs: Int
    }

    var send: ((Item) -> Void)?

    let minInterval: TimeInterval
    private let queue: DispatchQueue
    private let now: () -> CFAbsoluteTime
    private var pending: [Item] = []
    private var timer: DispatchSourceTimer?
    private var lastSentAt: CFAbsoluteTime = -1
    private(set) var lastSentText = ""
    private(set) var lastSentSegment = -1

    init(queue: DispatchQueue, minInterval: TimeInterval = 0.05, now: @escaping () -> CFAbsoluteTime = CFAbsoluteTimeGetCurrent) {
        self.queue = queue
        self.minInterval = minInterval
        self.now = now
    }

    /// Forget everything waiting and the dedupe memory (a fresh listening session).
    func reset() {
        timer?.cancel(); timer = nil
        pending.removeAll()
        lastSentText = ""
        lastSentSegment = -1
        lastSentAt = -1
    }

    /// True when `item` would be a repeat of what was last sent or is already waiting:
    /// the recogniser re-scores without re-wording, and the reflex layer has nothing to
    /// do with a repeat. Finals are never repeats.
    func isRepeat(_ item: Item) -> Bool {
        guard !item.isFinal else { return false }
        if let last = pending.last, last.segment == item.segment { return last.text == item.text }
        return item.segment == lastSentSegment && item.text == lastSentText
    }

    /// Queue `item`; sends now when the interval allows (always, for a final), else when it does.
    func offer(_ item: Item) {
        if item.isFinal {
            // The final supersedes any partial of its segment still waiting.
            pending.removeAll { !$0.isFinal && $0.segment == item.segment }
            // Anything of an older segment still waiting goes first, so segments stay in
            // order; a newer segment's partial (a late final of a closed segment) keeps waiting.
            let older = pending.filter { $0.segment < item.segment }
            pending.removeAll { $0.segment < item.segment }
            for o in older { emit(o) }
            emit(item)
            if pending.isEmpty { timer?.cancel(); timer = nil }
            return
        }
        if let last = pending.last, !last.isFinal, last.segment == item.segment {
            pending[pending.count - 1] = item
        } else {
            pending.append(item)
        }
        scheduleFlush()
    }

    /// Waiting to be sent, for harnesses.
    var pendingCount: Int { pending.count }

    private func scheduleFlush() {
        guard timer == nil, !pending.isEmpty else { return }
        let since = lastSentAt < 0 ? minInterval : now() - lastSentAt
        if since >= minInterval {
            flushOne()
            return
        }
        // `.strict`: no timer coalescing, so the hold ends within ~1 ms of the deadline
        // (a plain source still lands 5–10 ms late; `asyncAfter` up to 40 ms).
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        t.schedule(deadline: .now() + (minInterval - since), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            self.timer?.cancel(); self.timer = nil
            self.flushOne()
        }
        t.resume()
        timer = t
    }

    private func flushOne() {
        guard !pending.isEmpty else { return }
        emit(pending.removeFirst())
        if !pending.isEmpty { scheduleFlush() }
    }

    private func emit(_ item: Item) {
        lastSentAt = now()
        lastSentText = item.text
        lastSentSegment = item.segment
        send?(item)
    }
}
