// Work an agent does on a schedule. Mirrors server/routines.ts.
//
// `summary` and `nextRunAt` are computed server side rather than here, so
// the Mac and the phone can never disagree about what "Weekdays at 09:00"
// means or when it next happens.
import Foundation

struct Routine: Codable, Identifiable, Hashable {
    let id: String
    let targetId: String
    let targetKind: String
    var prompt: String
    /// "HH:MM", 24 hour, in the Mac's local time.
    var time: String
    /// 0 = Sunday through 6 = Saturday. Empty means every day.
    var days: [Int]
    var enabled: Bool
    var lastRunAt: Double?
    /// Server-rendered, e.g. "Weekdays at 09:00".
    var summary: String?
    var nextRunAt: Double?

    var lastRun: Date? { lastRunAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    var nextRun: Date? { nextRunAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    private enum CodingKeys: String, CodingKey {
        case id, targetId, targetKind, prompt, time, days, enabled, lastRunAt, summary, nextRunAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        targetId = (try? c.decode(String.self, forKey: .targetId)) ?? ""
        targetKind = (try? c.decode(String.self, forKey: .targetKind)) ?? "agent"
        prompt = (try? c.decode(String.self, forKey: .prompt)) ?? ""
        time = (try? c.decode(String.self, forKey: .time)) ?? "09:00"
        days = (try? c.decode([Int].self, forKey: .days)) ?? []
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? true
        lastRunAt = try? c.decodeIfPresent(Double.self, forKey: .lastRunAt)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        nextRunAt = try? c.decodeIfPresent(Double.self, forKey: .nextRunAt)
    }
}

/// What the editor sends. Split from `Routine` because a new one has no id
/// and no run history yet.
struct RoutineDraft {
    var prompt: String = ""
    /// Minutes past midnight, which is what a DatePicker gives us cleanly.
    var minutes: Int = 9 * 60
    var days: Set<Int> = []
    var enabled: Bool = true

    var time: String {
        String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }

    static let dayInitials = ["S", "M", "T", "W", "T", "F", "S"]

    init() {}

    init(from routine: Routine) {
        prompt = routine.prompt
        let parts = routine.time.split(separator: ":").compactMap { Int($0) }
        minutes = parts.count == 2 ? parts[0] * 60 + parts[1] : 9 * 60
        days = Set(routine.days)
        enabled = routine.enabled
    }
}
