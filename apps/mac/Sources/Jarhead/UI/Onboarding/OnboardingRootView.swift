import SwiftUI

// The wizard's shell: a rail of steps, the current step, Back / Continue. This
// is the only view here that observes `AppState`; it folds the state into one
// Equatable `OnboardingModel` and hands each step the slice it needs. Every step,
// the rail and the footer are Equatable on their data (closures ignored) and
// mounted with `.equatable()`, so the 20 Hz levels stream re-evaluates nothing
// below this body. Lines: the one vertical rule between rail and pane and the
// footer's top rule are drawn here.

let onboardingIconGap: CGFloat = 8
/// Label column of a form row.
let onboardingKeyWidth: CGFloat = 88
/// Content pane padding.
let onboardingInset: CGFloat = 24
/// A form control's row: fields and buttons are this tall; labels centre on it.
let onboardingRowHeight: CGFloat = 28

struct OnboardingRootView: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: OnboardingSession
    let actions: OnboardingActions

    var body: some View {
        let model = OnboardingModel(state: state)
        let report = OnboardingReport(model: model)
        HStack(spacing: 0) {
            OnboardingRail(step: session.step, report: report) { step in withAnimation(Motion.snappy) { session.go(step) } }
                .equatable()
                .frame(width: 168)
            ConsoleHairline(vertical: true)
            VStack(spacing: 0) {
                ScrollView(.vertical) {
                    // A step changing hands: the new one slides in 12pt from the side it
                    // came from (right going forward, left going back) over the old one
                    // fading where it stands — a ZStack so the two overlap.
                    ZStack(alignment: .topLeading) {
                        content(model: model, report: report)
                            .padding(onboardingInset)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .id(session.step)
                            .transition(ConsoleMotion.slide(forward: session.forward))
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .animation(Motion.gentle, value: session.step)
                }
                .scrollIndicators(.automatic)
                // Reopening rebuilds the steps so a draft typed before the window
                // was closed does not linger in a field.
                .id(session.generation)
                ConsoleHairline()
                OnboardingFooter(step: session.step, dirty: session.dirty,
                                 back: { withAnimation(Motion.snappy) { session.back() } },
                                 next: { withAnimation(Motion.snappy) { session.step == .done ? actions.finish() : session.next() } })
                    .equatable()
            }
        }
        .background(ConsoleGround())
        .frame(minWidth: 560, minHeight: 480)
        .task(id: PollKey(step: session.step, visible: session.visible)) {
            // TCC has no change notification: re-read (never a prompt) on every step
            // change, and every 2 s while the two steps that show it are on screen, so a
            // grant made in System Settings appears without a relaunch. The list itself
            // is AppState's (the PermissionsCenter publishes it).
            actions.permissions.refresh()
            guard session.visible, session.step == .permissions || session.step == .done else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { break }
                actions.permissions.refresh()
            }
        }
    }

    private struct PollKey: Equatable {
        let step: OnboardingStep
        let visible: Bool
    }

    @ViewBuilder
    private func content(model: OnboardingModel, report: OnboardingReport) -> some View {
        switch session.step {
        case .welcome:
            OnboardingWelcomeStep(connected: model.connected, daemonDetail: model.daemonDetail).equatable()
        case .voice:
            OnboardingVoiceStep(setup: model.setup, voice: model.voice, accent: model.accent, actions: actions).equatable()
        case .brain:
            OnboardingBrainStep(setup: model.setup, brain: model.brain, brainModel: model.brainModel, brainBaseUrl: model.brainBaseUrl, actions: actions).equatable()
        case .permissions:
            OnboardingPermissionsStep(permissions: model.permissions, sweep: model.sweep, actions: actions).equatable()
        case .wakeWord:
            OnboardingWakeStep(wake: model.wake, gate: model.wakeGate, heard: model.wakeHeard, passphraseSet: model.wakePassphraseSet, actions: actions).equatable()
        case .agents:
            OnboardingAgentsStep(agents: model.agents, connectors: model.connectors, actions: actions).equatable()
        case .done:
            OnboardingDoneStep(report: report).equatable()
        }
    }
}

// MARK: - Rail

/// Steps as icon + one word; the current one in the accent. A 5pt dot on the
/// right says whether the step is settled (ok) or wants attention. The current
/// row's ground is one view on a matched geometry id, so it glides between rows
/// (Motion.snappy); a dot changing its mind crossfades.
struct OnboardingRail: View, Equatable {
    let step: OnboardingStep
    let report: OnboardingReport
    let select: (OnboardingStep) -> Void

    @Namespace private var selection

    static func == (a: OnboardingRail, b: OnboardingRail) -> Bool { a.step == b.step && a.report == b.report }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(OnboardingStep.allCases) { s in
                OnboardingRailRow(step: s, current: s == step, mark: report.mark(s), selection: selection) { select(s) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .animation(Motion.snappy, value: step)
        .animation(Motion.fade, value: report)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Steps")
    }
}

private struct OnboardingRailRow: View {
    let step: OnboardingStep
    let current: Bool
    let mark: OnboardingReport.Mark?
    let selection: Namespace.ID
    let pick: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: pick) {
            HStack(spacing: onboardingIconGap) {
                ConsoleIcon(name: step.symbol, tint: current ? ConsoleTheme.accent : ConsoleTheme.titanium)
                Text(step.word)
                    .font(ConsoleTheme.sans(12, current ? .medium : .regular))
                    .foregroundStyle(current ? ConsoleTheme.accent : ConsoleTheme.fg2)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let mark = mark, mark != .neutral {
                    Circle()
                        .fill(OnboardingMarkStyle.color(mark))
                        .frame(width: 5, height: 5)
                        .accessibilityLabel(mark == .ok ? "ok" : "needs attention")
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 30)
            .background {
                if current {
                    RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.active)
                        .matchedGeometryEffect(id: "step", in: selection)
                } else if hovering {
                    RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.hover)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: current)
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

// MARK: - Footer

/// 56pt: Back (ghost, absent on Welcome), the step count, Continue — the one
/// accent-filled button in the window. It reads "Save & continue" while the step
/// holds edits it has not sent (they go out before the step changes), and
/// "Finish" on the last step.
struct OnboardingFooter: View, Equatable {
    let step: OnboardingStep
    let dirty: Bool
    let back: () -> Void
    let next: () -> Void

    static func == (a: OnboardingFooter, b: OnboardingFooter) -> Bool { a.step == b.step && a.dirty == b.dirty }

    private var nextTitle: String {
        if step == .done { return "Finish" }
        return dirty ? "Save & continue" : "Continue"
    }

    var body: some View {
        HStack(spacing: 10) {
            // Back fades in once there is somewhere to go back to; the count rolls its
            // digit; Continue's wording crossfades as the step picks up edits.
            Button("Back", action: back)
                .buttonStyle(ConsoleButtonStyle(kind: .ghost))
                .opacity(step.previous == nil ? 0 : 1)
                .disabled(step.previous == nil)
                .accessibilityHidden(step.previous == nil)
                .animation(Motion.fade, value: step.previous == nil)
            Spacer(minLength: 0)
            Text("\(step.index + 1) / \(OnboardingStep.allCases.count)")
                .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
                .contentTransition(ConsoleMotion.numeric)
                .animation(Motion.snappy, value: step)
                .accessibilityLabel("Step \(step.index + 1) of \(OnboardingStep.allCases.count)")
            Spacer(minLength: 0)
            Button(action: next) {
                Text(nextTitle).contentTransition(.opacity)
            }
            .buttonStyle(ConsoleButtonStyle(kind: .primary))
            .animation(Motion.fade, value: nextTitle)
        }
        .padding(.horizontal, 20)
        .frame(height: 56)
    }
}

// MARK: - Shared pieces

enum OnboardingMarkStyle {
    static func color(_ mark: OnboardingReport.Mark) -> Color {
        switch mark {
        case .ok: return ConsoleTheme.acting
        case .attention: return ConsoleTheme.speaking
        case .neutral: return ConsoleTheme.titanium
        }
    }
}

/// A step's head: one word at 15, one short paragraph at 13 under it.
/// The hero over the first and last steps: the icon's orb ramp (`Dither.orbStops`, diagonal,
/// five bands in 2 pt cells) as an 88 pt band — the dithered material as the picture, no text
/// on it — framed the way images are (`hairFrame`).
struct OnboardingHero: View {
    var body: some View {
        DitheredGradient(stops: Dither.orbStops, direction: .diagonal, bands: Dither.bands, cellPoints: 2)
            .frame(height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hairFrame, lineWidth: 1))
            .accessibilityHidden(true)
    }
}

struct OnboardingHead<Trailing: View>: View {
    let title: String
    let text: String
    let trailing: Trailing

    init(_ title: String, _ text: String, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.text = text
        self.trailing = trailing()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title).font(ConsoleTheme.sans(15, .medium)).foregroundStyle(ConsoleTheme.fg)
                Spacer(minLength: 0)
                trailing
            }
            .frame(minHeight: 20)
            if !text.isEmpty {
                Text(text)
                    .font(ConsoleTheme.sans(13)).foregroundStyle(ConsoleTheme.fg2)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

extension OnboardingHead where Trailing == EmptyView {
    init(_ title: String, _ text: String) {
        self.init(title, text) { EmptyView() }
    }
}

/// A key on the left, a control on the right. The label centres on the first
/// 28pt of the control, so a field with a note under it keeps its label on the
/// field, not on the gap.
struct OnboardingFormRow<C: View>: View {
    let label: String
    let control: C

    init(_ label: String, @ViewBuilder control: () -> C) {
        self.label = label
        self.control = control()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.titanium)
                .frame(width: onboardingKeyWidth, height: onboardingRowHeight, alignment: .leading)
            control.frame(maxWidth: .infinity, minHeight: onboardingRowHeight, alignment: .leading)
        }
    }
}

/// One status line as a single wrapping Text: `text` in sans, then " · id" in
/// mono (a model id), then " · detail" quieter. Ids are mono everywhere, like
/// the Console.
enum OnboardingLine {
    static func text(_ text: String, id: String? = nil, detail: String? = nil, color: Color = ConsoleTheme.fg) -> Text {
        var t = Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(color)
        if let id = id, !id.isEmpty {
            t = t + Text(" · ").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                + Text(id).font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg2)
        }
        if let detail = detail, !detail.isEmpty {
            t = t + Text(" · ").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                + Text(detail).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
        }
        return t
    }
}

/// A dot on the icon column and one line: "Key works · gpt-live-1". Wraps to
/// two lines rather than hiding the detail, which is where the fix usually is.
/// A probe's answer fades in: the dot's colour and the words crossfade.
struct OnboardingStatusLine: View {
    let color: Color
    var live = false
    let text: String
    var id: String? = nil
    var detail: String? = nil

    /// Everything the line says, as one value the crossfade watches.
    private var said: String { [text, id ?? "", detail ?? ""].joined(separator: "\u{1f}") }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: onboardingIconGap) {
            ConsoleDot(color: color, live: live, size: 6).frame(width: 20, height: 16, alignment: .center)
            OnboardingLine.text(text, id: id, detail: detail)
                .lineLimit(2).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 20)
        .animation(Motion.fade, value: said)
        .accessibilityElement(children: .combine)
    }
}

/// A quiet 12pt note under a control.
struct OnboardingNote: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A segmented control drawn like the Console's tabs: hairline box, the chosen
/// segment inverted. Segments size to their titles; the filled thumb is one view on
/// a matched geometry id, so it glides between them (Motion.snappy).
struct OnboardingSegments<Value: Hashable>: View {
    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.element) { index, option in
                if index > 0 { Rectangle().fill(ConsoleTheme.hair).frame(width: 1) }
                OnboardingSegment(title: title(option), on: option == value, thumb: thumb) {
                    withAnimation(Motion.snappy) { pick(option) }
                }
            }
        }
        .frame(height: 26)
        .fixedSize()
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .animation(Motion.snappy, value: value)
        .accessibilityElement(children: .contain)
    }
}

private struct OnboardingSegment: View {
    let title: String
    let on: Bool
    let thumb: Namespace.ID
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ConsoleTheme.sans(12, .medium))
                .foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg2)
                .padding(.horizontal, 10)
                .frame(height: 26)
                .background {
                    if on {
                        Rectangle().fill(ConsoleTheme.fg).matchedGeometryEffect(id: "thumb", in: thumb)
                    } else if hovering {
                        Rectangle().fill(ConsoleTheme.hover)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: on)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Clears a step's "pending" flag ~10 s after it was raised, so a failed env
/// write or a silent daemon cannot leave a live dot pulsing forever. Attach with
/// `.task(id: token)` and bump the token on every send.
enum OnboardingPending {
    static let timeout: UInt64 = 10_000_000_000

    static func expire(_ pending: Binding<Bool>) async {
        guard pending.wrappedValue else { return }
        try? await Task.sleep(nanoseconds: timeout)
        if !Task.isCancelled { pending.wrappedValue = false }
    }
}
