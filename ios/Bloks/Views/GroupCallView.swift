// A room on the line, phone edition. Beta.
//
// The desktop's group call, translated: the room's own turn engine
// decides who answers; a spoken leading name becomes the mention the
// engine understands ("Kat, take it" → "@Kat take it"); every fresh
// reply queues strictly one voice at a time, each synthesized in its
// own member's voice, and the mic reopens only when the queue drains
// and the room has gone quiet. Members without a voice still answer,
// their replies show as a caption instead of being spoken. One device
// on the line at a time, enforced by the same call lease as 1:1.
import AVFoundation
import SwiftUI

/// A spoken leading member name is the address; the room engine gets
/// the mention syntax it already understands. Longest name first, so a
/// name that prefixes another never steals the match.
func routeSpokenToRoom(_ text: String, memberNames: [String]) -> String {
    let said = text.trimmed
    var lead = said
    if let range = lead.range(of: "^(hey|hi|ok|okay)[,\\s]+", options: [.regularExpression, .caseInsensitive]) {
        lead.removeSubrange(range)
    }
    for name in memberNames.sorted(by: { $0.count > $1.count }) {
        let escaped = NSRegularExpression.escapedPattern(for: name)
        if let range = lead.range(
            of: "^\(escaped)[,.!?\\s]+",
            options: [.regularExpression, .caseInsensitive]
        ) {
            let rest = lead[range.upperBound...].trimmingCharacters(in: .whitespaces)
            return "@\(name) \(rest)".trimmed
        }
    }
    return said
}

/// The tell that someone is talking: rings of their own color breathe
/// outward from the avatar for as long as the voice plays.
struct SpeakingHalo: View {
    let color: Color
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(pulse ? 0 : 0.55), lineWidth: 3)
                .scaleEffect(pulse ? 1.5 : 1.0)
            Circle()
                .stroke(color.opacity(pulse ? 0 : 0.35), lineWidth: 2)
                .scaleEffect(pulse ? 1.28 : 0.95)
        }
        .animation(.easeOut(duration: 1.1).repeatForever(autoreverses: false), value: pulse)
        .onAppear { pulse = true }
    }
}

private final class GroupPlayerBox: NSObject, AVAudioPlayerDelegate {
    var player: AVAudioPlayer?
    var onFinish: (() -> Void)?

    func play(_ data: Data) throws {
        try AVAudioSession.sharedInstance().setCategory(.playback)
        try AVAudioSession.sharedInstance().setActive(true)
        let p = try AVAudioPlayer(data: data)
        p.delegate = self
        player = p
        p.play()
    }

    /// Stopping counts as finishing: a continuation awaiting playback
    /// must resume exactly once, whether the audio ended or was cut.
    func stop() {
        player?.stop()
        player = nil
        finish()
    }

    private func finish() {
        let cb = onFinish
        onFinish = nil
        cb?()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        finish()
    }
}

struct GroupCallView: View {
    let room: Room
    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case listening, thinking, speaking }
    @State private var phase: Phase = .listening
    @State private var dictation = Dictation()
    @State private var caption = ""
    @State private var errorLine: String?
    @State private var player = GroupPlayerBox()
    @State private var speakingId: String?
    @State private var baseline = 0
    @State private var spokenIds = Set<String>()
    @State private var speechQueue: [(memberId: String?, text: String)] = []
    @State private var draining = false
    @State private var lastTranscript = ""
    @State private var stillTicks = 0
    @State private var generation = 0
    @State private var leaseToken: String?
    @State private var renewTask: Task<Void, Never>?

    private let ticker = Timer.publish(every: 0.3, on: .main, in: .common).autoconnect()

    private var liveRoom: Room { store.rooms.first(where: { $0.id == room.id }) ?? room }
    private var members: [Bot] {
        store.bots.filter { liveRoom.memberIds.contains($0.id) }
    }
    private var anyBusy: Bool { members.contains { $0.busy ?? false } }

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            VStack(spacing: 22) {
                Spacer()
                HStack(alignment: .bottom, spacing: 14) {
                    ForEach(members) { member in
                        let focused = speakingId == member.id
                            || (speakingId == nil && (member.busy ?? false))
                        let tint = Color(hex: BlokArt.colorHex[BlokColor.named(member.color)] ?? 0x4C86F5)
                        VStack(spacing: 5) {
                            ZStack {
                                if speakingId == member.id {
                                    SpeakingHalo(color: tint)
                                        .frame(width: 72, height: 72)
                                }
                                BlokAvatar(
                                    color: BlokColor(rawValue: member.color) ?? .blue,
                                    shape: BlokShape(rawValue: member.shape ?? "star") ?? .star,
                                    expression: speakingId == member.id
                                        ? .excited
                                        : (member.busy ?? false) ? .thinking : .friendly,
                                    size: focused ? 72 : 54
                                )
                                .shadow(
                                    color: speakingId == member.id ? tint.opacity(0.5) : .clear,
                                    radius: 14
                                )
                            }
                            Text(member.name)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .opacity(focused || speakingId == nil ? 1 : 0.6)
                        .animation(.spring(duration: 0.3), value: focused)
                    }
                }
                .padding(.horizontal, 20)

                VStack(spacing: 6) {
                    Text(liveRoom.name)
                        .font(.title2.weight(.semibold))
                    Text(errorLine ?? statusLine)
                        .font(.subheadline)
                        .foregroundStyle(errorLine == nil ? Color.secondary : Color.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .frame(minHeight: 44, alignment: .top)
                }
                Spacer()

                HStack(spacing: 26) {
                    if phase == .speaking {
                        Button {
                            bargeIn()
                        } label: {
                            Image(systemName: "mic.fill")
                                .font(.system(size: 22))
                                .foregroundStyle(Color.primary)
                                .frame(width: 62, height: 62)
                                .background(Color(.secondarySystemBackground), in: Circle())
                        }
                        .accessibilityLabel("Interrupt and talk")
                    }
                    Button {
                        hangUp()
                    } label: {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 24))
                            .foregroundStyle(.white)
                            .frame(width: 66, height: 66)
                            .background(Color.red, in: Circle())
                    }
                    .accessibilityLabel("End call")
                }
                Spacer().frame(height: 18)
            }

            VStack {
                HStack {
                    Spacer()
                    Text("BETA")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.orange.opacity(0.12), in: Capsule())
                        .overlay(Capsule().stroke(Color.orange.opacity(0.4)))
                }
                Spacer()
            }
            .padding()
        }
        .task { await claimAndListen() }
        .onReceive(ticker) { _ in tickEndpoint() }
        .onChange(of: liveRoom.messages.count) { collectReplies() }
        .onChange(of: anyBusy) { maybeReopenMic() }
        .onDisappear {
            dictation.stop()
            player.stop()
            renewTask?.cancel()
            if let token = leaseToken {
                let client = store.client
                Task { try? await client.releaseCall(token: token) }
            }
        }
    }

    private var statusLine: String {
        switch phase {
        case .listening:
            return dictation.transcript.isEmpty
                ? "Listening. Say a name or just talk."
                : dictation.transcript
        case .thinking:
            return "The room is thinking…"
        case .speaking:
            return caption
        }
    }

    private func claimAndListen() async {
        // the backlog is never recited: a call starts in the present
        spokenIds = Set(liveRoom.messages.map(\.id))
        do {
            let token = try await store.client.claimCall(targetId: room.id)
            leaseToken = token
            renewTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(6))
                    try? await store.client.renewCall(token: token)
                }
            }
            await beginListening()
        } catch {
            if case BloksError.server(_, let message) = error {
                errorLine = message
            } else {
                errorLine = "Already on a call on another device. Hang up there first."
            }
        }
    }

    private func beginListening() async {
        phase = .listening
        speakingId = nil
        lastTranscript = ""
        stillTicks = 0
        await dictation.start()
        if case .unavailable(let why) = dictation.state {
            errorLine = why
        }
    }

    private func tickEndpoint() {
        guard phase == .listening else { return }
        let now = dictation.transcript
        if now.isEmpty { stillTicks = 0; return }
        if now == lastTranscript {
            stillTicks += 1
            if stillTicks >= 4 { finishUtterance(now) }
        } else {
            lastTranscript = now
            stillTicks = 0
        }
    }

    private func finishUtterance(_ text: String) {
        dictation.stop()
        let said = text.trimmed
        guard !said.isEmpty else {
            Task { await beginListening() }
            return
        }
        baseline = liveRoom.messages.count
        phase = .thinking
        let routed = routeSpokenToRoom(said, memberNames: members.map(\.name))
        Task { await store.send(to: .room(liveRoom), text: routed) }
    }

    /// Fresh settled replies join the speech queue in arrival order.
    private func collectReplies() {
        let fresh = liveRoom.messages.dropFirst(baseline).filter {
            $0.role == .bot && $0.kind == .text && !($0.text ?? "").isEmpty && !spokenIds.contains($0.id)
        }
        guard !fresh.isEmpty else { return }
        for message in fresh {
            spokenIds.insert(message.id)
            speechQueue.append((memberId: message.from, text: message.text ?? ""))
        }
        drainQueue()
    }

    /// One voice at a time: speak the head of the queue, then recurse.
    private func drainQueue() {
        guard !draining, let item = speechQueue.first else { return }
        // a member may speak unprompted (a routine landing mid-call);
        // the mic must not record the reply being played back
        if phase == .listening { dictation.stop() }
        draining = true
        speechQueue.removeFirst()
        let member = members.first(where: { $0.id == item.memberId })
        phase = .speaking
        speakingId = member?.id
        caption = "\(member?.name ?? "Agent"): \(String(item.text.prefix(140)))"
        let gen = generation
        Task {
            defer {
                draining = false
                if gen == generation {
                    if speechQueue.isEmpty {
                        maybeReopenMic()
                    } else {
                        drainQueue()
                    }
                }
            }
            guard let member, member.voice != nil else {
                // voiceless members hold the floor long enough to be read
                let ms = min(4000, 1200 + item.text.count * 25)
                try? await Task.sleep(for: .milliseconds(ms))
                return
            }
            do {
                let bytes = try await store.client.speak(botId: member.id, text: item.text)
                guard gen == generation else { return }
                await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                    player.onFinish = { cont.resume() }
                    do {
                        try player.play(bytes)
                    } catch {
                        player.onFinish = nil
                        cont.resume()
                    }
                }
            } catch {
                // one member's voice failing must not stall the call
            }
        }
    }

    /// The floor returns to the human when the queue is empty and the
    /// room has gone quiet.
    private func maybeReopenMic() {
        guard phase != .listening, speechQueue.isEmpty, !draining, !anyBusy else { return }
        Task { await beginListening() }
    }

    private func bargeIn() {
        generation += 1
        speechQueue.removeAll()
        draining = false
        player.stop()
        for member in members where member.busy ?? false {
            Task { await store.interrupt(bot: member) }
        }
        Task { await beginListening() }
    }

    private func hangUp() {
        generation += 1
        dictation.stop()
        player.stop()
        dismiss()
    }
}
