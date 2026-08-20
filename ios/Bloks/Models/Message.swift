// Codable mirrors of the harness types.
//
// These are hand-written rather than generated, because the server is the
// source of truth and a field that moves should fail here, next to the
// name that moved, rather than three screens away.
//
// Mirrors server/store.ts `Message`.
//
// One rule runs through this file: a newer harness must never blank an
// older client's screen. Every enum decodes an unrecognised value to a
// case the UI can still render, and every field the server might omit is
// decoded with a default rather than being required.
import Foundation

/// Exactly the kinds server/store.ts emits, plus a landing spot for
/// one that does not exist yet.
/// An app the agent asked the user to connect, right in the chat.
/// A value the agent asked for; saved on the Mac, never in the chat.
struct SecretMeta: Codable, Hashable {
    let envName: String
    let label: String
    var hint: String?
    var status: String
}

struct ConnectorMeta: Codable, Hashable {
    let slug: String
    let label: String
    var status: String
    var authUrl: String?
    var resumed: Bool?
    var error: String?
}

enum MessageKind: String, Codable, Hashable {
    case text
    case options
    case activity
    case screen
    case notice
    case artifact
    case connector
    case secret
    /// An answer that is not a paragraph. Mirrors server/components.ts.
    case component
    /// Not a server value. Anything unrecognised becomes this and renders
    /// as nothing, which beats failing the whole transcript.
    case unrecognised

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageKind(rawValue: raw) ?? .unrecognised
    }
}

enum MessageRole: String, Codable, Hashable {
    case bot
    case user

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // An unknown role is far more likely to be an agent than the person
        // holding the phone, and rendering it on the left is the safe miss.
        self = MessageRole(rawValue: raw) ?? .bot
    }
}

/// An `activity` message: a tool name, and whether it finished cleanly.
/// `ok` stays nil while the tool is still running.
struct ToolRun: Codable, Hashable {
    let name: String
    let ok: Bool?

    private enum CodingKeys: String, CodingKey { case name, ok }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? "tool"
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
    }

    init(name: String, ok: Bool?) {
        self.name = name
        self.ok = ok
    }
}

struct Message: Codable, Identifiable, Hashable {
    let id: String
    let role: MessageRole
    /// Which agent spoke, in a room with more than one. Absent in solo
    /// chats, where the agent is unambiguous.
    let from: String?
    let kind: MessageKind
    let text: String?
    var card: OptionCard?
    let tool: ToolRun?
    /// `screen` messages: a base64 frame of the agent's computer.
    let png: String?
    let mime: String?
    /// Set when this message answers an earlier one.
    let replyTo: ReplyRef?
    /// Artifact messages: a file the agent saved to its deliverables dir.
    let artifact: ArtifactMeta?
    var connector: ConnectorMeta?
    var secret: SecretMeta?
    /// `component` messages: an answer that is not a paragraph.
    let component: AnswerComponent?
    /// Taken back. The row stays so replies pointing at it still make
    /// sense and the transcript keeps its shape, but nothing it carried
    /// is drawn again.
    let deleted: Bool
    /// Milliseconds since the epoch, which is what Date.now() gives the
    /// harness. Divide before handing it to Foundation.
    let at: Double

    var timestamp: Date { Date(timeIntervalSince1970: at / 1000) }

    /// Whether this message carries anything worth drawing. An empty text
    /// bubble is a layout bug, not a message.
    var isRenderable: Bool {
        // A tombstone is worth a row: a reply pointing at it has to keep
        // making sense.
        if deleted { return true }
        switch kind {
        case .text, .notice: return !(text ?? "").trimmed.isEmpty
        case .options: return card != nil
        case .activity: return tool != nil
        case .screen: return !(png ?? "").isEmpty
        case .artifact: return artifact != nil
        case .connector: return connector != nil
        case .secret: return secret != nil
        case .component: return component != nil
        case .unrecognised: return false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, from, kind, text, card, tool, png, mime, at, replyTo, artifact, connector, secret,
            component, deleted
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = (try? c.decode(MessageRole.self, forKey: .role)) ?? .bot
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        kind = (try? c.decode(MessageKind.self, forKey: .kind)) ?? .text
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        card = try? c.decodeIfPresent(OptionCard.self, forKey: .card)
        tool = try? c.decodeIfPresent(ToolRun.self, forKey: .tool)
        png = try? c.decodeIfPresent(String.self, forKey: .png)
        mime = try? c.decodeIfPresent(String.self, forKey: .mime)
        replyTo = try? c.decodeIfPresent(ReplyRef.self, forKey: .replyTo)
        artifact = try? c.decodeIfPresent(ArtifactMeta.self, forKey: .artifact)
        connector = try? c.decodeIfPresent(ConnectorMeta.self, forKey: .connector)
        secret = try? c.decodeIfPresent(SecretMeta.self, forKey: .secret)
        component = try? c.decodeIfPresent(AnswerComponent.self, forKey: .component)
        deleted = (try? c.decodeIfPresent(Bool.self, forKey: .deleted)) ?? false
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
    }

    init(
        id: String,
        role: MessageRole,
        from: String? = nil,
        kind: MessageKind,
        text: String? = nil,
        card: OptionCard? = nil,
        tool: ToolRun? = nil,
        png: String? = nil,
        mime: String? = nil,
        replyTo: ReplyRef? = nil,
        artifact: ArtifactMeta? = nil,
        component: AnswerComponent? = nil,
        deleted: Bool = false,
        at: Double
    ) {
        self.id = id
        self.role = role
        self.from = from
        self.kind = kind
        self.text = text
        self.card = card
        self.tool = tool
        self.png = png
        self.mime = mime
        self.replyTo = replyTo
        self.artifact = artifact
        self.component = component
        self.deleted = deleted
        self.at = at
    }
}

/// An answer that is not a paragraph. Mirrors server/components.ts, which
/// has already checked the shape: everything optional here is optional
/// there, and an unrecognised kind renders as nothing rather than
/// blanking a transcript.
struct AnswerComponent: Codable, Hashable {
    struct Bar: Codable, Hashable {
        let label: String
        let value: Double
    }
    struct Option: Codable, Hashable {
        let label: String
        var detail: String?
        var pick: Bool?
    }
    struct Step: Codable, Hashable {
        let label: String
        let state: String
        var detail: String?
    }

    let kind: String
    var title: String?
    var note: String?
    var bars: [Bar]?
    var columns: [String]?
    var rows: [[String]]?
    var question: String?
    var because: String?
    var options: [Option]?
    var steps: [Step]?
    var text: String?
    var from: String?
    var whereFrom: String?
    var what: String?

    private enum CodingKeys: String, CodingKey {
        case kind, title, note, bars, columns, rows, question, because, options, steps, text, from,
            what
        case whereFrom = "where"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        bars = try? c.decodeIfPresent([Bar].self, forKey: .bars)
        columns = try? c.decodeIfPresent([String].self, forKey: .columns)
        rows = try? c.decodeIfPresent([[String]].self, forKey: .rows)
        question = try? c.decodeIfPresent(String.self, forKey: .question)
        because = try? c.decodeIfPresent(String.self, forKey: .because)
        options = try? c.decodeIfPresent([Option].self, forKey: .options)
        steps = try? c.decodeIfPresent([Step].self, forKey: .steps)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        whereFrom = try? c.decodeIfPresent(String.self, forKey: .whereFrom)
        what = try? c.decodeIfPresent(String.self, forKey: .what)
    }

    /// One line for a list, where a component cannot be drawn. What it is
    /// beats an empty row.
    var previewLine: String {
        let named = title?.trimmed
        switch kind {
        case "chart": return named?.isEmpty == false ? named! : "A chart"
        case "table": return named?.isEmpty == false ? named! : "A table"
        case "decision": return question ?? "A recommendation"
        case "steps": return named?.isEmpty == false ? named! : "Some steps"
        case "quote": return text ?? "A quote"
        case "refused": return what.map { "Refused: \($0)" } ?? "Refused"
        default: return "An answer"
        }
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The message an answer points back at, denormalised for rendering.
struct ReplyRef: Codable, Hashable {
    let author: String
    let excerpt: String
}

/// A deliverable the agent produced, served by the harness.
struct ArtifactMeta: Codable, Hashable {
    let name: String
    let mime: String
    let size: Int
}
