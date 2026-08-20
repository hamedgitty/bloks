// An agent. Mirrors server/store.ts `BotRecord`, plus the `messages` array
// that GET /api/bots folds in.
//
// Agents are named by role: "Chief of Staff", "Research Analyst". `title`
// is a tagline ("Keeps the week on track"), not the role. Getting that
// backwards makes every screen read wrong, so it is worth saying twice.
import Foundation

struct ModelSelection: Codable, Hashable {
    let instanceId: String
    let model: String
}

struct Bot: Codable, Identifiable, Hashable {
    let id: String
    /// The transcript key. Solo messages arrive on this, not on `id`, and
    /// mixing the two up is the single easiest way to lose a message.
    var threadId: String
    var name: String
    var title: String
    var description: String
    var color: String
    var shape: String?
    /// 1 to 5, defaulting to 1. The most senior member of a room speaks
    /// last and carries the final call.
    var seniority: Int?
    /// Reasoning effort, for engines with the dial.
    var effort: String?
    /// Upload time of the user's own photo; absent means the pixel face.
    var avatarAt: Double?
    var mascotExpression: String?
    var unread: Bool
    var busy: Bool?
    var pinned: Bool?
    var hidden: Bool?
    /// Retired. The harness sets `hidden` alongside this, which is what
    /// every list here filters on, so an older build behaves exactly as
    /// it always did and a newer one can say why the agent is quiet.
    var archivedAt: Double?
    var modelSelection: ModelSelection?
    var createdAt: Double
    /// Full transcript. Present on GET /api/bots, absent on most `bot` SSE
    /// frames, which is why the store merges rather than replaces.
    var messages: [Message]
    /// Parallel work lanes; the active one owns `messages`.
    var tasks: [TaskSummary]?
    var activeTaskId: String?
    /// How this agent sounds; nil means calls are off for it.
    var voice: BotVoice?

    var lastMessage: Message? {
        messages.last(where: { $0.isRenderable })
    }

    /// What the conversation list shows under the name.
    var preview: String {
        guard let last = lastMessage else { return "" }
        switch last.kind {
        case .text, .notice:
            return (last.text ?? "").replacingOccurrences(of: "\n", with: " ").trimmed
        case .options:
            guard let card = last.card else { return "" }
            return card.isLiveAsk ? "Needs your approval" : card.title
        case .activity:
            return last.tool?.name ?? ""
        case .screen:
            return "Screenshot"
        case .artifact:
            return last.artifact.map { "Saved \($0.name)" } ?? "Saved a file"
        case .connector:
            return last.connector.map { "Connect \($0.label)" } ?? "Connect an app"
        case .secret:
            return last.secret.map { "Needs your \($0.label)" } ?? "Needs a key"
        case .component:
            // A preview line is prose, so a component is described rather
            // than drawn: what it is beats an empty row.
            return last.component?.previewLine ?? "An answer"
        case .unrecognised:
            return ""
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, threadId, name, title, description, color, shape, seniority, effort, avatarAt
        case mascotExpression, unread, busy, pinned, hidden, archivedAt, modelSelection
        case createdAt, messages, tasks, activeTaskId, voice
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        threadId = (try? c.decode(String.self, forKey: .threadId)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "Agent"
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        description = (try? c.decode(String.self, forKey: .description)) ?? ""
        color = (try? c.decode(String.self, forKey: .color)) ?? "blue"
        shape = try? c.decodeIfPresent(String.self, forKey: .shape)
        seniority = try? c.decodeIfPresent(Int.self, forKey: .seniority)
        effort = try? c.decode(String.self, forKey: .effort)
        avatarAt = try? c.decode(Double.self, forKey: .avatarAt)
        mascotExpression = try? c.decodeIfPresent(String.self, forKey: .mascotExpression)
        unread = (try? c.decode(Bool.self, forKey: .unread)) ?? false
        busy = try? c.decodeIfPresent(Bool.self, forKey: .busy)
        pinned = try? c.decodeIfPresent(Bool.self, forKey: .pinned)
        hidden = try? c.decodeIfPresent(Bool.self, forKey: .hidden)
        archivedAt = try? c.decodeIfPresent(Double.self, forKey: .archivedAt)
        modelSelection = try? c.decodeIfPresent(ModelSelection.self, forKey: .modelSelection)
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        messages = (try? c.decode([Message].self, forKey: .messages)) ?? []
        tasks = try? c.decodeIfPresent([TaskSummary].self, forKey: .tasks)
        activeTaskId = try? c.decodeIfPresent(String.self, forKey: .activeTaskId)
        voice = try? c.decodeIfPresent(BotVoice.self, forKey: .voice)
    }
}

/// A `bot` SSE frame. The harness sends the whole record, but not always
/// with the transcript, so this decodes the fields the list cares about and
/// leaves merging to the store.
/// One lane of an agent's parallel work, as the switcher renders it.
struct TaskSummary: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    /// "working" | "needs-you" | "idle"; unknown values read as idle.
    let state: String
}

/// A voice an agent speaks with, synthesized by the harness.
struct BotVoice: Codable, Hashable {
    let provider: String
    let id: String
    let name: String?
}

struct BotPatch: Codable {
    let id: String
    let threadId: String?
    let name: String?
    let title: String?
    let color: String?
    let shape: String?
    let seniority: Int?
    let effort: String?
    let avatarAt: Double?
    let unread: Bool?
    let busy: Bool?
    let pinned: Bool?
    let hidden: Bool?
    /// Carried alongside hidden, because the two move together on the
    /// harness and a patch that brought one without the other would tell
    /// this device an agent is out of the list and still working, or in
    /// it and unable to answer.
    let archivedAt: Double?
    let messages: [Message]?
    let tasks: [TaskSummary]?
    let activeTaskId: String?
    let voice: BotVoice?
}
