// The first ninety seconds, phone edition.
//
// The film the desktop plays on first launch: the mark assembles
// itself block by block, rattles, and bursts; a living mascot holds the
// workspace loader; two short vignettes show what agents are. Connecting
// tools needs the harness on the Mac, so the desktop's plugin-connect
// stage has no phone counterpart; the jobs vignette hands straight off
// to the app's normal first-run flow.
//
// Runs once, gated by @AppStorage. A Skip control appears after two
// seconds, and Reduce Motion collapses the whole sequence to plain
// crossfades starting at the Welcome card, because a cinematic that
// ignores that setting is a defect, not a flourish.
//
// The vignettes are scripted theater, not live agents: nothing is
// paired yet on a first run, so a real demo is impossible by
// construction.
import SwiftUI

/// One block of the brand mark, geometry verbatim from bloks-mark.svg
/// (viewBox 1272 x 1483.5) as fractions of that box. `from` is the side
/// it arrives from; `dir` the vector it departs along at the burst.
private struct MarkBlock {
    let x: CGFloat
    let y: CGFloat
    let w: CGFloat
    let h: CGFloat
    let color: Color
    let from: CGVector
    let dir: CGVector
}

private let MARK_ASPECT: CGFloat = 1272 / 1483.5

private let MARK_BLOCKS: [MarkBlock] = [
    .init(x: 0, y: 0, w: 0.2201, h: 0.7739, color: Color(hex: 0x004AAD),
          from: .init(dx: -1, dy: 0), dir: .init(dx: -1.2, dy: -0.1)), // left bar
    .init(x: 0.2626, y: 0, w: 0.7374, h: 0.1887, color: Color(hex: 0xFF751F),
          from: .init(dx: 0, dy: -1), dir: .init(dx: 0.3, dy: -1.2)), // top bar
    .init(x: 0.7799, y: 0.2258, w: 0.2201, h: 0.7732, color: Color(hex: 0xCB6CE6),
          from: .init(dx: 1, dy: 0), dir: .init(dx: 1.2, dy: 0.2)), // right bar
    .init(x: 0, y: 0.8109, w: 0.7374, h: 0.1887, color: Color(hex: 0xFF3131),
          from: .init(dx: 0, dy: 1), dir: .init(dx: -0.3, dy: 1.2)), // bottom bar
    .init(x: 0.2516, y: 0.2568, w: 0.1077, h: 0.3761, color: Color(hex: 0x5CE1E6),
          from: .init(dx: -0.6, dy: -0.4), dir: .init(dx: -0.7, dy: -0.5)), // inner left
    .init(x: 0.3789, y: 0.2568, w: 0.3577, h: 0.0924, color: Color(hex: 0xFF5757),
          from: .init(dx: 0.4, dy: -0.6), dir: .init(dx: 0.6, dy: -0.8)), // inner top
    .init(x: 0.6297, y: 0.3667, w: 0.1077, h: 0.3761, color: Color(hex: 0x7ED957),
          from: .init(dx: 0.6, dy: 0.4), dir: .init(dx: 0.8, dy: 0.6)), // inner right
    .init(x: 0.2516, y: 0.6505, w: 0.3577, h: 0.0924, color: Color(hex: 0xFFBD59),
          from: .init(dx: -0.4, dy: 0.6), dir: .init(dx: -0.6, dy: 0.9)), // inner bottom
]

/// The idle life of the loader mascot: where it looks, in order.
private let IDLE_EXPRESSIONS: [BlokExpression] = [
    .deadpan, .thinking, .friendly, .surprised, .focused, .excited,
]

/// The five-role reveal in the jobs vignette.
private struct CastMember {
    let name: String
    let color: BlokColor
    let shape: BlokShape
}

private let CAST: [CastMember] = [
    .init(name: "Chief of Staff", color: .blue, shape: .star),
    .init(name: "Research Analyst", color: .cyan, shape: .bit),
    .init(name: "Growth Marketer", color: .pink, shape: .burst),
    .init(name: "Inbox Manager", color: .green, shape: .diamond),
    .init(name: "Support Agent", color: .orange, shape: .cloud),
]

struct IntroView: View {
    enum Stage {
        case logo, workspace, welcome, computers, jobs
    }

    let onDone: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var stage: Stage = .logo
    @State private var skippable = false

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            switch stage {
            case .logo:
                LogoStage()
            case .workspace:
                WorkspaceStage()
            case .welcome:
                welcome
            case .computers:
                ComputersStage { advance(.jobs) }
            case .jobs:
                JobsStage { finish() }
            }

            if skippable {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button("Skip intro") { finish() }
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .padding(.trailing, 24)
                            .padding(.bottom, 8)
                    }
                }
            }
        }
        .task {
            if reduceMotion { stage = .welcome }
            try? await Task.sleep(for: .seconds(2))
            skippable = true
        }
        .task(id: stage) {
            // the two automatic stages advance themselves; everything after
            // has a button, because reading speed is not ours to schedule
            switch stage {
            case .logo:
                try? await Task.sleep(for: .seconds(5.6))
                advance(.workspace)
            case .workspace:
                try? await Task.sleep(for: .seconds(2.8))
                advance(.welcome)
            default:
                break
            }
        }
    }

    private func advance(_ next: Stage) {
        withAnimation(.easeOut(duration: 0.4)) { stage = next }
    }

    private func finish() {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "bloksIntroDone")
        onDone()
    }

    // ── stage 3: welcome ───────────────────────────────────────────────
    private var welcome: some View {
        VStack(spacing: 0) {
            Image("BloksWordmark")
                .resizable()
                .scaledToFit()
                .frame(height: 40)
            Text("Welcome to Bloks")
                .font(.title.weight(.semibold))
                .padding(.top, 24)
            Text("Personal AI agents that live on your machine, not in someone else's cloud.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 44)
            PrimaryButton(title: "Next") { advance(.computers) }
                .padding(.top, 32)
        }
        .transition(.opacity)
    }

}

/// The app's one filled call-to-action, shared by every stage.
private struct PrimaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color(.systemBackground))
                .padding(.horizontal, 24)
                .padding(.vertical, 11)
                .background(Capsule().fill(Color.primary))
        }
        .buttonStyle(.plain)
    }
}

// ── stage 1: the mark builds itself, then bursts ───────────────────────
/// The rattle before the blast: a long build of small jitters with the
/// amplitude ramping up, so it reads as pressure rising, not a glitch.
private let SHAKE_STEPS: [(dx: CGFloat, dy: CGFloat, rot: Double)] = [
    (-1, 1, -0.2), (1, -1, 0.2), (-1, -1, -0.3), (1, 1, 0.3),
    (-2, 1, -0.4), (2, -1, 0.4), (-2, -2, -0.5), (2, 2, 0.5),
    (-2, 2, -0.6), (3, -2, 0.6), (-3, -2, -0.7), (3, 2, 0.8),
    (-3, 2, -0.9), (4, -2, 0.9), (-4, -3, -1.0), (4, 3, 1.1),
    (-5, 3, -1.2), (5, -3, 1.3), (-5, 2, -1.2), (0, 0, 0),
]

private struct LogoStage: View {
    /// Per-block animation progress: 0 hidden, 1 settled.
    @State private var arrived: [Bool] = Array(repeating: false, count: MARK_BLOCKS.count)
    @State private var shake = 0
    @State private var burst = false

    var body: some View {
        let width: CGFloat = 190
        // far enough that every block starts beyond the screen edge
        let offscreen = CGSize(width: 520, height: 960)
        ZStack {
            ForEach(MARK_BLOCKS.indices, id: \.self) { i in
                let block = MARK_BLOCKS[i]
                let size = CGSize(width: width * block.w, height: width / MARK_ASPECT * block.h)
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(block.color)
                    .frame(width: size.width, height: size.height)
                    // position: block origin plus half its size, centered on
                    // the mark's own box; before arrival it waits fully
                    // outside the frame along its own side's direction
                    .offset(
                        x: width * (block.x + block.w / 2 - 0.5)
                            + (arrived[i] ? 0 : block.from.dx * offscreen.width)
                            + (burst ? block.dir.dx * 160 : 0),
                        y: width / MARK_ASPECT * (block.y + block.h / 2 - 0.5)
                            + (arrived[i] ? 0 : block.from.dy * offscreen.height)
                            + (burst ? block.dir.dy * 160 : 0)
                    )
                    .rotationEffect(burst ? .degrees(block.dir.dx * 40) : .zero)
                    // separation rides the same accelerating clock as the
                    // zoom below: one continuous motion, no pause
                    .animation(.easeIn(duration: 1.1), value: burst)
                    // opaque until the blocks are at the edges: the
                    // explosion should be seen leaving, not evaporate
                    .opacity(burst ? 0 : 1)
                    .animation(.easeIn(duration: 0.45).delay(0.62), value: burst)
            }
        }
        // the rattle before the blast
        .offset(
            x: shake > 0 && !burst ? SHAKE_STEPS[(shake - 1) % SHAKE_STEPS.count].dx : 0,
            y: shake > 0 && !burst ? SHAKE_STEPS[(shake - 1) % SHAKE_STEPS.count].dy : 0
        )
        .rotationEffect(.degrees(shake > 0 && !burst ? SHAKE_STEPS[(shake - 1) % SHAKE_STEPS.count].rot : 0))
        // one motion: ease-in from rest reads as a swell that keeps going
        // until the mark blows out far past the frame
        .scaleEffect(burst ? 9 : 1)
        .animation(.easeIn(duration: 1.1), value: burst)
        .task {
            // outer bars first, one by one; the inner ring follows as a
            // second, gentler wave
            for i in MARK_BLOCKS.indices {
                let delay = i < 4 ? Double(i) * 0.32 : 1.28 + Double(i - 4) * 0.15
                let duration = i < 4 ? 0.65 : 0.85
                Task {
                    try? await Task.sleep(for: .seconds(delay))
                    withAnimation(.spring(duration: duration, bounce: 0.18)) { arrived[i] = true }
                }
            }
            try? await Task.sleep(for: .seconds(2.62))
            for _ in SHAKE_STEPS.indices {
                try? await Task.sleep(for: .seconds(0.08))
                withAnimation(.linear(duration: 0.08)) { shake += 1 }
            }
            burst = true
        }
    }
}

// ── stage 2: the workspace loader, with a mascot that is alive ─────────
private struct WorkspaceStage: View {
    @State private var expressionIndex = 0
    @State private var hovering = false
    @State private var sweep = false

    var body: some View {
        VStack(spacing: 0) {
            BlokAvatar(
                color: .blue,
                shape: .star,
                expression: IDLE_EXPRESSIONS[expressionIndex % IDLE_EXPRESSIONS.count],
                size: 104
            )
            .offset(y: hovering ? -9 : 0)
            .rotationEffect(.degrees(hovering ? 1.5 : -1.5))
            .animation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true), value: hovering)

            Text("Setting up your Bloks workspace…")
                .font(.subheadline.weight(.medium))
                .padding(.top, 24)

            // indeterminate: honest about not knowing how long
            Capsule()
                .fill(Color(.systemFill))
                .frame(width: 176, height: 4)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Color.accentColor)
                        .frame(width: 56)
                        .offset(x: sweep ? 120 : -56)
                        .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: false), value: sweep)
                }
                .clipShape(Capsule())
                .padding(.top, 16)
        }
        .transition(.opacity)
        .onAppear {
            hovering = true
            sweep = true
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(0.65))
                expressionIndex += 1
            }
        }
    }
}

// ── stage 4: agents have their own computers ───────────────────────────
//
// A miniature desktop with the agent's own cursor working it: the cursor
// glides to the dock, opens a browser onto a dashboard, opens a
// spreadsheet, fills the week's numbers in, and a toast confirms the
// report. One step counter drives every actor.
private let SHEET_ROWS: [[String]] = [
    ["Day", "Sessions", "Revenue"],
    ["Mon", "1,204", "$8.2k"],
    ["Tue", "1,377", "$9.1k"],
    ["Wed", "1,890", "$11.4k"],
    ["Thu", "2,041", "$12.9k"],
]

private struct ComputersStage: View {
    let onNext: () -> Void

    // 0 idle · 1 cursor to dock · 2 browser opens, charts rise · 3 cursor
    // to sheets · 4 sheet opens, cells fill · 5 toast
    @State private var step = 0

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Circle().fill(Color(hex: 0xFF5F57)).frame(width: 10, height: 10)
                    Circle().fill(Color(hex: 0xFEBC2E)).frame(width: 10, height: 10)
                    Circle().fill(Color(hex: 0x28C840)).frame(width: 10, height: 10)
                    Text("Research Analyst's computer")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 6)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                Divider()
                desktop
            }
            .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemGroupedBackground)))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .frame(maxWidth: 378)
            .shadow(color: .black.opacity(0.18), radius: 22, y: 12)

            Text("Every agent gets its own computer")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.top, 28)
                .padding(.horizontal, 32)
            Text("A real machine to browse, run tools and finish work on, while you do something better with your afternoon.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 40)

            PrimaryButton(title: "Next", action: onNext)
                .padding(.top, 28)
        }
        .transition(.opacity)
        .task {
            for beat in [0.5, 0.9, 2.1, 0.9, 2.6] {
                try? await Task.sleep(for: .seconds(beat))
                if Task.isCancelled { return }
                withAnimation(.easeOut(duration: 0.3)) { step += 1 }
            }
        }
    }

    /// Where the agent's cursor is, per step, as a fraction of the
    /// desktop area.
    private var cursorAt: CGPoint {
        if step < 1 { return CGPoint(x: 0.82, y: 0.82) }
        if step < 3 { return CGPoint(x: 0.40, y: 0.90) }
        if step < 4 { return CGPoint(x: 0.56, y: 0.90) }
        return CGPoint(x: 0.62, y: 0.55)
    }

    private var desktop: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                LinearGradient(
                    colors: [Color(.systemFill).opacity(0.35), Color(.systemFill).opacity(0.7)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                browserWindow
                    .frame(width: geo.size.width * 0.68)
                    .offset(x: geo.size.width * 0.06, y: geo.size.height * 0.08)
                    .scaleEffect(step >= 2 ? 1 : 0.9)
                    .opacity(step >= 2 ? 1 : 0)

                sheetWindow
                    .frame(width: geo.size.width * 0.56)
                    .offset(x: geo.size.width * 0.37, y: geo.size.height * 0.16)
                    .scaleEffect(step >= 4 ? 1 : 0.9)
                    .opacity(step >= 4 ? 1 : 0)

                // toast
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                    Text("Report updated, 4 charts refreshed")
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.green)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(.systemBackground)))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
                .offset(x: geo.size.width * 0.30, y: step >= 5 ? 8 : -6)
                .opacity(step >= 5 ? 1 : 0)

                dock
                    .frame(maxWidth: .infinity)
                    .offset(y: geo.size.height - 34)

                cursor
                    .offset(
                        x: geo.size.width * cursorAt.x,
                        y: geo.size.height * cursorAt.y
                    )
                    .animation(.easeInOut(duration: 0.7), value: step)
            }
        }
        .frame(height: 305)
    }

    private var browserWindow: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Circle().fill(Color(.systemFill)).frame(width: 5, height: 5)
                Circle().fill(Color(.systemFill)).frame(width: 5, height: 5)
                Text("dashboard.bloks.dev")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color(.systemBackground)))
            }
            .padding(6)
            .background(Color(.systemFill).opacity(0.5))
            Divider()
            Text("Revenue dashboard")
                .font(.system(size: 10.5, weight: .semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            HStack(alignment: .bottom, spacing: 7) {
                ForEach(Array([0.34, 0.48, 0.42, 0.6, 0.74, 0.9].enumerated()), id: \.offset) { i, height in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.accentColor.opacity(0.8))
                        .frame(height: (step >= 2 ? height : 0.04) * 92)
                        .frame(maxWidth: .infinity)
                        .animation(.easeOut(duration: 0.7).delay(0.2 + Double(i) * 0.12), value: step >= 2)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(height: 108, alignment: .bottom)
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(.systemBackground)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 4)
    }

    private var sheetWindow: some View {
        VStack(spacing: 0) {
            Text("Weekly numbers · Q3")
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(Color(.systemFill).opacity(0.5))
            ForEach(SHEET_ROWS.indices, id: \.self) { r in
                Divider()
                HStack(spacing: 0) {
                    ForEach(SHEET_ROWS[r].indices, id: \.self) { c in
                        let order = r * SHEET_ROWS[r].count + c
                        Text(SHEET_ROWS[r][c])
                            .font(.system(size: 10).monospacedDigit())
                            .foregroundStyle(c == 0 ? Color.secondary : Color.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3.5)
                            .opacity(step >= 4 ? 1 : 0)
                            .animation(.easeOut(duration: 0.15).delay(0.3 + Double(order) * 0.11), value: step >= 4)
                        if c < SHEET_ROWS[r].count - 1 { Divider() }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(.systemBackground)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.16), radius: 10, y: 5)
    }

    private var dock: some View {
        HStack(spacing: 10) {
            VStack(spacing: 2) {
                Circle()
                    .strokeBorder(Color.accentColor, lineWidth: 2.5)
                    .frame(width: 16, height: 16)
                    .frame(width: 24, height: 24)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(.systemBackground)))
                    .scaleEffect(step >= 2 ? 1.12 : 1)
                Circle().fill(step >= 2 ? Color.secondary : Color.clear).frame(width: 3, height: 3)
            }
            VStack(spacing: 2) {
                Grid(horizontalSpacing: 1.5, verticalSpacing: 1.5) {
                    GridRow {
                        RoundedRectangle(cornerRadius: 1).fill(Color.green.opacity(0.8)).frame(width: 6, height: 6)
                        RoundedRectangle(cornerRadius: 1).fill(Color.green.opacity(0.8)).frame(width: 6, height: 6)
                    }
                    GridRow {
                        RoundedRectangle(cornerRadius: 1).fill(Color.green.opacity(0.8)).frame(width: 6, height: 6)
                        RoundedRectangle(cornerRadius: 1).fill(Color.green.opacity(0.8)).frame(width: 6, height: 6)
                    }
                }
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(.systemBackground)))
                .scaleEffect(step >= 4 ? 1.12 : 1)
                Circle().fill(step >= 4 ? Color.secondary : Color.clear).frame(width: 3, height: 3)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(.systemBackground).opacity(0.8)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
        .fixedSize()
    }

    /// The agent's cursor with its name tag riding along, like a
    /// multiplayer cursor: somebody working, not a screensaver.
    private var cursor: some View {
        HStack(alignment: .top, spacing: 3) {
            Image(systemName: "cursorarrow")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.accentColor)
                .shadow(color: .black.opacity(0.25), radius: 1, y: 1)
            Text("Research Analyst")
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(Color.brandForeground)
                .padding(.horizontal, 5)
                .padding(.vertical, 2.5)
                .background(Capsule().fill(Color.accentColor))
                .offset(y: 8)
        }
        .fixedSize()
    }
}

// ── stage 5: one agent becomes a team ──────────────────────────────────
private struct JobsStage: View {
    let onNext: () -> Void

    @State private var spread = false
    @State private var sweepAngle: Double = 0
    @State private var sweepVisible = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                // the sweep: one slow ring of light while the cast takes its
                // places, then it stays as a faint halo
                Circle()
                    .stroke(
                        AngularGradient(
                            gradient: Gradient(colors: [
                                .clear,
                                Color.accentColor.opacity(0.55),
                                .clear, .clear, .clear,
                            ]),
                            center: .center
                        ),
                        lineWidth: 26
                    )
                    .frame(width: 216, height: 216)
                    .blur(radius: 14)
                    .rotationEffect(.degrees(sweepAngle))
                    .opacity(sweepVisible ? 1 : 0)

                ForEach(CAST.indices, id: \.self) { i in
                    let member = CAST[i]
                    let angle = (-90 + Double(i) * 360 / Double(CAST.count)) * .pi / 180
                    let radius: CGFloat = 104
                    VStack(spacing: 6) {
                        BlokAvatar(color: member.color, shape: member.shape, expression: .friendly, size: 52)
                        Text(member.name)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .fixedSize()
                            .opacity(spread ? 1 : 0)
                    }
                    .offset(
                        x: spread ? radius * cos(angle) : 0,
                        y: spread ? radius * sin(angle) : 0
                    )
                    .animation(
                        .spring(duration: 0.65, bounce: 0.3).delay(Double(i) * 0.07),
                        value: spread
                    )
                }
            }
            .frame(width: 290, height: 290)

            Text("Give every agent a job")
                .font(.title2.weight(.semibold))
                .padding(.top, 6)
            Text("Each one carries its own role, skills and memory. Put them in a room together and the most senior one runs the meeting.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 40)

            PrimaryButton(title: "Get started", action: onNext)
                .padding(.top, 24)
        }
        .transition(.opacity)
        .task {
            try? await Task.sleep(for: .seconds(0.55))
            spread = true
            sweepVisible = true
            withAnimation(.easeInOut(duration: 2.4)) { sweepAngle = 360 }
            try? await Task.sleep(for: .seconds(2.4))
            withAnimation(.easeOut(duration: 0.5)) { sweepVisible = false }
        }
    }
}
