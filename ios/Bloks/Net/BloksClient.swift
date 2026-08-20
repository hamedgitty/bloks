// The seam.
//
// One implementation today (HTTPClient, talking to a harness on loopback or
// over the LAN). This protocol exists so a future Bloks Cloud slots in
// without the views knowing, and for nothing else. Do not add a second
// implementation for a cloud that does not exist yet.
import Foundation

/// Where the harness is, and what proves we are allowed to talk to it.
///
/// The token is only ever needed off-machine. On the Simulator the request
/// comes from the Mac's own loopback and `isLocalRequest()` in
/// server/http-guard.ts waves it through, which is why phases 1 to 7 need
/// no pairing at all.
struct BloksConnection: Equatable, Codable {
    var host: String
    var port: Int
    /// Bearer token from pairing. Absent on loopback.
    var token: String?
    /// The road home when the local network cannot reach the Mac. All
    /// three arrive together from /api/relay/join after pairing; old
    /// saved connections decode them as nil and stay LAN-only.
    var relayUrl: String?
    var relayClientToken: String?
    var deviceId: String?

    static let simulator = BloksConnection(host: "127.0.0.1", port: 8799, token: nil)

    var baseURL: URL {
        // http, not https: the harness is a local server with no
        // certificate to present. Info.plist carries the matching
        // NSAllowsLocalNetworking exemption.
        URL(string: "http://\(host):\(port)")!
    }

    var isLoopback: Bool {
        host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    /// Whether this connection can fall back to the relay at all.
    var relayReady: Bool {
        relayUrl != nil && relayClientToken != nil && deviceId != nil
            && token != nil && !isLoopback
    }
}

enum RespondBehavior: String {
    case allow
    case deny
    case answer
}

/// What went wrong, in words a person could act on. The harness returns
/// `{error}` bodies, and those are usually already written for a reader,
/// so they are passed through rather than replaced.
enum BloksError: LocalizedError, Equatable {
    case notPaired
    case messageTooLong
    case server(status: Int, message: String)
    case unreachable(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .notPaired:
            return "This device is not paired with your Mac yet."
        case .messageTooLong:
            return "That message is too long to send in one go."
        case .server(_, let message):
            return message
        case .unreachable(let detail):
            return "Could not reach Bloks on your Mac. \(detail)"
        case .decoding(let detail):
            return "Bloks sent something this version does not understand. \(detail)"
        }
    }
}

struct Health: Codable {
    let app: String
    let pid: Int
}

protocol BloksClient: AnyObject {
    var connection: BloksConnection { get set }

    // Reads
    func health() async throws -> Health
    /// Raw bytes of a deliverable the agent saved.
    func artifact(botId: String, name: String) async throws -> Data
    /// The agent's voice saying `text`, as mp3 bytes from the harness.
    func speak(botId: String, text: String) async throws -> Data
    /// One call at a time, workspace-wide: claim the line, keep it
    /// renewed while talking, release it on hang-up.
    func claimCall(targetId: String) async throws -> String
    func renewCall(token: String) async throws
    func releaseCall(token: String) async throws
    /// A new work lane on the agent; the answer wears its empty transcript.
    func createTask(botId: String) async throws -> Bot
    /// Switch lanes; the answer wears that lane's transcript.
    func activateTask(botId: String, taskId: String) async throws -> Bot
    func bots() async throws -> [Bot]
    /// What every agent is doing right now. Mirrors GET /api/activity.
    func activity() async throws -> Activity
    func rooms() async throws -> [Room]

    // Writes
    func send(botId: String, text: String, replyTo: ReplyRef?) async throws
    func send(roomId: String, text: String, replyTo: ReplyRef?) async throws
    func respond(botId: String, requestId: String, behavior: RespondBehavior, message: String?) async throws
    /// Answer the card a workflow run is parked on. Its own route because
    /// it resumes a run rather than saying anything to an agent.
    func answerGate(runId: String, answer: String) async throws
    func editAgent(
        botId: String,
        name: String?,
        title: String?,
        color: String?,
        shape: String?,
        expression: String?
    ) async throws
    func secretSave(botId: String, messageId: String, value: String) async throws
    func secretDismiss(botId: String, messageId: String) async throws
    func connectorAuthorize(botId: String, messageId: String) async throws -> String
    func connectorRefresh(botId: String, messageId: String) async throws
    func patchCard(botId: String, messageId: String, answered: String?, dismissed: Bool?) async throws
    /// Stop a turn. The lane matters: a background lane is not the one
    /// on screen, and the activity screen stops rows in either.
    func interrupt(botId: String, taskId: String?) async throws
    /// Give a computer back to the agent whose it is.
    func handBackWheel(botId: String) async throws
    func markRead(botId: String) async throws
    func setPinned(botId: String, pinned: Bool) async throws
    func markUnread(botId: String) async throws
    func setEffort(botId: String, effort: String?) async throws
    func setLeadOnly(roomId: String, on: Bool) async throws

    // Webhooks and team manifests
    func webhooks(botId: String) async throws -> [Webhook]
    func createWebhook(botId: String, name: String) async throws -> Webhook
    func deleteWebhook(id: String) async throws
    func teamManifest(roomId: String) async throws -> Data

    // The agent's uploaded photo
    func avatar(botId: String) async throws -> Data
    func uploadAvatar(botId: String, jpeg: Data) async throws
    func removeAvatar(botId: String) async throws

    // Engines and usage
    func instances() async throws -> [ProviderInstance]
    func usage(days: Int) async throws -> UsageSummary
    func setModel(botId: String, instanceId: String, model: String) async throws

    // Rooms
    func createRoom(name: String, memberIds: [String]) async throws -> Room

    // Routines
    func routines() async throws -> [Routine]
    func createRoutine(targetId: String, targetKind: String, prompt: String, time: String, days: [Int]) async throws -> Routine
    func patchRoutine(id: String, prompt: String?, time: String?, days: [Int]?, enabled: Bool?) async throws
    func deleteRoutine(id: String) async throws
    func runRoutine(id: String) async throws

    // Pairing
    func claimPairing(code: String, deviceName: String) async throws -> String

    /// The event stream. One per connection; the store owns it.
    func events() -> AsyncThrowingStream<ServerEvent, Error>
}

extension BloksClient {
    /// The lane the caller is already looking at. A protocol requirement
    /// cannot carry a default argument, so this keeps every existing call
    /// site compiling while the activity screen names a lane explicitly.
    func interrupt(botId: String) async throws {
        try await interrupt(botId: botId, taskId: nil)
    }
}
