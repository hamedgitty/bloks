// Making an agent yours, from the phone.
//
// The same identity the desktop edits: a live face up top that shuffles
// on a tap, then one panel at a time for shape, color, and face, with
// the name and title below. Every change lands on the Mac immediately,
// so the desktop and the widgets see the new look the moment it is
// picked.
import SwiftUI

struct EditAgentView: View {
    let bot: Bot
    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum LookTab: String, CaseIterable {
        case shape = "Shape"
        case color = "Color"
        case face = "Face"
    }

    @State private var tab: LookTab = .shape
    @State private var name: String
    @State private var title: String
    @State private var color: String
    @State private var shape: String
    @State private var expression: String?
    @State private var saving = false
    @State private var errorLine: String?

    init(bot: Bot) {
        self.bot = bot
        _name = State(initialValue: bot.name)
        _title = State(initialValue: bot.title ?? "")
        _color = State(initialValue: bot.color)
        _shape = State(initialValue: bot.shape ?? AgentAppearance.shape(for: bot).rawValue)
        _expression = State(initialValue: bot.mascotExpression)
    }

    private var liveShape: BlokShape { BlokShape(rawValue: shape) ?? .star }
    private var liveColor: BlokColor { BlokColor(rawValue: color) ?? .blue }
    private var liveExpression: BlokExpression {
        expression.flatMap(BlokExpression.init(rawValue:)) ?? .friendly
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    // the face itself, tappable for a lucky dip
                    Button {
                        color = BlokColor.allCases.randomElement()!.rawValue
                        shape = BlokShape.allCases.randomElement()!.rawValue
                    } label: {
                        VStack(spacing: 6) {
                            BlokAvatar(color: liveColor, shape: liveShape, expression: liveExpression, size: 96)
                            Text("tap to shuffle")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 6)

                    Picker("Look", selection: $tab) {
                        ForEach(LookTab.allCases, id: \.self) { Text($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)

                    Group {
                        switch tab {
                        case .shape:
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 10) {
                                ForEach(BlokShape.allCases, id: \.self) { candidate in
                                    Button {
                                        shape = candidate.rawValue
                                    } label: {
                                        BlokAvatar(color: liveColor, shape: candidate, expression: .deadpan, size: 44)
                                            .padding(6)
                                            .background(
                                                RoundedRectangle(cornerRadius: 12)
                                                    .fill(shape == candidate.rawValue ? Color.accentColor.opacity(0.15) : .clear)
                                            )
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 12)
                                                    .stroke(shape == candidate.rawValue ? Color.accentColor : .clear, lineWidth: 1.5)
                                            )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        case .color:
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 5), spacing: 12) {
                                ForEach(BlokColor.allCases, id: \.self) { candidate in
                                    Button {
                                        color = candidate.rawValue
                                    } label: {
                                        Circle()
                                            .fill(Color(hex: BlokArt.colorHex[candidate] ?? 0x4C86F5))
                                            .frame(width: 40, height: 40)
                                            .overlay(
                                                Circle().stroke(
                                                    color == candidate.rawValue ? Color.primary : .clear,
                                                    lineWidth: 2.5
                                                ).padding(-4)
                                            )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        case .face:
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 10) {
                                ForEach(BlokExpression.allCases, id: \.self) { candidate in
                                    Button {
                                        expression = candidate.rawValue
                                    } label: {
                                        BlokAvatar(color: liveColor, shape: liveShape, expression: candidate, size: 44)
                                            .padding(6)
                                            .background(
                                                RoundedRectangle(cornerRadius: 12)
                                                    .fill(expression == candidate.rawValue ? Color.accentColor.opacity(0.15) : .clear)
                                            )
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 12)
                                                    .stroke(expression == candidate.rawValue ? Color.accentColor : .clear, lineWidth: 1.5)
                                            )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    .padding(.horizontal)

                    VStack(spacing: 10) {
                        TextField("Name", text: $name)
                            .textFieldStyle(.roundedBorder)
                        TextField("Title, e.g. Research", text: $title)
                            .textFieldStyle(.roundedBorder)
                    }
                    .padding(.horizontal)

                    if let errorLine {
                        Text(errorLine)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.bottom, 24)
            }
            .navigationTitle("Edit agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { save() }
                        .disabled(saving || name.trimmed.isEmpty)
                }
            }
        }
    }

    private func save() {
        saving = true
        errorLine = nil
        Task {
            do {
                try await store.client.editAgent(
                    botId: bot.id,
                    name: name.trimmed != bot.name ? name.trimmed : nil,
                    title: title.trimmed != (bot.title ?? "") ? title.trimmed : nil,
                    color: color != bot.color ? color : nil,
                    shape: shape != bot.shape ? shape : nil,
                    expression: expression != bot.mascotExpression ? expression : nil
                )
                await store.hydrate()
                dismiss()
            } catch {
                errorLine = error.localizedDescription
                saving = false
            }
        }
    }
}
