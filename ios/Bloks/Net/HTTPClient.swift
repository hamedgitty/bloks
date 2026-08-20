// The one BloksClient implementation: plain URLSession against the harness.
//
// Two things here are load-bearing and easy to break by tidying:
//
//   No Origin header. URLSession does not send one, and that is precisely
//   why loopback works: isLocalRequest() in server/http-guard.ts accepts a
//   request with no Origin. Setting one that is not the server's own host
//   gets you a 403, by design.
//
//   Long request timeout on the event stream. The default 60s would kill a
//   healthy idle SSE connection every minute. EventStream.swift uses its
//   own session for that reason.
import Foundation

final class HTTPClient: BloksClient {
    var connection: BloksConnection

    private let session: URLSession

    init(connection: BloksConnection = .simulator) {
        self.connection = connection
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        // The harness is local. Caching a transcript response would just
        // serve a stale thread after a reconnect.
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)
    }

    // MARK: Reads

    func health() async throws -> Health {
        try await get("/api/health")
    }

    func bots() async throws -> [Bot] {
        let wrapper: BotsResponse = try await get("/api/bots")
        return wrapper.bots
    }

    func rooms() async throws -> [Room] {
        let wrapper: RoomsResponse = try await get("/api/bloks")
        return wrapper.bloks
    }

    // MARK: Writes

    func send(botId: String, text: String, replyTo: ReplyRef? = nil) async throws {
        try await write("POST", "/api/bots/\(botId)/messages", sendBody(text, replyTo))
    }

    func send(roomId: String, text: String, replyTo: ReplyRef? = nil) async throws {
        try await write("POST", "/api/bloks/\(roomId)/messages", sendBody(text, replyTo))
    }

    private func sendBody(_ text: String, _ replyTo: ReplyRef?) -> [String: Any] {
        var body: [String: Any] = ["text": text]
        if let replyTo {
            body["replyTo"] = ["author": replyTo.author, "excerpt": replyTo.excerpt]
        }
        return body
    }

    func respond(
        botId: String,
        requestId: String,
        behavior: RespondBehavior,
        message: String?
    ) async throws {
        var body: [String: Any] = ["requestId": requestId, "behavior": behavior.rawValue]
        if let message { body["message"] = message }
        try await write("POST", "/api/bots/\(botId)/respond", body)
    }

    func answerGate(runId: String, answer: String) async throws {
        try await write("POST", "/api/workflows/runs/\(runId)/answer", ["answer": answer])
    }

    func editAgent(
        botId: String,
        name: String?,
        title: String?,
        color: String?,
        shape: String?,
        expression: String?
    ) async throws {
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let title { body["title"] = title }
        if let color { body["color"] = color }
        if let shape { body["shape"] = shape }
        if let expression { body["mascotExpression"] = expression }
        guard !body.isEmpty else { return }
        try await write("PATCH", "/api/bots/\(botId)", body)
    }

    func patchCard(botId: String, messageId: String, answered: String?, dismissed: Bool?) async throws {
        var body: [String: Any] = [:]
        if let answered { body["answered"] = answered }
        if let dismissed { body["dismissed"] = dismissed }
        try await write("PATCH", "/api/bots/\(botId)/cards/\(messageId)", body)
    }

    func interrupt(botId: String, taskId: String?) async throws {
        try await write("POST", "/api/bots/\(botId)/interrupt", taskId.map { ["taskId": $0] } ?? [:])
    }

    func handBackWheel(botId: String) async throws {
        try await write("DELETE", "/api/bots/\(botId)/wheel", [:])
    }

    func markRead(botId: String) async throws {
        try await write("PATCH", "/api/bots/\(botId)", ["unread": false])
    }

    func setPinned(botId: String, pinned: Bool) async throws {
        try await write("PATCH", "/api/bots/\(botId)", ["pinned": pinned])
    }

    // MARK: Engines and usage

    func instances() async throws -> [ProviderInstance] {
        struct Wrapper: Codable { let instances: [ProviderInstance] }
        let wrapper: Wrapper = try await get("/api/instances")
        return wrapper.instances
    }

    func activity() async throws -> Activity {
        try await get("/api/activity")
    }

    func usage(days: Int) async throws -> UsageSummary {
        try await get("/api/usage?days=\(days)")
    }

    func setModel(botId: String, instanceId: String, model: String) async throws {
        try await write(
            "PATCH",
            "/api/bots/\(botId)",
            ["modelSelection": ["instanceId": instanceId, "model": model]]
        )
    }

    // MARK: Rooms

    func createRoom(name: String, memberIds: [String]) async throws -> Room {
        struct Created: Codable { let blok: Room }
        let created: Created = try await request(
            "POST",
            "/api/bloks",
            body: ["name": name, "memberIds": memberIds]
        )
        return created.blok
    }

    // MARK: Routines

    func routines() async throws -> [Routine] {
        struct Wrapper: Codable { let routines: [Routine] }
        let wrapper: Wrapper = try await get("/api/routines")
        return wrapper.routines
    }

    func createRoutine(
        targetId: String,
        targetKind: String,
        prompt: String,
        time: String,
        days: [Int]
    ) async throws -> Routine {
        struct Created: Codable { let routine: Routine }
        let created: Created = try await request(
            "POST",
            "/api/routines",
            body: ["targetId": targetId, "targetKind": targetKind, "prompt": prompt, "time": time, "days": days]
        )
        return created.routine
    }

    func patchRoutine(id: String, prompt: String?, time: String?, days: [Int]?, enabled: Bool?) async throws {
        var body: [String: Any] = [:]
        if let prompt { body["prompt"] = prompt }
        if let time { body["time"] = time }
        if let days { body["days"] = days }
        if let enabled { body["enabled"] = enabled }
        try await write("PATCH", "/api/routines/\(id)", body)
    }

    func deleteRoutine(id: String) async throws {
        _ = try await data("DELETE", "/api/routines/\(id)", body: nil)
    }

    func runRoutine(id: String) async throws {
        try await write("POST", "/api/routines/\(id)/run", [:])
    }

    // MARK: Pairing

    func claimPairing(code: String, deviceName: String) async throws -> String {
        struct Claimed: Codable { let token: String }
        // a six digit code travels under the old key; the QR token under
        // the new one, so older Macs keep pairing
        let key = code.count == 6 && code.allSatisfy(\.isNumber) ? "code" : "credential"
        let claimed: Claimed = try await request(
            "POST",
            "/api/pair/claim",
            body: [key: code, "device": deviceName]
        )
        return claimed.token
    }

    func connectorAuthorize(botId: String, messageId: String) async throws -> String {
        struct Opened: Codable { let url: String }
        let opened: Opened = try await request(
            "POST",
            "/api/bots/\(botId)/connector-cards/\(messageId)/authorize",
            body: [:]
        )
        return opened.url
    }

    func connectorRefresh(botId: String, messageId: String) async throws {
        try await write("POST", "/api/bots/\(botId)/connector-cards/\(messageId)/refresh", [:])
    }

    func secretSave(botId: String, messageId: String, value: String) async throws {
        try await write("POST", "/api/bots/\(botId)/secret-cards/\(messageId)/save", ["value": value])
    }

    func secretDismiss(botId: String, messageId: String) async throws {
        try await write("POST", "/api/bots/\(botId)/secret-cards/\(messageId)/dismiss", [:])
    }

    struct RelayJoin: Decodable {
        let url: String
        let clientToken: String
        let deviceId: String?
    }

    /// The Mac's relay credentials, for a phone that is already paired.
    func relayJoin() async throws -> RelayJoin {
        try await get("/api/relay/join")
    }

    /// Hands this phone's APNs token to the relay, which is the only
    /// party that can buzz it. No relay, no push; the call is a no-op
    /// without credentials.
    func registerPush(apnsToken: String) async {
        guard
            let relayUrl = connection.relayUrl,
            let clientToken = connection.relayClientToken,
            let url = URL(string: relayUrl + "/space/client/apns")
        else { return }
        // A dev-signed build mints sandbox tokens, a TestFlight or App
        // Store build production ones; the relay serves whichever host the
        // token names, so it has to be told which. #if DEBUG is the honest
        // proxy for the signing environment.
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(clientToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": apnsToken, "env": env])
        _ = try? await session.data(for: request)
    }

    // MARK: Events

    func events() -> AsyncThrowingStream<ServerEvent, Error> {
        // read the connection live, so a relay adopted mid-session is seen
        EventStream(connectionProvider: { [weak self] in self?.connection ?? .simulator }).stream()
    }

    // MARK: Plumbing

    private struct BotsResponse: Codable { let bots: [Bot] }
    private struct RoomsResponse: Codable { let bloks: [Room] }

    func markUnread(botId: String) async throws {
        try await write("PATCH", "/api/bots/\(botId)", ["unread": true])
    }

    func setEffort(botId: String, effort: String?) async throws {
        // NSNull survives JSONSerialization as a JSON null, which is how
        // "back to the engine's default" is spelled on the wire.
        try await write("PATCH", "/api/bots/\(botId)", ["effort": effort ?? NSNull()])
    }

    func setLeadOnly(roomId: String, on: Bool) async throws {
        try await write("PATCH", "/api/bloks/\(roomId)", ["leadOnly": on])
    }

    func webhooks(botId: String) async throws -> [Webhook] {
        struct Reply: Decodable { let webhooks: [Webhook] }
        let reply: Reply = try await get("/api/webhooks?botId=\(botId)")
        return reply.webhooks
    }

    func createWebhook(botId: String, name: String) async throws -> Webhook {
        struct Reply: Decodable { let webhook: Webhook }
        let data = try await data("POST", "/api/webhooks", body: ["name": name, "botId": botId])
        return try JSONDecoder().decode(Reply.self, from: data).webhook
    }

    func deleteWebhook(id: String) async throws {
        try await write("DELETE", "/api/webhooks/\(id)", [:])
    }

    func avatar(botId: String) async throws -> Data {
        try await data("GET", "/api/bots/\(botId)/avatar", body: nil)
    }

    private struct BotEnvelope: Decodable { let bot: Bot }

    func createTask(botId: String) async throws -> Bot {
        let raw = try await data("POST", "/api/bots/\(botId)/tasks", body: [:])
        return try JSONDecoder().decode(BotEnvelope.self, from: raw).bot
    }

    func activateTask(botId: String, taskId: String) async throws -> Bot {
        let raw = try await data("POST", "/api/bots/\(botId)/tasks/\(taskId)/activate", body: [:])
        return try JSONDecoder().decode(BotEnvelope.self, from: raw).bot
    }

    func speak(botId: String, text: String) async throws -> Data {
        try await data("POST", "/api/bots/\(botId)/speak", body: ["text": text])
    }

    private struct CallLease: Decodable { let token: String }

    func claimCall(targetId: String) async throws -> String {
        let raw = try await data(
            "POST", "/api/calls/claim",
            body: ["targetId": targetId, "device": "this iPhone"]
        )
        return try JSONDecoder().decode(CallLease.self, from: raw).token
    }

    func renewCall(token: String) async throws {
        try await write("POST", "/api/calls/renew", ["token": token])
    }

    func releaseCall(token: String) async throws {
        try await write("DELETE", "/api/calls", ["token": token])
    }

    func artifact(botId: String, name: String) async throws -> Data {
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        return try await data("GET", "/api/bots/\(botId)/artifacts/\(encoded)", body: nil)
    }

    func uploadAvatar(botId: String, jpeg: Data) async throws {
        try await write("PUT", "/api/bots/\(botId)/avatar", [
            "data": jpeg.base64EncodedString(),
            "mime": "image/jpeg",
        ])
    }

    func removeAvatar(botId: String) async throws {
        try await write("DELETE", "/api/bots/\(botId)/avatar", [:])
    }

    func teamManifest(roomId: String) async throws -> Data {
        try await data("GET", "/api/bloks/\(roomId)/manifest", body: nil)
    }

    private func urlRequest(_ method: String, _ path: String) -> URLRequest {
        // Built by string, NOT appendingPathComponent: that treats the whole
        // argument as one path component and percent-encodes the "?", so
        // "/api/usage?days=30" becomes "/api/usage%3Fdays=30" and 404s.
        let url = URL(string: connection.baseURL.absoluteString + path) ?? connection.baseURL
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Only ever set off-machine. On loopback the guard wants no
        // credential at all, and sending one is harmless but pointless.
        if let token = connection.token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await request("GET", path, body: nil)
    }

    /// A write whose body we do not care about. The harness answers 202 or
    /// 201 with a shape that is only ever confirmation.
    private func write(_ method: String, _ path: String, _ body: [String: Any]) async throws {
        _ = try await data(method, path, body: body.isEmpty ? nil : body)
    }

    private func request<T: Decodable>(
        _ method: String,
        _ path: String,
        body: [String: Any]? = nil
    ) async throws -> T {
        let payload = try await data(method, path, body: body)
        do {
            return try JSONDecoder().decode(T.self, from: payload)
        } catch {
            throw BloksError.decoding(String(describing: error))
        }
    }

    @discardableResult
    private func data(_ method: String, _ path: String, body: [String: Any]?) async throws -> Data {
        var request = urlRequest(method, path)
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let payload: Data
        let response: URLResponse
        do {
            (payload, response) = try await session.data(for: request)
        } catch {
            // The LAN could not carry the request at all. If the relay is
            // set up, the same request goes out again, sealed; an HTTP
            // error from the Mac is never retried this way, only a
            // transport that could not reach it.
            if connection.relayReady {
                return try await relayData(method, path, body: body)
            }
            throw BloksError.unreachable((error as NSError).localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BloksError.unreachable("No response.")
        }

        guard (200..<300).contains(http.statusCode) else {
            // The harness writes its error strings for a reader, so prefer
            // its words over anything invented here.
            let message = (try? JSONSerialization.jsonObject(with: payload) as? [String: Any])?
                .flatMap { $0["error"] as? String }
            switch http.statusCode {
            case 401: throw BloksError.notPaired
            case 413: throw BloksError.messageTooLong
            default:
                throw BloksError.server(
                    status: http.statusCode,
                    message: message ?? "Bloks returned HTTP \(http.statusCode)."
                )
            }
        }
        return payload
    }
}

// MARK: - The relay path

extension HTTPClient {
    /// One request through the relay: sealed on this phone, opened on the
    /// Mac, answered the same way back. The relay carries ciphertext and
    /// the Mac applies every check a LAN device gets; this is a road, not
    /// a side door.
    fileprivate func relayData(_ method: String, _ path: String, body: [String: Any]?) async throws -> Data {
        guard
            let relayUrl = connection.relayUrl,
            let clientToken = connection.relayClientToken,
            let deviceId = connection.deviceId,
            let token = connection.token,
            let url = URL(string: relayUrl + "/space/client/ask")
        else { throw BloksError.unreachable("No relay is set up.") }

        var ask: [String: Any] = ["method": method, "path": path]
        if let body { ask["body"] = body }
        // mutating requests carry freshness proof so a hostile relay
        // cannot re-run a captured approve or send; GETs need none
        if method != "GET", method != "HEAD" {
            ask["ts"] = Int(Date().timeIntervalSince1970 * 1000)
            ask["nonce"] = UUID().uuidString
        }
        let sealed = try RelayCrypto.seal(
            key: RelayCrypto.key(token: token, direction: .phoneToMac),
            deviceId: deviceId,
            value: ask
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(clientToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["payload": sealed])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BloksError.unreachable((error as NSError).localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw BloksError.unreachable("No response from the relay.")
        }
        guard (200..<300).contains(http.statusCode) else {
            // 503 and 504 are the relay's own words about the Mac being
            // asleep or slow; pass them through for the person to read.
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { $0["error"] as? String }
            if http.statusCode == 401 { throw BloksError.notPaired }
            throw BloksError.server(
                status: http.statusCode,
                message: message ?? "The relay returned HTTP \(http.statusCode)."
            )
        }

        guard
            let outer = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let outerStatus = outer["status"] as? Int
        else { throw BloksError.decoding("relay answer") }
        let sealedReply = outer["payload"] as? String ?? ""
        if sealedReply.isEmpty {
            // the Mac refused before sealing anything: a revoked device
            if outerStatus == 401 { throw BloksError.notPaired }
            throw BloksError.server(status: outerStatus, message: "Bloks returned HTTP \(outerStatus).")
        }

        guard
            let plain = RelayCrypto.open(
                key: RelayCrypto.key(token: token, direction: .macToPhone),
                payload: sealedReply
            ),
            let reply = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
            let status = reply["status"] as? Int
        else { throw BloksError.decoding("The relay answer could not be opened.") }

        let bodyData: Data
        if let value = reply["body"], !(value is NSNull) {
            bodyData = (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data()
        } else {
            bodyData = Data()
        }
        guard (200..<300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
                .flatMap { $0["error"] as? String }
            switch status {
            case 401: throw BloksError.notPaired
            case 413: throw BloksError.messageTooLong
            default:
                throw BloksError.server(status: status, message: message ?? "Bloks returned HTTP \(status).")
            }
        }
        return bodyData
    }
}
