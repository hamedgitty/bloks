// Bloks on the home screen: the roster at a glance.
//
// The app writes a small snapshot into the shared app group every time
// its state refreshes; the widget reads that snapshot and renders it.
// No networking here: a widget that phones home drains batteries and
// misses; one that reads a fresh local snapshot is always instant and
// exactly as current as the last time the app looked.
//
// Three families, three altitudes: the small widget is one glance
// (who needs you), the medium one is the working roster, and the lock
// screen accessories are a single number you can read mid-stride.
import SwiftUI
import WidgetKit

// ── the snapshot the app leaves behind ────────────────────────────────

struct AgentSnap: Codable, Identifiable {
    var id: String
    var name: String
    var color: String
    var shape: String = "star" 
    /// "working", "needs-you", or "idle"
    var state: String
    var unread: Bool
    /// The lane it is on, e.g. "Research competitor", when working.
    var task: String?
    var hasVoice: Bool
}

struct BloksSnapshot: Codable {
    var agents: [AgentSnap]
    var waitingCount: Int
    var workingCount: Int
    var updatedAt: Date
}

enum SnapshotStore {
    static let suite = "group.dev.bloks.app"
    static let key = "bloks.widget.snapshot"

    static func read() -> BloksSnapshot? {
        guard let defaults = UserDefaults(suiteName: suite),
              let data = defaults.data(forKey: key)
        else { return nil }
        return try? JSONDecoder().decode(BloksSnapshot.self, from: data)
    }
}

// ── timeline ──────────────────────────────────────────────────────────

struct BloksEntry: TimelineEntry {
    let date: Date
    let snapshot: BloksSnapshot?
}

struct BloksProvider: TimelineProvider {
    func placeholder(in context: Context) -> BloksEntry {
        BloksEntry(date: .now, snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (BloksEntry) -> Void) {
        completion(BloksEntry(date: .now, snapshot: SnapshotStore.read() ?? .preview))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BloksEntry>) -> Void) {
        let entry = BloksEntry(date: .now, snapshot: SnapshotStore.read())
        // the app reloads timelines on every real change; this refresh is
        // just the fallback heartbeat
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
    }
}

extension BloksSnapshot {
    static let preview = BloksSnapshot(
        agents: [
            AgentSnap(id: "1", name: "Scout", color: "blue", shape: "star", state: "working", unread: false, task: "Morning brief", hasVoice: true),
            AgentSnap(id: "2", name: "Juno", color: "pink", shape: "heart", state: "needs-you", unread: true, task: nil, hasVoice: false),
            AgentSnap(id: "3", name: "Echo", color: "teal", shape: "cloud", state: "idle", unread: false, task: nil, hasVoice: true),
        ],
        waitingCount: 1,
        workingCount: 1,
        updatedAt: .now
    )
}

// ── shared bits ───────────────────────────────────────────────────────

extension Color {
    /// The same palette the app draws its creatures with.
    static func blok(_ name: String) -> Color {
        switch name {
        case "green": Color(red: 0.23, green: 0.78, blue: 0.42)
        case "blue": Color(red: 0.30, green: 0.53, blue: 0.96)
        case "red": Color(red: 0.94, green: 0.27, blue: 0.22)
        case "orange": Color(red: 1.00, green: 0.58, blue: 0.20)
        case "purple": Color(red: 0.64, green: 0.41, blue: 0.97)
        case "cyan": Color(red: 0.25, green: 0.76, blue: 0.94)
        case "pink": Color(red: 0.98, green: 0.45, blue: 0.71)
        case "yellow": Color(red: 1.00, green: 0.85, blue: 0.23)
        case "teal": Color(red: 0.18, green: 0.79, blue: 0.66)
        case "coral": Color(red: 1.00, green: 0.48, blue: 0.39)
        default: Color(red: 0.30, green: 0.53, blue: 0.96)
        }
    }
}

struct AgentDot: View {
    let agent: AgentSnap
    var size: CGFloat = 30

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            BlokAvatar(
                color: BlokColor(rawValue: agent.color) ?? .blue,
                shape: BlokShape(rawValue: agent.shape) ?? .star,
                expression: agent.state == "working" ? .thinking : agent.state == "needs-you" ? .surprised : .friendly,
                size: size
            )
            if agent.state != "idle" {
                Circle()
                    .fill(agent.state == "needs-you" ? Color.orange : Color.green)
                    .frame(width: size * 0.32, height: size * 0.32)
                    .overlay(Circle().stroke(.background, lineWidth: 1.5))
                    .offset(x: 2, y: 2)
            }
        }
    }
}

func statusLine(_ agent: AgentSnap) -> String {
    switch agent.state {
    case "needs-you": "Waiting for you"
    case "working": agent.task ?? "Working"
    default: agent.unread ? "New reply" : "Idle"
    }
}

// ── the home screen widget ────────────────────────────────────────────

struct RosterView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BloksEntry

    var body: some View {
        if let snap = entry.snapshot, !snap.agents.isEmpty {
            switch family {
            case .systemSmall: small(snap)
            case .accessoryCircular: circular(snap)
            case .accessoryRectangular: rectangular(snap)
            default: medium(snap)
            }
        } else {
            VStack(spacing: 6) {
                Text("Bloks")
                    .font(.system(.headline, design: .rounded).weight(.bold))
                Text("Open the app once to fill this in.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    /// One glance: the agent that most needs attention.
    private func small(_ snap: BloksSnapshot) -> some View {
        let hero = snap.agents.first(where: { $0.state == "needs-you" })
            ?? snap.agents.first(where: { $0.state == "working" })
            ?? snap.agents[0]
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                AgentDot(agent: hero, size: 34)
                Spacer()
                if snap.waitingCount > 0 {
                    Text("\(snap.waitingCount)")
                        .font(.system(.subheadline, design: .rounded).weight(.bold))
                        .foregroundStyle(.white)
                        .frame(minWidth: 22, minHeight: 22)
                        .background(Color.orange, in: Circle())
                }
            }
            Spacer()
            Text(hero.name)
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .lineLimit(1)
            Text(statusLine(hero))
                .font(.caption2)
                .foregroundStyle(hero.state == "needs-you" ? Color.orange : Color.secondary)
                .lineLimit(2)
            Spacer().frame(height: 2)
            HStack(spacing: 3) {
                ForEach(snap.agents.prefix(5)) { agent in
                    Circle()
                        .fill(Color.blok(agent.color))
                        .frame(width: 6, height: 6)
                        .opacity(agent.state == "idle" && !agent.unread ? 0.35 : 1)
                }
            }
        }
        .widgetURL(URL(string: "bloks://agent/\(hero.id)"))
    }

    /// The roster: who is doing what, each row a door into that chat.
    private func medium(_ snap: BloksSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("Agents")
                    .font(.system(.caption, design: .rounded).weight(.bold))
                    .foregroundStyle(.secondary)
                Spacer()
                if snap.workingCount > 0 {
                    Label("\(snap.workingCount) working", systemImage: "bolt.fill")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.green)
                }
                if snap.waitingCount > 0 {
                    Label("\(snap.waitingCount) waiting", systemImage: "hand.raised.fill")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.orange)
                }
            }
            ForEach(snap.agents.prefix(3)) { agent in
                Link(destination: URL(string: "bloks://agent/\(agent.id)")!) {
                    HStack(spacing: 8) {
                        AgentDot(agent: agent, size: 26)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(agent.name)
                                .font(.system(.footnote, design: .rounded).weight(.semibold))
                                .lineLimit(1)
                            Text(statusLine(agent))
                                .font(.caption2)
                                .foregroundStyle(agent.state == "needs-you" ? Color.orange : Color.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if agent.hasVoice {
                            Image(systemName: "phone.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    /// Lock screen ring: how many agents want you.
    private func circular(_ snap: BloksSnapshot) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text("\(snap.waitingCount)")
                    .font(.system(.title2, design: .rounded).weight(.bold))
                Text("waiting")
                    .font(.system(size: 9))
            }
        }
        .widgetURL(URL(string: "bloks://open"))
    }

    private func rectangular(_ snap: BloksSnapshot) -> some View {
        let hero = snap.agents.first(where: { $0.state == "needs-you" })
            ?? snap.agents.first(where: { $0.state == "working" })
        return VStack(alignment: .leading, spacing: 1) {
            Text("Bloks")
                .font(.system(.caption2, design: .rounded).weight(.bold))
            if let hero {
                Text("\(hero.name): \(statusLine(hero))")
                    .font(.caption2)
                    .lineLimit(1)
            }
            Text("\(snap.workingCount) working · \(snap.waitingCount) waiting")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .widgetURL(URL(string: "bloks://open"))
    }
}

struct BloksRosterWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloksRoster", provider: BloksProvider()) { entry in
            RosterView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("Agents")
        .description("Who is working, who is waiting for you.")
        .supportedFamilies([
            .systemSmall, .systemMedium,
            .accessoryCircular, .accessoryRectangular,
        ])
    }
}

@main
struct BloksWidgetBundle: WidgetBundle {
    var body: some Widget {
        BloksRosterWidget()
    }
}
