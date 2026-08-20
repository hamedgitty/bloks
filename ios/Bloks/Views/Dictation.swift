// Dictation, owned by the app rather than borrowed from the keyboard.
//
// The keyboard's mic key already dictates into any text field for free, and
// for a long time that was the right answer here. It stops being the right
// answer the moment you want to show the user something while they talk:
// the app cannot see keyboard dictation happening, so there is nothing to
// animate. Owning the microphone is what buys the waveform.
//
// On-device when the device supports it, which is both faster and the
// honest match for a product whose whole pitch is that your words stay on
// your machine. `requiresOnDeviceRecognition` makes that a hard requirement
// rather than a preference, so it is only set when it can actually be met.
import AVFoundation
import Observation
import Speech
import SwiftUI

@Observable
@MainActor
final class Dictation {
    enum State: Equatable {
        case idle
        case listening
        /// Permission refused, or no recogniser for this locale.
        case unavailable(String)
    }

    private(set) var state: State = .idle
    /// What has been heard so far this session.
    private(set) var transcript = ""
    /// Smoothed microphone level, 0 to 1, for the waveform.
    private(set) var level: Double = 0

    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()

    var isListening: Bool { state == .listening }

    func toggle() async {
        if isListening {
            stop()
        } else {
            await start()
        }
    }

    func start() async {
        guard !isListening else { return }
        transcript = ""

        guard let recognizer, recognizer.isAvailable else {
            state = .unavailable("Dictation is not available for this language.")
            return
        }
        guard await requestPermissions() else {
            state = .unavailable("Bloks needs microphone and speech access. You can turn them on in Settings.")
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            // .measurement keeps the system from applying its own processing
            // to the signal, which is what makes the level meter twitchy.
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                request.requiresOnDeviceRecognition = true
            }
            self.request = request

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                request.append(buffer)
                let rms = Self.rms(of: buffer)
                Task { @MainActor in self?.absorb(level: rms) }
            }

            engine.prepare()
            try engine.start()
            state = .listening

            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result {
                        self.transcript = result.bestTranscription.formattedString
                    }
                    // A final result or an error both end the session. Not
                    // stopping here leaves the tap running and the level
                    // meter alive under a stopped recogniser.
                    if error != nil || result?.isFinal == true {
                        self.stop()
                    }
                }
            }
        } catch {
            state = .unavailable("The microphone could not be started.")
            stop()
        }
    }

    func stop() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        level = 0
        if case .unavailable = state {} else { state = .idle }
        // Hand the session back so audio from anything else resumes.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func clearError() {
        if case .unavailable = state { state = .idle }
    }

    // MARK: level

    /// Root mean square of a buffer, mapped to something a bar chart can
    /// use. Raw RMS spends most of its life near zero, so it goes through a
    /// log curve first or the waveform barely moves while you speak.
    private static func rms(of buffer: AVAudioPCMBuffer) -> Double {
        guard let channel = buffer.floatChannelData?[0] else { return 0 }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<count { sum += channel[i] * channel[i] }
        let mean = Double(sum) / Double(count)
        let power = 20 * log10(max(sqrt(mean), 1e-7))
        // -50 dB is a quiet room, -10 dB is talking at a phone.
        return min(max((power + 50) / 40, 0), 1)
    }

    /// Fast up, slow down. A meter that falls as fast as it rises reads as
    /// flicker; one that eases down reads as a voice.
    private func absorb(level next: Double) {
        level = next > level ? level + (next - level) * 0.55 : level + (next - level) * 0.16
    }

    private func requestPermissions() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }

        return await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
    }
}

/// The thing you watch while you talk.
///
/// Bars mirrored around the centre, tallest in the middle, each one lagging
/// its neighbour slightly so the shape travels outward instead of pumping
/// as a block. The idle state is a slow breath rather than a flat line, so
/// the control looks alive before you have said anything.
struct DictationWaveform: View {
    let level: Double
    var barCount: Int = 15
    var tint: Color = .accentColor

    @State private var phase: Double = 0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            Canvas { context, size in
                let now = timeline.date.timeIntervalSinceReferenceDate
                let spacing: CGFloat = 3
                let barWidth = max(2, (size.width - spacing * CGFloat(barCount - 1)) / CGFloat(barCount))
                let mid = Double(barCount - 1) / 2

                for index in 0..<barCount {
                    // Distance from the centre, 0 at the middle, 1 at the ends.
                    let offset = abs(Double(index) - mid) / mid
                    // Centre bars react most; the ends stay calmer.
                    let falloff = 1 - offset * 0.65
                    // A travelling wobble so neighbours are never identical.
                    let wobble = 0.5 + 0.5 * sin(now * 6 - Double(index) * 0.55)
                    // Idle breath keeps the control alive at rest.
                    let breath = 0.10 + 0.05 * sin(now * 1.8 - Double(index) * 0.3)

                    let amplitude = max(breath, level * falloff * (0.55 + 0.45 * wobble))
                    let height = max(barWidth, size.height * amplitude)
                    let x = CGFloat(index) * (barWidth + spacing)
                    let rect = CGRect(
                        x: x,
                        y: (size.height - height) / 2,
                        width: barWidth,
                        height: height
                    )
                    context.fill(
                        Path(roundedRect: rect, cornerRadius: barWidth / 2),
                        with: .color(tint.opacity(0.55 + 0.45 * amplitude))
                    )
                }
            }
        }
        .accessibilityHidden(true)
    }
}
