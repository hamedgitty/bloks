// What the home screen knows.
//
// Every time the store's picture of the roster changes, a small snapshot
// goes into the shared app group and the widgets are told to look again.
// The widget never talks to the Mac; it reads this, so it is exactly as
// fresh as the app's own list and costs nothing to render.
import Foundation
import WatchConnectivity
import WidgetKit

/// Mirrors the types in BloksWidgets.swift; the app group is the contract.
private struct AgentSnap: Codable {
    var id: String
    var name: String
    var color: String
    var shape: String
    var state: String
    var unread: Bool
    var task: String?
    var hasVoice: Bool
}

private struct BloksSnapshot: Codable {
    var agents: [AgentSnap]
    var waitingCount: Int
    var workingCount: Int
    var updatedAt: Date
}

enum WidgetSnapshot {
    private static let suite = "group.dev.bloks.app"
    private static let key = "bloks.widget.snapshot"
    private static var lastPayload: Data?

    static func publish(bots: [Bot]) {
        let agents = bots
            .filter { !($0.hidden ?? false) }
            .prefix(6)
            .map { bot -> AgentSnap in
                let lanes = bot.tasks ?? []
                let waiting = lanes.first(where: { $0.state == "needs-you" })
                let working = lanes.first(where: { $0.state == "working" })
                let state = waiting != nil ? "needs-you" : (bot.busy ?? false) ? "working" : "idle"
                return AgentSnap(
                    id: bot.id,
                    name: bot.name,
                    color: bot.color,
                    shape: bot.shape ?? AgentAppearance.shape(for: bot).rawValue,
                    state: state,
                    unread: bot.unread,
                    task: working?.title ?? waiting?.title,
                    hasVoice: bot.voice != nil
                )
            }
        // the ones that need a human float to the top of the widget
        .sorted { rank($0) < rank($1) }

        let snapshot = BloksSnapshot(
            agents: Array(agents),
            waitingCount: agents.filter { $0.state == "needs-you" }.count,
            workingCount: agents.filter { $0.state == "working" }.count,
            updatedAt: .now
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        // reload timelines only when something actually changed; the date
        // alone changing is not news the widget needs
        var comparable = snapshot
        comparable.updatedAt = .distantPast
        let compared = try? JSONEncoder().encode(comparable)
        guard compared != lastPayload else { return }
        lastPayload = compared

        UserDefaults(suiteName: suite)?.set(data, forKey: key)
        WidgetCenter.shared.reloadTimelines(ofKind: "BloksRoster")
        WatchBridge.shared.push(data)
    }

    private static func rank(_ agent: AgentSnap) -> Int {
        switch agent.state {
        case "needs-you": 0
        case "working": 1
        default: agent.unread ? 2 : 3
        }
    }
}


/// The watch's window onto the roster: the same snapshot, pushed over
/// Watch Connectivity whenever it changes. Fire and forget; a watch
/// that is out of reach simply gets the next one.
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func push(_ snapshot: Data) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        try? WCSession.default.updateApplicationContext(["snapshot": snapshot])
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
