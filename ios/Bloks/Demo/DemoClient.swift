// The sample workspace, as a BloksClient.
//
// This is the second implementation of BloksClient, and the only one that
// will ever be added on the "no real server" side. It exists because App
// Review has no Mac running Bloks: without it a reviewer opens the app,
// reads "Bloks is not reachable", and is entirely right to reject it as
// incomplete.
//
// Two rules it follows:
//
//   Nothing here touches the network. Not a loopback call, not a DNS
//   lookup. A sample that quietly fails differently on a reviewer's wifi
//   is worse than no sample.
//
//   It is never silently the real thing. The store keeps a flag, every
//   screen shows a banner, and leaving is one tap. Someone must not be
//   able to mistake the sample for their own agents.
import Foundation

final class DemoClient: BloksClient {
    /// Ignored. Kept because the protocol has it, and so that switching
    /// back to a real client preserves the address the user had.
    var connection: BloksConnection

    private var demoBots: [Bot] = []
    private var demoRooms: [Room] = []
    private var demoRoutines: [Routine] = []
    private var continuation: AsyncThrowingStream<ServerEvent, Error>.Continuation?

    init(connection: BloksConnection = .simulator) {
        self.connection = connection
        load()
    }

    private struct Fixture: Decodable {
        let bots: [Bot]
        let rooms: [Room]
    }

    private func load() {
        guard let url = Bundle.main.url(forResource: "demo-workspace", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let fixture = try? JSONDecoder().decode(Fixture.self, from: data)
        else { return }
        demoBots = fixture.bots
        demoRooms = fixture.rooms
    }

    // MARK: Reads

    func health() async throws -> Health { Health(app: "bloks-demo", pid: 0) }

    func artifact(botId: String, name: String) async throws -> Data { Data() }
    func speak(botId: String, text: String) async throws -> Data { throw URLError(.unsupportedURL) }
    func claimCall(targetId: String) async throws -> String { "demo" }
    func renewCall(token: String) async throws {}
    func releaseCall(token: String) async throws {}
    func createTask(botId: String) async throws -> Bot { throw URLError(.unsupportedURL) }
    func activateTask(botId: String, taskId: String) async throws -> Bot { throw URLError(.unsupportedURL) }
    func bots() async throws -> [Bot] { demoBots }

    /// Derived from the sample rather than a second hard coded copy, so an
    /// edit to demo-workspace.json cannot leave a ghost row behind.
    func activity() async throws -> Activity {
        // The sample's own timestamps are fixed, so that a screenshot of
        // it is reproducible. That is right for a transcript and wrong
        // here: a row saying a question was asked 155 days ago and stops
        // "any moment" reads as a broken app rather than as a sample.
        // These two are relative to now, which is what they mean.
        let now = Date().timeIntervalSince1970 * 1000
        var waiting: [WaitingWork] = []
        for bot in demoBots {
            for message in bot.messages {
                guard let card = message.card, card.isLiveAsk, !card.isSettled else { continue }
                waiting.append(
                    WaitingWork(
                        threadId: bot.threadId,
                        botId: bot.id,
                        botName: bot.name,
                        laneTitle: "General",
                        messageId: message.id,
                        asks: card.title,
                        since: now - 240_000,
                        kind: card.isGate ? "workflow" : "approval",
                        until: card.isGate ? now + 5_400_000 : nil,
                        runId: card.runId
                    )
                )
            }
        }
        // No Mac behind the sample, so nobody is at a wheel and nothing is
        // running. costKnown stays false: a sample must never show an
        // invented price.
        return Activity(waiting: waiting, today: Spend(turns: 6, input: 41_200, output: 5_800))
    }

    func handBackWheel(botId _: String) async throws {}
    func rooms() async throws -> [Room] { demoRooms }
    func routines() async throws -> [Routine] { demoRoutines }
    func instances() async throws -> [ProviderInstance] { [] }
    func usage(days: Int) async throws -> UsageSummary { .empty }

    // MARK: Writes
    //
    // A sample that cannot be typed into is a screenshot. So a sent message
    // lands in the transcript and the agent answers, scripted, after a beat.

    func send(botId: String, text: String, replyTo: ReplyRef?) async throws {
        guard let index = demoBots.firstIndex(where: { $0.id == botId }) else { return }
        let threadId = demoBots[index].threadId
        append(
            Message(id: UUID().uuidString, role: .user, kind: .text, text: text, at: now()),
            toThread: threadId
        )
        await reply(
            "This is a sample workspace, so I am not really running. Connect Bloks on your Mac and I will answer properly.",
            from: demoBots[index],
            in: threadId
        )
    }

    func send(roomId: String, text: String, replyTo: ReplyRef?) async throws {
        guard let index = demoRooms.firstIndex(where: { $0.id == roomId }) else { return }
        append(
            Message(id: UUID().uuidString, role: .user, kind: .text, text: text, at: now()),
            toThread: roomId
        )
        guard let speaker = demoBots.first(where: { demoRooms[index].memberIds.contains($0.id) }) else { return }
        await reply(
            "Sample room. Everyone here is a fixture, not a running agent.",
            from: speaker,
            in: roomId
        )
    }

    /// Answering the sample approval settles it, so the one interaction that
    /// matters can actually be performed rather than described.
    func respond(botId: String, requestId: String, behavior: RespondBehavior, message: String?) async throws {
        settleCard(requestId: requestId, answered: behavior.rawValue)
    }

    func answerGate(runId _: String, answer _: String) async throws {}

    func editAgent(
        botId: String, name: String?, title: String?, color: String?, shape: String?, expression: String?
    ) async throws {}

    func secretSave(botId: String, messageId: String, value: String) async throws {}
    func secretDismiss(botId: String, messageId: String) async throws {}
    func connectorAuthorize(botId: String, messageId: String) async throws -> String { "https://example.com" }
    func connectorRefresh(botId: String, messageId: String) async throws {}

    func patchCard(botId: String, messageId: String, answered: String?, dismissed: Bool?) async throws {
        guard let index = demoBots.firstIndex(where: { $0.id == botId }) else { return }
        guard let at = demoBots[index].messages.firstIndex(where: { $0.id == messageId }),
              var card = demoBots[index].messages[at].card else { return }
        if let answered { card.answered = answered }
        if let dismissed { card.dismissed = dismissed }
        demoBots[index].messages[at].card = card
        emit(.messagePatched(threadId: demoBots[index].threadId, message: demoBots[index].messages[at]))
    }

    func interrupt(botId _: String, taskId _: String?) async throws {}
    func markRead(botId: String) async throws {
        guard let index = demoBots.firstIndex(where: { $0.id == botId }) else { return }
        demoBots[index].unread = false
    }

    func setPinned(botId: String, pinned: Bool) async throws {
        guard let index = demoBots.firstIndex(where: { $0.id == botId }) else { return }
        demoBots[index].pinned = pinned
        emit(.bot(patch(from: demoBots[index])))
    }

    func setModel(botId: String, instanceId: String, model: String) async throws {}

    func createRoom(name: String, memberIds: [String]) async throws -> Room {
        throw BloksError.server(status: 400, message: "Rooms are made in Bloks on your Mac. This is a sample.")
    }

    // MARK: Routines
    //
    // Writable, so the editor can be tried, but held in memory only.

    func createRoutine(
        targetId: String,
        targetKind: String,
        prompt: String,
        time: String,
        days: [Int]
    ) async throws -> Routine {
        let json: [String: Any] = [
            "id": UUID().uuidString,
            "targetId": targetId,
            "targetKind": targetKind,
            "prompt": prompt,
            "time": time,
            "days": days,
            "enabled": true,
            "summary": Self.describe(time: time, days: days),
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let routine = try JSONDecoder().decode(Routine.self, from: data)
        demoRoutines.append(routine)
        return routine
    }

    func patchRoutine(id: String, prompt: String?, time: String?, days: [Int]?, enabled: Bool?) async throws {
        guard let index = demoRoutines.firstIndex(where: { $0.id == id }) else { return }
        if let prompt { demoRoutines[index].prompt = prompt }
        if let time { demoRoutines[index].time = time }
        if let days { demoRoutines[index].days = days }
        if let enabled { demoRoutines[index].enabled = enabled }
        demoRoutines[index].summary = Self.describe(
            time: demoRoutines[index].time,
            days: demoRoutines[index].days
        )
    }

    func deleteRoutine(id: String) async throws {
        demoRoutines.removeAll { $0.id == id }
    }

    func runRoutine(id: String) async throws {}

    /// Same wording as describe() in server/routines.ts, so the sample does
    /// not describe a schedule differently from the real thing.
    private static func describe(time: String, days: [Int]) -> String {
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        let sorted = days.sorted()
        if sorted.isEmpty { return "Every day at \(time)" }
        if sorted == [1, 2, 3, 4, 5] { return "Weekdays at \(time)" }
        if sorted == [0, 6] { return "Weekends at \(time)" }
        if sorted.count == 1 { return "Every \(names[sorted[0]]) at \(time)" }
        return sorted.map { String(names[$0].prefix(3)) }.joined(separator: ", ") + " at \(time)"
    }

    // MARK: Pairing

    func claimPairing(code: String, deviceName: String) async throws -> String {
        throw BloksError.server(status: 400, message: "Pairing needs a real Mac. This is a sample workspace.")
    }

    // MARK: Events

    func events() -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { continuation in
            self.continuation = continuation
            continuation.yield(.hello(resumed: false))
        }
    }

    // MARK: Plumbing

    private func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    private func emit(_ event: ServerEvent) { continuation?.yield(event) }

    private func patch(from bot: Bot) -> BotPatch {
        BotPatch(
            id: bot.id, threadId: bot.threadId, name: bot.name, title: bot.title,
            color: bot.color, shape: bot.shape, seniority: bot.seniority, effort: bot.effort, avatarAt: bot.avatarAt,
            unread: bot.unread, busy: bot.busy, pinned: bot.pinned, hidden: bot.hidden,
            archivedAt: bot.archivedAt,
            messages: nil, tasks: bot.tasks, activeTaskId: bot.activeTaskId, voice: bot.voice
        )
    }

    private func append(_ message: Message, toThread threadId: String) {
        if let index = demoBots.firstIndex(where: { $0.threadId == threadId }) {
            demoBots[index].messages.append(message)
        } else if let index = demoRooms.firstIndex(where: { $0.id == threadId }) {
            demoRooms[index].messages.append(message)
        }
        emit(.message(threadId: threadId, message: message))
    }

    /// A beat of "typing", then the line. Instant would look like a canned
    /// string, which it is, but the pause is what makes the transcript read
    /// the way the real one does.
    private func reply(_ text: String, from bot: Bot, in threadId: String) async {
        if let index = demoBots.firstIndex(where: { $0.id == bot.id }) {
            demoBots[index].busy = true
            emit(.bot(patch(from: demoBots[index])))
        }
        try? await Task.sleep(nanoseconds: 900_000_000)
        if let index = demoBots.firstIndex(where: { $0.id == bot.id }) {
            demoBots[index].busy = false
            emit(.bot(patch(from: demoBots[index])))
        }
        append(
            Message(
                id: UUID().uuidString,
                role: .bot,
                from: demoRooms.contains(where: { $0.id == threadId }) ? bot.id : nil,
                kind: .text,
                text: text,
                at: now()
            ),
            toThread: threadId
        )
    }

    private func settleCard(requestId: String, answered: String) {
        for index in demoBots.indices {
            for at in demoBots[index].messages.indices {
                guard var card = demoBots[index].messages[at].card,
                      card.requestId == requestId else { continue }
                card.answered = answered == "allow" ? "Allow" : answered == "deny" ? "Deny" : answered
                demoBots[index].messages[at].card = card
                emit(.messagePatched(threadId: demoBots[index].threadId, message: demoBots[index].messages[at]))
            }
        }
    }

    func markUnread(botId: String) async throws {}
    func setEffort(botId: String, effort: String?) async throws {}
    func setLeadOnly(roomId: String, on: Bool) async throws {}
    func webhooks(botId: String) async throws -> [Webhook] { [] }
    func createWebhook(botId: String, name: String) async throws -> Webhook {
        Webhook(id: UUID().uuidString, token: "demo-token", name: name, enabled: true, lastFiredAt: nil)
    }
    func deleteWebhook(id: String) async throws {}
    func teamManifest(roomId: String) async throws -> Data { Data("{}".utf8) }
    func avatar(botId: String) async throws -> Data { Data() }
    func uploadAvatar(botId: String, jpeg: Data) async throws {}
    func removeAvatar(botId: String) async throws {}
}
