// A URL that wakes an agent. Mirrors server/webhooks.ts.
import Foundation

struct Webhook: Codable, Identifiable, Hashable {
    let id: String
    let token: String
    var name: String
    var enabled: Bool
    var lastFiredAt: Double?
    var firedCount: Int?
}
