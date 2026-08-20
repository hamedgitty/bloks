// A room: several agents and you, in one transcript. Mirrors
// server/bloks.ts `BlokRecord`.
//
// A room's id doubles as its transcript key, exactly like an agent's
// threadId, which is why solo and group transcripts share one storage path
// on the server and one code path here.
import Foundation

struct Room: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var memberIds: [String]
    /// Unaddressed messages wake only the most senior member.
    var leadOnly: Bool?
    var createdAt: Double
    var messages: [Message]

    var lastMessage: Message? {
        messages.last(where: { $0.isRenderable })
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, memberIds, leadOnly, createdAt, messages
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? "Room"
        memberIds = (try? c.decode([String].self, forKey: .memberIds)) ?? []
        leadOnly = try? c.decode(Bool.self, forKey: .leadOnly)
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        messages = (try? c.decode([Message].self, forKey: .messages)) ?? []
    }
}

/// Either side of the conversation list. Agents and rooms sit together in
/// one list the way DMs and group chats do in Messages, so the list needs
/// one type to sort and render.
enum Conversation: Identifiable, Hashable {
    case agent(Bot)
    case room(Room)

    var id: String {
        switch self {
        case .agent(let bot): return bot.id
        case .room(let room): return room.id
        }
    }

    /// The key a `message` SSE frame is addressed to.
    var threadId: String {
        switch self {
        case .agent(let bot): return bot.threadId
        case .room(let room): return room.id
        }
    }

    var name: String {
        switch self {
        case .agent(let bot): return bot.name
        case .room(let room): return room.name
        }
    }

    /// The agent whose deliverables directory solo-chat artifacts live in.
    var botId: String? {
        switch self {
        case .agent(let bot): return bot.id
        case .room: return nil
        }
    }

    var messages: [Message] {
        switch self {
        case .agent(let bot): return bot.messages
        case .room(let room): return room.messages
        }
    }

    var lastMessage: Message? {
        switch self {
        case .agent(let bot): return bot.lastMessage
        case .room(let room): return room.lastMessage
        }
    }

    /// Sort key for the list. A conversation with nothing in it falls back
    /// to when it was made, so a brand new agent still lands at the top.
    var sortedAt: Double {
        lastMessage?.at ?? {
            switch self {
            case .agent(let bot): return bot.createdAt
            case .room(let room): return room.createdAt
            }
        }()
    }

    var isPinned: Bool {
        if case .agent(let bot) = self { return bot.pinned == true }
        return false
    }

    var isUnread: Bool {
        if case .agent(let bot) = self { return bot.unread }
        return false
    }

    var isBusy: Bool {
        if case .agent(let bot) = self { return bot.busy == true }
        return false
    }
}
