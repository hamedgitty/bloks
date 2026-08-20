// The six shapes an agent can answer with, on a phone.
//
// Mirrors src/components/Gallery.tsx. The server has already checked what
// arrives (server/components.ts), so these render rather than defend, with
// the one exception every bar chart needs: a span of nothing would divide
// by zero, and every bar being equal is a real answer.
//
// A kind this build does not know renders as nothing rather than as an
// error, the same rule the rest of the models follow: a newer harness must
// never blank an older phone's screen.
import SwiftUI

struct AnswerComponentView: View {
    let component: AnswerComponent

    var body: some View {
        switch component.kind {
        case "chart": ChartAnswer(component: component)
        case "table": TableAnswer(component: component)
        case "decision": DecisionAnswer(component: component)
        case "steps": StepsAnswer(component: component)
        case "quote": QuoteAnswer(component: component)
        case "refused": RefusedAnswer(component: component)
        default: EmptyView()
        }
    }
}

/// One frame, so every shape sits in the conversation the same way.
private struct Frame<Content: View>: View {
    var title: String?
    var note: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title, !title.trimmed.isEmpty {
                Text(title).font(.subheadline.weight(.semibold))
            }
            content
            if let note, !note.trimmed.isEmpty {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.separator.opacity(0.6), lineWidth: 0.5)
        )
    }
}

private struct ChartAnswer: View {
    let component: AnswerComponent

    var body: some View {
        let bars = component.bars ?? []
        // Every bar the same, or every bar zero, are real answers. A span
        // of nothing would divide by zero and draw nothing at all, which
        // reads as broken rather than as flat.
        let top = max(bars.map(\.value).max() ?? 0, 0)
        let bottom = min(bars.map(\.value).min() ?? 0, 0)
        let span = (top - bottom) == 0 ? 1 : (top - bottom)

        Frame(title: component.title, note: component.note) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(bars.enumerated()), id: \.offset) { _, bar in
                    HStack(spacing: 10) {
                        Text(bar.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .frame(width: 88, alignment: .leading)
                        GeometryReader { geo in
                            HStack(spacing: 8) {
                                RoundedRectangle(cornerRadius: 5, style: .continuous)
                                    .fill(bar.value < 0 ? Color.red.opacity(0.6) : Color.accentColor)
                                    .frame(
                                        width: max(3, (abs(bar.value) / span) * (geo.size.width - 52)),
                                        height: 14
                                    )
                                Text(number(bar.value))
                                    .font(.caption.monospacedDigit())
                                Spacer(minLength: 0)
                            }
                            .frame(height: geo.size.height, alignment: .leading)
                        }
                        .frame(height: 16)
                    }
                }
            }
        }
    }

    private func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.2f", value)
    }
}

private struct TableAnswer: View {
    let component: AnswerComponent

    var body: some View {
        let columns = component.columns ?? []
        let rows = component.rows ?? []
        Frame(title: component.title, note: component.note) {
            // A wide table scrolls inside its own card rather than pushing
            // the conversation sideways.
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                            Text(column)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 62, alignment: .leading)
                        }
                    }
                    .padding(.bottom, 6)
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        HStack(alignment: .top, spacing: 14) {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(cell).font(.caption).frame(minWidth: 62, alignment: .leading)
                            }
                        }
                        .padding(.vertical, 6)
                        Divider()
                    }
                }
            }
        }
    }
}

private struct DecisionAnswer: View {
    let component: AnswerComponent

    var body: some View {
        Frame(title: component.question) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array((component.options ?? []).enumerated()), id: \.offset) { _, option in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: option.pick == true ? "checkmark.circle.fill" : "circle")
                            .font(.caption)
                            .foregroundStyle(option.pick == true ? Color.accentColor : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).font(.subheadline)
                            if let detail = option.detail, !detail.trimmed.isEmpty {
                                Text(detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(option.pick == true ? Color.accentColor.opacity(0.1) : Color.clear)
                    )
                }
                if let because = component.because, !because.trimmed.isEmpty {
                    Text(because).font(.caption).foregroundStyle(.secondary).padding(.top, 2)
                }
            }
        }
    }
}

private struct StepsAnswer: View {
    let component: AnswerComponent

    var body: some View {
        Frame(title: component.title) {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array((component.steps ?? []).enumerated()), id: \.offset) { _, step in
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: symbol(step.state))
                            .font(.caption2)
                            .foregroundStyle(colour(step.state))
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.label)
                                .font(.caption)
                                .foregroundStyle(step.state == "todo" ? .secondary : .primary)
                            if let detail = step.detail, !detail.trimmed.isEmpty {
                                Text(detail).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private func symbol(_ state: String) -> String {
        switch state {
        case "done": return "checkmark"
        case "failed": return "xmark"
        case "doing": return "circle.dotted"
        default: return "circle"
        }
    }

    private func colour(_ state: String) -> Color {
        switch state {
        case "done": return .green
        case "failed": return .red
        case "doing": return .accentColor
        default: return .secondary
        }
    }
}

private struct QuoteAnswer: View {
    let component: AnswerComponent

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2).fill(Color.accentColor).frame(width: 2)
            VStack(alignment: .leading, spacing: 6) {
                Text(component.text ?? "").font(.subheadline)
                let attribution = [component.from, component.whereFrom]
                    .compactMap { $0?.trimmed }
                    .filter { !$0.isEmpty }
                    .joined(separator: " · ")
                if !attribution.isEmpty {
                    Text(attribution).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct RefusedAnswer: View {
    let component: AnswerComponent

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "nosign").font(.footnote).foregroundStyle(.orange).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(component.what ?? "").font(.subheadline)
                if let because = component.because, !because.trimmed.isEmpty {
                    Text(because).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.orange.opacity(0.3), lineWidth: 0.5)
        )
    }
}
