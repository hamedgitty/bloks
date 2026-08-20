// End to end, past our own relay: the phone's half.
//
// A byte-for-byte mirror of server/relay-crypto.ts. The shared secret is
// the pairing token this phone already holds; the Mac keeps only its
// sha256, so both ends derive the same keys and the relay, which has
// neither, cannot. One key per direction, so nothing this phone seals
// can ever be replayed back to it wearing a response's clothes.
//
// AES-256-GCM under keys from HKDF-SHA256. The envelope is
// base64(JSON {d, n, c}) with the GCM tag riding after the ciphertext,
// exactly as the Mac writes it.
import CryptoKit
import Foundation

enum RelayCrypto {
    static let info = "bloks-relay-v1"

    enum Direction: String {
        case phoneToMac = "phone-to-mac"
        case macToPhone = "mac-to-phone"
    }

    /// The key for one direction, from the pairing token itself.
    static func key(token: String, direction: Direction) -> SymmetricKey {
        let digest = SHA256.hash(data: Data(token.utf8))
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: Data(digest)),
            salt: Data(),
            info: Data("\(info):\(direction.rawValue)".utf8),
            outputByteCount: 32
        )
    }

    /// Seals a JSON value into the envelope the Mac expects.
    static func seal(key: SymmetricKey, deviceId: String, value: [String: Any]) throws -> String {
        let plain = try JSONSerialization.data(withJSONObject: value)
        let sealed = try AES.GCM.seal(plain, using: key)
        let envelope: [String: String] = [
            "d": deviceId,
            "n": Data(sealed.nonce).base64EncodedString(),
            "c": (sealed.ciphertext + sealed.tag).base64EncodedString(),
        ]
        return try JSONSerialization.data(withJSONObject: envelope).base64EncodedString()
    }

    /// Opens an envelope, or nil for anything not sealed for us. A wrong
    /// key, a flipped bit and a forged frame all land in the same place.
    static func open(key: SymmetricKey, payload: String) -> Data? {
        guard
            let raw = Data(base64Encoded: payload),
            let envelope = try? JSONSerialization.jsonObject(with: raw) as? [String: String],
            let nonceData = Data(base64Encoded: envelope["n"] ?? ""),
            let blob = Data(base64Encoded: envelope["c"] ?? ""),
            nonceData.count == 12, blob.count > 16,
            let nonce = try? AES.GCM.Nonce(data: nonceData)
        else { return nil }
        let ciphertext = blob.prefix(blob.count - 16)
        let tag = blob.suffix(16)
        guard
            let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag),
            let plain = try? AES.GCM.open(box, using: key)
        else { return nil }
        return plain
    }

    /// The device id an envelope claims, without touching the ciphertext.
    static func peekDevice(_ payload: String) -> String? {
        guard
            let raw = Data(base64Encoded: payload),
            let envelope = try? JSONSerialization.jsonObject(with: raw) as? [String: String]
        else { return nil }
        return envelope["d"]
    }
}
