// What every agent is doing right now, and what today cost.
//
// Mirrors server/activity.ts and GET /api/activity, hand written the way
// the rest of the models here are. The sections and their order are the
// design and are the same on both: waiting for you, then the wheel, then
// running, then the tally. Reordering them on the phone would make the
// two surfaces disagree about what is urgent.
//
// Every field decodes with a default and every list defaults to empty. A
// harness that grows a field, or an older one that never had `paused`,
// must never blank this screen: a person opens it precisely when
// something is wrong, which is the worst moment to show nothing.
import Foundation

struct Spend: Codable, Hashable {
    var turns: Int = 0
    var input: Int = 0
    var output: Int = 0
    var cost: Double = 0

    private enum CodingKeys: String, CodingKey { case turns, input, output, cost }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        turns = (try? c.decode(Int.self, forKey: .turns)) ?? 0
        input = (try? c.decode(Int.self, forKey: .input)) ?? 0
        output = (try? c.decode(Int.self, forKey: .output)) ?? 0
        cost = (try? c.decode(Double.self, forKey: .cost)) ?? 0
    }

    init(turns: Int = 0, input: Int = 0, output: Int = 0, cost: Double = 0) {
        self.turns = turns
        self.input = input
        self.output = output
        self.cost = cost
    }

    var tokens: Int { input + output }
}

/// Something stopped, waiting on a person. An approval parks an agent's
/// turn; a workflow gate parks a run and carries a deadline with it.
struct WaitingWork: Codable, Identifiable, Hashable {
    let threadId: String
    let botId: String
    let botName: String
    let laneTitle: String
    let messageId: String
    let asks: String
    let since: Double
    /// "approval" or "workflow". A plain String rather than an enum, so a
    /// kind a newer harness invents does not throw the payload away.
    let kind: String
    /// Only a gate has one.
    let until: Double?
    /// Set for a gate, and the thing that makes it answerable from here.
    let runId: String?

    var id: String { messageId }
    var isGate: Bool { runId != nil }

    private enum CodingKeys: String, CodingKey {
        case threadId, botId, botName, laneTitle, messageId, asks, since, kind, until, runId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadId = (try? c.decode(String.self, forKey: .threadId)) ?? ""
        botId = (try? c.decode(String.self, forKey: .botId)) ?? ""
        botName = (try? c.decode(String.self, forKey: .botName)) ?? "an agent"
        laneTitle = (try? c.decode(String.self, forKey: .laneTitle)) ?? ""
        messageId = (try? c.decode(String.self, forKey: .messageId)) ?? UUID().uuidString
        asks = (try? c.decode(String.self, forKey: .asks)) ?? "a question"
        since = (try? c.decode(Double.self, forKey: .since)) ?? 0
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "approval"
        until = try? c.decodeIfPresent(Double.self, forKey: .until)
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
    }

    init(
        threadId: String, botId: String, botName: String, laneTitle: String, messageId: String,
        asks: String, since: Double, kind: String, until: Double? = nil, runId: String? = nil
    ) {
        self.threadId = threadId
        self.botId = botId
        self.botName = botName
        self.laneTitle = laneTitle
        self.messageId = messageId
        self.asks = asks
        self.since = since
        self.kind = kind
        self.until = until
        self.runId = runId
    }
}

/// A lane with a turn in it, and what set it off.
struct RunningWork: Codable, Identifiable, Hashable {
    let threadId: String
    let botId: String
    let botName: String
    let laneTitle: String
    /// "you", "routine", "job" or "workflow".
    let kind: String
    let because: String
    let since: Double?

    var id: String { threadId }

    private enum CodingKeys: String, CodingKey {
        case threadId, botId, botName, laneTitle, kind, because, since
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadId = (try? c.decode(String.self, forKey: .threadId)) ?? ""
        botId = (try? c.decode(String.self, forKey: .botId)) ?? ""
        botName = (try? c.decode(String.self, forKey: .botName)) ?? "an agent"
        laneTitle = (try? c.decode(String.self, forKey: .laneTitle)) ?? ""
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "you"
        because = (try? c.decode(String.self, forKey: .because)) ?? "working"
        since = try? c.decodeIfPresent(Double.self, forKey: .since)
    }
}

/// A computer somebody has taken over.
struct PausedAgent: Codable, Identifiable, Hashable {
    let botId: String
    let botName: String
    let since: Double
    let why: String
    let turnedAway: Int

    var id: String { botId }

    private enum CodingKeys: String, CodingKey { case botId, botName, since, why, turnedAway }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = (try? c.decode(String.self, forKey: .botId)) ?? ""
        botName = (try? c.decode(String.self, forKey: .botName)) ?? "an agent"
        since = (try? c.decode(Double.self, forKey: .since)) ?? 0
        why = (try? c.decode(String.self, forKey: .why)) ?? "you are using it"
        turnedAway = (try? c.decode(Int.self, forKey: .turnedAway)) ?? 0
    }
}

/// One agent's share of today.
struct AgentRoll: Codable, Identifiable, Hashable {
    let botId: String
    let botName: String
    let running: Int
    let waiting: Int
    let today: Spend

    var id: String { botId }

    private enum CodingKeys: String, CodingKey { case botId, botName, running, waiting, today }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = (try? c.decode(String.self, forKey: .botId)) ?? ""
        botName = (try? c.decode(String.self, forKey: .botName)) ?? "an agent"
        running = (try? c.decode(Int.self, forKey: .running)) ?? 0
        waiting = (try? c.decode(Int.self, forKey: .waiting)) ?? 0
        today = (try? c.decode(Spend.self, forKey: .today)) ?? Spend()
    }
}

struct Activity: Codable, Hashable {
    var waiting: [WaitingWork] = []
    var running: [RunningWork] = []
    var paused: [PausedAgent] = []
    var agents: [AgentRoll] = []
    var today: Spend = Spend()
    /// False when nothing in range reported a price, so a zero that means
    /// "unknown" is left out rather than shown.
    var costKnown: Bool = false
    var at: Double = 0

    private enum CodingKeys: String, CodingKey {
        case waiting, running, paused, agents, today, costKnown, at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        waiting = (try? c.decode([WaitingWork].self, forKey: .waiting)) ?? []
        running = (try? c.decode([RunningWork].self, forKey: .running)) ?? []
        paused = (try? c.decode([PausedAgent].self, forKey: .paused)) ?? []
        agents = (try? c.decode([AgentRoll].self, forKey: .agents)) ?? []
        today = (try? c.decode(Spend.self, forKey: .today)) ?? Spend()
        costKnown = (try? c.decode(Bool.self, forKey: .costKnown)) ?? false
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
    }

    init(
        waiting: [WaitingWork] = [], running: [RunningWork] = [], paused: [PausedAgent] = [],
        agents: [AgentRoll] = [], today: Spend = Spend(), costKnown: Bool = false, at: Double = 0
    ) {
        self.waiting = waiting
        self.running = running
        self.paused = paused
        self.agents = agents
        self.today = today
        self.costKnown = costKnown
        self.at = at
    }

    /// Nothing is running and nothing wants you. The tally may still have
    /// rows in it, which is why this is not simply "empty".
    var isQuiet: Bool { waiting.isEmpty && running.isEmpty && paused.isEmpty }
}

/// How long ago, short enough for a row. Mirrors elapsed() in
/// src/components/Activity.tsx.
func elapsed(since: Double, now: Date) -> String {
    let seconds = max(0, Int(now.timeIntervalSince1970 - since / 1000))
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86_400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86_400)d"
}

/// How long is left. "any moment" rather than a negative number, because
/// a deadline that has passed is about to be acted on, not overdue.
func until(_ deadline: Double, now: Date) -> String {
    let seconds = Int(deadline / 1000 - now.timeIntervalSince1970)
    if seconds <= 0 { return "any moment" }
    if seconds < 3600 { return "in \(max(1, seconds / 60))m" }
    if seconds < 86_400 { return "in \(seconds / 3600)h" }
    return "in \(seconds / 86_400)d"
}

/// Two decimals at a pound and above, three below, so a fraction of a
/// penny does not read as nothing. Mirrors money() in Activity.tsx.
func money(_ amount: Double) -> String {
    amount >= 1 ? String(format: "$%.2f", amount) : String(format: "$%.3f", amount)
}
