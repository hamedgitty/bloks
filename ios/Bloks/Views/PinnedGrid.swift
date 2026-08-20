// Pinned conversations, as the grid of big circles Messages puts above the
// list rather than as rows at the top of it.
//
// A pinned conversation leaves the list entirely while it is pinned, which
// is what Messages does and what stops the same agent appearing twice.
// Tiles shrink as more are added so a full set still fits above the fold.
import SwiftUI

struct PinnedGrid: View {
    let conversations: [Conversation]
    let members: (Conversation) -> [Bot]
    let onUnpin: (Bot) -> Void
    /// Pushed programmatically rather than with a NavigationLink: inside a
    /// List row, every nested link picks up the row's disclosure chevron,
    /// and nine of those in a grid of faces looks like a bug.
    let onOpen: (Conversation) -> Void

    var body: some View {
        LazyVGrid(columns: columns, alignment: .center, spacing: 16) {
            ForEach(conversations) { conversation in
                Button {
                    onOpen(conversation)
                } label: {
                    tile(for: conversation)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    if case .agent(let bot) = conversation {
                        Button {
                            onUnpin(bot)
                        } label: {
                            Label("Unpin", systemImage: "pin.slash.fill")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 14)
    }

    /// Messages sizes its pins by how many there are. Three big ones read
    /// as a shortcut; nine small ones read as a grid, and both are right at
    /// their own count.
    private var size: CGFloat {
        switch conversations.count {
        case 0...2: return 82
        case 3...4: return 72
        case 5...6: return 62
        default: return 54
        }
    }

    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: size + 18), spacing: 12)]
    }

    @ViewBuilder
    private func tile(for conversation: Conversation) -> some View {
        VStack(spacing: 6) {
            ZStack(alignment: .topTrailing) {
                switch conversation {
                case .agent(let bot):
                    AgentAvatar(bot: bot, size: size, tile: .circle)
                case .room:
                    RoomAvatar(members: members(conversation), size: size)
                }

                if conversation.isUnread {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 14, height: 14)
                        .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                        .offset(x: 2, y: -2)
                } else if needsApproval(conversation) {
                    // An agent parked on an approval is worth a mark of its
                    // own: unread means "something arrived", this means
                    // "something is stuck until you answer".
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(.orange, Color(uiColor: .systemBackground))
                        .offset(x: 3, y: -3)
                }
            }

            Text(conversation.name)
                .font(.system(size: 12))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: size + 46)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(conversation.name), pinned"
                + (conversation.isUnread ? ", unread" : "")
                + (needsApproval(conversation) ? ", waiting on your approval" : "")
        )
    }

    private func needsApproval(_ conversation: Conversation) -> Bool {
        conversation.messages.contains { message in
            guard message.kind == .options, let card = message.card else { return false }
            return card.isLiveAsk && !card.isSettled
        }
    }
}
