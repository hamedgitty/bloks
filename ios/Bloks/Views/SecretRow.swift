// The secure field an agent plants when a service wants an API key,
// phone edition. The value goes straight to the Mac and reaches the
// agent's tools as an environment variable; the chat never carries it.
import SwiftUI

struct SecretRow: View {
    let botId: String
    let messageId: String
    var meta: SecretMeta

    @Environment(BloksStore.self) private var store
    @State private var value = ""
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(meta.label)
                        .font(.system(size: 14, weight: .semibold))
                    if let hint = meta.hint {
                        Text(hint)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 6)
                if meta.status == "saved" {
                    Label("Saved", systemImage: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.green)
                }
            }
            if meta.status == "needs-value" {
                HStack(spacing: 8) {
                    SecureField("Paste your \(meta.label)", text: $value)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 13))
                    Button {
                        save()
                    } label: {
                        if saving {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Save")
                                .font(.system(size: 13, weight: .semibold))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .disabled(saving || value.trimmed.isEmpty)
                }
                Label("Stored on your Mac, never shown in chat.", systemImage: "checkmark.shield")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .opacity(meta.status == "dismissed" ? 0.55 : 1)
    }

    private func save() {
        saving = true
        Task {
            defer { saving = false }
            try? await store.client.secretSave(botId: botId, messageId: messageId, value: value)
            value = ""
        }
    }
}
