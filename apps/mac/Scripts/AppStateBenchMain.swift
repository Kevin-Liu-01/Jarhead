import Foundation

/// Runs the Swift model's acceptance checks (apps/mac has no XCTest target): AppStateBench in
/// Model/AppState.swift — 20 000 append deltas keep 400 messages in under 200 ms, prepend
/// dedupes and keeps order, a re-sent trimmed message is skipped, isLive derives from
/// connection and status, a daemon drop seals every utterance, SettingsPatch carries
/// language / accent / memory — and, compiled with -D ONBOARDING_BENCH and the onboarding
/// preview's file list, OnboardingBench (the Setup › Voice pins). Both live behind `#if DEBUG`,
/// so this is built with -D DEBUG (see Scripts/appstate-bench.sh). One line per check, the
/// timing line last, exit 1 on any FAIL. Foundation only: no window, no TCC, no daemon, no
/// Live session.
@main
struct AppStateBenchMain {
    static func main() {
        MainActor.assumeIsolated {
            var lines = AppStateBench.run()
            #if ONBOARDING_BENCH
            lines += OnboardingBench.run()
            #endif
            for line in lines { print(line) }
            let checks = lines.filter { $0.hasPrefix("ok") || $0.hasPrefix("FAIL") }
            let failed = checks.filter { $0.hasPrefix("FAIL") }.count
            print(failed == 0 ? "ok · \(checks.count) checks" : "FAIL · \(failed) of \(checks.count) checks")
            exit(failed == 0 ? 0 : 1)
        }
    }
}
