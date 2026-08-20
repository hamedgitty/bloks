// A pairing invite, arriving by QR or deep link.
//
// The invite replaces typing, never consent: parsing only prefills the
// pairing screen, and the person still reads what was scanned and taps
// to confirm. Every field is validated to a strict shape because the
// payload comes from a camera pointed at the world; anything malformed
// is rejected whole rather than repaired.
import Foundation

struct PairInvite: Equatable {
    let host: String
    let port: Int
    /// The QR token, or a six digit code from an older Mac.
    let credential: String
    /// Display only, attacker-controllable: sanitized and capped.
    let name: String

    static func parse(_ url: URL) -> PairInvite? {
        guard url.scheme == "bloks", url.host == "pair",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = parts.queryItems
        else { return nil }

        // duplicate keys are how query smuggling starts; refuse them
        let keys = items.map(\.name)
        guard Set(keys).count == keys.count else { return nil }
        func value(_ key: String) -> String? {
            items.first(where: { $0.name == key })?.value
        }

        guard let address = value("address"), !address.isEmpty else { return nil }
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        let host: String
        let portText: String
        if trimmed.hasPrefix("[") {
            // bracketed IPv6: [::1]:8799
            guard let close = trimmed.firstIndex(of: "]") else { return nil }
            host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
            let rest = trimmed[trimmed.index(after: close)...]
            guard rest.hasPrefix(":") else { return nil }
            portText = String(rest.dropFirst())
        } else {
            guard let colon = trimmed.lastIndex(of: ":") else { return nil }
            host = String(trimmed[..<colon])
            portText = String(trimmed[trimmed.index(after: colon)...])
        }
        guard !host.isEmpty, let port = Int(portText), (1...65535).contains(port) else { return nil }

        let token = value("token") ?? ""
        let code = value("code") ?? ""
        let credential: String
        if token.range(of: "^bloks_pair_[A-Za-z0-9_-]{32}$", options: .regularExpression) != nil {
            credential = token
        } else if code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil {
            credential = code
        } else {
            return nil
        }

        let rawName = value("name") ?? "your Mac"
        let name = String(
            rawName.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        ).trimmed
        return PairInvite(
            host: host,
            port: port,
            credential: credential,
            name: String(name.prefix(80)).isEmpty ? "your Mac" : String(name.prefix(80))
        )
    }
}
