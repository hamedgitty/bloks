// What your agents have been spending.
//
// The word "remaining" does not appear anywhere in this screen, and that is
// deliberate. Bloks never resells tokens, so the quota belongs to whichever
// account you signed the engine in with, and neither a Claude subscription
// nor a raw API key exposes a balance we could read. A gauge showing "60%
// left" would be an invented number attached to somebody's real bill.
//
// So: what was spent, by whom, on what. Cost only where the provider
// actually reported one, and said out loud when it did not.
import SwiftUI

struct UsageView: View {
    @Environment(BloksStore.self) private var store

    @State private var summary: UsageSummary?
    @State private var days = 30
    @State private var loading = true

    var body: some View {
        List {
            Section {
                Picker("Range", selection: $days) {
                    Text("7 days").tag(7)
                    Text("30 days").tag(30)
                    Text("90 days").tag(90)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            }

            if let summary {
                Section {
                    totals(summary)
                    if !summary.daily.isEmpty {
                        Sparkline(days: summary.daily)
                            .frame(height: 54)
                            .padding(.vertical, 6)
                    }
                } header: {
                    Text("Last \(days) days")
                } footer: {
                    Text(summary.costKnown
                         ? "Cost is only counted for engines that report one. Claude Code does; the others report tokens only, so the real figure is higher than this."
                         : "None of the engines you used report a price, so only tokens are shown. Your spend lives with whoever you signed the engine in with.")
                }

                if !summary.byAgent.isEmpty {
                    Section("By agent") {
                        ForEach(summary.byAgent.prefix(10)) { row in
                            agentRow(row, of: summary.total)
                        }
                    }
                }

                if !summary.byProvider.isEmpty {
                    Section("By engine") {
                        ForEach(summary.byProvider) { row in
                            LabeledContent(engineName(row.provider)) {
                                Text("\(compactCount(row.tokens)) tokens")
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                        }
                    }
                }
            } else if loading {
                Section { ProgressView() }
            } else {
                Section {
                    ContentUnavailableView(
                        "Nothing yet",
                        systemImage: "chart.bar",
                        description: Text("Usage appears here once your agents have run a few turns.")
                    )
                }
            }
        }
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: days) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        summary = await store.loadUsage(days: days)
        loading = false
    }

    @ViewBuilder
    private func totals(_ summary: UsageSummary) -> some View {
        HStack(spacing: 0) {
            stat("Turns", "\(summary.total.turns)")
            divider
            stat("Tokens", compactCount(summary.total.tokens))
            if summary.costKnown {
                divider
                stat("Cost", String(format: "$%.2f", summary.total.cost))
            }
        }
        .padding(.vertical, 4)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.primary.opacity(0.08))
            .frame(width: 1, height: 30)
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value) \(label)")
    }

    private func agentRow(_ row: UsageSummary.AgentRow, of total: UsageSummary.Total) -> some View {
        let bot = store.bot(id: row.botId)
        let share = total.tokens > 0 ? Double(row.tokens) / Double(total.tokens) : 0

        return HStack(spacing: 10) {
            if let bot {
                BlokAvatar(
                    color: bot.avatarColor,
                    shape: bot.avatarShape,
                    expression: .deadpan,
                    size: 28,
                    tile: .circle
                )
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(bot?.name ?? "Deleted agent")
                    .font(.subheadline)
                // A share bar rather than a percentage: the question is
                // "which of these is the expensive one", and a bar answers
                // it without being read.
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.primary.opacity(0.08))
                        Capsule()
                            .fill(Color.accentColor)
                            .frame(width: max(2, geo.size.width * share))
                    }
                }
                .frame(height: 4)
            }
            Text(compactCount(row.tokens))
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(bot?.name ?? "Deleted agent"), \(row.tokens) tokens, \(row.turns) turns")
    }

    private func engineName(_ provider: String) -> String {
        store.instance(id: provider)?.displayName ?? provider
    }
}

/// Tokens per day. Deliberately unlabelled: it is a shape, not a chart, and
/// the numbers above it are the part you read.
struct Sparkline: View {
    let days: [UsageSummary.Day]

    var body: some View {
        let peak = max(days.map(\.tokens).max() ?? 0, 1)
        GeometryReader { geo in
            let width = geo.size.width / CGFloat(max(days.count, 1))
            HStack(alignment: .bottom, spacing: max(1, width * 0.18)) {
                ForEach(days) { day in
                    Capsule()
                        .fill(day.tokens > 0 ? Color.accentColor : Color.primary.opacity(0.08))
                        .frame(height: max(3, geo.size.height * CGFloat(day.tokens) / CGFloat(peak)))
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .accessibilityElement()
        .accessibilityLabel("Tokens per day for the last \(days.count) days")
    }
}
