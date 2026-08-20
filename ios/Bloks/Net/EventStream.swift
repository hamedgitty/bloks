// The one event stream, folded exactly like the web client folds it.
//
// GET /api/events is text/event-stream: `data: {json}\n\n` frames with a
// `: keepalive` comment every 25 seconds. There is no SSE client in the
// SDK, and it does not need one: URLSession.bytes gives us lines, and the
// framing is two rules deep.
//
// Two things that will cost an hour each if changed:
//
//   The request timeout is raised to effectively never. A healthy SSE
//   connection sends nothing between keepalives, and URLSession's default
//   60s idle timeout reads that as a dead socket and kills it.
//
//   Every reconnect emits .hello again, and the store re-hydrates on it.
//   The web client does the same thing in es.onopen for the same reason
//   (src/state/store.tsx): anything that happened while the socket was
//   down was never delivered, so the transcript on screen is a lie until
//   it is refetched.
import Foundation

/// One frame off the wire. The cases the client acts on are spelled out;
/// everything else the harness broadcasts becomes `.refresh` so a newer
/// server cannot break an older phone.
enum ServerEvent {
    case hello(resumed: Bool)
    case disconnected(String)
    case message(threadId: String, message: Message)
    case messagePatched(threadId: String, message: Message)
    case bot(BotPatch)
    case botDeleted(String)
    case room(Room)
    case roomDeleted(String)
    /// Token-level assistant text, folded into a per-thread buffer.
    case streamDelta(threadId: String, delta: String)
    /// The turn settled, so the buffer is replaced by a real message.
    case streamEnded(threadId: String)
    case screen(botId: String, png: String, mime: String)
    /// This device was unpaired on the Mac. Terminal: the loop stops
    /// rather than polling a door that will not open until re-pairing.
    case pairingRejected
    /// providers, config, skills, computer, pairing: refetch the matching
    /// endpoint rather than trying to patch state from the frame.
    case refresh(String)
}

final class EventStream {
    /// Read fresh on every attempt, not captured once: the store adopts
    /// relay credentials mid-session without tearing the stream down, and
    /// a stale copy would never learn the relay road exists.
    private let connectionProvider: () -> BloksConnection
    private var connection: BloksConnection { connectionProvider() }
    /// The last sequence number seen, carried into the next connect as
    /// ?since= so the server can replay just the gap. See server/index.ts.
    private var lastSeq = 0
    /// Whether the next attempt should take the relay road instead of the
    /// LAN. Flips on failure whenever the relay is available, so the
    /// stream oscillates between the two until one works.
    private var viaRelay = false

    init(connectionProvider: @escaping () -> BloksConnection) {
        self.connectionProvider = connectionProvider
    }

    func stream() -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { [self] in
                var backoff: UInt64 = 1
                // Reset the clock once a connection proves itself with a
                // hello, so an accept-then-drop relay cannot pin the
                // backoff and a healthy reconnect starts fast again.
                let resetBackoff = { backoff = 1 }
                while !Task.isCancelled {
                    do {
                        if self.viaRelay && self.connection.relayReady {
                            try await self.consumeRelay(into: continuation, onHello: resetBackoff)
                        } else {
                            try await self.consume(into: continuation, onHello: resetBackoff)
                        }
                        // A clean end is still a drop: the harness holds
                        // this open forever when it is healthy.
                        continuation.yield(.disconnected("The stream closed."))
                    } catch is CancellationError {
                        break
                    } catch BloksError.notPaired {
                        // The Mac revoked this device. Say so once and stop;
                        // re-pairing rebuilds the client and the stream.
                        continuation.yield(.pairingRejected)
                        break
                    } catch {
                        continuation.yield(.disconnected((error as NSError).localizedDescription))
                    }
                    if Task.isCancelled { break }
                    // try the other road next time, when there is one
                    if self.connection.relayReady { self.viaRelay.toggle() }
                    try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                    // Back off to 16s and stay there. A phone that wakes up
                    // on the wrong network should not hammer the Mac.
                    backoff = min(backoff * 2, 16)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func consume(
        into continuation: AsyncThrowingStream<ServerEvent, Error>.Continuation,
        onHello: @escaping () -> Void = {}
    ) async throws {
        var components = URLComponents(
            url: connection.baseURL.appendingPathComponent("/api/events"),
            resolvingAgainstBaseURL: false
        )!
        if lastSeq > 0 {
            components.queryItems = [URLQueryItem(name: "since", value: String(lastSeq))]
        }
        var request = URLRequest(url: components.url!)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let token = connection.token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let config = URLSessionConfiguration.ephemeral
        // Effectively no idle timeout. See the header.
        config.timeoutIntervalForRequest = TimeInterval(Int32.max)
        config.timeoutIntervalForResource = TimeInterval(Int32.max)
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BloksError.unreachable("No response from the event stream.")
        }
        guard http.statusCode == 200 else {
            if http.statusCode == 401 { throw BloksError.notPaired }
            throw BloksError.server(status: http.statusCode, message: "Event stream refused.")
        }

        for try await line in bytes.lines {
            if Task.isCancelled { return }
            // `: keepalive` and blank separators carry no payload.
            guard line.hasPrefix("data:") else { continue }
            let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let data = json.data(using: .utf8) else { continue }
            for event in decode(data) {
                if case .hello = event { onHello() }
                continuation.yield(event)
            }
        }
    }


    /// The same stream, through the relay: sealed frames on a shared
    /// space. Events opened here are exactly the broadcasts the LAN
    /// stream carries; anything not addressed to this device drops
    /// silently. There is no ?since= replay on this road, but every
    /// connect emits .hello and the store re-hydrates on it, which
    /// covers the gap the same way.
    private func consumeRelay(
        into continuation: AsyncThrowingStream<ServerEvent, Error>.Continuation,
        onHello: @escaping () -> Void = {}
    ) async throws {
        // Relayed frames carry no sequence number, so the ?since= cursor
        // would go stale on this road and replay already-applied frames
        // (doubling in-flight assistant text) once back on the LAN. Drop
        // the cursor; the hello-driven rehydrate covers the gap instead.
        lastSeq = 0
        guard
            let relayUrl = connection.relayUrl,
            let clientToken = connection.relayClientToken,
            let deviceId = connection.deviceId,
            let token = connection.token,
            let url = URL(string: relayUrl + "/space/client/stream")
        else { throw BloksError.unreachable("No relay is set up.") }

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(clientToken)", forHTTPHeaderField: "Authorization")

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = TimeInterval(Int32.max)
        config.timeoutIntervalForResource = TimeInterval(Int32.max)
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BloksError.unreachable("No response from the relay stream.")
        }
        guard http.statusCode == 200 else {
            if http.statusCode == 401 { throw BloksError.notPaired }
            throw BloksError.server(status: http.statusCode, message: "Relay stream refused.")
        }

        let openKey = RelayCrypto.key(token: token, direction: .macToPhone)
        for try await line in bytes.lines {
            if Task.isCancelled { return }
            guard line.hasPrefix("data:") else { continue }
            let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let data = json.data(using: .utf8),
                  let outer = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            if outer["kind"] as? String == "hello" {
                onHello()
                continuation.yield(.hello(resumed: false))
                continue
            }
            guard
                outer["kind"] as? String == "frame",
                let payload = outer["payload"] as? String,
                RelayCrypto.peekDevice(payload) == deviceId,
                let plain = RelayCrypto.open(key: openKey, payload: payload)
            else { continue }
            for event in decode(plain) { continuation.yield(event) }
        }
    }

    /// One frame can produce zero or one events. Returning an array keeps
    /// the "a frame we do not know is not an error" rule in one place.
    private func decode(_ data: Data) -> [ServerEvent] {
        struct Frame: Decodable {
            let kind: String
            let threadId: String?
            let message: Message?
            let bot: BotPatch?
            let botId: String?
            let blok: Room?
            let blokId: String?
            let png: String?
            let mime: String?
            let event: RuntimeEvent?
            let _seq: Int?
            let resumed: Bool?
        }
        struct RuntimeEvent: Decodable {
            let type: String
            let threadId: String
            let streamKind: String?
            let delta: String?
        }

        guard let frame = try? JSONDecoder().decode(Frame.self, from: data) else { return [] }
        if let seq = frame._seq { lastSeq = seq }

        switch frame.kind {
        case "hello":
            return [.hello(resumed: frame.resumed ?? false)]

        case "message":
            guard let threadId = frame.threadId, let message = frame.message else { return [] }
            return [.message(threadId: threadId, message: message)]

        case "message.patch":
            guard let threadId = frame.threadId, let message = frame.message else { return [] }
            return [.messagePatched(threadId: threadId, message: message)]

        case "bot":
            guard let bot = frame.bot else { return [] }
            return [.bot(bot)]

        case "bot.deleted":
            guard let botId = frame.botId else { return [] }
            return [.botDeleted(botId)]

        case "blok":
            guard let blok = frame.blok else { return [] }
            return [.room(blok)]

        case "blok.deleted":
            guard let blokId = frame.blokId else { return [] }
            return [.roomDeleted(blokId)]

        case "screen":
            guard let botId = frame.botId, let png = frame.png else { return [] }
            return [.screen(botId: botId, png: png, mime: frame.mime ?? "image/png")]

        case "runtime":
            guard let event = frame.event else { return [] }
            // Only assistant text is streamed to the bubble. Reasoning
            // deltas are deliberately not shown: the desktop does not show
            // them either, and a half-thought on a phone screen is noise.
            if event.type == "content.delta",
               event.streamKind == "assistant_text",
               let delta = event.delta {
                return [.streamDelta(threadId: event.threadId, delta: delta)]
            }
            if event.type == "turn.completed" {
                return [.streamEnded(threadId: event.threadId)]
            }
            return []

        default:
            // providers, config, skills, computer, pairing, and anything a
            // newer harness invents.
            return [.refresh(frame.kind)]
        }
    }
}
