import Foundation

/// One thread's conversation as the Console holds it: the pages and deltas of the wire's
/// `thread.transcript` (`replace` | `append` | `prepend`), numbered by `seq`. The agents'
/// transcript store's rules, keyed by seq instead of a message id, plus one thing a thread
/// needs that an agent does not: a `step` or `status` entry is not a row of its own — it is a
/// delta on the delegation card it names, patched in place through a delegationId → position
/// map, so a busy thread's 20 steps a second cost 20 dictionary hits and never a rebuild.
///
/// Bounded: `cap` (AppState.maxTranscriptMessages, 400) plus what Kevin loaded with "Load
/// earlier" (`prependedCount`); the oldest go from the front, their seqs enter a ring
/// (`TrimmedSeqs`) so a re-sent entry older than the fold never lands as the newest row.
public struct ThreadStore: Equatable {
    public static let cap = AppState.maxTranscriptMessages
    /// How far into the held rows a prepend looks for the orphan steps of a card it brings (a
    /// page boundary splits a card from its steps at most one page deep; two is the margin).
    static let orphanScan = 120

    public let threadId: String
    public private(set) var entries: [ThreadEntry] = []
    public private(set) var total = 0
    public private(set) var complete = false
    public private(set) var live = false
    public private(set) var cursor: ThreadTranscript.Cursor?
    public private(set) var readMs: Double?
    /// Rows `prepend` added since the last whole page: the cap grows by as many.
    public private(set) var prependedCount = 0
    /// Wire entries folded into a held card (a step, a status): they count in `total` and hold
    /// no row, so "how many remain behind Load earlier" subtracts them (see `remaining`).
    public private(set) var foldedCount = 0

    /// seq → absolute position; the array index is `position - base`.
    private var index: [Int: Int] = [:]
    private var base = 0
    /// delegation id → absolute position of its `delegation` entry, for O(1) step patching.
    private var delegationAt: [String: Int] = [:]
    /// delegation id → how many wire entries were folded into that card (given back when it is trimmed).
    private var foldedByDelegation: [String: Int] = [:]
    private var trimmed = TrimmedSeqs()

    /// The oldest held seq — "Load earlier" asks for the page before it.
    public var startSeq: Int? { entries.first?.seq }
    public var endSeq: Int? { entries.last?.seq }
    public var isEmpty: Bool { entries.isEmpty }
    /// Entries of the thread's record not on screen: behind "Load earlier", or above the fold.
    public var remaining: Int { max(0, total - entries.count - foldedCount) }

    /// Only what a view can see decides equality; the side tables are derived from `entries`.
    public static func == (a: ThreadStore, b: ThreadStore) -> Bool {
        a.threadId == b.threadId && a.entries == b.entries && a.total == b.total && a.complete == b.complete
            && a.live == b.live && a.cursor == b.cursor && a.prependedCount == b.prependedCount && a.foldedCount == b.foldedCount
    }

    /// A whole page (`replace`): the first open, or a re-open. Steps and statuses in the page
    /// fold into the delegations the page carries; the rest are held as they came.
    public init(page t: ThreadTranscript) {
        threadId = t.threadId
        total = t.total
        complete = t.complete
        live = t.live
        cursor = t.cursor
        readMs = t.readMs
        for e in t.entries { add(e) }
        trimFront(cap: ThreadStore.cap)
    }

    // MARK: - the three modes

    /// A live delta: a step or status patches its card; a re-sent entry upserts; an entry
    /// older than the fold is skipped; anything else is the newest row.
    public mutating func append(_ t: ThreadTranscript) {
        for e in t.entries { add(e) }
        total = max(total, t.total)
        live = t.live
        cursor = ThreadStore.merged(cursor, t.cursor)
        trimFront(cap: ThreadStore.cap + prependedCount)
    }

    /// An older page (`thread.history`): what we do not hold, in the page's own order, in
    /// front of what we do. Kevin asked for it, so it is held whole and the cap grows by it.
    /// `complete` comes from the page (the last one reaches the thread's first entry).
    ///
    /// A page boundary can fall between a card and its steps: the steps landed first (the
    /// newer page) and stood as orphan rows; the card arrives now. Those rows fold into the
    /// card and leave — the card reads whole, once — so paging back never doubles a step.
    public mutating func prepend(_ t: ThreadTranscript) {
        var fresh: [ThreadEntry] = []
        fresh.reserveCapacity(t.entries.count)
        var seen = Set<Int>()
        // Steps and statuses of a delegation the page (or we) hold patch it; orphans stay rows.
        var pageDelegations: [String: Int] = [:]
        for e in t.entries where index[e.seq] == nil && !seen.contains(e.seq) {
            seen.insert(e.seq)
            if let id = e.delegationId, e.kind == "step" || e.kind == "status" {
                if let i = pageDelegations[id] {
                    if ThreadStore.patch(&fresh[i], with: e) { noteFolded(id) }
                    continue
                }
                if let i = position(ofDelegation: id) {
                    if ThreadStore.patch(&entries[i], with: e) { noteFolded(id) }
                    continue
                }
            }
            if e.kind == "delegation", let id = e.delegation?.id { pageDelegations[id] = fresh.count }
            fresh.append(e)
        }
        // The orphans we hold whose card just arrived: into the card, out of the rows.
        var dropped = 0
        if !pageDelegations.isEmpty {
            let scan = min(entries.count, ThreadStore.orphanScan)
            var kept: [ThreadEntry] = []
            kept.reserveCapacity(scan)
            for e in entries.prefix(scan) {
                if let id = e.delegationId, e.kind == "step" || e.kind == "status", let fi = pageDelegations[id] {
                    index[e.seq] = nil
                    if ThreadStore.patch(&fresh[fi], with: e) { noteFolded(id) }
                    dropped += 1
                    continue
                }
                kept.append(e)
            }
            if dropped > 0 { entries.replaceSubrange(0..<scan, with: kept) }
        }
        base -= fresh.count
        entries.insert(contentsOf: fresh, at: 0)
        if dropped > 0 {
            // Rows left the middle: every held position moved. Once per page Kevin asked for.
            reindex()
        } else {
            for (i, e) in fresh.enumerated() {
                index[e.seq] = base + i
                if e.kind == "delegation", let id = e.delegation?.id { delegationAt[id] = base + i }
            }
        }
        prependedCount = max(0, prependedCount + fresh.count - dropped)
        complete = t.complete
        total = max(total, t.total)
        cursor = ThreadStore.merged(cursor, t.cursor)
    }

    /// The array index of the entry with `seq`, or nil.
    public func position(of seq: Int) -> Int? {
        guard let p = index[seq] else { return nil }
        let i = p - base
        return i >= 0 && i < entries.count ? i : nil
    }

    /// The array index of a delegation's card, or nil (not held, or above the fold).
    public func position(ofDelegation id: String) -> Int? {
        guard let p = delegationAt[id] else { return nil }
        let i = p - base
        return i >= 0 && i < entries.count ? i : nil
    }

    // MARK: - internals

    /// One entry, wherever it lands: a patch, an upsert, a skip, or the newest row.
    private mutating func add(_ e: ThreadEntry) {
        if let id = e.delegationId, e.kind == "step" || e.kind == "status", let i = position(ofDelegation: id) {
            if ThreadStore.patch(&entries[i], with: e) { noteFolded(id) }
            return
        }
        if let i = position(of: e.seq) {
            entries[i] = e
            if e.kind == "delegation", let id = e.delegation?.id { delegationAt[id] = base + i }
            return
        }
        // Above the fold: not the newest row, whatever changed in it.
        if trimmed.contains(e.seq) { return }
        index[e.seq] = base + entries.count
        if e.kind == "delegation", let id = e.delegation?.id { delegationAt[id] = base + entries.count }
        entries.append(e)
    }

    /// A step lands once (the engine re-sends a step when it changes: same id, newer text) at
    /// the end of the card; a status sets how the card ended. True when the entry was new to
    /// the card (a step it did not have, a status that changed it) — a re-send is not counted twice.
    @discardableResult
    static func patch(_ card: inout ThreadEntry, with e: ThreadEntry) -> Bool {
        guard var d = card.delegation else { return false }
        var fresh = false
        switch e.kind {
        case "step":
            guard let step = e.step else { return false }
            if let i = d.steps.lastIndex(where: { $0.id == step.id }) {
                d.steps[i] = step
            } else {
                d.steps.append(step)
                fresh = true
                if step.kind == .thinking, d.timings.firstThinkingAt == nil { d.timings.firstThinkingAt = step.at }
                if step.kind == .commentary, d.timings.firstCommentaryAt == nil { d.timings.firstCommentaryAt = step.at }
            }
            if let count = d.stepCount { d.stepCount = max(count, d.steps.count) }
        case "status":
            if let s = e.status, s != d.status { d.status = s; fresh = true }
            if let summary = e.summary, summary != d.summary { d.summary = summary; fresh = true }
            if let timings = e.timings, timings != d.timings { d.timings = timings; fresh = true }
        default:
            return false
        }
        card.delegation = d
        return fresh
    }

    private mutating func noteFolded(_ delegationId: String) {
        foldedCount += 1
        foldedByDelegation[delegationId, default: 0] += 1
    }

    /// The oldest past `cap` go: the base moves by as many, their seqs leave the index and
    /// enter the ring, their cards leave the delegation map (and give back what was folded
    /// into them — those entries are above the fold now too), and `complete` turns false.
    private mutating func trimFront(cap: Int) {
        let excess = entries.count - cap
        guard excess > 0 else { return }
        for e in entries.prefix(excess) {
            index[e.seq] = nil
            trimmed.insert(e.seq)
            if e.kind == "delegation", let id = e.delegation?.id {
                delegationAt[id] = nil
                foldedCount -= foldedByDelegation.removeValue(forKey: id) ?? 0
            }
        }
        entries.removeFirst(excess)
        complete = false
        base += excess
    }

    /// The side tables from `entries`, after rows left the middle. O(held), rare (a prepend that folded orphans).
    private mutating func reindex() {
        index.removeAll(keepingCapacity: true)
        delegationAt.removeAll(keepingCapacity: true)
        for (i, e) in entries.enumerated() {
            index[e.seq] = base + i
            if e.kind == "delegation", let id = e.delegation?.id { delegationAt[id] = base + i }
        }
    }

    private static func merged(_ a: ThreadTranscript.Cursor?, _ b: ThreadTranscript.Cursor?) -> ThreadTranscript.Cursor? {
        guard let a else { return b }
        guard let b else { return a }
        return ThreadTranscript.Cursor(startSeq: min(a.startSeq, b.startSeq), endSeq: max(a.endSeq, b.endSeq))
    }

    /// A bounded set of seqs with first-in-first-out eviction (AppState.TrimmedIds for Ints):
    /// the ring names the order, the set answers `contains` in O(1).
    struct TrimmedSeqs: Equatable {
        static let capacity = 8_192
        private var ring: [Int] = []
        private var next = 0
        private var held = Set<Int>()

        var count: Int { held.count }
        func contains(_ seq: Int) -> Bool { held.contains(seq) }
        mutating func insert(_ seq: Int) {
            guard !held.contains(seq) else { return }
            if ring.count < TrimmedSeqs.capacity {
                ring.append(seq)
            } else {
                held.remove(ring[next])
                ring[next] = seq
            }
            next = (next + 1) % TrimmedSeqs.capacity
            held.insert(seq)
        }
    }
}

// MARK: - Threads in AppState

extension AppState {
    /// A finished thread stays on the rail this long after its `ended` event (the snapshot's own
    /// linger is 30 s; the Console keeps them longer, from events, in its own store).
    public static let threadLingerMs: Double = 300_000
    /// How many threads' conversations are kept once their pane closed (the newest opened).
    public static let threadStoreLRU = 8
    /// What a live thread the engine dropped without a word reads as.
    public static let threadGoneDetail = "gone from the engine"

    /// One `thread.event` (the wire's ≤ 200 B delta): `started` brings the whole record, the
    /// rest patch the one we hold. An event for a thread we do not know is dropped — the next
    /// snapshot's `threads` brings it whole. Out-of-order events (a seq at or below the last
    /// applied for that thread) are dropped too: the engine coalesces per thread and the socket
    /// is ordered, so this only ever catches a replay. The seq restarts with the daemon process
    /// (`noteDaemonHello` clears the guard; so does a record whose `startedAt` changed).
    public func applyThreadEvent(_ e: ThreadEvent) {
        if e.kind == "started", let t = e.thread {
            upsertThread(t)
            threadLastSeq[t.id] = e.seq
            threadsGone.remove(t.id)
            return
        }
        guard var t = threads[e.threadId] else { return }
        if let last = threadLastSeq[e.threadId], e.seq <= last { return }
        threadLastSeq[e.threadId] = e.seq
        t.updatedAt = max(t.updatedAt, e.at)
        switch e.kind {
        case "status":
            if let s = e.status { t.status = s }
            if let d = e.detail { t.detail = d }
            if t.status != .waitingKevin { t.question = nil }
        case "step":
            if let n = e.steps { t.steps = n }
            if let tool = e.tool { t.detail = e.ok == false ? "\(tool) · failed" : tool }
        case "turn":
            if let id = e.delegationId { t.currentDelegationId = id }
            t.turns += 1
        case "question":
            t.question = e.question
            t.status = .waitingKevin
        case "said":
            if let text = e.text { t.detail = text }
        case "at":
            if let x = e.x, let y = e.y { t.at = Point2(x: x, y: y) }
            if let app = e.app {
                t.app = app
                if !t.apps.contains(app) { t.apps.append(app) }
            }
        case "ended":
            if let s = e.status { t.status = s }
            t.doneAt = e.at
            if let summary = e.summary, !summary.isEmpty { t.detail = summary }
            t.question = nil
            t.canSay = false
            t.canStop = false
        default:
            break
        }
        threads[e.threadId] = t
        if !t.status.isLive { scheduleThreadPrune() }
    }

    /// The daemon said hello (a connection, a reconnection — a new process or the old one): the
    /// event seq is the process's and starts over, so the replay guard starts over with it.
    public func noteDaemonHello() {
        threadLastSeq.removeAll()
    }

    /// The snapshot's `threads` (live, plus those finished within the engine's 30 s linger): the
    /// whole truth for what it lists, so each replaces ours unless ours is fresher (an event
    /// landed after the snapshot was built; on the same clock an end stands — an end never
    /// un-ends). nil is an older daemon: nothing is known, nothing is touched.
    ///
    /// A live thread of ours the snapshot does not list: the snapshot may simply predate it —
    /// the client parks a snapshot up to 33 ms while a `started` event lands at once, so on every
    /// spawn a snapshot built before the thread can be applied after its event. Only a thread a
    /// snapshot HAS listed before can be gone from one: that one settles `failed` here (its
    /// engine restarted without the ledger rows, or dropped it without a word) so the rail never
    /// shows a pulse nothing feeds — with its clock left alone, so the next snapshot that lists
    /// it live wins the merge and heals it.
    public func applySnapshotThreads(_ list: [WorkThread]?) {
        guard let list else { return }
        threadsKnown = true
        var seen = Set<String>()
        for t in list {
            seen.insert(t.id)
            threadsSeenInSnapshot.insert(t.id)
            if let mine = threads[t.id] {
                if threadsGone.remove(t.id) != nil {
                    // Ours was a guess ("gone"); the engine's word replaces it whatever its clock.
                } else if mine.startedAt != t.startedAt {
                    // The same id, another life (main after a daemon restart): its events' seq starts over.
                    threadLastSeq[t.id] = nil
                } else if mine.updatedAt > t.updatedAt {
                    continue
                } else if mine.updatedAt == t.updatedAt, !mine.status.isLive, t.status.isLive {
                    continue
                }
            }
            upsertThread(t)
        }
        let now = Date().timeIntervalSince1970 * 1000
        for (id, mine) in threads where !seen.contains(id) && mine.status.isLive && threadsSeenInSnapshot.contains(id) {
            var gone = mine
            gone.status = .failed
            gone.doneAt = now
            gone.detail = AppState.threadGoneDetail
            gone.question = nil
            gone.canSay = false
            gone.canStop = false
            threads[id] = gone
            threadsGone.insert(id)
        }
        pruneThreads()
        if threads.values.contains(where: { !$0.status.isLive }) { scheduleThreadPrune() }
    }

    private func upsertThread(_ t: WorkThread) {
        threads[t.id] = t
        if !threadOrder.contains(t.id) { threadOrder.append(t.id) }
    }

    /// Finished threads leave `threadLingerMs` after they ended, unless the Console is looking
    /// at one (`heldThreadIds`); their conversations go with them.
    public func pruneThreads(now: Double = Date().timeIntervalSince1970 * 1000) {
        var dropped: [String] = []
        for (id, t) in threads where !t.status.isLive && !heldThreadIds.contains(id) {
            let endedAt = t.doneAt ?? t.updatedAt
            if now - endedAt >= AppState.threadLingerMs { dropped.append(id) }
        }
        guard !dropped.isEmpty else { return }
        for id in dropped {
            threads[id] = nil
            threadLastSeq[id] = nil
            threadStores[id] = nil
            threadsSeenInSnapshot.remove(id)
            threadsGone.remove(id)
            threadStoreRecency.removeAll { $0 == id }
        }
        threadOrder.removeAll { dropped.contains($0) }
    }

    /// One sweep every 15 s while any finished thread is held; ends itself when none is.
    private func scheduleThreadPrune() {
        guard threadPruneTask == nil else { return }
        threadPruneTask = Task { @MainActor [weak self] in
            defer { self?.threadPruneTask = nil }
            while let self, self.threads.values.contains(where: { !$0.status.isLive }) {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled else { return }
                self.pruneThreads()
            }
        }
    }

    /// Called by the daemon client for every `thread.transcript` event (ThreadStore's three modes).
    public func applyThreadTranscript(_ t: ThreadTranscript, mode: String) {
        let id = t.threadId
        switch mode {
        case "append":
            // Taken out while edited so the entries array stays uniquely referenced (AppState.applyTranscript).
            if var s = threadStores.removeValue(forKey: id) {
                s.append(t)
                threadStores[id] = s
            } else {
                threadStores[id] = ThreadStore(page: t)
            }
        case "prepend":
            if var s = threadStores.removeValue(forKey: id), !s.isEmpty {
                s.prepend(t)
                threadStores[id] = s
            } else {
                threadStores[id] = ThreadStore(page: t)
            }
        default:
            threadStores[id] = ThreadStore(page: t)
        }
        noteThreadStoreUsed(id)
    }

    /// A pane opened this thread: it is the newest in the LRU.
    public func noteThreadStoreUsed(_ id: String) {
        threadStoreRecency.removeAll { $0 == id }
        threadStoreRecency.append(id)
    }

    /// Drops the conversations of threads no pane shows, past the newest `threadStoreLRU` used.
    public func evictThreadStores(keep: Set<String>) {
        let recent = Set(threadStoreRecency.suffix(AppState.threadStoreLRU))
        for id in threadStores.keys where !keep.contains(id) && !recent.contains(id) {
            threadStores[id] = nil
        }
    }

    /// The rail's order: waiting on Kevin first (the one thing only he can move), then the busy
    /// ones, then the idle main, then the finished — each by when they began, newest first.
    public nonisolated static func railOrder(_ threads: [WorkThread]) -> [WorkThread] {
        threads.sorted { a, b in
            let ra = railRank(a.status), rb = railRank(b.status)
            return ra != rb ? ra < rb : a.startedAt > b.startedAt
        }
    }

    public nonisolated static func railRank(_ s: ThreadStatus) -> Int {
        switch s {
        case .waitingKevin: return 0
        case .queued, .starting, .thinking, .acting, .waitingScreen, .paused: return 1
        case .idle: return 2
        case .done, .failed, .stopped: return 3
        }
    }

    /// Every thread in rail order (AppState.threads is a dictionary; this is the list the rail and ⌘⇧] read).
    public var orderedThreads: [WorkThread] { AppState.railOrder(Array(threads.values)) }
    public var liveThreads: [WorkThread] { orderedThreads.filter { $0.status.isLive } }
    public var busyThreadCount: Int { threads.values.filter { $0.status.isBusy }.count }

    // The verbs, as commands. Each acts on one thread; none is the transport's stop.
    /// Stop one thread. For "main" the engine parks the main turn and the spawned threads carry
    /// on; never `transportStop()`, which closes the session and sleeps.
    public func threadStop(_ id: String) { send(.threadStop(threadId: id)) }
    public func threadPause(_ id: String) { send(.threadPause(threadId: id)) }
    public func threadResume(_ id: String) { send(.threadResume(threadId: id)) }
    /// Allow / Deny that thread's question: the engine arms only when the question is on the
    /// floor for that thread, else refuses with a toast. Never bound to Return anywhere.
    public func threadAnswer(_ id: String, yes: Bool) { send(.threadAnswer(threadId: id, yes: yes)) }
    /// Typed words to a thread: a follow-up turn on its own brain; for "main" the typed line
    /// lands on the record before anything else reads it.
    public func threadSay(_ id: String, text: String) { send(.threadSay(threadId: id, text: text)) }

    /// Open a thread's Console pane (a satellite's click, the CLI's `jarhead://`). Installed by the app.
    public func openThread(_ id: String) { openThreadHandler(id) }
}
