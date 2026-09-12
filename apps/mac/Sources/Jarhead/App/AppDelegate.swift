import AppKit
import Combine

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()

    private var orb: OrbPanelController!
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
    private var cancellables = Set<AnyCancellable>()

    private var micGrant: Grant = .unknown
    private var audioActive = false
    private var speechRequested = false
    /// Phase and connection as last *published*. `@Published` emits in `willSet`, so
    /// inside a sink `state.phase` / `state.connected` still hold the previous value;
    /// these are fed from the sink payloads and are what the audio decision reads.
    private var phaseSeen: Phase = .asleep
    private var connectedSeen = false

    // MARK: - launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        installDockIcon()

        orb = OrbPanelController(state: state)
        overlay = OverlayManager(state: state)
        console = ConsoleWindowController(state: state)
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
        audio.onStatus = { [weak self] text in
            NSLog("Audio: %@", text)
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
            default:
                self.client.send(cmd)
            }
        }
        state.ledgerDaysHandler = { [weak self] in await self?.client.ledgerDays() ?? [] }
        state.ledgerReadHandler = { [weak self] day in await self?.client.ledgerRows(day: day) ?? [] }
        state.installJarheadSessions(list: { [weak self] in await self?.client.jarheadSessions() ?? [] },
                                     rows: { [weak self] id in await self?.client.jarheadSessionRows(id) ?? [] })
        state.openConsoleHandler = { [weak self] in self?.console.show() }

        // A (re)started daemon knows nothing about us: re-send what it must know.
        client.onConnected = { [weak self] in
            guard let self else { return }
            if self.micGrant != .unknown { self.client.sendPermission(which: "microphone", state: self.micGrant) }
            // The list, once it has been read (placeholders would tell the daemon "unknown").
            if self.permissions.hasRead { self.client.sendPermissions(all: self.permissions.list) }
        }

        // The daemon: start or attach, then connect.
        do {
            let location = try RepoLocator.locate()
            let d = DaemonProcess(location: location, socketPath: socketPath, state: state)
            daemon = d
            d.start()
        } catch {
            state.daemonDetail = error.localizedDescription
            state.toast(error.localizedDescription, tone: .error)
            NSLog("Jarhead: %@", error.localizedDescription)
        }
        client.start()

        // Setup wizard on first run (once the daemon has told us the settings). The
        // payload carries the value; the snapshot itself is still the old one in here.
        state.$snapshot
            .map { (s: Snapshot) -> Bool? in s.settings.onboarded }
            .removeDuplicates()
            .sink { [weak self] (onboarded: Bool?) in MainActor.assumeIsolated { self?.checkFirstRun(onboarded: onboarded) } }
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

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.overlay.screensChanged() }
        }

        // Audio follows the phase; the mic device follows settings. Read the payloads
        // (see `phaseSeen`), never `state.phase` inside the sink.
        state.$snapshot
            .map(\.phase)
            .removeDuplicates()
            .sink { [weak self] (phase: Phase) in
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
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.connectedSeen = on
                    self.updateAudioActivity()
                }
            }
            .store(in: &cancellables)
        state.$snapshot
            .map(\.settings.micDeviceId)
            .removeDuplicates()
            .sink { [weak self] uid in MainActor.assumeIsolated { self?.audio.setPreferredInputDevice(uid: uid) } }
            .store(in: &cancellables)

        // The first read of every permission (read-only; the daemon gets the list on connect).
        permissions.start()

        // Microphone: ask once, tell the daemon, and never start audio before we know.
        // JARHEAD_NO_AUDIO=1 skips the request entirely (headless test launches).
        if ProcessInfo.processInfo.environment["JARHEAD_NO_AUDIO"] == "1" {
            NSLog("Jarhead: JARHEAD_NO_AUDIO=1, audio disabled")
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
    /// `onboarded` is the value just published (nil until the daemon has spoken).
    private func checkFirstRun(onboarded: Bool?) {
        guard !firstRunChecked, let onboarded, state.connected else { return }
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
        return a
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
        case .transportToggle, .transportToggleAlias:
            // ⌥⇧Space (and ⌥⇧P, the same toggle): go when asleep or paused, pause in session.
            state.transportToggle()
        }
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
            case "go", "wake", "resume":
                // The transport's Go (`wake` and `resume` are the old names for it). Anything
                // on this Mac (or a browser) can open a URL: while the gate is on and the
                // engine is dormant, the URL authenticates like the spoken word; while
                // paused it resumes like the word does, without authentication (WakeGate.heard).
                if !wake.requestWake(source: "jarhead://\(verb)") { state.transportGo() }
            case "pause": state.transportPause()
            case "stop", "sleep": state.transportStop()
            case "orb": orb.summon()
            default: console.show()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        // Stop the engine first so the Live session (which bills by the second) closes:
        // the transport's stop interrupts whatever runs, closes the session and sleeps.
        if state.connected { client.send(.stop) }
        hotkeys?.unregister()
        overlay?.stop()
        ear?.setVoiceAudioActive(false)
        audio?.stop()
        // Give the sleep command a moment to leave the socket before we tear it down.
        Thread.sleep(forTimeInterval: 0.25)
        client?.stop()
        daemon?.stop(timeout: 5)
        statusItem?.remove()
    }

    // MARK: - helpers

    private func installDockIcon() {
        let candidates = [
            Bundle.main.url(forResource: "Jarhead", withExtension: "icns"),
            URL(fileURLWithPath: "/Users/kevinliu/jarvis/build/Jarhead.icns"),
        ]
        for url in candidates.compactMap({ $0 }) where FileManager.default.fileExists(atPath: url.path) {
            if let image = NSImage(contentsOf: url) {
                NSApp.applicationIconImage = image
                return
            }
        }
    }

    /// `$JARHEAD_SOCKET`, else `<state dir>/jarhead.sock` — the same rule as packages/core.
    static func socketPath() -> String {
        let env = ProcessInfo.processInfo.environment
        if let s = env["JARHEAD_SOCKET"], !s.isEmpty { return (s as NSString).expandingTildeInPath }
        let stateDir = (env["JARHEAD_STATE_DIR"].map { ($0 as NSString).expandingTildeInPath })
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".jarhead").path
        return (stateDir as NSString).appendingPathComponent("jarhead.sock")
    }
}
