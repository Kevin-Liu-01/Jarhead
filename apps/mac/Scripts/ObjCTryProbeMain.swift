import AVFoundation
import Foundation

// Throwaway harness: proves the ObjC exception shim (Sources/JarheadObjC, wrapped by
// Audio/ObjCTry.swift) catches what AVFoundation raises, without the app, the daemon or
// any TCC prompt. Not part of the package; compiled only by Scripts/objc-try-probe.sh.
//
// Always (no hardware needed):
//   1. mixer → output connected at a 0 Hz format — what a device that has just vanished
//      reports — raises "required condition is false: IsFormatSampleRateAndChannelCountValid".
//   2. a stereo buffer scheduled on a mono player raises "required condition is false:
//      _outputFormat.channelCount == buffer.format.channelCount".
// Only when this process already holds the microphone grant (the probe never prompts):
//   3. installTap on the INPUT node with a format it does not have raises "Failed to
//      create tap due to format mismatch" — the exact raise that took the app down five
//      times on 2026-09-11, uncaught, from the wake listener after a device change.
//      (On a player node AVFoundation applies the format to the bus instead; the input
//      node's format is the hardware's and cannot be applied — hence the raise.)
//   4. the same tap with `format: nil` (how every tap is installed now): no raise.
//   5. the voice `AudioEngine` starts, a configuration change is simulated at +1.5 s, and
//      the status lines show the input format before → after and the restart — no abort;
//      every mic level it reports is checked to be finite and within 0…1.
// Inside `objcTry` each raise is a Swift error whose reason prints and the process lives.
//
//   OBJC_TRY_PROBE_UNSAFE=1   run check 1 outside the shim first, to watch the abort.
//
// Exit status 0 when every raise that should be caught was caught, 1 otherwise.
@main
struct ObjCTryProbeMain {
    static func main() {
        setlinebuf(stdout)
        let t0 = Date()
        func say(_ s: String) { print(String(format: "+%6.3f  %@", Date().timeIntervalSince(t0), s)) }
        var failures = 0

        /// Runs `body` inside the shim and reports: caught (good), no raise, or a non-ObjC error.
        func expectRaise(_ label: String, _ body: () -> Void) {
            say(label)
            do {
                try objcTry(body)
                say("   FAIL: no exception was raised")
                failures += 1
            } catch let raised as ObjCException {
                say("   caught \(raised.name): \(raised.reason)")
                let top = raised.callStack.split(separator: "\n").dropFirst(2).prefix(3).map { $0.trimmingCharacters(in: .whitespaces) }
                if !top.isEmpty { say("   raised from: \(top.joined(separator: " | "))") }
            } catch {
                say("   FAIL: not an ObjC exception: \(error)")
                failures += 1
            }
        }
        func expectQuiet(_ label: String, _ body: () -> Void) {
            say(label)
            do {
                try objcTry(body)
                say("   ok: no raise")
            } catch {
                say("   FAIL: raised: \(error)")
                failures += 1
            }
        }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let mono24k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
        let stereo48k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
        engine.connect(player, to: engine.mainMixerNode, format: mono24k)

        // 1. a 0 Hz connection (a vanished device)
        if let zero = AVAudioFormat(standardFormatWithSampleRate: 0, channels: 1) {
            if ProcessInfo.processInfo.environment["OBJC_TRY_PROBE_UNSAFE"] == "1" {
                say("OBJC_TRY_PROBE_UNSAFE=1: connecting mixer → output at 0 Hz outside the shim first — expect an abort")
                engine.connect(engine.mainMixerNode, to: engine.outputNode, format: zero)
            }
            expectRaise("1. mixer → output connected at a 0 Hz format, inside objcTry") {
                engine.connect(engine.mainMixerNode, to: engine.outputNode, format: zero)
            }
        } else {
            say("1. skipped: this OS refuses to build a 0 Hz AVAudioFormat")
        }

        // 2. channel mismatch on the player
        expectRaise("2. a 48 kHz ×2 buffer scheduled on the 24 kHz ×1 player, inside objcTry") {
            let b = AVAudioPCMBuffer(pcmFormat: stereo48k, frameCapacity: 480)!
            b.frameLength = 480
            player.scheduleBuffer(b, completionHandler: nil)
        }

        // 3–5 need the microphone; never prompt for it.
        let grant = AVCaptureDevice.authorizationStatus(for: .audio)
        guard grant == .authorized else {
            let name: String
            switch grant {
            case .notDetermined: name = "not decided"
            case .denied: name = "denied"
            case .restricted: name = "restricted"
            case .authorized: name = "granted"
            @unknown default: name = "unknown"
            }
            say("3–5. skipped: this process's microphone grant is \(name); the probe never prompts (run it from a terminal that already has the microphone to see the input-node raise and the restart path)")
            say("done: \(failures == 0 ? "every raise was caught" : "\(failures) check(s) failed")")
            exit(failures == 0 ? 0 : 1)
        }

        let input = engine.inputNode
        let hw = input.outputFormat(forBus: 0)
        say("microphone granted; the input node reports \(hw.brief)")
        guard hw.sampleRate > 0 else {
            say("3–5. skipped: no input device")
            say("done: \(failures == 0 ? "every raise was caught" : "\(failures) check(s) failed")")
            exit(failures == 0 ? 0 : 1)
        }
        // A rate the device does not run: 44.1 kHz unless that is what it runs, then 22.05 kHz.
        let wrongRate: Double = hw.sampleRate == 44_100 ? 22_050 : 44_100
        let wrong = AVAudioFormat(standardFormatWithSampleRate: wrongRate, channels: 1)!
        expectRaise("3. installTap on the input node with \(wrong.brief) (it runs \(hw.brief)), inside objcTry — the 2026-09-11 crash") {
            input.installTap(onBus: 0, bufferSize: 4096, format: wrong) { _, _ in }
        }
        _ = try? objcTry { input.removeTap(onBus: 0) }
        expectQuiet("4. installTap on the input node with format nil, inside objcTry") {
            input.installTap(onBus: 0, bufferSize: 4096, format: nil) { _, _ in }
        }
        _ = try? objcTry { input.removeTap(onBus: 0) }

        say("5. starting the voice AudioEngine; simulating a configuration change at +1.5 s; stopping at +4 s")
        let audio = AudioEngine()
        audio.onStatus = { text in say("   audio: \(text)") }
        audio.onMicLevel = { level in
            if !level.isFinite || level < 0 || level > 1 { say("   FAIL: mic level \(level) left 0…1"); failures += 1 }
        }
        audio.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            say("   simulating AVAudioEngineConfigurationChange")
            audio.simulateConfigurationChange()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
            audio.stop()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                say("done: \(failures == 0 ? "every raise was caught; the engine restarted without aborting" : "\(failures) check(s) failed")")
                exit(failures == 0 ? 0 : 1)
            }
        }
        RunLoop.main.run()
    }
}
