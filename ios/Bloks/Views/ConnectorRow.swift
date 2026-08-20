// The sign-in card an agent plants when it needs an app, phone edition.
//
// One tap opens the provider's sign-in in the browser; while that tab is
// away, the row quietly asks the Mac whether the connection landed, so
// coming back to the chat usually means coming back to "Added".
import SwiftUI

struct ConnectorRow: View {
    let botId: String
    let messageId: String
    var meta: ConnectorMeta

    @Environment(BloksStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var working = false

    var body: some View {
        HStack(spacing: 10) {
            Text(String(meta.label.prefix(1)).uppercased())
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 1) {
                Text(meta.label)
                    .font(.system(size: 14, weight: .semibold))
                Text(statusLine)
                    .font(.system(size: 11))
                    .foregroundStyle(meta.status == "failed" ? Color.red : Color.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if meta.status == "connected" {
                Label("Added", systemImage: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.green)
                    .labelStyle(.titleAndIcon)
            } else if meta.status != "dismissed" {
                Button {
                    connect()
                } label: {
                    if working {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(meta.status == "authorizing" ? "Reopen" : meta.status == "failed" ? "Retry" : "Connect")
                            .font(.system(size: 13, weight: .semibold))
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
            }
        }
        .padding(10)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .opacity(meta.status == "dismissed" ? 0.55 : 1)
        .task(id: meta.status) {
            // while a sign-in is out in the browser, watch for it landing
            guard meta.status == "authorizing" else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                try? await store.client.connectorRefresh(botId: botId, messageId: messageId)
            }
        }
    }

    private var statusLine: String {
        switch meta.status {
        case "connected": (meta.resumed ?? false) ? "Connected. Task resumed." : "Connected"
        case "authorizing": "Waiting for your sign-in…"
        case "failed": meta.error ?? "The connection failed."
        case "dismissed": "Dismissed"
        default: "Sign in so your agent can use it"
        }
    }

    private func connect() {
        working = true
        Task {
            defer { working = false }
            if let url = try? await store.client.connectorAuthorize(botId: botId, messageId: messageId),
               let link = URL(string: url) {
                openURL(link)
            }
        }
    }
}
