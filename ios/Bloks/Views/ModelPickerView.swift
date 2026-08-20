// Which engine an agent thinks with.
//
// This is the one piece of configuration the phone gets, and it earns its
// place: the failure it fixes is an agent stranded on an engine that is
// signed out or unavailable, which otherwise means walking to the Mac.
//
// The tools badge is not decoration. An agent moved onto a chat engine
// quietly loses half its job, and the desktop badges that difference
// everywhere it shows an engine, so this does too.
import SwiftUI

struct ModelPickerView: View {
    let bot: Bot

    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.instances) { instance in
                    Section {
                        if instance.isAvailable {
                            ForEach(instance.models.options) { option in
                                row(instance: instance, option: option)
                            }
                        } else {
                            Text(instance.snapshot.reason ?? "Not available on this Mac.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Text(instance.displayName)
                            if instance.runsTools {
                                Label("Runs tools", systemImage: "wrench.and.screwdriver.fill")
                                    .labelStyle(.iconOnly)
                                    .foregroundStyle(.secondary)
                                    .accessibilityLabel("Runs tools")
                            }
                            Spacer()
                            if !instance.isAvailable {
                                Text("Unavailable")
                                    .foregroundStyle(.orange)
                            }
                        }
                    } footer: {
                        if instance.isAvailable && !instance.runsTools {
                            Text("Chat only. This engine cannot run tools or touch files.")
                        }
                    }
                }
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay {
                if store.instances.isEmpty {
                    ContentUnavailableView(
                        "No engines",
                        systemImage: "cpu",
                        description: Text("Connect an engine in Bloks on your Mac.")
                    )
                }
            }
        }
    }

    private func row(instance: ProviderInstance, option: ProviderInstance.ModelOption) -> some View {
        let chosen = bot.modelSelection?.instanceId == instance.instanceId
            && bot.modelSelection?.model == option.id

        return Button {
            Task {
                await store.setModel(for: bot, instanceId: instance.instanceId, model: option.id)
                dismiss()
            }
        } label: {
            HStack {
                Text(option.label)
                    .foregroundStyle(.primary)
                Spacer()
                if chosen {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                        .fontWeight(.semibold)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// Making a room, which is the group chat of this app.
///
/// The server refuses fewer than two members, so the button refuses first:
/// a 400 arriving after you tapped Create is a worse way to learn the rule.
struct NewRoomView: View {
    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let onCreated: (String) -> Void

    @State private var name = ""
    @State private var picked: Set<String> = []
    @State private var working = false

    private var candidates: [Bot] {
        store.bots.filter { $0.hidden != true }
    }

    private var lead: Bot? {
        candidates
            .filter { picked.contains($0.id) }
            .reduce(nil as Bot?) { best, member in
                guard let best else { return member }
                return (member.seniority ?? 1) > (best.seniority ?? 1) ? member : best
            }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Launch week", text: $name)
                }

                Section {
                    ForEach(candidates) { bot in
                        Button {
                            if picked.contains(bot.id) { picked.remove(bot.id) } else { picked.insert(bot.id) }
                        } label: {
                            HStack(spacing: 12) {
                                BlokAvatar(
                                    color: bot.avatarColor,
                                    shape: bot.avatarShape,
                                    expression: bot.avatarExpression,
                                    size: 34,
                                    tile: .circle
                                )
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(bot.name).foregroundStyle(.primary)
                                    if !bot.title.isEmpty {
                                        Text(bot.title)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if picked.contains(bot.id) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("Who is in it")
                } footer: {
                    // Seniority decides who speaks last, and it is set on the
                    // Mac. Saying who that will be here avoids a room whose
                    // order surprises you afterwards.
                    if let lead, picked.count > 1 {
                        Text("\(lead.name) is the most senior here, so they speak last and make the call when members disagree.")
                    } else {
                        Text("Pick at least two. They take turns rather than talking over each other.")
                    }
                }
            }
            .navigationTitle("New room")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        working = true
                        Task {
                            let id = await store.createRoom(
                                name: name.trimmed.isEmpty ? "New room" : name.trimmed,
                                memberIds: Array(picked)
                            )
                            working = false
                            dismiss()
                            if let id { onCreated(id) }
                        }
                    }
                    .disabled(picked.count < 2 || working)
                }
            }
        }
    }
}
