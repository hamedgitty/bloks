// A call with an agent, phone edition. Beta.
//
// The same loop the desktop runs: listen → think → speak. Words are
// recognized on-device by the existing Dictation engine; an utterance
// ends when the transcript sits still for a beat (Apple's recognizer
// keeps re-emitting partials, so stillness IS the endpoint). The turn
// goes out as an ordinary message; the settled reply comes back, the
// harness synthesizes it in the agent's own voice, and when the audio
// finishes the mic opens again. Barge in by tapping the mic while it
// speaks. The whole call lands in the chat as normal messages.
import AVFoundation
import SwiftUI

/// AVAudioPlayer needs a delegate object to say when audio finished;
/// this wraps one closure around that ceremony.
private final class PlayerBox: NSObject, AVAudioPlayerDelegate {
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

    func stop() {
        player?.stop()
        player = nil
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish?()
    }
}

struct CallView: View {
    let bot: Bot
    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case listening, thinking, speaking }
    @State private var phase: Phase = .listening
    @State private var dictation = Dictation()
    @State private var caption = ""
    @State private var errorLine: String?
    @State private var player = PlayerBox()
    @State private var baseline = 0
    @State private var lastTranscript = ""
    @State private var stillTicks = 0
    /// Guards stale async work after barge-in or hang-up.
    @State private var generation = 0
    /// The one-call-at-a-time lease; nil until claimed.
    @State private var leaseToken: String?
    @State private var renewTask: Task<Void, Never>?

    /// The transcript's stillness clock: four quiet ticks of 300ms with
    /// words on the board means the sentence is over.
    private let ticker = Timer.publish(every: 0.3, on: .main, in: .common).autoconnect()

    private var liveBot: Bot { store.bots.first(where: { $0.id == bot.id }) ?? bot }

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            VStack(spacing: 22) {
                Spacer()
                let tint = Color(hex: BlokArt.colorHex[BlokColor.named(liveBot.color)] ?? 0x4C86F5)
                ZStack {
                    if phase == .speaking {
                        SpeakingHalo(color: tint)
                            .frame(width: 160, height: 160)
                    }
                    BlokAvatar(
                        color: BlokColor(rawValue: liveBot.color) ?? .blue,
                        shape: BlokShape(rawValue: liveBot.shape ?? "star") ?? .star,
                        expression: phase == .thinking ? .thinking : phase == .speaking ? .excited : .friendly,
                        size: 140
                    )
                    .shadow(color: phase == .speaking ? tint.opacity(0.5) : .clear, radius: 18)
                }

                VStack(spacing: 6) {
                    Text(liveBot.name)
                        .font(.title2.weight(.semibold))
                    Text(errorLine ?? statusLine)
                        .font(.subheadline)
                        .foregroundStyle(errorLine == nil ? Color.secondary : Color.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 36)
                        .frame(minHeight: 40, alignment: .top)
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
        .onChange(of: liveBot.messages.count) { checkForReply() }
        .onChange(of: liveBot.busy ?? false) { checkForReply() }
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
            return dictation.transcript.isEmpty ? "Listening…" : dictation.transcript
        case .thinking:
            return "Thinking…"
        case .speaking:
            return caption
        }
    }

    /// The line is claimed before the mic ever opens: two devices on
    /// the same call double-speak every reply, so the second one is
    /// told where the first is instead of joining.
    private func claimAndListen() async {
        do {
            let token = try await store.client.claimCall(targetId: bot.id)
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
        lastTranscript = ""
        stillTicks = 0
        await dictation.start()
        if case .unavailable(let why) = dictation.state {
            errorLine = why
        }
    }

    /// Silence endpointing: words on the board, then stillness, means
    /// the sentence is done. An empty board waits forever.
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
        baseline = liveBot.messages.count
        phase = .thinking
        Task { await store.send(to: .agent(liveBot), text: said) }
    }

    /// The settled reply is the newest bot text after our send, once the
    /// agent has gone quiet.
    private func checkForReply() {
        guard phase == .thinking, !(liveBot.busy ?? false) else { return }
        let fresh = liveBot.messages.dropFirst(baseline)
        guard let reply = fresh.last(where: { $0.role == .bot && $0.kind == .text && !($0.text ?? "").isEmpty })
        else { return }
        phase = .speaking
        caption = String((reply.text ?? "").prefix(160))
        let gen = generation
        Task {
            do {
                let bytes = try await store.client.speak(botId: liveBot.id, text: reply.text ?? "")
                guard gen == generation else { return }
                player.onFinish = {
                    guard gen == generation else { return }
                    Task { await beginListening() }
                }
                try player.play(bytes)
            } catch {
                errorLine = "That reply couldn't be spoken. Check the voice key on your Mac."
                guard gen == generation else { return }
                await beginListening()
            }
        }
    }

    private func bargeIn() {
        generation += 1
        player.stop()
        Task { await beginListening() }
    }

    private func hangUp() {
        generation += 1
        dictation.stop()
        player.stop()
        dismiss()
    }
}
