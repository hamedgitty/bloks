// The pairing token lives here and nowhere else.
//
// Not UserDefaults: that is a plist in the app container, readable from a
// backup and from any file-level access to the device. The token is the
// whole credential for reaching someone's agents, files and logged-in
// accounts through their Mac, so it gets the same treatment a password
// would.
//
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, deliberately:
//   AfterFirstUnlock  so the stream can reconnect in the background
//                     without the phone being unlocked in your hand.
//   ThisDeviceOnly    so it never travels in an iCloud backup to a device
//                     the Mac never paired with.
import Foundation
import Security

enum Keychain {
    private static let service = "dev.bloks.app.pairing"

    static func set(_ value: String?, for account: String) {
        guard let value, !value.isEmpty else {
            remove(account)
            return
        }
        // Delete first: SecItemUpdate on a missing item fails, and the
        // add-then-update dance is more code than it is worth here.
        remove(account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func get(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func remove(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// Where to find the Mac, and what proves we may talk to it.
///
/// Host and port are a preference and live in UserDefaults. The token is a
/// credential and lives in the Keychain. They are stored apart on purpose.
enum ConnectionStore {
    private static let hostKey = "bloks.host"
    private static let portKey = "bloks.port"
    private static let tokenAccount = "bearer"

    static func load() -> BloksConnection {
        let defaults = UserDefaults.standard
        let host = defaults.string(forKey: hostKey) ?? BloksConnection.simulator.host
        let port = defaults.object(forKey: portKey) as? Int ?? BloksConnection.simulator.port
        return BloksConnection(host: host, port: port, token: Keychain.get(tokenAccount))
    }

    static func save(_ connection: BloksConnection) {
        let defaults = UserDefaults.standard
        defaults.set(connection.host, forKey: hostKey)
        defaults.set(connection.port, forKey: portKey)
        Keychain.set(connection.token, for: tokenAccount)
    }

    static func forgetToken() {
        Keychain.remove(tokenAccount)
    }
}
