// Engines and usage. Mirrors GET /api/instances and GET /api/usage.
import Foundation

/// One provider instance: an engine and the models it serves.
struct ProviderInstance: Codable, Identifiable, Hashable {
    struct Snapshot: Codable, Hashable {
        let state: String
        let reason: String?
        let authenticated: Bool?
    }

    struct ModelOption: Codable, Identifiable, Hashable {
        let id: String
        let label: String
    }

    struct ModelCatalog: Codable, Hashable {
        let `default`: String
        let options: [ModelOption]
    }

    let instanceId: String
    let driverKind: String
    let displayName: String
    let snapshot: Snapshot
    let models: ModelCatalog

    var id: String { instanceId }
    var isAvailable: Bool { snapshot.state == "available" }

    /// Whether this engine can run tools and touch files, or only talk.
    /// An agent moved onto a chat engine quietly loses half its job, so the
    /// picker badges the difference the way the desktop does.
    var runsTools: Bool {
        ["claudeAgent", "codex", "geminiCli", "boxAgent"].contains(driverKind)
    }
}

/// What has been spent. Never what is left: see server/usage.ts for why
/// that number does not exist.
struct UsageSummary: Codable, Hashable {
    struct Day: Codable, Identifiable, Hashable {
        let date: String
        let turns: Int
        let input: Int
        let output: Int
        let cost: Double
        var id: String { date }
        var tokens: Int { input + output }
    }

    struct AgentRow: Codable, Identifiable, Hashable {
        let botId: String
        let turns: Int
        let input: Int
        let output: Int
        let cost: Double
        var id: String { botId }
        var tokens: Int { input + output }
    }

    struct ProviderRow: Codable, Identifiable, Hashable {
        let provider: String
        let turns: Int
        let input: Int
        let output: Int
        let cost: Double
        var id: String { provider }
        var tokens: Int { input + output }
    }

    struct Total: Codable, Hashable {
        let turns: Int
        let input: Int
        let output: Int
        let cost: Double
        var tokens: Int { input + output }
    }

    let daily: [Day]
    let byAgent: [AgentRow]
    let byProvider: [ProviderRow]
    let total: Total
    /// False when nothing in range reported a price, so a cost of zero is
    /// hidden rather than shown as though everything was free.
    let costKnown: Bool
    let days: Int

    static let empty = UsageSummary(
        daily: [], byAgent: [], byProvider: [],
        total: Total(turns: 0, input: 0, output: 0, cost: 0),
        costKnown: false, days: 30
    )
}

/// Big numbers, read at a glance. 18400 is noise; "18.4k" is a number.
func compactCount(_ value: Int) -> String {
    switch value {
    case ..<1_000: return "\(value)"
    case ..<1_000_000: return String(format: "%.1fk", Double(value) / 1_000)
    default: return String(format: "%.1fM", Double(value) / 1_000_000)
    }
}
