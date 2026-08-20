// What every agent is doing right now, on a phone.
//
// This screen is the reason the phone can offer to put a workflow gate
// aside again. A gate has two places it can be answered, the card in the
// chat and a row in a list, and the phone only ever had the card: hiding
// it there left the run parked with nowhere to answer it from.
//
// Mirrors src/components/Activity.tsx, including the order of the
// sections, which is the design rather than an accident. What wants you
// comes before what is merely happening, and the tally comes last.
//
// The snapshot is owned here rather than on the store, because it has
// elapsed times baked into it and a copy kept alive elsewhere would
// render as a frozen list on a screen nobody is looking at.
import SwiftUI

struct ActivityView: View {
    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var activity: Activity?
    @State private var now = Date()
    @State private var busy: String?

    var body: some View {
        NavigationStack {
            List {
                today
                if let activity {
                    waitingSection(activity)
                    pausedSection(activity)
                    runningSection(activity)
                    agentsSection(activity)
                    if activity.isQuiet { quiet }
                }
            }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable { await load() }
        }
        .task {
            // Slower than the window's three seconds. The Mac polls a
            // loopback socket; a phone may be paying for a sealed relay
            // round trip each time, and stopping when the sheet closes is
            // not a nicety.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
    }

    private func load() async {
        guard scenePhase == .active else { return }
        if let fresh = await store.activity() { activity = fresh }
    }

    // MARK: today

    @ViewBuilder private var today: some View {
        if let activity {
            Section {
                HStack(spacing: 18) {
                    figure("\(activity.today.turns)", activity.today.turns == 1 ? "turn" : "turns")
                    figure(compactCount(activity.today.tokens), "tokens")
                    if activity.costKnown {
                        figure(money(activity.today.cost), "spent")
                    }
                }
                .padding(.vertical, 2)
            } header: {
                Text("Today")
            } footer: {
                Text(
                    activity.costKnown
                        ? "Only some engines report a price, so this is what is known rather than everything."
                        : "No engine in range reports a price, so there is no cost to show."
                )
            }
        }
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.system(size: 17, weight: .semibold)).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: the four sections

    @ViewBuilder private func waitingSection(_ activity: Activity) -> some View {
        if !activity.waiting.isEmpty {
            Section("Waiting for you") {
                ForEach(activity.waiting) { row in
                    ActivityRow(
                        botId: row.botId,
                        title: row.asks,
                        detail: waitingDetail(row),
                        urgent: true
                    ) {
                        if let runId = row.runId {
                            // A gate has exactly two answers, and both of
                            // them decide what the run does next.
                            Button("Approve") {
                                answer(runId: runId, approve: true, key: row.id)
                            }
                            .disabled(busy == row.id)
                            Button("Decline") {
                                answer(runId: runId, approve: false, key: row.id)
                            }
                            .disabled(busy == row.id)
                        } else {
                            // An approval cannot be settled from here:
                            // this payload carries no requestId, and
                            // guessing one would answer the wrong
                            // question. Opening the lane is the honest
                            // move.
                            Button("Answer it") {
                                Task {
                                    await store.reveal(conversationId: row.botId, lane: row.threadId)
                                    dismiss()
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func pausedSection(_ activity: Activity) -> some View {
        if !activity.paused.isEmpty {
            Section("You have the wheel") {
                ForEach(activity.paused) { row in
                    ActivityRow(
                        botId: row.botId,
                        title: "\(row.botName) is waiting for you",
                        detail: pausedDetail(row),
                        urgent: true
                    ) {
                        Button("Hand it back") {
                            busy = row.id
                            Task {
                                await store.handBackWheel(botId: row.botId)
                                await load()
                                busy = nil
                            }
                        }
                        .disabled(busy == row.id)
                    }
                }
            }
        }
    }

    @ViewBuilder private func runningSection(_ activity: Activity) -> some View {
        if !activity.running.isEmpty {
            Section("Running") {
                ForEach(activity.running) { row in
                    ActivityRow(
                        botId: row.botId,
                        title: "\(row.botName) \(row.because)",
                        detail: runningDetail(row),
                        urgent: false
                    ) {
                        Button("Open") {
                            Task {
                                await store.reveal(conversationId: row.botId, lane: row.threadId)
                                dismiss()
                            }
                        }
                        Button {
                            busy = row.id
                            Task {
                                await store.stopTurn(botId: row.botId, taskId: row.threadId)
                                await load()
                                busy = nil
                            }
                        } label: {
                            Image(systemName: "stop.fill")
                        }
                        .disabled(busy == row.id)
                        .accessibilityLabel("Stop this turn")
                    }
                }
            }
        }
    }

    @ViewBuilder private func agentsSection(_ activity: Activity) -> some View {
        if !activity.agents.isEmpty {
            Section("Today, by agent") {
                ForEach(activity.agents) { row in
                    ActivityRow(
                        botId: row.botId,
                        title: row.botName,
                        detail: "\(row.today.turns) \(row.today.turns == 1 ? "turn" : "turns") · \(compactCount(row.today.tokens)) tokens",
                        urgent: false
                    ) {
                        if row.waiting > 0 {
                            Label("\(row.waiting)", systemImage: "hourglass")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        } else if row.running > 0 {
                            Text("\(row.running) running").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private var quiet: some View {
        Section {
            ContentUnavailableView {
                Label("Nothing is running", systemImage: "checkmark.circle")
            } description: {
                Text("Routines, jobs and workflows show up here while they work, and anything that stops to ask you appears at the top.")
            }
        }
    }

    // MARK: words

    private func waitingDetail(_ row: WaitingWork) -> String {
        var parts = ["\(row.botName)"]
        if !row.laneTitle.isEmpty { parts.append(row.laneTitle) }
        parts.append("asked \(elapsed(since: row.since, now: now)) ago")
        if let deadline = row.until { parts.append("stops \(until(deadline, now: now))") }
        return parts.joined(separator: " · ")
    }

    private func pausedDetail(_ row: PausedAgent) -> String {
        let taken = "You took over \(elapsed(since: row.since, now: now)) ago"
        guard row.turnedAway > 0 else { return "\(taken). It will not start anything until you hand it back." }
        let things = row.turnedAway == 1 ? "1 thing has" : "\(row.turnedAway) things have"
        return "\(taken). \(things) been turned away since."
    }

    private func runningDetail(_ row: RunningWork) -> String {
        var parts: [String] = []
        if !row.laneTitle.isEmpty { parts.append(row.laneTitle) }
        if let since = row.since { parts.append("\(elapsed(since: since, now: now)) so far") }
        return parts.joined(separator: " · ")
    }

    private func answer(runId: String, approve: Bool, key: String) {
        busy = key
        Task {
            await store.answerGate(runId: runId, approve: approve)
            await load()
            busy = nil
        }
    }
}

/// One row: who, what, and what you can do about it.
///
/// The avatar is looked up rather than assumed, because a row can carry a
/// room id in `botId` and there is no agent behind that one.
private struct ActivityRow<Actions: View>: View {
    let botId: String
    let title: String
    let detail: String
    let urgent: Bool
    @ViewBuilder var actions: Actions

    @Environment(BloksStore.self) private var store

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if let bot = store.bots.first(where: { $0.id == botId }) {
                AgentAvatar(bot: bot, size: 26, tile: .circle)
            } else {
                Image(systemName: "person.2")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(width: 26, height: 26)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14)).fixedSize(horizontal: false, vertical: true)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(urgent ? Color.orange : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Below the words rather than beside them: two buttons and
                // a sentence do not fit across a phone.
                HStack(spacing: 8) {
                    actions
                }
                .font(.system(size: 13, weight: .medium))
                // A List row with more than one button collapses them into
                // one tap target unless each is borderless.
                .buttonStyle(.borderless)
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }
}
