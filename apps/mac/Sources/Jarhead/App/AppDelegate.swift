import AppKit
import Combine
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()

    private var orb: OrbPanelController!
    /// The satellites: one small blob per live spawned thread, beside the main orb.
    private var fleet: BlobFleet!
    private var overlay: OverlayManager!
    private var console: ConsoleWindowController!
    private var onboarding: OnboardingWindowController!
    private var firstRunChecked = false
    private var client: EngineClient!
    private var audio: AudioEngine!
    private var wake: WakeGate!
    private var ear: ReflexEar!
    private var daemon: DaemonProcess?
    private var statusItem: StatusItem!
    private var menus: Menus!
    private var hotkeys: Hotkeys!
    private var permissions: PermissionsCenter!
    /// The automations' app half (design11): the signals the daemon cannot see, and the banner with Snooze · Done.
    private var signals: SignalObserver!
    private var notifications: Notifications!
    /// `Settings.automations.openAtLogin` as last seen from a real snapshot: the SMAppService call is made on a flip, never on arrival.
    private var openAtLoginSeen: Bool?
    private var cancellables = Set<AnyCancellable>()

    private var micGrant: Grant = .unknown
    private var audioActive = false
    /// design12: the last audio read-back sent to the daemon, and the ≤ 1 Hz coalescing behind it.
    private var audioFrameLast: AudioStateInfo?
    private var audioFrameSentAt: CFAbsoluteTime = 0
    private var audioFramePending = false
    /// The engine's last read-back as the island needs it (the guard's edge, who shares the mic).
    private var audioGuardHeld = false
    private var audioSharedWith: String?
    private var speechRequested = false
    /// Phase and connection as last *published*. `@Published` emits in `willSet`, so
    /// inside a sink `state.phase` / `state.connected` still hold the previous value;
    /// these are fed from the sink payloads and are what the audio decision reads.
    private var phaseSeen: Phase = .asleep
    private var connectedSeen = false
    /// The previous run's crash report, when fresh (CrashGuard.install), until it is shown.
    private var crashNotice: CrashGuard.Notice?

    /// `CFBundleShortVersionString`, or "dev" for a `swift build` binary.
    static let appVersion: String = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"

    override init() {
        super.init()
        // The crash guard before anything else can crash: the report writer, the relaunch,
        // and the previous run's report if it is fresh (shown once the surfaces exist).
        crashNotice = CrashGuard.install(stateDir: AppDelegate.stateDir(), appVersion: AppDelegate.appVersion)
        // The wake listener's diagnostics (formats before/after a device change, failed starts) ride the crash ring too.
        WakeWordListener.log = { appLog("WakeListener: \($0)") }
    }

    // MARK: - launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        appLog("launch: Jarhead \(AppDelegate.appVersion) pid \(ProcessInfo.processInfo.processIdentifier)")
        installDockIcon()
        // The dither tiles (wipes, meter edges) for this display's scale, off the main thread, before the first surface asks.
        Dither.prewarm(scale: NSScreen.main?.backingScaleFactor ?? 2)

        orb = OrbPanelController(state: state)
        // The fleet: one satellite blob per live spawned thread, driven by AppState's
        // thread table (`thread.event` deltas + `snapshot.threads`, in arrival order) and
        // the tagged flies; a satellite's click opens its thread in the Console.
        fleet = BlobFleet(state: state, orb: orb)
        fleet.observe(threads: Publishers.CombineLatest(state.$threads, state.$threadOrder)
            .map { (threads: [String: WorkThread], order: [String]) -> [WorkThread] in order.compactMap { threads[$0] } }
            .removeDuplicates()
            .eraseToAnyPublisher())
        fleet.onOpenThread = { [weak self] id in self?.state.openThreadHandler(id) }
        overlay = OverlayManager(state: state)
        console = ConsoleWindowController(state: state)
        // A thread's pane, from a satellite's click (or anything else that asks AppState).
        state.openThreadHandler = { [weak self] id in
            guard let self else { return }
            self.console.openThread(id)
            NSApp.activate(ignoringOtherApps: true)
        }
        onboarding = OnboardingWindowController(state: state)
        state.openOnboardingHandler = { [weak self] in self?.onboarding.show() }
        state.openPermissionsSetupHandler = { [weak self] in self?.onboarding.show(at: .permissions) }
        state.beginMarkModeHandler = { [weak self] in self?.overlay.beginMarkMode() }

        let socketPath = AppDelegate.socketPath()

        // The wake word gate: on-device listening while asleep, authentication, then `wake`.
        wake = WakeGate(state: state)

        // Audio: mic chunks and levels flow to the client; speaker frames flow back.
        audio = AudioEngine()
        client = EngineClient(socketPath: socketPath, state: state)
        client.audio = audio
        audio.onMicChunk = { [client] pcm in client?.sendMic(pcm) }
        audio.onMicLevel = { [client] level in client?.sendMicLevel(level) }
        // design12: the graph read back (on the audio queue) → main: AppState, the daemon's frame, the island's mute box.
        audio.onAudioState = { [weak self] readback in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.audioStateChanged(readback) } }
        }
        audio.onStatus = { [weak self] text in
            appLog("audio: \(text)")
            // A dead mic is not a log line: say so where Kevin looks.
            guard text.hasPrefix("audio failed") else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.state.toast("Microphone isn't working: \(text)", tone: .error) }
            }
        }

        // The on-device ear: while awake (not paused, not muted) it hears Kevin's words
        // ~100–200 ms after he says them, from the same microphone buffers the voice
        // gets, and feeds the engine's reflex layer as `ear` messages.
        ear = ReflexEar(state: state) { [client] text, isFinal, segment, at in
            client?.sendEar(text: text, isFinal: isFinal, segment: segment, at: at)
        }
        audio.onMicBuffer = { [ear] buffer, when in ear?.ingest(buffer, at: when) }

        // Permissions: this process is the one TCC keys the grants on, so every read,
        // every prompt and the "ask for everything" sweep happen here; the daemon only
        // hears the results (`permission` / `permissions` frames → snapshot.permissions).
        permissions = PermissionsCenter(state: state)
        permissions.onOne = { [weak self] kind, grant, detail in self?.client.sendPermission(which: kind.rawValue, state: grant, detail: detail) }
        permissions.onList = { [weak self] all in self?.client.sendPermissions(all: all) }

        // AppState handlers: UI code only ever talks to AppState. A few commands are
        // ours to act on before (or instead of) the daemon.
        state.sendHandler = { [weak self] cmd in
            guard let self else { return }
            switch cmd {
            case .requestPermission(let which) where which == "microphone":
                // The daemon cannot grant the mic; only this process can ask TCC.
                self.refreshMicrophoneGrant(openSettingsIfDenied: true)
            case .requestPermission(let which) where which == "all":
                // The sweep runs here, in order, one dialog at a time — the daemon's own
                // helper prompt for Accessibility / Screen Recording is not asked for as
                // well, or the two dialogs would stack.
                self.permissions.requestAll()
            case .requestPermission(let which) where which != "accessibility" && which != "screenRecording":
                // Every other kind the app owns. Accessibility and Screen Recording keep
                // going to the daemon, whose fresh helper process prompts and then polls.
                if let kind = PermissionKind(rawValue: which) { self.permissions.requestOne(kind) } else { self.client.send(cmd) }
            case .stop, .pause:
                // Both close the session: drop the queued speech here, instantly, before
                // the daemon's own flush arrives — speech dies at the press.
                self.audio.flush()
                self.client.send(cmd)
            case .automationSnooze(let id, let minutes):
                // A ring's press, from the island, the banner, the menu or ⌥⇧S: what a crash report should know.
                CrashGuard.remember("automation → snooze \(id) \(minutes) min")
                self.client.send(cmd)
            case .automationDone(let id):
                CrashGuard.remember("automation → done \(id)")
                self.client.send(cmd)
            default:
                self.client.send(cmd)
            }
        }
        // The signals the app observes for the daemon's watchers ride the socket as `system.signal` — data, never a command.
        state.signalHandler = { [weak self] signal in self?.client.sendSignal(signal) }
        // A fire while asleep: the earcon and the fixed line through the gate's speaker (never while a session is
        // open — the awake path speaks through Live), and the banner with Snooze · Done.
        client.onLocalSay = { [weak self] msg in
            guard let self, !self.state.inSession else { return }
            self.state.localSpeaker.earcon(msg.sound ?? "Pop")
            if let text = msg.text, !text.isEmpty { self.state.localSpeaker.speak(String(text.prefix(160))) }
        }
        client.onNotify = { [weak self] msg in self?.notifications.post(msg) }
        state.ledgerDaysHandler = { [weak self] in await self?.client.ledgerDays() ?? [] }
        state.ledgerReadHandler = { [weak self] day in await self?.client.ledgerRows(day: day) ?? [] }
        // The rail's search: full text over the live ledger through the daemon (titles only without it).
        state.ledgerSearchHandler = { [weak self] query, limit in await self?.client.ledgerSearch(query: query, limit: limit) }
        state.installJarheadSessions(list: { [weak self] in await self?.client.jarheadSessions() ?? [] },
                                     rows: { [weak self] id in await self?.client.jarheadSessionRows(id) ?? [] },
                                     chain: { [weak self] rootId in await self?.client.jarheadChainRows(rootId) })
        // Memory: the rail's list and search read the store through the daemon (never the snapshot).
        state.memoryListHandler = { [weak self] memoryState, limit in await self?.client.memoryList(state: memoryState, limit: limit) }
        state.memorySearchHandler = { [weak self] query, limit in await self?.client.memorySearch(query: query, limit: limit) }
        state.openConsoleHandler = { [weak self] in self?.console.show() }

        // A (re)started daemon knows nothing about us: re-send what it must know.
        client.onConnected = { [weak self] in
            guard let self else { return }
            if self.micGrant != .unknown { self.client.sendPermission(which: "microphone", state: self.micGrant) }
            // The list, once it has been read (placeholders would tell the daemon "unknown").
            if self.permissions.hasRead { self.client.sendPermissions(all: self.permissions.list) }
            // Its open conversations too: a fresh engine follows nothing until a pane asks again.
            // The first connect counts as well, on purpose: a pane Kevin opened while the daemon
            // was still spawning queued its `agent.open` in EngineClient's outbox, which drops a
            // command older than 5 s — a slow cold start would leave that pane unfollowed. A
            // second open for the same viewer is idempotent at the engine.
            self.console.reconnected()
            // design12: the audio frame too. A restarted daemon starts with `audioState` empty, and
            // while asleep nothing in the read-back changes, so no new frame would ever come —
            // `pnpm jarhead status` would say `no app connected` until the next wake.
            self.audioFrameLast = nil
            if let info = self.state.audioState { self.sendAudioFrame(info) }
        }

        // The daemon: start or attach, then connect.
        do {
            let location = try RepoLocator.locate()
            CrashGuard.setCommit(AppDelegate.commit(of: location.repo))
            let d = DaemonProcess(location: location, socketPath: socketPath, state: state)
            daemon = d
            d.start()
        } catch {
            state.daemonDetail = error.localizedDescription
            state.toast(error.localizedDescription, tone: .error)
            appLog("daemon: \(error.localizedDescription)")
        }
        client.start()

        // The previous run's crash, while its report is fresh: one dismissable line in the
        // Console's rail and one row in the status menu, and the same line in daemon.log
        // next to the engine's, so both halves of the story sit in one file. Never a modal.
        state.revealCrashHandler = { url in NSWorkspace.shared.activateFileViewerSelecting([url]) }
        if let n = crashNotice {
            let notice = CrashNotice(at: n.at, reason: n.reason, fileURL: n.url, relaunched: n.relaunched)
            state.noteCrash(notice)
            daemon?.noteCrash(notice)
            crashNotice = nil
        }

        // Setup wizard on first run (once the daemon has told us the settings: the empty
        // snapshot's defaults are skipped). The payload carries the value; the snapshot
        // itself is still the old one in here.
        state.$snapshot
            .filter { $0 != .empty }
            .map { (s: Snapshot) -> Bool in s.settings.onboarded }
            .removeDuplicates()
            .sink { [weak self] (onboarded: Bool) in MainActor.assumeIsolated { self?.checkFirstRun(onboarded: onboarded) } }
            .store(in: &cancellables)

        // Surface.
        let actions = makeActions()
        menus = Menus(actions: actions)
        menus.install()
        statusItem = StatusItem(state: state, actions: actions)
        hotkeys = Hotkeys { [weak self] action in self?.handle(hotkey: action) }
        hotkeys.register()
        orb.show()
        overlay.start()

        // The automations' banner: the category with Snooze N · Done, the delegate; a press lands on the same row as
        // the island's presses. Bundle-only — a `swift build` binary skips it.
        notifications = Notifications()
        notifications.install(snoozeMinutes: state.snapshot.settings.automationSettings.snoozeMinutes)
        notifications.onSnooze = { [weak self] id, minutes in self?.state.send(.automationSnooze(id: id, minutes: minutes)) }
        notifications.onDone = { [weak self] id in self?.state.send(.automationDone(id: id)) }
        notifications.onOpen = { [weak self] _, _ in self?.state.openConsole() }
        notifications.onTap = { [weak self] _ in self?.state.openConsole() }
        state.$snapshot
            .map { (s: Snapshot) -> Int in s.settings.automationSettings.snoozeMinutes }
            .removeDuplicates()
            .sink { [weak self] (minutes: Int) in MainActor.assumeIsolated { self?.notifications.setSnoozeMinutes(minutes) } }
            .store(in: &cancellables)
        // The signals: app launch / quit, sleep / wake, lock / unlock, displays, the clock.
        signals = SignalObserver(state: state)
        signals.start()
        // `Open at login`: the app registers itself with SMAppService on Kevin's flip in Settings › Automations
        // (D writes the setting; this acts on the change). Never on arrival: Kevin may have removed the login
        // item in System Settings, and a launch must not put it back.
        state.$snapshot
            .filter { $0 != .empty }
            .compactMap { (s: Snapshot) -> Bool? in s.settings.automations?.openAtLogin }
            .removeDuplicates()
            .sink { [weak self] (on: Bool) in MainActor.assumeIsolated { self?.openAtLoginChanged(on) } }
            .store(in: &cancellables)

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.overlay.screensChanged() }
        }

        // Audio follows the phase; the mic device follows settings. Read the payloads
        // (see `phaseSeen`), never `state.phase` inside the sink.
        state.$snapshot
            .map(\.phase)
            .removeDuplicates()
            .sink { [weak self] (phase: Phase) in
                // What a crash report says the app was doing (CrashGuard: the phase line and the ring).
                CrashGuard.setPhase(phase)
                CrashGuard.remember("phase → \(phase.rawValue)")
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.phaseSeen = phase
                    self.updateAudioActivity()
                }
            }
            .store(in: &cancellables)
        state.$connected
            .removeDuplicates()
            .sink { [weak self] (on: Bool) in
                CrashGuard.remember(on ? "daemon connected" : "daemon disconnected")
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.connectedSeen = on
                    self.updateAudioActivity()
                }
            }
            .store(in: &cancellables)
        state.$wakeGate
            .removeDuplicates()
            .sink { (gate: WakeGateState) in CrashGuard.remember("wake gate: \(String(describing: gate))") }
            .store(in: &cancellables)
        state.$snapshot
            .map(\.settings.micDeviceId)
            .removeDuplicates()
            .sink { [weak self] uid in MainActor.assumeIsolated { self?.audio.setPreferredInputDevice(uid: uid) } }
            .store(in: &cancellables)
        // design12 · the two sinks. Recording → the voice-processing policy (the engine reads it at every start, and
        // rebuilds a running graph once Jarhead has finished his sentence); the island hears the setting too.
        state.$snapshot
            .map(\.settings.audioSettings.recording)
            .removeDuplicates()
            .sink { [weak self] (on: Bool) in
                CrashGuard.remember("audio: recording \(on ? "on" : "off")")
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.audio.setPolicy(VoiceProcessingPolicy.from(recording: on))
                    self.postDockAudio()
                }
            }
            .store(in: &cancellables)
        // Mute (phase `muted`) → this process's input zeroed at the HAL, so the orange dot is honest; the graph stays up.
        state.$snapshot
            .map { (s: Snapshot) -> Bool in s.phase == .muted }
            .removeDuplicates()
            .sink { [weak self] (muted: Bool) in MainActor.assumeIsolated { self?.audio.setProcessInputMuted(muted) } }
            .store(in: &cancellables)

        // The first read of every permission (read-only; the daemon gets the list on connect).
        permissions.start()

        // JARHEAD_CRASH_TEST=exception|signal: a dev build crashes on purpose two seconds
        // in, to see the report written, the relaunch spawned and the notice on the next run.
        if let kind = ProcessInfo.processInfo.environment["JARHEAD_CRASH_TEST"] { CrashGuard.armTestCrash(kind) }

        // Microphone: ask once, tell the daemon, and never start audio before we know.
        // JARHEAD_NO_AUDIO=1 skips the request entirely (headless test launches).
        if ProcessInfo.processInfo.environment["JARHEAD_NO_AUDIO"] == "1" {
            appLog("JARHEAD_NO_AUDIO=1, audio disabled")
            return
        }
        refreshMicrophoneGrant(openSettingsIfDenied: false)
    }

    /// Ask TCC (prompting only when undetermined), tell the daemon, and start or stop
    /// audio to match. Re-run on every activation so a grant made in System Settings
    /// takes effect without a relaunch.
    private func refreshMicrophoneGrant(openSettingsIfDenied: Bool) {
        guard ProcessInfo.processInfo.environment["JARHEAD_NO_AUDIO"] != "1" else { return }
        PermissionsKit.requestMicrophone { [weak self] grant in
            guard let self else { return }
            let previous = self.micGrant
            self.micGrant = grant
            CrashGuard.remember("microphone grant: \(grant.rawValue)")
            self.client.sendPermission(which: "microphone", state: grant)
            self.permissions.set(.microphone, grant: grant)
            self.wake.setMicrophone(granted: grant == .granted)
            if grant == .granted, !self.speechRequested {
                // Second prompt, once, right after the first: the wake word needs the
                // on-device recogniser. Nothing is sent anywhere.
                self.speechRequested = true
                WakeWordListener.requestAuthorization { [weak self] ok, detail in
                    self?.wake.setSpeechRecognition(authorized: ok, detail: detail)
                    self?.permissions.set(.speechRecognition, grant: ok ? .granted : PermissionsKit.speechRecognitionStatus())
                    if !ok { self?.state.toast("Wake word off: \(detail)", tone: .warn) }
                }
            }
            if grant == .denied {
                if previous != .denied {
                    self.state.toast("Microphone access denied — Jarhead cannot hear you. Enable it in System Settings › Privacy › Microphone.", tone: .error)
                }
                if openSettingsIfDenied { PermissionsKit.openSettings(pane: .microphone) }
            } else if grant == .granted, previous == .denied {
                self.state.toast("Microphone on.", tone: .info)
            }
            self.updateAudioActivity()
        }
    }

    /// First snapshot from the daemon: if setup never finished, open the wizard once.
    /// `onboarded` is the value just published.
    private func checkFirstRun(onboarded: Bool) {
        guard !firstRunChecked, state.connected else { return }
        firstRunChecked = true
        if !onboarded { onboarding.show() }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // Back from System Settings, most likely: every grant is re-read, fresh.
        permissions?.appActivated()
        if micGrant != .granted { refreshMicrophoneGrant(openSettingsIfDenied: false) }
        // Speech Recognition is asked once, but a grant made later in System Settings
        // must count without a relaunch: re-read the status (no prompt) on activation.
        if speechRequested, !wake.speechAuthorized {
            let (ok, detail) = WakeWordListener.currentAuthorization()
            if ok { wake.setSpeechRecognition(authorized: true, detail: detail) }
        }
    }

    // MARK: - actions

    private func makeActions() -> AppActions {
        var a = AppActions()
        // The transport (AppState's Transport region): the menus press the same two
        // buttons as the capsule, the notch, the Console and the hotkeys.
        a.transportToggle = { [weak self] in self?.state.transportToggle() }
        a.toggleMute = { [weak self] in
            guard let self else { return }
            self.state.send(self.state.phase == .muted ? .unmute : .mute)
        }
        a.stop = { [weak self] in self?.state.transportStop() }
        // design12: the Recording row (and the Dock menu's): set-settings only.
        a.toggleRecording = { [weak self] in self?.toggleRecording() }
        a.openConsole = { [weak self] in
            self?.console.show()
            NSApp.activate(ignoringOtherApps: true)
        }
        a.summonOrb = { [weak self] in self?.orb.summon() }
        a.openLedgerFolder = { [weak self] in
            guard let self else { return }
            let dir = self.state.stateDir.appendingPathComponent("ledger", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            NSWorkspace.shared.open(dir)
        }
        a.quit = { NSApp.terminate(nil) }
        // The automations (design11): the status menu's ring rows and Automations… — the row's commands, the Console.
        a.snoozeRing = { [weak self] id, minutes in self?.state.send(.automationSnooze(id: id, minutes: minutes)) }
        a.doneRing = { [weak self] id in self?.state.send(.automationDone(id: id)) }
        a.openAutomations = { [weak self] in
            self?.console.show()
            NSApp.activate(ignoringOtherApps: true)
        }
        return a
    }

    /// ⌥⇧S, the menu row, the banner: the ring's own snooze press, else Settings' minutes (timers five).
    private func snoozeRinging() {
        guard let ring = state.ringing else { return }
        let minutes = StatusItem.snoozeMinutes(for: ring, settings: state.snapshot.settings.automationSettings)
        state.send(.automationSnooze(id: ring.id, minutes: minutes))
    }

    /// `Settings.automations.openAtLogin` flipped: register or unregister this app as a login item. The first
    /// value seen is remembered, not acted on.
    private func openAtLoginChanged(_ on: Bool) {
        defer { openAtLoginSeen = on }
        guard let seen = openAtLoginSeen, seen != on else { return }
        guard PermissionsKit.runsAsBundle else {
            appLog("open at login: not a bundle, SMAppService skipped")
            return
        }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            CrashGuard.remember("open at login → \(on ? "registered" : "unregistered")")
            appLog("open at login: \(on ? "registered" : "unregistered") (status \(SMAppService.mainApp.status.rawValue))")
        } catch {
            appLog("open at login: SMAppService failed — \(error.localizedDescription)")
            state.toast("Open at login could not be set: \(error.localizedDescription)", tone: .warn)
        }
    }

    private func handle(hotkey: Hotkeys.Action) {
        switch hotkey {
        case .openConsole:
            console.show()
            NSApp.activate(ignoringOtherApps: true)
        case .toggleMute:
            state.send(state.phase == .muted ? .unmute : .mute)
        case .stop:
            // ⌥⎋: the speaker flush rides in the send handler above, before the command leaves.
            state.transportStop()
        case .markScreen:
            state.beginMarkMode()
        case .sayLine:
            // ⌥⇧Return: the notch's field while the blob is parked there, else the Console's composer.
            orb.sayLine()
        case .transportToggle:
            // ⌥⇧Space: go when asleep or paused, pause in session.
            state.transportToggle()
        case .snooze:
            // ⌥⇧S: snooze the ring; nothing rings, nothing happens — never a Go.
            snoozeRinging()
        case .toggleRecording:
            // ⌥⇧R: Settings › Audio › Recording flipped — the whole audio block through `set-settings`, nothing else.
            toggleRecording()
        }
    }

    // MARK: - audio state (design12)

    /// Recording flipped from the menu, the Dock menu or ⌥⇧R: `set-settings` only (AppState.setRecording; the bench pins it).
    private func toggleRecording() {
        state.setRecording(!state.snapshot.settings.audioSettings.recording)
    }

    /// On main, from `AudioEngine.onAudioState`: AppState (the Console's `Shared with …`, the fuse's `guardOn`), the daemon's
    /// `audio-state` frame at ≤ 1 Hz (a trailing send carries the last value of a burst), and the island's three facts.
    private func audioStateChanged(_ readback: AudioStateReadback) {
        let info = AudioStateInfo(readback)
        audioGuardHeld = readback.guardHeld
        audioSharedWith = info.sharedWith?.first
        if info != state.audioState { state.audioState = info }
        postDockAudio()
        sendAudioFrame(info)
    }

    private func sendAudioFrame(_ info: AudioStateInfo) {
        guard info != audioFrameLast else { return }
        audioFrameLast = info
        let now = CFAbsoluteTimeGetCurrent()
        if now - audioFrameSentAt >= 1 {
            audioFrameSentAt = now
            client.sendAudioState(info)
            return
        }
        guard !audioFramePending else { return }
        audioFramePending = true
        let wait = max(0.05, 1 - (now - audioFrameSentAt))
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let last = self.audioFrameLast else { return }
                self.audioFramePending = false
                self.audioFrameSentAt = CFAbsoluteTimeGetCurrent()
                self.client.sendAudioState(last)
            }
        }
    }

    /// The island's mute box and peek chip (`NotchDock.audioNotification`): the setting, the guard's edge, who shares.
    private func postDockAudio() {
        var info: [String: Any] = [
            NotchDock.audioRecordingKey: state.snapshot.settings.audioSettings.recording,
            NotchDock.audioHeldKey: audioGuardHeld,
        ]
        if let audioSharedWith { info[NotchDock.audioSharedKey] = audioSharedWith }
        NotificationCenter.default.post(name: NotchDock.audioNotification, object: nil, userInfo: info)
    }

    // MARK: - audio activity

    /// The mic and speaker run while a session is open or opening (anything but asleep,
    /// error and paused — `AppState.voiceAudioRuns(in:)`) and the microphone is granted.
    /// Asleep and paused both mean nothing is captured and nothing is billed: a pause
    /// closes the session, so the orange mic dot goes out and the wake gate takes the
    /// microphone back to listen for the word that resumes. The gate and the voice
    /// engine never hold the microphone together: the gate is told to let go before the
    /// voice engine starts, and told it may listen only after the voice engine has been
    /// asked to stop.
    private func updateAudioActivity() {
        let wantActive = micGrant == .granted && connectedSeen && AppState.voiceAudioRuns(in: phaseSeen)
        guard wantActive != audioActive else { return }
        audioActive = wantActive
        CrashGuard.remember(wantActive ? "voice audio: start (gate lets go, mic + speaker up)" : "voice audio: stop (gate may listen)")
        if wantActive {
            wake.setVoiceAudioActive(true)
            audio.start()
            ear.setVoiceAudioActive(true)
        } else {
            ear.setVoiceAudioActive(false)
            audio.stop()
            wake.setVoiceAudioActive(false)
        }
    }

    // MARK: - app events

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        console.show()
        return false
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        statusItem?.buildMenu()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "jarhead" {
            let verb = url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            switch verb {
            case "go":
                // The transport's Go. Anything on this Mac (or a browser) can open a URL: while
                // the gate is on and the engine is dormant, the URL authenticates like the spoken
                // word; while paused it resumes like the word does, without authentication
                // (WakeGate.heard).
                if !wake.requestWake(source: "jarhead://\(verb)") { state.transportGo() }
            case "pause": state.transportPause()
            case "stop": state.transportStop()
            case "orb": orb.summon()
            case "setup": state.openOnboarding()
            default: console.show()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        appLog("quit: terminating in phase \(state.phase.rawValue)")
        // Stop the engine first so the Live session (which bills by the second) closes:
        // the transport's stop interrupts whatever runs, closes the session and sleeps.
        if state.connected { client.send(.stop) }
        hotkeys?.unregister()
        signals?.stop()
        overlay?.stop()
        ear?.setVoiceAudioActive(false)
        audio?.stop()
        // Give the sleep command a moment to leave the socket before we tear it down.
        Thread.sleep(forTimeInterval: 0.25)
        client?.stop()
        // A clean quit: the daemon hears `bye` before its stdin closes (DaemonProcess.stop),
        // so it shuts down instead of lingering for a relaunch that is not coming.
        daemon?.stop(timeout: 5)
        statusItem?.remove()
    }

    // MARK: - helpers

    /// The bundle's icns; from a `swift build` binary, the checkout's build/Jarhead.icns when it has been made.
    private func installDockIcon() {
        let candidates = [
            Bundle.main.url(forResource: "Jarhead", withExtension: "icns"),
            RepoLocator.repoRoot()?.appendingPathComponent("build/Jarhead.icns"),
        ]
        for url in candidates.compactMap({ $0 }) where FileManager.default.fileExists(atPath: url.path) {
            if let image = NSImage(contentsOf: url) {
                NSApp.applicationIconImage = image
                return
            }
        }
    }

    /// `$JARHEAD_STATE_DIR`, else `~/.jarhead` — the same rule as packages/core.
    static func stateDir() -> URL {
        let env = ProcessInfo.processInfo.environment
        if let s = env["JARHEAD_STATE_DIR"], !s.isEmpty { return URL(fileURLWithPath: (s as NSString).expandingTildeInPath, isDirectory: true) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".jarhead", isDirectory: true)
    }

    /// `$JARHEAD_SOCKET`, else `<state dir>/jarhead.sock` — the same rule as packages/core.
    static func socketPath() -> String {
        let env = ProcessInfo.processInfo.environment
        if let s = env["JARHEAD_SOCKET"], !s.isEmpty { return (s as NSString).expandingTildeInPath }
        return stateDir().appendingPathComponent("jarhead.sock").path
    }

    /// The checkout's commit, short, for the crash report: `.git/HEAD` and the ref it names.
    static func commit(of repo: URL) -> String {
        let git = repo.appendingPathComponent(".git")
        guard let head = try? String(contentsOf: git.appendingPathComponent("HEAD"), encoding: .utf8) else { return "unknown" }
        let line = head.trimmingCharacters(in: .whitespacesAndNewlines)
        var sha = line
        if line.hasPrefix("ref: ") {
            let ref = String(line.dropFirst(5))
            if let s = try? String(contentsOf: git.appendingPathComponent(ref), encoding: .utf8) {
                sha = s.trimmingCharacters(in: .whitespacesAndNewlines)
            } else if let packed = try? String(contentsOf: git.appendingPathComponent("packed-refs"), encoding: .utf8),
                      let row = packed.split(separator: "\n").first(where: { $0.hasSuffix(" " + ref) }) {
                sha = String(row.prefix(40))
            } else {
                return ref.replacingOccurrences(of: "refs/heads/", with: "")
            }
        }
        return sha.count >= 7 ? String(sha.prefix(7)) : sha
    }
}

// MARK: - design12: the read-back as the protocol spells it

private extension AudioDeviceInfo {
    init(_ d: AudioDeviceFacts) { self.init(name: d.name, uid: d.uid, rate: d.rate, channels: d.channels, transport: d.transport) }
}

private extension AudioStateInfo {
    /// `AudioStateReadback` → the frame's value: bundle ids become process names here (`NSRunningApplication`), the duck level
    /// a plain number, the held seconds milliseconds; nil `sharedWith` stays nil (the HAL could not say — never `[]`).
    init(_ r: AudioStateReadback) {
        self.init(running: r.running, voiceProcessing: r.voiceProcessing, duckLevel: r.duckLevel.map { Int($0) },
                  advancedDucking: r.advancedDucking, agc: r.agc, bypassed: r.bypassed, rung: r.rung, wiring: r.wiring,
                  hears: r.hears.map(AudioDeviceInfo.init), speaks: r.speaks.map(AudioDeviceInfo.init), tapFormat: r.tapFormat,
                  recording: r.recording, fallback: r.fallback, guardOn: r.guardOn, guardTailMs: r.guardTailMs,
                  guardHeldMs: Int((r.heldSeconds * 1000).rounded()), gated: r.gated, chunks: r.chunks, breakthroughs: r.breakthroughs,
                  sharedWith: r.sharedWith?.map(MicRouteInfo.processName), inputMuted: r.inputMuted, aggregatePresent: r.aggregatePresent)
    }
}
