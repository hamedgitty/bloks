// Which face an agent wears.
//
// A hand port of expressionForBot() in src/lib/mascot.ts. Live state wins
// first, then the keyword groups, which deliberately overlap as little as
// possible so an agent's look stays put while its title is being edited.
//
// The patterns are word-anchored exactly as the TypeScript is, because
// tokenising instead would break "long-running" and quietly move an agent
// off `sleepy`.
import Foundation

enum AgentAppearance {
    /// Ordered: the first group that matches wins.
    private static let groups: [(pattern: String, expression: BlokExpression)] = [
        (#"\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b"#, .focused),
        (#"\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b"#, .thinking),
        (#"\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b"#, .excited),
        (#"\b(overnight|night|background|async|queue|batch|long-running)\b"#, .sleepy),
        (#"\b(monitor|monitoring|incident|alert|watch|status|uptime)\b"#, .surprised),
        (#"\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b"#, .skeptical),
        (#"\b(security|secure|compliance|risk|privacy|finance|financial)\b"#, .worried),
        (#"\b(design|designer|creative|brainstorm|art|illustration|music|story)\b"#, .mischievous),
        (#"\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b"#, .friendly),
    ]

    private static let compiled: [(regex: NSRegularExpression, expression: BlokExpression)] = groups.compactMap {
        guard let regex = try? NSRegularExpression(pattern: $0.pattern, options: [.caseInsensitive]) else {
            return nil
        }
        return (regex, $0.expression)
    }

    static func expression(for bot: Bot) -> BlokExpression {
        if let declared = bot.mascotExpression, let expression = BlokExpression(rawValue: declared) {
            return expression
        }

        let last = bot.messages.last
        if last?.kind == .activity, last?.tool?.ok == false { return .worried }
        if bot.busy == true { return .focused }
        if bot.unread { return .surprised }
        if last?.kind == .options { return .thinking }

        let profile = "\(bot.name) \(bot.title) \(bot.description)".lowercased()
        let range = NSRange(profile.startIndex..., in: profile)
        for entry in compiled where entry.regex.firstMatch(in: profile, range: range) != nil {
            return entry.expression
        }
        return .deadpan
    }

    static func shape(for bot: Bot) -> BlokShape {
        BlokShape.forAgent(id: bot.id, name: bot.name, declared: bot.shape)
    }

    static func color(for bot: Bot) -> BlokColor {
        BlokColor.named(bot.color)
    }
}

extension Bot {
    var avatarColor: BlokColor { AgentAppearance.color(for: self) }
    var avatarShape: BlokShape { AgentAppearance.shape(for: self) }
    var avatarExpression: BlokExpression { AgentAppearance.expression(for: self) }
}
