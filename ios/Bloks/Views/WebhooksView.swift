// The URLs that wake this agent from outside.
//
// Kept deliberately small: name it, copy the URL, delete it. Everything
// else about a webhook (what it says, how the agent reacts) is visible in
// the chat itself, because a fired hook is just a turn.
import SwiftUI
import UIKit

struct WebhooksView: View {
    let bot: Bot

    @Environment(BloksStore.self) private var store
    @State private var hooks: [Webhook]?
    @State private var name = ""
    @State private var copiedId: String?

    var body: some View {
        List {
            Section {
                if let hooks {
                    if hooks.isEmpty {
                        Text("Nothing wakes \(bot.name) from outside yet.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(hooks) { hook in
                        // content reads as content, the action reads as an
                        // action: name in primary, one blue Copy button,
                        // matching every other list in the app
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(hook.name)
                                    .font(.system(size: 15, weight: .medium))
                                Text(firedLine(hook))
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(copiedId == hook.id ? "Copied" : "Copy URL") {
                                UIPasteboard.general.string = store.hookURL(hook)
                                copiedId = hook.id
                                Task {
                                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                                    if copiedId == hook.id { copiedId = nil }
                                }
                            }
                            .font(.system(size: 13, weight: .medium))
                            .buttonStyle(.borderless)
                        }
                    }
                    .onDelete { offsets in
                        let doomed = offsets.map { hooks[$0] }
                        Task {
                            for hook in doomed { await store.deleteWebhook(id: hook.id) }
                            await reload()
                        }
                    }
                } else {
                    ProgressView()
                }
            } footer: {
                Text("POST anything to a webhook URL and \(bot.name) picks it up as a message. The link is the key, so share it like one.")
            }

            Section {
                HStack {
                    TextField("What fires it, e.g. CI failed", text: $name)
                        .onSubmit { add() }
                    Button("Add") { add() }
                        .disabled(name.trimmed.isEmpty)
                }
            }
        }
        .navigationTitle("Webhooks")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
    }

    private func firedLine(_ hook: Webhook) -> String {
        guard let count = hook.firedCount, count > 0 else { return "Never fired" }
        return count == 1 ? "Fired once" : "Fired \(count) times"
    }

    private func reload() async {
        hooks = await store.webhooks(bot: bot)
    }

    private func add() {
        let title = name.trimmed
        guard !title.isEmpty else { return }
        name = ""
        Task {
            _ = await store.createWebhook(bot: bot, name: title)
            await reload()
        }
    }
}
