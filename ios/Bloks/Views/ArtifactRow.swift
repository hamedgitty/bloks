// A deliverable in the chat, phone edition.
//
// The card mirrors the desktop: type icon, filename, size. Tapping
// downloads the bytes through the paired client and hands them to
// QuickLook, which is the honest native viewer on iOS: it renders
// HTML, PDFs, images, CSV, office files and more without us shipping
// a renderer. The share button inside QuickLook covers "download".
import QuickLook
import SwiftUI

struct ArtifactRow: View {
    let botId: String
    let meta: ArtifactMeta
    @Environment(BloksStore.self) private var store
    @State private var previewURL: URL?
    @State private var loading = false

    private var symbol: String {
        let ext = (meta.name as NSString).pathExtension.lowercased()
        switch ext {
        case "html", "htm": return "curlybraces.square"
        case "pdf": return "doc.richtext"
        case "png", "jpg", "jpeg", "gif", "webp", "svg": return "photo"
        case "csv", "tsv", "xlsx": return "tablecells"
        case "pptx": return "rectangle.on.rectangle.angled"
        default: return "doc.text"
        }
    }

    private var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(meta.size), countStyle: .file)
    }

    var body: some View {
        Button {
            open()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 18))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 38, height: 38)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 1) {
                    Text(meta.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(sizeLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if loading {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "eye")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .quickLookPreview($previewURL)
    }

    /// QuickLook wants a file on disk whose name carries the extension,
    /// so the bytes land in a temp file named like the artifact.
    private func open() {
        guard !loading else { return }
        loading = true
        Task {
            defer { loading = false }
            guard let bytes = try? await store.client.artifact(botId: botId, name: meta.name),
                  !bytes.isEmpty
            else { return }
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("artifacts", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent(meta.name)
            guard (try? bytes.write(to: file)) != nil else { return }
            previewURL = file
        }
    }
}

/// The message a reply answers, floating above the reply as its own
/// small muted bubble with a connector curve, the way Messages draws
/// threads: the quoted line reads first, the answer sits under it.
struct QuotedReplyBubble: View {
    let reply: ReplyRef
    let isOutgoing: Bool

    var body: some View {
        VStack(alignment: isOutgoing ? .trailing : .leading, spacing: 0) {
            Text("\(reply.author): \(reply.excerpt)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Color(uiColor: .secondarySystemFill).opacity(0.55),
                    in: RoundedRectangle(cornerRadius: 16),
                )
            ReplyConnector(isOutgoing: isOutgoing)
                .stroke(Color(uiColor: .systemFill), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .frame(width: 22, height: 12)
                .padding(isOutgoing ? .trailing : .leading, 8)
        }
        .padding(.bottom, 2)
    }
}

/// The little hook between a quoted line and its reply.
struct ReplyConnector: Shape {
    let isOutgoing: Bool

    func path(in rect: CGRect) -> Path {
        var p = Path()
        if isOutgoing {
            p.move(to: CGPoint(x: rect.maxX - 6, y: 0))
            p.addQuadCurve(
                to: CGPoint(x: rect.minX, y: rect.maxY),
                control: CGPoint(x: rect.maxX - 8, y: rect.maxY)
            )
        } else {
            p.move(to: CGPoint(x: rect.minX + 6, y: 0))
            p.addQuadCurve(
                to: CGPoint(x: rect.maxX, y: rect.maxY),
                control: CGPoint(x: rect.minX + 8, y: rect.maxY)
            )
        }
        return p
    }
}
