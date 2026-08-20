// Timestamps, the way a messaging app writes them.
//
// A bare clock time on a three day old message reads as "this morning", so
// the stamp widens as the message ages. Same rule as formatWhen() in
// src/state/store.tsx, so the phone and the desktop never disagree about
// when something happened.
import Foundation

enum Stamp {
    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    private static let weekday: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEE")
        return f
    }()

    private static let date: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f
    }()

    /// For the conversation list: time today, "Yesterday", weekday inside a
    /// week, then the date.
    static func relative(_ moment: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(moment) { return time.string(from: moment) }
        if calendar.isDateInYesterday(moment) { return "Yesterday" }
        let midnight = calendar.startOfDay(for: now)
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: midnight), moment >= weekAgo {
            return weekday.string(from: moment)
        }
        return date.string(from: moment)
    }

    /// For the separators inside a transcript, which say the day as well as
    /// the time because you are reading a whole thread rather than scanning.
    static func separator(_ moment: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(moment) { return "Today \(time.string(from: moment))" }
        if calendar.isDateInYesterday(moment) { return "Yesterday \(time.string(from: moment))" }
        let midnight = calendar.startOfDay(for: now)
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: midnight), moment >= weekAgo {
            return "\(weekday.string(from: moment)) \(time.string(from: moment))"
        }
        return "\(date.string(from: moment)) \(time.string(from: moment))"
    }

    static func clock(_ moment: Date) -> String { time.string(from: moment) }
}
