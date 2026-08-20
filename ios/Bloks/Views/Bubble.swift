// The bubble, and the inline markdown inside it.
//
// Outgoing is the accent colour with white text on the right; incoming is
// systemGray on the left. Consecutive messages from one speaker group into
// a run with tight spacing, and only the last of a run gets a tail. That
// grouping is what makes a long transcript readable, and it is the part
// people notice is missing without being able to name it.
import SwiftUI

/// A rounded rect, plus the little curl at the bottom corner on the last
/// bubble of a run.
struct BubbleShape: Shape {
    let isOutgoing: Bool
    let hasTail: Bool
    var radius: CGFloat = 18

    func path(in rect: CGRect) -> Path {
        var path = Path(roundedRect: rect, cornerRadius: min(radius, rect.height / 2))
        guard hasTail else { return path }

        // The tail has to swallow the corner arc rather than cross it,
        // otherwise the rounded corner shows through as a notch where the
        // two subpaths meet. So it starts and ends well inside the body and
        // only the curl pokes out past the edge.
        let curl: CGFloat = 6
        let rise = min(16, rect.height)
        let inset: CGFloat = 20

        // Both subpaths must wind the same way. Path(roundedRect:) is
        // clockwise in this y-down space, so a counter-wound tail cancels
        // against it under the nonzero rule and punches a hole in the
        // corner instead of extending it. The mirrored tail is naturally
        // clockwise; the outgoing one has to be built in reverse to match.
        var tail = Path()
        if isOutgoing {
            tail.move(to: CGPoint(x: rect.maxX - inset, y: rect.maxY - rise))
            tail.addLine(to: CGPoint(x: rect.maxX - curl, y: rect.maxY - rise))
            tail.addQuadCurve(
                to: CGPoint(x: rect.maxX + curl, y: rect.maxY),
                control: CGPoint(x: rect.maxX - 1, y: rect.maxY - curl)
            )
            tail.addQuadCurve(
                to: CGPoint(x: rect.maxX - inset, y: rect.maxY),
                control: CGPoint(x: rect.maxX - 4, y: rect.maxY)
            )
        } else {
            tail.move(to: CGPoint(x: rect.minX + inset, y: rect.maxY))
            tail.addQuadCurve(
                to: CGPoint(x: rect.minX - curl, y: rect.maxY),
                control: CGPoint(x: rect.minX + 4, y: rect.maxY)
            )
            tail.addQuadCurve(
                to: CGPoint(x: rect.minX + curl, y: rect.maxY - rise),
                control: CGPoint(x: rect.minX + 1, y: rect.maxY - curl)
            )
            tail.addLine(to: CGPoint(x: rect.minX + inset, y: rect.maxY - rise))
        }
        tail.closeSubpath()
        path.addPath(tail)
        return path
    }
}

/// Where a message sits in a run of messages from the same speaker. Only
/// the last one carries a tail.
struct RunPosition {
    let isFirst: Bool
    let isLast: Bool

    static let only = RunPosition(isFirst: true, isLast: true)
}

/// Light markdown, rendered as views rather than as HTML.
///
/// A port of Markdownish() in src/components/ChatView.tsx: headings,
/// bullets, numbered lines, with bold and code inline. Model output is
/// untrusted, and building views rather than parsing HTML means there is
/// no path from a reply to markup at all.
struct MarkdownishText: View {
    let text: String
    var isOutgoing = false
    /// Room members, so "@Name" can be picked out. Empty in a solo chat,
    /// where there is nobody to address.
    var mentionNames: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                switch line {
                case .blank:
                    Color.clear.frame(height: 6)
                case .heading(let body):
                    inline(body).font(.system(size: 16, weight: .semibold))
                case .bullet(let body):
                    HStack(alignment: .top, spacing: 6) {
                        Text("\u{2022}").foregroundStyle(secondary)
                        inline(body)
                    }
                case .numbered(let number, let body):
                    HStack(alignment: .top, spacing: 6) {
                        Text("\(number).").foregroundStyle(secondary)
                        inline(body)
                    }
                case .plain(let body):
                    inline(body)
                }
            }
        }
    }

    private var secondary: Color {
        isOutgoing ? Color.brandForeground.opacity(0.7) : Color.secondary
    }

    private func inline(_ body: String) -> Text {
        // Inline-only so a stray '#' or '-' in prose cannot restructure the
        // bubble; the line-level cases above already handled structure.
        var attributed = (try? AttributedString(
            markdown: body,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(body)

        // Who a line was aimed at is half its meaning in a room, so the
        // mention is picked out the way the desktop picks it out. Longest
        // name first, or "@Chief of Staff" would colour only "@Chief".
        for name in mentionNames.sorted(by: { $0.count > $1.count }) {
            let needle = "@\(name)"
            var searchRange = attributed.startIndex..<attributed.endIndex
            while let found = attributed[searchRange].range(
                of: needle,
                options: [.caseInsensitive]
            ) {
                attributed[found].foregroundColor = isOutgoing ? .white : .accentColor
                attributed[found].inlinePresentationIntent = .stronglyEmphasized
                guard found.upperBound < attributed.endIndex else { break }
                searchRange = found.upperBound..<attributed.endIndex
            }
        }
        return Text(attributed)
    }

    private enum Line {
        case blank
        case heading(String)
        case bullet(String)
        case numbered(String, String)
        case plain(String)
    }

    private var lines: [Line] {
        text.components(separatedBy: "\n").map { raw in
            let line = raw
            if line.trimmed.isEmpty { return .blank }
            if let match = line.firstMatch(#"^#{1,4}\s+(.*)$"#) { return .heading(match) }
            if let match = line.firstMatch(#"^\s*[-\u{2022}*]\s+(.*)$"#) { return .bullet(match) }
            if let pair = line.firstMatchPair(#"^\s*(\d+)\.\s+(.*)$"#) {
                return .numbered(pair.0, pair.1)
            }
            return .plain(line)
        }
    }
}

extension String {
    /// First capture group, or nil.
    func firstMatch(_ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: self, range: NSRange(startIndex..., in: self)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: self)
        else { return nil }
        return String(self[range])
    }

    /// First two capture groups, or nil.
    func firstMatchPair(_ pattern: String) -> (String, String)? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: self, range: NSRange(startIndex..., in: self)),
              match.numberOfRanges > 2,
              let a = Range(match.range(at: 1), in: self),
              let b = Range(match.range(at: 2), in: self)
        else { return nil }
        return (String(self[a]), String(self[b]))
    }
}
