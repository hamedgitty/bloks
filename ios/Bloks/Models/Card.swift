// Option cards, and the one distinction that matters most in this app.
//
// Mirrors server/store.ts `OptionCardData`.
//
// A card with a `requestId` is a live provider ask: an agent is blocked on
// it right now, and answering is the whole reason this app exists. A card
// without one is a setup question that has already been asked and can be
// answered whenever. They look different on purpose, and they are answered
// down completely different routes (see BloksStore.answer).
import Foundation

/// A team a lead wants to hire, pending approval. Mirrors server/teams.ts.
struct TeamPlan: Codable, Hashable {
    struct Member: Codable, Hashable, Identifiable {
        let name: String
        let title: String
        let description: String
        let skills: [String]

        var id: String { name }

        private enum CodingKeys: String, CodingKey { case name, title, description, skills }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decode(String.self, forKey: .name)) ?? ""
            title = (try? c.decode(String.self, forKey: .title)) ?? ""
            description = (try? c.decode(String.self, forKey: .description)) ?? ""
            skills = (try? c.decode([String].self, forKey: .skills)) ?? []
        }
    }

    let room: String
    let brief: String
    let members: [Member]

    private enum CodingKeys: String, CodingKey { case room, brief, members }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        room = (try? c.decode(String.self, forKey: .room)) ?? "New team"
        brief = (try? c.decode(String.self, forKey: .brief)) ?? ""
        members = (try? c.decode([Member].self, forKey: .members)) ?? []
    }
}

struct OptionCard: Codable, Hashable {
    let title: String
    let subtitle: String
    let options: [String]
    var answered: String?
    var dismissed: Bool?
    /// Present when this card is a live provider ask. The agent's turn is
    /// parked until this is answered or it times out server side.
    let requestId: String?
    /// Present when a workflow run is parked on this card. Answering it
    /// resumes that run, which is a different thing from saying something
    /// to an agent, so it goes down its own route. Mirrors the same field
    /// in server/store.ts.
    let runId: String?
    /// Present when a lead has proposed hiring a team.
    let team: TeamPlan?

    /// An agent is waiting on this right now. A workflow gate counts:
    /// a run is parked on it, which is the same fact from the other side.
    var isLiveAsk: Bool { requestId != nil || runId != nil }

    /// A workflow is parked on this, rather than an agent's turn.
    var isGate: Bool { runId != nil }

    /// Answered or dismissed, either by this device or somewhere else.
    var isSettled: Bool { answered != nil || dismissed == true }

    private enum CodingKeys: String, CodingKey {
        case title, subtitle, options, answered, dismissed, requestId, runId, team
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        subtitle = (try? c.decode(String.self, forKey: .subtitle)) ?? ""
        options = (try? c.decode([String].self, forKey: .options)) ?? []
        answered = try? c.decodeIfPresent(String.self, forKey: .answered)
        dismissed = try? c.decodeIfPresent(Bool.self, forKey: .dismissed)
        requestId = try? c.decodeIfPresent(String.self, forKey: .requestId)
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
        team = try? c.decodeIfPresent(TeamPlan.self, forKey: .team)
    }

    init(
        title: String,
        subtitle: String,
        options: [String],
        answered: String? = nil,
        dismissed: Bool? = nil,
        requestId: String? = nil,
        runId: String? = nil,
        team: TeamPlan? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.options = options
        self.answered = answered
        self.dismissed = dismissed
        self.requestId = requestId
        self.runId = runId
        self.team = team
    }
}
