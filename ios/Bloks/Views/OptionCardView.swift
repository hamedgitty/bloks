// Option cards.
//
// Two cards live in this one view and the difference is the whole point.
//
//   With a requestId, this is an Approval. An agent's turn is parked right
//   now, waiting on this answer, and it will sit there for fifteen minutes
//   before the harness gives up and denies it. The eyebrow is amber, and
//   the card says plainly that something is waiting.
//
//   Without one, it is a Question that was asked at some point and can be
//   answered whenever. The eyebrow is the brand colour and nothing is
//   blocked.
//
// Mirrors src/components/OptionCard.tsx, including the lettered options,
// so answering from the phone looks like answering on the Mac.
import SwiftUI

struct OptionCardView: View {
    let message: Message
    let speaker: Bot?
    let onAnswer: (String) -> Void
    let onDismiss: () -> Void

    @State private var custom = ""
    @FocusState private var customFocused: Bool

    private let letters = ["A", "B", "C", "D", "E", "F"]

    private var card: OptionCard? { message.card }

    var body: some View {
        if let card, card.dismissed != true {
            if let team = card.team {
                TeamProposalCard(
                    plan: team,
                    leadName: speaker?.name ?? "Your agent",
                    settled: card.answered,
                    onHire: { onAnswer("Hire the team") },
                    onDecline: { onAnswer("Not now. Handle this yourself.") }
                )
            } else {
                standard(card)
            }
        }
    }

    private func standard(_ card: OptionCard) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    // The same three words the window uses. A gate is not
                    // an approval: an approval parks an agent's turn, a
                    // gate parks a workflow run, and calling both the
                    // same thing hides which one is waiting.
                    Text(card.isGate ? "WORKFLOW" : card.requestId != nil ? "APPROVAL" : "QUESTION")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.1)
                        .foregroundStyle(card.isLiveAsk ? Color.orange : Color.accentColor)

                    Text(card.title)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)

                    if !card.subtitle.isEmpty {
                        Text(card.subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }

                Spacer(minLength: 8)

                // A gate can be put aside now: the Activity screen lists
                // every parked run and offers the same two buttons, and
                // the harness keeps a dismissed gate in that list rather
                // than treating the card being hidden as the run being
                // finished. Putting one aside is not declining it.
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(6)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    card.isGate ? "Put aside" : card.isLiveAsk ? "Deny and dismiss" : "Dismiss"
                )
            }
            .padding(.horizontal, 14)
            .padding(.top, 13)

            VStack(spacing: 4) {
                ForEach(Array(card.options.enumerated()), id: \.offset) { index, option in
                    optionRow(card: card, index: index, option: option)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 11)

            // A workflow gate has exactly two answers and each one decides
            // what happens next. Offering a text box beside them would
            // invite an answer nobody can act on, and anything the run
            // does not recognise has to be read as a decline, which is
            // not what somebody typing a sentence would expect. The
            // window leaves it out for the same reason.
            if card.answered == nil && !card.isGate {
                HStack(spacing: 8) {
                    TextField("Type your own answer", text: $custom, axis: .vertical)
                        .font(.system(size: 15))
                        .lineLimit(1...4)
                        .focused($customFocused)
                        .submitLabel(.send)
                        .onSubmit { submitCustom() }

                    if !custom.trimmed.isEmpty {
                        Button(action: submitCustom) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 22))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Send answer")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 14)
                .padding(.top, 8)
            }

            // An approval that is still open is the reason to have opened
            // the app. Say so, rather than leaving it to the eyebrow.
            if card.isLiveAsk && !card.isSettled {
                Label(
                    card.isGate ? "A workflow is waiting on this" : "Your agent is waiting on this",
                    systemImage: "clock"
                )
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 14)
                    .padding(.top, 10)
            }
        }
        .padding(.bottom, 14)
        .frame(maxWidth: 340, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(
                    card.isLiveAsk && !card.isSettled ? Color.orange.opacity(0.45) : Color.primary.opacity(0.08),
                    lineWidth: 1
                )
        )
    }

    private func optionRow(card: OptionCard, index: Int, option: String) -> some View {
        let chosen = card.answered == option
        let settled = card.answered != nil

        return Button {
            onAnswer(option)
        } label: {
            HStack(spacing: 10) {
                Text(index < letters.count ? letters[index] : "\(index + 1)")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .background(
                        chosen ? Color.accentColor : Color(uiColor: .tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
                    .foregroundStyle(chosen ? Color.brandForeground : Color.secondary)

                Text(option)
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                chosen ? Color.accentColor.opacity(0.12) : Color.clear,
                in: RoundedRectangle(cornerRadius: 11)
            )
            .opacity(settled && !chosen ? 0.45 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(settled)
        .accessibilityLabel(option)
        .accessibilityHint(chosen ? "Chosen" : "")
    }

    private func submitCustom() {
        let text = custom.trimmed
        guard !text.isEmpty else { return }
        custom = ""
        customFocused = false
        onAnswer(text)
    }
}

/// A lead asking to hire. Nothing is created until this is approved, so the
/// card shows the whole roster: who, what they own, what they can do.
struct TeamProposalCard: View {
    let plan: TeamPlan
    let leadName: String
    let settled: String?
    let onHire: () -> Void
    let onDecline: () -> Void

    @State private var briefOpen = false

    private var hired: Bool { settled == "Hire the team" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(hired ? "TEAM HIRED" : "PROPOSED TEAM")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.1)
                    .foregroundStyle(Color.accentColor)
                Text("\(leadName) wants \(plan.members.count) people for \u{201C}\(plan.room)\u{201D}")
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Text("They run on the cheaper model and do the legwork. \(leadName) reviews everything and reports back to you.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 14)
            .padding(.top, 13)

            VStack(spacing: 0) {
                ForEach(plan.members) { member in
                    Divider()
                    HStack(alignment: .top, spacing: 10) {
                        BlokAvatar(
                            color: BlokColor.named(deterministicColor(for: member.name)),
                            shape: BlokShape.forAgent(id: nil, name: member.name, declared: nil),
                            expression: .friendly,
                            size: 30,
                            tile: .circle
                        )
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.name).font(.system(size: 14, weight: .semibold))
                            if !member.title.isEmpty {
                                Text(member.title)
                                    .font(.system(size: 13))
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if !member.skills.isEmpty {
                                Text(member.skills.map { $0.components(separatedBy: ":").first ?? $0 }
                                    .joined(separator: " \u{2022} "))
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                }
            }
            .padding(.top, 11)

            if !plan.brief.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Button(briefOpen ? "Hide the brief" : "See the brief they get") {
                        withAnimation(.snappy) { briefOpen.toggle() }
                    }
                    .font(.system(size: 13, weight: .medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)

                    if briefOpen {
                        Text(plan.brief)
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }

            Divider()

            HStack(spacing: 10) {
                if hired {
                    Text("Hired. The room is open and \(leadName) has briefed them.")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                } else if settled != nil {
                    Text("Declined.").font(.system(size: 13)).foregroundStyle(.secondary)
                } else {
                    Button(action: onHire) {
                        Text("Hire the team")
                            .font(.system(size: 15, weight: .medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(Color.brandForeground)
                    }
                    .buttonStyle(.plain)

                    Button(action: onDecline) {
                        Text("Not now")
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 9)
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
        }
        .frame(maxWidth: 340, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18).stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
    }

    /// Deterministic colour for someone who is not an agent yet, so the
    /// roster you approve looks like the roster you get. Same hash as
    /// colorFor() in src/components/OptionCard.tsx.
    private func deterministicColor(for name: String) -> String {
        var hash: Int32 = 0
        for scalar in name.unicodeScalars {
            hash = hash &* 31 &+ Int32(truncatingIfNeeded: Int(scalar.value))
        }
        let all = BlokColor.allCases
        return all[Int(hash.magnitude) % all.count].rawValue
    }
}
