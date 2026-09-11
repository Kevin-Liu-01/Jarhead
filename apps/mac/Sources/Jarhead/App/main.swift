import AppKit

// Entry point. No @main: top-level code so the delegate is created before the
// run loop starts and the activation policy is explicit (Dock icon on).
// Top-level code is not main-actor isolated in language mode 5, hence the wrapper.

/// Signal sources, kept alive for the life of the process. Declared before use: main.swift
/// globals are initialised in source order.
nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)

    // `pkill Jarhead` / Ctrl-C should quit the same way ⌘Q does, so the daemon is
    // stopped and the voice session put to sleep instead of the process just vanishing.
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { NSApp.terminate(nil) } }
        source.resume()
        signalSources.append(source)
    }

    app.run()
}
