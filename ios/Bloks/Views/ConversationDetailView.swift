// The sheet behind the avatar: who this is, and everything about them
// that is not the conversation itself.
//
// Messages taught everyone that the contact's face at the top of a chat
// is a button, so ours is too. What used to be a row of little toolbar
// icons (model, routines) now lives here, with room to say what each one
// currently is instead of hiding behind a glyph.
import PhotosUI
import SwiftUI
import UIKit

struct ConversationDetailView: View {
    let conversationId: String

    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var showModel = false
    @State private var showEdit = false
    @State private var showRoutines = false
    @State private var exportText: String?
    @State private var pickedPhoto: PhotosPickerItem?

    var body: some View {
        NavigationStack {
            Group {
                if let conversation = store.conversation(id: conversationId) {
                    detail(for: conversation)
                } else {
                    // The agent was deleted on the Mac while this sheet was
                    // open. Nothing to show, and pretending otherwise would
                    // render stale data.
                    ContentUnavailableView("Gone", systemImage: "person.crop.circle.badge.xmark")
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func detail(for conversation: Conversation) -> some View {
        List {
            Section {
                card(for: conversation)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            Section {
                if case .agent(let bot) = conversation {
                    Button { showEdit = true } label: {
                        row("Edit look and name", systemImage: "paintpalette", value: "")
                    }
                    .sheet(isPresented: $showEdit) { EditAgentView(bot: bot) }
                    Button { showModel = true } label: {
                        row(
                            "Model",
                            systemImage: "cpu",
                            value: store.modelLabel(for: bot) ?? "Choose"
                        )
                    }

                    // Effort settles in place rather than opening a screen:
                    // it is one choice, and the row shows where it stands.
                    Menu {
                        Picker("Reasoning effort", selection: Binding(
                            get: { bot.effort ?? "default" },
                            set: { choice in
                                Task {
                                    await store.setEffort(
                                        bot: bot,
                                        effort: choice == "default" ? nil : choice
                                    )
                                }
                            }
                        )) {
                            Text("Default").tag("default")
                            Text("Low").tag("low")
                            Text("Medium").tag("medium")
                            Text("High").tag("high")
                        }
                    } label: {
                        row(
                            "Effort",
                            systemImage: "brain",
                            value: (bot.effort ?? "Default").capitalized
                        )
                    }

                    NavigationLink {
                        WebhooksView(bot: bot)
                    } label: {
                        Label("Webhooks", systemImage: "arrow.down.forward.circle")
                    }

                    // The photo. Picking one swaps the pixel face for it
                    // everywhere; removing it brings the same pixel face
                    // back, because the identity underneath never changes.
                    PhotosPicker(selection: $pickedPhoto, matching: .images) {
                        row(
                            "Photo",
                            systemImage: "person.crop.circle.badge.plus",
                            value: bot.avatarAt == nil ? "None" : "Custom"
                        )
                    }
                    if bot.avatarAt != nil {
                        Button(role: .destructive) {
                            Task { await store.removeAvatar(bot: bot) }
                        } label: {
                            Label("Remove photo", systemImage: "person.crop.circle.badge.minus")
                        }
                    }
                }

                Button { showRoutines = true } label: {
                    let live = store.routines(for: conversation).filter(\.enabled).count
                    row(
                        "Routines",
                        systemImage: "clock",
                        value: live == 0 ? "None yet" : "\(live) running"
                    )
                }
            }

            if case .room(let room) = conversation {
                Section {
                    Toggle(
                        "Only the lead answers",
                        isOn: Binding(
                            get: { room.leadOnly ?? false },
                            set: { on in Task { await store.setLeadOnly(room: room, on: on) } }
                        )
                    )
                } footer: {
                    Text("A message that names nobody wakes just the most senior agent, who can still delegate with @name.")
                }

                Section {
                    Button {
                        Task {
                            exportText = await store.teamManifestText(room: room)
                        }
                    } label: {
                        Label("Export team", systemImage: "square.and.arrow.up")
                    }
                }

                let members = store.members(of: room)
                let lead = store.lead(of: room)
                Section("Members") {
                    ForEach(members) { member in
                        HStack(spacing: 10) {
                            AgentAvatar(bot: member, size: 32, tile: .circle)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(member.name).font(.system(size: 15, weight: .medium))
                                if !member.title.isEmpty {
                                    Text(member.title)
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if member.id == lead?.id, members.count > 1 {
                                Image(systemName: "crown.fill")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.orange)
                                    .accessibilityLabel("Most senior")
                            }
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showModel) {
            if case .agent(let bot) = conversation {
                ModelPickerView(bot: bot)
            }
        }
        .sheet(isPresented: $showRoutines) {
            RoutinesView(conversation: conversation)
        }
        .onChange(of: pickedPhoto) { _, item in
            guard let item, case .agent(let bot) = conversation else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    await store.uploadAvatar(bot: bot, image: image)
                }
                pickedPhoto = nil
            }
        }
        .sheet(item: $exportText) { text in
            // The team as a file someone else can import. ShareLink needs
            // Transferable ceremony for files, and a share sheet with the
            // JSON as text reaches every target that matters.
            ActivitySheet(text: text)
        }
    }

    @ViewBuilder
    private func card(for conversation: Conversation) -> some View {
        VStack(spacing: 8) {
            switch conversation {
            case .agent(let bot):
                AgentAvatar(bot: bot, size: 72, tile: .circle)
                Text(bot.name).font(.title3.weight(.semibold))
                if !bot.title.isEmpty {
                    Text(bot.title)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            case .room(let room):
                RoomAvatar(members: store.members(of: room), size: 72)
                Text(room.name).font(.title3.weight(.semibold))
                Text("\(room.memberIds.count) agents")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 4)
    }

    private func row(_ title: String, systemImage: String, value: String) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
                .foregroundStyle(.primary)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
    }
}

/// Lets a bare string drive `.sheet(item:)`.
extension String: @retroactive Identifiable {
    public var id: String { self }
}

/// UIActivityViewController, because SwiftUI's ShareLink cannot be handed
/// its payload lazily and the manifest is fetched on tap.
private struct ActivitySheet: UIViewControllerRepresentable {
    let text: String

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [text], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
