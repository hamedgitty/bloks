// Routines: what an agent does without being asked.
//
// Reached from the chat, the way you reach a contact's details from a
// thread in Messages, because a routine belongs to one agent rather than
// floating in a global settings screen.
//
// The schedule editor is a time and seven day chips, matching what
// server/routines.ts can actually store. Offering cron here and then
// refusing most of it would be worse than not offering it.
import SwiftUI

struct RoutinesView: View {
    let conversation: Conversation

    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var editing: Routine?
    @State private var creating = false

    private var routines: [Routine] { store.routines(for: conversation) }

    var body: some View {
        NavigationStack {
            List {
                if routines.isEmpty {
                    Section {
                        ContentUnavailableView {
                            Label("No routines yet", systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
                        } description: {
                            Text("A routine is something \(conversation.name) does on a schedule, like briefing you every weekday morning.")
                        }
                    }
                } else {
                    Section {
                        ForEach(routines) { routine in
                            row(routine)
                        }
                    } header: {
                        Text("Scheduled")
                    } footer: {
                        // The honest limit. Saying it here is cheaper than a
                        // support thread about the brief that never arrived.
                        Text("Routines run while Bloks is open on your Mac.")
                    }
                }

                Section {
                    Button {
                        creating = true
                    } label: {
                        Label("New routine", systemImage: "plus")
                    }
                }
            }
            .navigationTitle("Routines")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $creating) {
                RoutineEditor(title: "New routine", draft: RoutineDraft()) { draft in
                    await store.addRoutine(to: conversation, draft: draft)
                }
            }
            .sheet(item: $editing) { routine in
                RoutineEditor(
                    title: "Edit routine",
                    draft: RoutineDraft(from: routine),
                    onDelete: { await store.deleteRoutine(routine) },
                    onRunNow: { await store.runRoutineNow(routine) }
                ) { draft in
                    await store.updateRoutine(routine, draft: draft)
                }
            }
        }
    }

    private func row(_ routine: Routine) -> some View {
        Button {
            editing = routine
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(routine.summary ?? routine.time)
                        .font(.headline)
                        .foregroundStyle(routine.enabled ? .primary : .secondary)
                    Text(routine.prompt)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if routine.enabled, let next = routine.nextRun {
                        Text("Next \(Stamp.separator(next))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    } else if !routine.enabled {
                        Text("Paused")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 8)
                Toggle(
                    "",
                    isOn: Binding(
                        get: { routine.enabled },
                        set: { on in Task { await store.setRoutineEnabled(routine, enabled: on) } }
                    )
                )
                .labelsHidden()
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { await store.deleteRoutine(routine) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
}

struct RoutineEditor: View {
    let title: String
    @State var draft: RoutineDraft
    var onDelete: (() async -> Void)?
    var onRunNow: (() async -> Void)?
    let onSave: (RoutineDraft) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var pickedTime = Date()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What should it do?", text: $draft.prompt, axis: .vertical)
                        .lineLimit(3...8)
                } header: {
                    Text("Instruction")
                } footer: {
                    Text("Sent as though you had typed it.")
                }

                Section("When") {
                    DatePicker(
                        "Time",
                        selection: $pickedTime,
                        displayedComponents: .hourAndMinute
                    )
                    .onChange(of: pickedTime) { _, new in
                        let parts = Calendar.current.dateComponents([.hour, .minute], from: new)
                        draft.minutes = (parts.hour ?? 9) * 60 + (parts.minute ?? 0)
                    }

                    dayPicker
                }

                if onRunNow != nil || onDelete != nil {
                    Section {
                        if let onRunNow {
                            Button {
                                Task {
                                    await onRunNow()
                                    dismiss()
                                }
                            } label: {
                                Label("Run it now", systemImage: "play.fill")
                            }
                        }
                        if let onDelete {
                            Button(role: .destructive) {
                                Task {
                                    await onDelete()
                                    dismiss()
                                }
                            } label: {
                                Label("Delete routine", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await onSave(draft)
                            dismiss()
                        }
                    }
                    .disabled(draft.prompt.trimmed.isEmpty)
                }
            }
            .onAppear {
                pickedTime = Calendar.current.date(
                    bySettingHour: draft.minutes / 60,
                    minute: draft.minutes % 60,
                    second: 0,
                    of: Date()
                ) ?? Date()
            }
        }
    }

    /// Seven chips. An empty selection means every day, which is stated
    /// rather than left for someone to infer from nothing being lit.
    private var dayPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                ForEach(0..<7, id: \.self) { day in
                    Button {
                        if draft.days.contains(day) { draft.days.remove(day) } else { draft.days.insert(day) }
                    } label: {
                        Text(RoutineDraft.dayInitials[day])
                            .font(.system(size: 14, weight: .semibold))
                            .frame(maxWidth: .infinity, minHeight: 34)
                            .background(
                                draft.days.contains(day) ? Color.accentColor : Color(uiColor: .tertiarySystemFill),
                                in: RoundedRectangle(cornerRadius: 9)
                            )
                            .foregroundStyle(draft.days.contains(day) ? Color.brandForeground : Color.primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(dayName(day))
                    .accessibilityAddTraits(draft.days.contains(day) ? .isSelected : [])
                }
            }
            HStack(spacing: 12) {
                Button("Every day") { draft.days = [] }
                Button("Weekdays") { draft.days = [1, 2, 3, 4, 5] }
                Button("Weekends") { draft.days = [0, 6] }
            }
            .font(.footnote)
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)

            Text(draft.days.isEmpty ? "Runs every day" : "Runs on the selected days")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func dayName(_ day: Int) -> String {
        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]
    }
}
