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
    private var daemon: DaemonProcess?
    private var statusItem: StatusItem!
    private var menus: Menus!
    private var hotkeys: Hotkeys!
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

        // AppState handlers: UI code only ever talks to AppState. A few commands are
        // ours to act on before (or instead of) the daemon.
        state.sendHandler = { [weak self] cmd in
            guard let self else { return }
            switch cmd {
            case .requestPermission(let which) where which == "microphone":
                // The daemon cannot grant the mic; only this process can ask TCC.
                self.refreshMicrophoneGrant(openSettingsIfDenied: true)
            case .stop:
                self.audio.flush() // instant, before the daemon's own flush arrives
                self.client.send(cmd)
            default:
                self.client.send(cmd)
            }
        }
        state.ledgerDaysHandler = { [weak self] in await self?.client.ledgerDays() ?? [] }
        state.ledgerReadHandler = { [weak self] day in await self?.client.ledgerRows(day: day) ?? [] }
        state.openConsoleHandler = { [weak self] in self?.console.show() }

        // A (re)started daemon knows nothing about us: re-send what it must know.
        client.onConnected = { [weak self] in
            guard let self else { return }
            if self.micGrant != .unknown { self.client.sendPermission(which: "microphone", state: self.micGrant) }
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
            self.wake.setMicrophone(granted: grant == .granted)
            if grant == .granted, !self.speechRequested {
                // Second prompt, once, right after the first: the wake word needs the
                // on-device recogniser. Nothing is sent anywhere.
                self.speechRequested = true
                WakeWordListener.requestAuthorization { [weak self] ok, detail in
                    self?.wake.setSpeechRecognition(authorized: ok, detail: detail)
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
        a.toggleWake = { [weak self] in
            guard let self else { return }
            self.state.send(self.state.isAwake ? .sleep : .wake)
        }
        a.toggleMute = { [weak self] in
            guard let self else { return }
            self.state.send(self.state.phase == .muted ? .unmute : .mute)
        }
        a.stop = { [weak self] in self?.state.send(.stop) }
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
            state.send(.stop)
            audio.flush()
        case .markScreen:
            state.beginMarkMode()
        case .toggleWake:
            state.send(state.isAwake ? .sleep : .wake)
        }
    }

    // MARK: - audio activity

    /// The mic and speaker run while a session is open (anything but asleep/error) and
    /// the microphone is granted. Asleep means nothing is captured and nothing is billed.
    /// The gate and the voice engine never hold the microphone together: the gate is
    /// told to let go before the voice engine starts, and told it may listen only after
    /// the voice engine has been asked to stop.
    private func updateAudioActivity() {
        let awake = phaseSeen != .asleep && phaseSeen != .error
        let wantActive = micGrant == .granted && connectedSeen && awake
        guard wantActive != audioActive else { return }
        audioActive = wantActive
        if wantActive {
            wake.setVoiceAudioActive(true)
            audio.start()
        } else {
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
            switch url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) {
            case "wake":
                // Anything on this Mac (or a browser) can open a URL: while the gate is on
                // and the engine is dormant, the URL authenticates like the spoken word.
                if !wake.requestWake(source: "jarhead://wake") { state.send(.wake) }
            case "sleep": state.send(.sleep)
            case "stop": state.send(.stop)
            case "orb": orb.summon()
            default: console.show()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        // Put the engine to sleep first so the Live session (which bills by the second) closes.
        if state.connected { client.send(.sleep) }
        hotkeys?.unregister()
        overlay?.stop()
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
