// The composer, in the arrangement Messages taught everyone: attach on
// the left, a glass field that grows with the text, and one control at
// the end of the field that is always whichever action matters right now.
//
// That trailing slot is the whole interaction design. Empty field: a mic.
// Something typed: send. Agent working: stop. Dictating: the tick that
// ends it. Never two of them, because two actions in a thumb-width means
// hitting the wrong one.
//
// While dictating, the field itself becomes the waveform. The words still
// land in the text underneath, but what you watch is your own voice, which
// is the only honest way to show that something is listening.
import SwiftUI

struct ComposerView: View {
    let placeholder: String
    let isBusy: Bool
    let onSend: (String) -> Void
    let onInterrupt: () -> Void

    @State private var text = ""
    @State private var dictation = Dictation()
    /// What was already typed before the mic went on, so a dictated phrase
    /// appends to it instead of wiping it.
    @State private var textBeforeDictation = ""
    @State private var showAttachNote = false
    @FocusState private var focused: Bool

    private var canSend: Bool { !text.trimmed.isEmpty }

    var body: some View {
        VStack(spacing: 8) {
            if case .unavailable(let why) = dictation.state {
                HStack(spacing: 8) {
                    Image(systemName: "mic.slash.fill")
                    Text(why).font(.footnote).lineLimit(2)
                    Button("OK") { dictation.clearError() }
                        .font(.footnote.weight(.semibold))
                }
                .foregroundStyle(.orange)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .glassCapsule()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            GlassGroup(spacing: 10) {
                HStack(alignment: .bottom, spacing: 10) {
                    attach
                    field
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(.snappy(duration: 0.22), value: dictation.isListening)
        .animation(.snappy(duration: 0.18), value: canSend)
        .animation(.snappy(duration: 0.2), value: dictation.state)
        .onChange(of: dictation.transcript) { _, heard in
            guard dictation.isListening else { return }
            let base = textBeforeDictation.trimmed
            text = base.isEmpty ? heard : "\(base) \(heard)"
        }
        .alert("Attachments", isPresented: $showAttachNote) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Sharing photos and files with your agents is coming in a later update.")
        }
    }

    /// The plus. Today it explains what is coming; the menu shape is
    /// already the final one, so attachments arrive without relearning.
    private var attach: some View {
        Menu {
            Button { showAttachNote = true } label: {
                Label("Photos", systemImage: "photo.on.rectangle")
            }
            Button { showAttachNote = true } label: {
                Label("Files", systemImage: "folder")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.primary)
                .frame(width: 38, height: 38)
        }
        .glassCircle()
        // Menus tint their labels accent-blue by default; this control is
        // chrome, and chrome is ink-colored
        .tint(.primary)
        .accessibilityLabel("Attach")
        .padding(.bottom, 1)
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if dictation.isListening {
                listening
            } else {
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.leading, 14)
                    .padding(.vertical, 9)
            }

            trailingControl
        }
        .glassCapsule(interactive: true)
        .overlay(
            // The accent ring while listening. Drawn over the glass so the
            // material itself stays untinted.
            Capsule().stroke(
                Color.accentColor.opacity(dictation.isListening ? 0.55 : 0),
                lineWidth: 1.5
            )
        )
        .background(
            // A soft bloom that scales with how loud you are, so the whole
            // control breathes with the voice rather than just the bars.
            Capsule()
                .fill(Color.accentColor)
                .opacity(dictation.isListening ? 0.06 + 0.10 * dictation.level : 0)
                .blur(radius: 10)
        )
    }

    private var listening: some View {
        HStack(spacing: 10) {
            DictationWaveform(level: dictation.level)
                .frame(height: 26)
                .padding(.leading, 14)

            Text(text.trimmed.isEmpty ? "Listening" : text)
                .font(.footnote)
                .foregroundStyle(text.trimmed.isEmpty ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.head)
                .frame(maxWidth: 120, alignment: .trailing)
        }
        .padding(.vertical, 9)
        .transition(.opacity.combined(with: .scale(scale: 0.97)))
        .accessibilityElement()
        .accessibilityLabel("Listening. \(text.isEmpty ? "Say something." : text)")
    }

    @ViewBuilder
    private var trailingControl: some View {
        if canSend && !dictation.isListening {
            control("arrow.up.circle.fill", tint: Color.accentColor, label: "Send") {
                let body = text
                text = ""
                onSend(body)
            }
        } else if dictation.isListening {
            control("checkmark.circle.fill", tint: Color.accentColor, label: "Stop dictating") {
                dictation.stop()
                focused = true
            }
        } else if isBusy {
            control("stop.circle.fill", tint: .secondary, label: "Stop this turn", action: onInterrupt)
        } else {
            // A bare mic, quiet and in-field, exactly where Messages keeps
            // its dictation affordance.
            Button {
                textBeforeDictation = text
                Task { await dictation.start() }
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 34)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 6)
            .padding(.bottom, 2)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Dictate")
        }
    }

    private func control(
        _ symbol: String,
        tint: Color,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 29))
                .foregroundStyle(tint)
                .symbolRenderingMode(.hierarchical)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 4)
        .padding(.bottom, 3)
        .transition(.scale.combined(with: .opacity))
        .accessibilityLabel(label)
    }
}
