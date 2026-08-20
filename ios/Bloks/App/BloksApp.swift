// Bloks for iOS.
//
// This is not Bloks. It is a window onto a Bloks running on your Mac, the
// way the Slack app is a window onto a Slack server. No agent runs here:
// the phone reads threads, sends messages, and answers approval cards.
import SwiftUI
import UserNotifications

/// The one thing an app delegate still does in a SwiftUI app: receive the
/// APNs token. It lands here on Apple's schedule, possibly before the
/// relay credentials exist, so the bridge keeps it until someone with a
/// relay connection asks. It is also the notification-center delegate, so
/// a wake that arrives while the app is open is swallowed rather than
/// shown: the relay buzzes on every approval because it cannot tell a
/// live phone from a zombie socket, and this is the live phone declining
/// the banner it does not need.
@MainActor
final class PushBridge: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static var token: String?
    static var onToken: ((String) -> Void)?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    nonisolated func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            PushBridge.token = hex
            PushBridge.onToken?(hex)
        }
    }

    nonisolated func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // The simulator and unprovisioned builds land here; nothing to do.
    }

    /// A wake delivered while the app is foregrounded: the stream already
    /// carries the real event, so present nothing.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }
}

@main
struct BloksApp: App {
    @UIApplicationDelegateAdaptor(PushBridge.self) private var pushBridge
    // Loads the saved address and, on a paired device, the token out of the
    // Keychain. Falls back to loopback, which is what the Simulator wants.
    @State private var store = BloksStore(client: HTTPClient(connection: ConnectionStore.load()))

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                // bloks://agent/<id> from a widget tap opens that chat
                .onOpenURL { url in
                    if url.host == "agent", let id = url.pathComponents.dropFirst().first {
                        store.pendingOpenId = id
                    } else if url.host == "pair" {
                        // never silently re-target a paired phone
                        guard store.client.connection.token == nil else { return }
                        store.pendingPairInvite = PairInvite.parse(url)
                    }
                }
        }
    }
}
