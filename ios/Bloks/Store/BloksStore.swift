// The one piece of state, mirroring the shape of src/state/store.tsx.
//
// Hydrate everything on connect, apply SSE frames incrementally, and
// re-hydrate on every reconnect. The last part is not optional: anything
// that happened while the socket was down was never delivered, so what is
// on screen is stale until it is refetched. The web client calls loadAll()
// in es.onopen for exactly this reason.
import Foundation
import Observation
import UIKit
import UserNotifications

@Observable
@MainActor
final class BloksStore {
    enum Status: Equatable {
        case connecting
        case connected
        case offline(String)

        var isConnected: Bool { self == .connected }
    }

    private(set) var bots: [Bot] = []
    private(set) var rooms: [Room] = []
    /// Scheduled work, across every agent and room.
    private(set) var routines: [Routine] = []
    /// Engines and their models, for the model picker.
    private(set) var instances: [ProviderInstance] = []
    private(set) var status: Status = .connecting
    /// In-flight assistant text per threadId, folded from content.delta.
    /// Rendered as a trailing bubble until the settled message arrives.
    private(set) var streaming: [String: String] = [:]

    /// Surfaced to the user, then cleared. The harness writes its error
    /// strings for a reader, so they are shown as-is.
    var error: String?

    /// Showing the bundled sample rather than a real Mac. Never implicit:
    /// every screen says so, because someone must not be able to mistake
    /// the sample for their own agents.
    private(set) var isDemo = false

    /// The Mac refused our token. Holding one is not the same as being
    /// paired, and a revoked device that still says "Paired" is the app
    /// lying about the one thing this screen exists to report.
    private(set) var pairingRejected = false

    /// Where the Mac is, mirrored out of the client so views can read it
    /// without holding the client themselves.
    private(set) var connection: BloksConnection

    private(set) var client: BloksClient
    private var streamTask: Task<Void, Never>?

    init(client: BloksClient) {
        self.client = client
        self.connection = client.connection
    }

    // MARK: The sample workspace

    /// Swaps in the bundled sample. Used by App Review, who have no Mac, and
    /// by anyone who installs the phone app before the desktop one.
    func enterDemo() {
        guard !isDemo else { return }
        disconnect()
        isDemo = true
        client = DemoClient(connection: connection)
        streaming = [:]
        status = .connecting
        connect()
        Task { await hydrate() }
    }

    func exitDemo() {
        guard isDemo else { return }
        disconnect()
        isDemo = false
        bots = []
        rooms = []
        routines = []
        streaming = [:]
        client = HTTPClient(connection: connection)
        status = .connecting
        connect()
        Task { await hydrate() }
    }

    // MARK: Connection

    /// Point at a different Mac, or the same one after a network change.
    func reconnect(host: String, port: Int) {
        var next = connection
        next.host = host
        next.port = port
        apply(next)
    }

    /// Trade a six digit code for a bearer token. The code is shown on the
    /// Mac and is good for one claim, so a failure here has to say why
    /// rather than silently leaving the device unpaired.
    func pair(host: String, port: Int, code: String) async throws {
        var next = connection
        next.host = host
        next.port = port
        next.token = nil
        client.connection = next
        connection = next

        // iOS returns the model name here ("iPhone") rather than the user's
        // chosen device name unless the app is entitled to it. That is fine:
        // this string only has to help someone recognise a row on the Mac's
        // revoke screen, and the pairing time does most of that work.
        let token = try await client.claimPairing(
            code: code,
            deviceName: UIDevice.current.name
        )
        next.token = token
        apply(next)
    }

    func unpair() {
        var next = connection
        next.token = nil
        // relay credentials ride on the pairing; they go with it
        next.relayUrl = nil
        next.relayClientToken = nil
        next.deviceId = nil
        ConnectionStore.forgetToken()
        apply(next)
    }

    /// The relay credentials, fetched over the working LAN connection and
    /// saved without tearing the stream down. Having them is also the
    /// moment push notifications become meaningful, so the permission ask
    /// happens here and not on first launch.
    private func adoptRelay() async {
        guard let http = client as? HTTPClient,
              let join = try? await http.relayJoin(), join.deviceId != nil else { return }
        var next = connection
        next.relayUrl = join.url
        next.relayClientToken = join.clientToken
        next.deviceId = join.deviceId
        connection = next
        client.connection = next
        ConnectionStore.save(next)
        registerForPush()
    }

    /// Ask, register, and hand the token to the relay whenever it shows
    /// up. Safe to call repeatedly; every step is idempotent.
    func registerForPush() {
        guard connection.relayReady else { return }
        PushBridge.onToken = { [weak self] token in
            Task { @MainActor in
                guard let self, let http = self.client as? HTTPClient else { return }
                await http.registerPush(apnsToken: token)
            }
        }
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            let granted =
                (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
            // the token may already be waiting from an earlier launch
            if let token = PushBridge.token, let http = self.client as? HTTPClient {
                await http.registerPush(apnsToken: token)
            }
        }
    }

    private func apply(_ next: BloksConnection) {
        connection = next
        // Changing the address is a statement that a real Mac exists.
        if isDemo {
            isDemo = false
            bots = []
            rooms = []
            routines = []
            client = HTTPClient(connection: next)
        }
        client.connection = next
        ConnectionStore.save(next)
        // The stream is bound to the old address, so it has to be torn down
        // rather than left to notice on its own.
        disconnect()
        status = .connecting
        connect()
        Task { await hydrate() }
    }

    // MARK: Conversations

    /// Agents and rooms in one list, the way DMs and group chats share one
    /// list in Messages. Pinned first, hidden excluded, newest first.
    var conversations: [Conversation] {
        let agents = bots.filter { $0.hidden != true }.map(Conversation.agent)
        let groups = rooms.map(Conversation.room)
        return (agents + groups).sorted { a, b in
            if a.isPinned != b.isPinned { return a.isPinned }
            return a.sortedAt > b.sortedAt
        }
    }

    func conversation(id: String) -> Conversation? {
        if let bot = bots.first(where: { $0.id == id }) { return .agent(bot) }
        if let room = rooms.first(where: { $0.id == id }) { return .room(room) }
        return nil
    }

    func bot(id: String) -> Bot? { bots.first { $0.id == id } }
    func bot(threadId: String) -> Bot? { bots.first { $0.threadId == threadId } }
    func room(id: String) -> Room? { rooms.first { $0.id == id } }

    func members(of room: Room) -> [Bot] {
        room.memberIds.compactMap { id in bots.first { $0.id == id } }
    }

    /// Highest seniority wins, ties break toward the earliest listed. Same
    /// rule as leadOf() in server/index.ts.
    func lead(of room: Room) -> Bot? {
        members(of: room).reduce(nil as Bot?) { best, member in
            guard let best else { return member }
            return (member.seniority ?? 1) > (best.seniority ?? 1) ? member : best
        }
    }

    /// A widget tap names the conversation to open; the list consumes it.
    var pendingOpenId: String?

    /// A scanned or deep-linked pairing invite, waiting for the person
    /// to read it and confirm. Refused outright when already paired.
    var pendingPairInvite: PairInvite?

    // MARK: Loading

    func hydrate() async {
        do {
            async let fetchedBots = client.bots()
            async let fetchedRooms = client.rooms()
            let (b, r) = try await (fetchedBots, fetchedRooms)
            bots = b
            rooms = r
            // Routines are a smaller, separate concern: a failure to load
            // them must not blank the conversation list.
            routines = (try? await client.routines()) ?? routines
            instances = (try? await client.instances()) ?? instances
            status = .connected
            pairingRejected = false
            WidgetSnapshot.publish(bots: bots)
            // While the LAN can still reach the Mac, keep the relay
            // credentials current: fetch on every hydrate, not once, so a
            // relay the Mac recreated (new url or client token) is picked
            // up instead of leaving a dead road that fails half of all
            // stream attempts forever.
            if connection.token != nil, !connection.isLoopback {
                await adoptRelay()
            }
        } catch {
            if case BloksError.notPaired = error { pairingRejected = true }
            status = .offline(error.localizedDescription)
        }
    }

    /// Opens the event stream and keeps it open for the life of the app.
    func connect() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            guard let self else { return }
            let stream = self.client.events()
            do {
                for try await event in stream {
                    if Task.isCancelled { return }
                    await self.apply(event)
                }
            } catch {
                self.status = .offline(error.localizedDescription)
            }
        }
    }

    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
    }

    // MARK: Folding the stream

    private func apply(_ event: ServerEvent) async {
        switch event {
        case .hello(let resumed):
            status = .connected
            // A resumed stream already replayed everything missed, so the
            // re-hydrate is only for gaps the server could not cover.
            if !resumed { await hydrate() }

        case .disconnected(let why):
            status = .offline(why)

        case .pairingRejected:
            // the Mac revoked this device; surface it and clear the relay
            // credentials so a stale road is not retried
            pairingRejected = true
            status = .offline("This device was unpaired.")
            if connection.relayUrl != nil {
                var next = connection
                next.relayUrl = nil
                next.relayClientToken = nil
                next.deviceId = nil
                connection = next
                client.connection = next
                ConnectionStore.save(next)
            }

        case .message(let threadId, let message):
            append(message, to: threadId)

        case .messagePatched(let threadId, let message):
            replace(message, in: threadId)

        case .bot(let patch):
            merge(patch)
            WidgetSnapshot.publish(bots: bots)

        case .botDeleted(let id):
            bots.removeAll { $0.id == id }
            WidgetSnapshot.publish(bots: bots)

        case .room(let room):
            if let index = rooms.firstIndex(where: { $0.id == room.id }) {
                // A `blok` frame carries no transcript, so keep the one we
                // already have rather than blanking the thread.
                var updated = room
                updated.messages = rooms[index].messages
                rooms[index] = updated
            } else {
                rooms.insert(room, at: 0)
            }

        case .roomDeleted(let id):
            rooms.removeAll { $0.id == id }

        case .streamDelta(let threadId, let delta):
            streaming[threadId, default: ""] += delta

        case .streamEnded(let threadId):
            streaming.removeValue(forKey: threadId)

        case .screen:
            // Live frames belong to the desktop's computer panel. The final
            // frame of a turn arrives as a `screen` message and is rendered
            // in the transcript, which is the part that matters on a phone.
            break

        case .refresh(let what):
            // The harness says "something in this area changed"; refetch
            // rather than trying to patch state out of the frame.
            switch what {
            case "routines": routines = (try? await client.routines()) ?? routines
            case "providers", "config": instances = (try? await client.instances()) ?? instances
            default: break
            }
        }
    }

    private func append(_ message: Message, to threadId: String) {
        if let index = rooms.firstIndex(where: { $0.id == threadId }) {
            guard !rooms[index].messages.contains(where: { $0.id == message.id }) else { return }
            rooms[index].messages.append(message)
            return
        }
        guard let index = bots.firstIndex(where: { $0.threadId == threadId }) else { return }
        guard !bots[index].messages.contains(where: { $0.id == message.id }) else { return }
        bots[index].messages.append(message)
        // A settled assistant bubble replaces the in-flight stream.
        if message.role == .bot, message.kind == .text {
            streaming.removeValue(forKey: threadId)
        }
    }

    private func replace(_ message: Message, in threadId: String) {
        if let index = rooms.firstIndex(where: { $0.id == threadId }),
           let at = rooms[index].messages.firstIndex(where: { $0.id == message.id }) {
            rooms[index].messages[at] = message
            return
        }
        if let index = bots.firstIndex(where: { $0.threadId == threadId }),
           let at = bots[index].messages.firstIndex(where: { $0.id == message.id }) {
            bots[index].messages[at] = message
        }
    }

    private func merge(_ patch: BotPatch) {
        guard let index = bots.firstIndex(where: { $0.id == patch.id }) else {
            // A record for an agent nobody has seen is a new agent, not a
            // patch: one a lead just hired arrives this way. Without a
            // threadId it is not usable, so refetch instead of guessing.
            Task { await hydrate() }
            return
        }
        var bot = bots[index]
        if let name = patch.name { bot.name = name }
        if let title = patch.title { bot.title = title }
        if let color = patch.color { bot.color = color }
        if let shape = patch.shape { bot.shape = shape }
        if let seniority = patch.seniority { bot.seniority = seniority }
        if let effort = patch.effort { bot.effort = effort }
        // nil in a patch can mean either "unchanged" or "removed"; the
        // server always sends the field on avatar changes, so absent-when-
        // present-before means the photo went away.
        bot.avatarAt = patch.avatarAt
        if let unread = patch.unread { bot.unread = unread }
        if let busy = patch.busy { bot.busy = busy }
        if let pinned = patch.pinned { bot.pinned = pinned }
        // Absent means "not set" rather than "unchanged" for both of
        // these. A bot frame is always the whole agent, and the harness
        // drops both fields when one is restored: reading absence as no
        // news left a restored agent hidden on this device forever.
        bot.hidden = patch.hidden
        bot.archivedAt = patch.archivedAt
        if let tasks = patch.tasks { bot.tasks = tasks }
        if let voice = patch.voice { bot.voice = voice }
        if let active = patch.activeTaskId {
            bot.activeTaskId = active
            if let threadId = patch.threadId { bot.threadId = threadId }
        }
        // Never take messages from a patch: the frame usually omits them,
        // and an empty array here would wipe the open thread.
        if let messages = patch.messages, !messages.isEmpty { bot.messages = messages }
        bots[index] = bot
    }

    /// Switch to a lane: the server answers with the bot wearing that
    /// lane's transcript, which replaces ours whole.
    func activateTask(bot: Bot, taskId: String) async {
        do {
            let fresh = try await client.activateTask(botId: bot.id, taskId: taskId)
            if let index = bots.firstIndex(where: { $0.id == fresh.id }) { bots[index] = fresh }
        } catch {
            report(error)
        }
    }

    func createTask(bot: Bot) async {
        do {
            let fresh = try await client.createTask(botId: bot.id)
            if let index = bots.firstIndex(where: { $0.id == fresh.id }) { bots[index] = fresh }
        } catch {
            report(error)
        }
    }

    // MARK: Actions

    func send(to conversation: Conversation, text: String, replyTo: ReplyRef? = nil) async {
        let body = text.trimmed
        guard !body.isEmpty else { return }
        do {
            switch conversation {
            case .agent(let bot):
                try await client.send(botId: bot.id, text: body, replyTo: replyTo)
            case .room(let room):
                try await client.send(roomId: room.id, text: body, replyTo: replyTo)
            }
        } catch {
            report(error)
        }
    }

    func interrupt(bot: Bot) async {
        do { try await client.interrupt(botId: bot.id) } catch { report(error) }
    }

    func markRead(_ conversation: Conversation) async {
        guard case .agent(let bot) = conversation, bot.unread else { return }
        // Clear it locally first so the badge goes away on tap rather than
        // on the round trip.
        if let index = bots.firstIndex(where: { $0.id == bot.id }) { bots[index].unread = false }
        try? await client.markRead(botId: bot.id)
    }

    func setPinned(bot: Bot, pinned: Bool) async {
        if let index = bots.firstIndex(where: { $0.id == bot.id }) { bots[index].pinned = pinned }
        do { try await client.setPinned(botId: bot.id, pinned: pinned) } catch { report(error) }
    }

    func markUnread(bot: Bot) async {
        do { try await client.markUnread(botId: bot.id) } catch { report(error) }
    }

    func setEffort(bot: Bot, effort: String?) async {
        do { try await client.setEffort(botId: bot.id, effort: effort) } catch { report(error) }
        if let index = bots.firstIndex(where: { $0.id == bot.id }) {
            bots[index].effort = effort
        }
    }

    func setLeadOnly(room: Room, on: Bool) async {
        do { try await client.setLeadOnly(roomId: room.id, on: on) } catch { report(error) }
        if let index = rooms.firstIndex(where: { $0.id == room.id }) {
            rooms[index].leadOnly = on
        }
    }

    func webhooks(bot: Bot) async -> [Webhook] {
        (try? await client.webhooks(botId: bot.id)) ?? []
    }

    func createWebhook(bot: Bot, name: String) async -> Webhook? {
        do { return try await client.createWebhook(botId: bot.id, name: name) } catch {
            report(error)
            return nil
        }
    }

    func deleteWebhook(id: String) async {
        do { try await client.deleteWebhook(id: id) } catch { report(error) }
    }

    /// The full URL a webhook consumer should POST to, against wherever
    /// this phone currently reaches the harness.
    func hookURL(_ hook: Webhook) -> String {
        client.connection.baseURL.appendingPathComponent("hook/\(hook.token)").absoluteString
    }

    func uploadAvatar(bot: Bot, image: UIImage) async {
        // Center-crop to square, shrink to 512, ship as JPEG: the server
        // stores what it gets, so the phone does the diet.
        let side = min(image.size.width, image.size.height)
        let crop = CGRect(
            x: (image.size.width - side) / 2,
            y: (image.size.height - side) / 2,
            width: side,
            height: side
        )
        guard let cg = image.cgImage?.cropping(to: crop) else { return }
        let square = UIImage(cgImage: cg, scale: 1, orientation: image.imageOrientation)
        let out = UIGraphicsImageRenderer(size: CGSize(width: 512, height: 512)).image { _ in
            square.draw(in: CGRect(x: 0, y: 0, width: 512, height: 512))
        }
        guard let jpeg = out.jpegData(compressionQuality: 0.85) else { return }
        do { try await client.uploadAvatar(botId: bot.id, jpeg: jpeg) } catch { report(error) }
    }

    func removeAvatar(bot: Bot) async {
        do { try await client.removeAvatar(botId: bot.id) } catch { report(error) }
    }

    /// The manifest as shareable text, pretty-printed for humans.
    func teamManifestText(room: Room) async -> String? {
        guard let data = try? await client.teamManifest(roomId: room.id) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                withJSONObject: object, options: [.prettyPrinted, .sortedKeys]
              )
        else { return String(data: data, encoding: .utf8) }
        return String(data: pretty, encoding: .utf8)
    }

    /// Answering an option card. Three routes, and they are NOT
    /// interchangeable. Copied from the dispatch in src/state/store.tsx:
    /// getting this wrong means an approval silently never reaches the
    /// agent and the turn hangs until it times out server side.
    func answer(
        card message: Message,
        in conversation: Conversation,
        speaker: Bot,
        with answer: String
    ) async {
        let text = answer.trimmed
        guard !text.isEmpty else { return }

        // Settle it on screen immediately; the server's message.patch
        // confirms it a moment later.
        settle(messageId: message.id, in: conversation, answered: text)

        do {
            if let runId = message.card?.runId {
                // 0. A workflow run is parked on this card. Answering it
                //    resumes that run, which is a different thing from
                //    saying something to an agent, so it has its own
                //    route. Checked first: a gate carries a run rather
                //    than a request, and treating it as a setup question
                //    would post the answer into the chat and leave the
                //    run parked forever.
                try await client.answerGate(runId: runId, answer: text)
            } else if let requestId = message.card?.requestId {
                // 1. A live provider ask. It settles against the agent that
                //    raised it, wherever the card happens to be shown.
                let behavior: RespondBehavior
                switch text {
                case "Allow": behavior = .allow
                case "Deny": behavior = .deny
                default: behavior = .answer
                }
                try await client.respond(
                    botId: speaker.id,
                    requestId: requestId,
                    behavior: behavior,
                    message: behavior == .answer ? text : nil
                )
            } else if case .room(let room) = conversation {
                // 2. A setup question inside a room: the answer is just a
                //    message to the room.
                try await client.send(roomId: room.id, text: text, replyTo: nil)
            } else {
                // 3. A setup question in a solo chat: persist the card's
                //    answered state AND say it, because the agent only
                //    hears the message.
                try await client.patchCard(
                    botId: speaker.id,
                    messageId: message.id,
                    answered: text,
                    dismissed: nil
                )
                try await client.send(botId: speaker.id, text: text, replyTo: nil)
            }
        } catch {
            report(error)
        }
    }

    func dismiss(card message: Message, in conversation: Conversation, speaker: Bot) async {
        settle(messageId: message.id, in: conversation, dismissed: true)
        do {
            if let requestId = message.card?.requestId {
                // Closing a live approval is a denial, not a no-op. The
                // agent is blocked and something has to answer it.
                try await client.respond(
                    botId: speaker.id,
                    requestId: requestId,
                    behavior: .deny,
                    message: "Dismissed by user."
                )
            } else if case .agent = conversation {
                try await client.patchCard(
                    botId: speaker.id,
                    messageId: message.id,
                    answered: nil,
                    dismissed: true
                )
            }
        } catch {
            report(error)
        }
    }

    private func settle(
        messageId: String,
        in conversation: Conversation,
        answered: String? = nil,
        dismissed: Bool? = nil
    ) {
        func patch(_ messages: inout [Message]) {
            guard let index = messages.firstIndex(where: { $0.id == messageId }),
                  var card = messages[index].card else { return }
            if let answered { card.answered = answered }
            if let dismissed { card.dismissed = dismissed }
            messages[index].card = card
        }

        switch conversation {
        case .agent(let bot):
            guard let index = bots.firstIndex(where: { $0.id == bot.id }) else { return }
            patch(&bots[index].messages)
        case .room(let room):
            guard let index = rooms.firstIndex(where: { $0.id == room.id }) else { return }
            patch(&rooms[index].messages)
        }
    }

    // MARK: Engines

    func instance(id: String) -> ProviderInstance? {
        instances.first { $0.instanceId == id }
    }

    /// What the chat header shows: the model's own label, not its id.
    func modelLabel(for bot: Bot) -> String? {
        guard let selection = bot.modelSelection else { return nil }
        guard let instance = instance(id: selection.instanceId) else { return selection.model }
        return instance.models.options.first { $0.id == selection.model }?.label ?? selection.model
    }

    func setModel(for bot: Bot, instanceId: String, model: String) async {
        if let index = bots.firstIndex(where: { $0.id == bot.id }) {
            bots[index].modelSelection = ModelSelection(instanceId: instanceId, model: model)
        }
        do {
            try await client.setModel(botId: bot.id, instanceId: instanceId, model: model)
        } catch {
            report(error)
        }
    }

    // MARK: Rooms

    func createRoom(name: String, memberIds: [String]) async -> String? {
        do {
            let room = try await client.createRoom(name: name, memberIds: memberIds)
            rooms = (try? await client.rooms()) ?? rooms
            return room.id
        } catch {
            report(error)
            return nil
        }
    }

    // MARK: Usage

    func loadUsage(days: Int = 30) async -> UsageSummary? {
        do { return try await client.usage(days: days) } catch { return nil }
    }

    // MARK: Activity
    //
    // Deliberately not kept on the store. It is a snapshot with elapsed
    // times baked into it, and a copy held here would go on rendering as
    // a frozen list on a screen nobody is looking at. The view owns it,
    // the way the usage screen owns its summary.

    func activity() async -> Activity? {
        do { return try await client.activity() } catch { return nil }
    }

    /// "Approve" or "Decline": the two words the run's own route knows,
    /// and anything else it does not recognise reads as a decline.
    func answerGate(runId: String, approve: Bool) async {
        do { try await client.answerGate(runId: runId, answer: approve ? "Approve" : "Decline") } catch {
            report(error)
        }
    }

    func stopTurn(botId: String, taskId: String) async {
        do { try await client.interrupt(botId: botId, taskId: taskId) } catch { report(error) }
    }

    func handBackWheel(botId: String) async {
        do { try await client.handBackWheel(botId: botId) } catch { report(error) }
    }

    /// Open the conversation a row belongs to, on the lane the row names.
    /// A row can point at a background lane, which is not the one the
    /// conversation currently shows.
    func reveal(conversationId: String, lane: String) async {
        if let bot = bots.first(where: { $0.id == conversationId }), bot.threadId != lane {
            if let fresh = try? await client.activateTask(botId: bot.id, taskId: lane),
               let index = bots.firstIndex(where: { $0.id == fresh.id }) {
                bots[index] = fresh
            }
        }
        pendingOpenId = conversationId
    }

    // MARK: Routines

    func routines(for conversation: Conversation) -> [Routine] {
        routines
            .filter { $0.targetId == conversation.id }
            .sorted { ($0.time, $0.id) < ($1.time, $1.id) }
    }

    func addRoutine(to conversation: Conversation, draft: RoutineDraft) async {
        let kind: String = { if case .room = conversation { return "room" } else { return "agent" } }()
        do {
            _ = try await client.createRoutine(
                targetId: conversation.id,
                targetKind: kind,
                prompt: draft.prompt,
                time: draft.time,
                days: draft.days.sorted()
            )
            routines = (try? await client.routines()) ?? routines
        } catch {
            report(error)
        }
    }

    func updateRoutine(_ routine: Routine, draft: RoutineDraft) async {
        do {
            try await client.patchRoutine(
                id: routine.id,
                prompt: draft.prompt,
                time: draft.time,
                days: draft.days.sorted(),
                enabled: draft.enabled
            )
            routines = (try? await client.routines()) ?? routines
        } catch {
            report(error)
        }
    }

    func setRoutineEnabled(_ routine: Routine, enabled: Bool) async {
        if let index = routines.firstIndex(where: { $0.id == routine.id }) {
            routines[index].enabled = enabled
        }
        do {
            try await client.patchRoutine(id: routine.id, prompt: nil, time: nil, days: nil, enabled: enabled)
            routines = (try? await client.routines()) ?? routines
        } catch {
            report(error)
        }
    }

    func deleteRoutine(_ routine: Routine) async {
        routines.removeAll { $0.id == routine.id }
        do {
            try await client.deleteRoutine(id: routine.id)
        } catch {
            report(error)
        }
    }

    /// Runs one now, for "does this do what I meant" without waiting until
    /// tomorrow morning.
    func runRoutineNow(_ routine: Routine) async {
        do { try await client.runRoutine(id: routine.id) } catch { report(error) }
    }

    private func report(_ error: Error) {
        self.error = error.localizedDescription
        Task {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if self.error == error.localizedDescription { self.error = nil }
        }
    }
}
