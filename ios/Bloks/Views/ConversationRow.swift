// One row of the conversation list, laid out the way Messages lays one out:
// circular avatar, name, two lines of preview, the stamp top right, and the
// unread dot in the leading gutter rather than as a badge.
//
// Bloks earns this layout rather than borrowing it. An agent really is a
// contact and a room really is a group chat, so the conventions people
// already know are the correct ones here.
import SwiftUI

struct ConversationRow: View {
    @AppStorage("bloksRoleBadges") private var showRoleBadges = true
    let conversation: Conversation
    /// Members, for a room's clustered avatar. Empty for an agent.
    let members: [Bot]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // The unread dot rides the avatar's shoulder instead of
            // holding a gutter of its own; the reclaimed width goes to
            // the name row, where longer badges want it.
            avatar
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 11, height: 11)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                        .opacity(conversation.isUnread ? 1 : 0)
                        .offset(x: 1, y: 1)
                }
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                // The position badge rides beside the name when it fits
                // whole; a longer title gets its own row under the name
                // instead of truncating into noise.
                let badgeTitle: String? = {
                    guard showRoleBadges, case .agent(let bot) = conversation, !bot.title.isEmpty
                    else { return nil }
                    return bot.title
                }()

                ViewThatFits(in: .horizontal) {
                    nameRow(inlineBadge: badgeTitle)
                    VStack(alignment: .leading, spacing: 3) {
                        nameRow(inlineBadge: nil)
                        if let badgeTitle {
                            RoleBadge(title: badgeTitle)
                        }
                    }
                }

                Text(preview)
                    .font(.subheadline)
                    // unread reads darker: the dot says NEW, the ink says
                    // it is worth reading now
                    .foregroundStyle(
                        previewIsUrgent
                            ? Color.accentColor
                            : conversation.isUnread ? Color.primary : Color.secondary
                    )
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var avatar: some View {
        switch conversation {
        case .agent(let bot):
            AgentAvatar(bot: bot, size: 52, tile: .circle)
        case .room:
            RoomAvatar(members: members, size: 52)
        }
    }

    /// An agent blocked on an approval is the one thing worth colouring: it
    /// is the reason to open the app rather than a summary of the thread.
    /// The top line: name, optionally the inline badge, and the stamp.
    /// Everything is natural-width here so ViewThatFits can judge it;
    /// the stacked fallback is where truncation is allowed.
    @ViewBuilder
    private func nameRow(inlineBadge: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(conversation.name)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .layoutPriority(1)
            if let inlineBadge {
                RoleBadge(title: inlineBadge)
                    .fixedSize()
            }
            Spacer(minLength: 4)
            // The stamp and its chevron travel together, the way Messages
            // draws them; the row's NavigationLink is invisible so this is
            // the only chevron on the line.
            if let last = conversation.lastMessage {
                HStack(spacing: 5) {
                    Text(Stamp.relative(last.timestamp))
                        .font(.subheadline)
                        .lineLimit(1)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .foregroundStyle(.secondary)
                .fixedSize()
            }
        }
    }

    private var previewIsUrgent: Bool {
        guard let last = conversation.lastMessage, last.kind == .options, !last.deleted else { return false }
        return last.card?.isLiveAsk == true && last.card?.isSettled == false
    }

    private var preview: String {
        guard let last = conversation.lastMessage else { return "No messages yet" }
        let speaker: String = {
            guard case .room = conversation, let from = last.from else { return "" }
            guard let member = members.first(where: { $0.id == from }) else { return "" }
            return "\(member.name): "
        }()

        // Taken back, whatever it used to be. The row should not still
        // advertise words, a chart or a question somebody removed. The
        // window says the same thing in the same place.
        if last.deleted { return speaker + "Message taken back" }

        switch last.kind {
        case .text, .notice:
            return speaker + (last.text ?? "").replacingOccurrences(of: "\n", with: " ").trimmed
        case .options:
            guard let card = last.card else { return speaker + "Asked you something" }
            if card.isLiveAsk && !card.isSettled { return speaker + "Waiting on your approval" }
            return speaker + card.title
        case .activity:
            return speaker + (last.tool?.name ?? "Working")
        case .screen:
            return speaker + "Screenshot"
        case .artifact:
            return speaker + (last.artifact.map { "Saved \($0.name)" } ?? "Saved a file")
        case .connector:
            return speaker + (last.connector.map { "Connect \($0.label)" } ?? "Connect an app")
        case .secret:
            return speaker + (last.secret.map { "Needs your \($0.label)" } ?? "Needs a key")
        case .component:
            // The preview line is prose, so a component is described
            // rather than drawn: what it is beats an empty row.
            return speaker + (last.component?.previewLine ?? "An answer")
        case .unrecognised:
            return ""
        }
    }

    private var accessibilityLabel: String {
        var parts = [conversation.name]
        if conversation.isUnread { parts.append("unread") }
        if let last = conversation.lastMessage {
            parts.append(preview)
            parts.append(Stamp.relative(last.timestamp))
        }
        return parts.joined(separator: ", ")
    }
}

/// A room's icon: its members' avatars overlapped, the way a group chat
/// shows the people in it.
struct RoomAvatar: View {
    let members: [Bot]
    var size: CGFloat = 52

    var body: some View {
        let shown = Array(members.prefix(3))
        ZStack {
            if shown.isEmpty {
                Circle()
                    .fill(Color.secondary.opacity(0.2))
                    .frame(width: size, height: size)
                Image(systemName: "person.2.fill")
                    .font(.system(size: size * 0.4))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, member in
                    AgentAvatar(bot: member, size: size * 0.62, tile: .circle)
                    .overlay(
                        Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2)
                    )
                    .offset(offset(for: index, count: shown.count))
                }
            }
        }
        .frame(width: size, height: size)
    }

    /// One behind, the others fanned in front. Enough to read as "several
    /// people" at 52 points without turning into mush.
    private func offset(for index: Int, count: Int) -> CGSize {
        let spread = size * 0.19
        switch count {
        case 1: return .zero
        case 2:
            return index == 0 ? CGSize(width: -spread, height: -spread) : CGSize(width: spread, height: spread)
        default:
            switch index {
            case 0: return CGSize(width: 0, height: -spread * 1.1)
            case 1: return CGSize(width: -spread * 1.1, height: spread * 0.8)
            default: return CGSize(width: spread * 1.1, height: spread * 0.8)
            }
        }
    }
}


/// An agent's position, worn as a quiet capsule.
struct RoleBadge: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 7))
    }
}
