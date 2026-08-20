// One message, in whichever of the five shapes it is.
//
// The kinds are not variations on a bubble. An `activity` is a tool run and
// renders as an inline chip with no bubble at all, because a bubble says
// "somebody said this" and nobody said it. A `notice` is usually
// instructions for the user, so it is readable prose in a card rather than
// a truncated line of monospace.
import SwiftUI
import UIKit

struct MessageRow: View {
    let message: Message
    let position: RunPosition
    /// The agent that spoke, when the transcript has more than one.
    let speaker: Bot?
    /// Rooms attribute every line; solo chats do not need to.
    let showsAttribution: Bool
    /// Room members, for highlighting who a line was addressed to.
    var mentionNames: [String] = []
    /// Whose deliverables directory an artifact in this row belongs to.
    var artifactBotId: String? = nil
    var onReply: ((Message) -> Void)? = nil
    var onForward: ((Message) -> Void)? = nil
    let onAnswer: (String) -> Void
    let onDismiss: () -> Void

    private var isOutgoing: Bool { message.role == .user }

    var body: some View {
        if message.deleted {
            // Whatever it used to be. The window shows the same line, and
            // a row that simply vanished would leave replies pointing at
            // nothing.
            takenBack
        } else {
            shape
        }
    }

    private var takenBack: some View {
        HStack {
            if isOutgoing { Spacer(minLength: 60) }
            Text("Message taken back")
                .font(.footnote.italic())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(.separator, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                )
            if !isOutgoing { Spacer(minLength: 60) }
        }
    }

    @ViewBuilder private var shape: some View {
        switch message.kind {
        case .text:
            bubble
                .contextMenu {
                    if let onReply {
                        Button {
                            onReply(message)
                        } label: {
                            Label("Reply", systemImage: "arrowshape.turn.up.left")
                        }
                    }
                    if let onForward {
                        Button {
                            onForward(message)
                        } label: {
                            Label("Forward", systemImage: "arrowshape.turn.up.right")
                        }
                    }
                    Button {
                        UIPasteboard.general.string = message.text ?? ""
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
        case .options:
            card
        case .activity:
            activity
        case .notice:
            notice
        case .screen:
            screen
        case .artifact:
            if let meta = message.artifact, let owner = artifactBotId ?? message.from {
                HStack {
                    ArtifactRow(botId: owner, meta: meta)
                        .frame(maxWidth: 300, alignment: .leading)
                    Spacer(minLength: 40)
                }
            }
        case .connector:
            if let meta = message.connector, let owner = artifactBotId ?? message.from {
                HStack {
                    ConnectorRow(botId: owner, messageId: message.id, meta: meta)
                        .frame(maxWidth: 320, alignment: .leading)
                    Spacer(minLength: 30)
                }
            }
        case .secret:
            if let meta = message.secret, let owner = artifactBotId ?? message.from {
                HStack {
                    SecretRow(botId: owner, messageId: message.id, meta: meta)
                        .frame(maxWidth: 320, alignment: .leading)
                    Spacer(minLength: 30)
                }
            }
        case .component:
            if let component = message.component {
                HStack {
                    AnswerComponentView(component: component)
                        .frame(maxWidth: 340, alignment: .leading)
                    Spacer(minLength: 20)
                }
            }
        case .unrecognised:
            EmptyView()
        }
    }

    // MARK: text

    private var bubble: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if isOutgoing {
                Spacer(minLength: 60)
            } else if showsAttribution {
                // The avatar sits beside the last bubble of a run, the way
                // a group chat shows who is talking.
                Group {
                    if position.isLast, let speaker {
                        BlokAvatar(
                            color: speaker.avatarColor,
                            shape: speaker.avatarShape,
                            expression: speaker.avatarExpression,
                            size: 28,
                            tile: .circle
                        )
                    } else {
                        Color.clear.frame(width: 28, height: 28)
                    }
                }
                .accessibilityHidden(true)
            }

            VStack(alignment: isOutgoing ? .trailing : .leading, spacing: 2) {
                if showsAttribution, !isOutgoing, position.isFirst, let speaker {
                    Text(speaker.name)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 12)
                }

                if let reply = message.replyTo {
                    QuotedReplyBubble(reply: reply, isOutgoing: isOutgoing)
                }
                MarkdownishText(
                    text: message.text ?? "",
                    isOutgoing: isOutgoing,
                    mentionNames: mentionNames
                )
                    .font(.body)
                    .foregroundStyle(isOutgoing ? Color.brandForeground : Color.primary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(
                        BubbleShape(isOutgoing: isOutgoing, hasTail: position.isLast)
                            .fill(isOutgoing ? Color.accentColor : Color(uiColor: .secondarySystemFill))
                    )
                    .textSelection(.enabled)
            }

            if !isOutgoing { Spacer(minLength: 60) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            (isOutgoing ? "You said" : "\(speaker?.name ?? "Agent") said") + ": " + (message.text ?? "")
        )
    }

    // MARK: options

    private var card: some View {
        HStack {
            OptionCardView(message: message, speaker: speaker, onAnswer: onAnswer, onDismiss: onDismiss)
            Spacer(minLength: 0)
        }
        .padding(.leading, showsAttribution ? 34 : 0)
    }

    // MARK: activity

    /// A tool run. No bubble: the agent did not say this, it did it.
    private var activity: some View {
        HStack(spacing: 6) {
            Group {
                if let ok = message.tool?.ok {
                    Image(systemName: ok ? "checkmark" : "xmark")
                        .foregroundStyle(ok ? Color.green : Color.red)
                } else {
                    ProgressView().controlSize(.mini)
                }
            }
            .font(.system(size: 11, weight: .semibold))

            Text(message.tool?.name ?? "")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(message.tool?.ok == false ? Color.red : .secondary)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 0)
        }
        .padding(.leading, showsAttribution ? 34 : 2)
        .padding(.vertical, 1)
        .accessibilityLabel("Tool \(message.tool?.name ?? ""), \(message.tool?.ok == true ? "finished" : message.tool?.ok == false ? "failed" : "running")")
    }

    // MARK: notice

    /// The turn itself could not run: no engine installed, a CLI that is
    /// not signed in. The text is usually what to do about it.
    private var notice: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.orange)
                .padding(.top, 2)
            Text(message.text ?? "")
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14).stroke(Color.orange.opacity(0.28), lineWidth: 1)
        )
        .padding(.leading, showsAttribution ? 34 : 0)
        .padding(.trailing, 40)
    }

    // MARK: screen

    private var screen: some View {
        HStack {
            if let image = decodedScreen {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.1), lineWidth: 1)
                    )
                    .accessibilityLabel("A screenshot of the agent's computer")
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, showsAttribution ? 34 : 0)
    }

    /// The mime is pinned to an image allowlist, the same way the desktop
    /// pins it, so a frame can never widen into some other kind of payload.
    private var decodedScreen: UIImage? {
        let allowed: Set<String> = ["image/png", "image/jpeg", "image/webp"]
        guard let png = message.png,
              allowed.contains(message.mime ?? "image/png"),
              let data = Data(base64Encoded: png)
        else { return nil }
        return UIImage(data: data)
    }
}
