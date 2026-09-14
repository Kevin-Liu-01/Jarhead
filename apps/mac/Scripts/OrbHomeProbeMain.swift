import Foundation

// The blob-home rule of a mark's own echo (`MarkHomeRule`, UI/Orb/OrbPanelController.swift),
// pinned transition by transition without a window — the package has no test target, and the
// orb preview harness needs a display, a simulated notch and a run loop for the same scenario.
// Not part of the package; compiled only by Scripts/orb-home-probe.sh over the Model, UI, Orb
// and Overlay sources (the rule lives beside the controller) and this file.
//
// What it proves, in the order the controller drives the rule:
//   - a trace arms it only as a mark's echo from the dock (tucked, reason "mark"), and the dock
//     keeps its pin; a reflex circle, a trace with no reason, or a mark echo with the blob
//     already out never do — and one of those arriving while an echo was owed its way home
//     drops the folded pin (the blob stays out by the new line);
//   - the review's scenario: the mark echo cut short by Kevin's hand, the capsule, a hide or a
//     display going away (`cancelFlight` → `interrupted`) ends the rule and drops the folded pin
//     ONCE, so a later unrelated job's fly has nothing to drop and its `workDone` stays where it
//     worked — before the fix the flag stayed armed and the blob tucked into the notch, and the
//     dock restored the pin at the next sleep tuck with nobody near;
//   - another job's fly overtaking the line (`fly(to:)`, any reason but "mark") ends it the
//     same way; the mark echo's own Reduce Motion flight (reason "mark") leaves it armed;
//   - the happy path tucks once and is consumed; with notch mode gone it stays;
//   - a route home by other means — the explicit `orb.home`, a Stop whose sleep tucks the blob —
//     disarms without dropping the pin (it comes back with the blob);
//   - a fresh mark echo after an interruption arms again.
// One line per check, "ok" or "FAIL" first; exit 1 on any FAIL.
@main
struct OrbHomeProbeMain {
    static func main() {
        setlinebuf(stdout)
        var failed = 0
        func expect(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failed += 1 }
            print("check: \(ok ? "ok  " : "FAIL") \(name) → '\(got)'\(ok ? "" : " (want '\(want)')")")
        }
        func word(_ b: Bool) -> String { b ? "true" : "false" }
        func word(_ e: MarkHomeRule.End) -> String { e == .tuck ? "tuck" : "stay" }
        func word(_ p: MarkHomeRule.Pin) -> String {
            switch p {
            case .keep: return "keep"
            case .drop: return "drop"
            case .leave: return "leave"
            }
        }

        // Arming.
        var rule = MarkHomeRule()
        expect("at rest: not armed", word(rule.armed), "false")
        expect("mark echo from the dock arms: the dock keeps its pin", word(rule.traceBegins(tucked: true, reason: "mark")), "keep")
        expect("armed after the mark echo", word(rule.armed), "true")
        var other = MarkHomeRule()
        expect("reflex circle never arms, no pin to speak of", word(other.traceBegins(tucked: true, reason: "reflex")), "leave")
        expect("trace with no reason never arms", word(other.traceBegins(tucked: true, reason: nil)), "leave")
        expect("mark echo with the blob already out never arms", word(other.traceBegins(tucked: false, reason: "mark")), "leave")
        expect("still not armed", word(other.armed), "false")

        // A second trace takes the echo's line down while its way home was owed.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        expect("a second mark while the blob is out: the folded pin is dropped", word(rule.traceBegins(tucked: false, reason: "mark")), "drop")
        expect("… and the rule is over", word(rule.armed), "false")
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        expect("the brain's own trace overtaking the echo: the pin is dropped", word(rule.traceBegins(tucked: false, reason: "show_trace")), "drop")

        // The review's scenario: the outline interrupted, then an unrelated job minutes later.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        expect("interrupted (summon / drag / capsule / hide): the pin is dropped", word(rule.interrupted()), "drop")
        expect("interrupted: the rule is over", word(rule.armed), "false")
        expect("a later job's fly finds nothing to drop", word(rule.flyBegins(reason: "click")), "leave")
        expect("that job's work ends where it worked, not in the notch", word(rule.workDone(notchMode: true)), "stay")
        expect("a second interruption drops nothing (the pin was dropped once)", word(rule.interrupted()), "leave")

        // Another job's fly overtakes the line itself.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        expect("another job's fly overtaking ends the rule and drops the pin", word(rule.flyBegins(reason: "type")), "drop")
        expect("overtaken: not armed", word(rule.armed), "false")
        expect("the overtaking fly's work stays", word(rule.workDone(notchMode: true)), "stay")

        // The mark echo's own Reduce Motion flight keeps the rule.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        expect("the echo's own fly (reason mark) changes nothing for the pin", word(rule.flyBegins(reason: "mark")), "leave")
        expect("… and leaves the rule armed", word(rule.armed), "true")
        expect("its hover's end tucks", word(rule.workDone(notchMode: true)), "tuck")

        // The happy path: home once, then nothing owed.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        expect("the sealed line's end tucks in notch mode", word(rule.workDone(notchMode: true)), "tuck")
        expect("consumed: not armed", word(rule.armed), "false")
        expect("the next work's end stays", word(rule.workDone(notchMode: true)), "stay")

        // Notch mode gone before the end: stay, and nothing left armed.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        expect("notch mode off at the end: stays", word(rule.workDone(notchMode: false)), "stay")
        expect("… and the rule is consumed all the same", word(rule.armed), "false")

        // Home by other means (orb.home, a Stop's sleep): disarmed, the pin left to the dock's rule at the tuck.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        rule.homeBound()
        expect("orb.home / Stop disarms", word(rule.armed), "false")
        expect("… and drops no pin (it comes back with the blob at the tuck)", word(rule.interrupted()), "leave")
        expect("… so the flight's teardown after a Stop stays put", word(rule.workDone(notchMode: true)), "stay")

        // A fresh mark echo after an interruption arms again.
        rule = MarkHomeRule()
        _ = rule.traceBegins(tucked: true, reason: "mark")
        _ = rule.interrupted()
        expect("a fresh mark echo arms again", word(rule.traceBegins(tucked: true, reason: "mark")), "keep")
        expect("two rules at rest are equal", word(MarkHomeRule() == MarkHomeRule()), "true")

        print("check: \(failed == 0 ? "all ok" : "\(failed) FAILED") (mark home)")
        exit(failed == 0 ? 0 : 1)
    }
}
