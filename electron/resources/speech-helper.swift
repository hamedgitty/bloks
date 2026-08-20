// Dictation, done natively.
//
// The browser speech APIs need a network round trip; this helper uses the
// macOS recognizer, on device when the machine supports it. It exists as
// a separate binary spawned from the Electron MAIN process for one
// reason: the microphone and speech permission prompts attribute to
// whichever app owns the process, and that has to say Bloks.
//
// The contract with electron/speech.mjs, one JSON object per line:
//
//   {"partial":true,"text":"…"}   recognition in progress
//   {"partial":false,"text":"…"}  the finished transcript; exits 0
//   {"level":0.0-1.0}             loudness right now, for the meter
//   {"error":"…"}                 something failed; exits 1
//
// The process lives until the final result arrives or it is told to stop.
import AVFoundation
import Foundation
import Speech

func writeLine(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
  // stdout to a pipe is block buffered; a partial that sits in the buffer
  // is a transcript the user cannot see growing
  fflush(stdout)
}

func die(_ reason: String) -> Never {
  writeLine(["error": reason])
  exit(1)
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { die("speech-not-authorized") }

  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
    recognizer.isAvailable
  else { die("recognizer-unavailable") }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  // Prefer on-device: no audio leaves the machine, and it works offline.
  // Older hardware falls back to Apple's server recognizer.
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let engine = AVAudioEngine()
  let microphone = engine.inputNode
  // Loudness, about ten times a second. Without it a person talking into
  // a silent interface cannot tell the difference between "listening"
  // and "broken", which is the whole complaint a meter answers.
  var lastLevelAt = Date.distantPast
  microphone.installTap(
    onBus: 0, bufferSize: 1024, format: microphone.outputFormat(forBus: 0)
  ) { buffer, _ in
    request.append(buffer)

    let now = Date()
    if now.timeIntervalSince(lastLevelAt) >= 0.1, let channel = buffer.floatChannelData?[0] {
      lastLevelAt = now
      let count = Int(buffer.frameLength)
      guard count > 0 else { return }
      var sum: Float = 0
      for i in 0..<count { sum += channel[i] * channel[i] }
      let rms = (sum / Float(count)).squareRoot()
      // speech sits well below full scale; lift it into a usable range
      writeLine(["level": min(1.0, Double(rms) * 12)])
    }
  }

  do {
    engine.prepare()
    try engine.start()
  } catch {
    die("mic-failed")
  }

  recognizer.recognitionTask(with: request) { result, error in
    if let result {
      writeLine(["partial": !result.isFinal, "text": result.bestTranscription.formattedString])
      if result.isFinal { exit(0) }
    }
    if error != nil { die("recognition-error") }
  }
}

RunLoop.main.run()
