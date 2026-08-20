import SwiftUI

struct RootView: View {
    @Environment(BloksStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    @State private var path = NavigationPath()
    // The one-time cinematic. Read once at launch so finishing it mid-run
    // animates the overlay away instead of re-evaluating storage.
    @State private var introShowing = UserDefaults.standard.object(forKey: "bloksIntroDone") == nil

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                demoBanner
                stack
            }
            if introShowing {
                IntroView {
                    withAnimation(.easeOut(duration: 0.4)) { introShowing = false }
                }
                .transition(.opacity)
                .zIndex(1)
            }
        }
        .task {
            await store.hydrate()
            store.connect()
        }
        // Text scales with the reader's setting, but not without limit:
        // past accessibility3 a chat bubble becomes one word per line and
        // the layout stops being a conversation. The system sizes below
        // that all lay out correctly.
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                store.connect()
                Task { await store.hydrate() }
                // registration is idempotent and only meaningful once the
                // relay exists; calling it on every foreground is how a
                // rotated token or a re-registration after a relay restart
                // actually reaches the relay
                store.registerForPush()
            case .background:
                store.disconnect()
            default:
                break
            }
        }
    }

    /// Always visible while the sample is showing. The whole risk of a demo
    /// mode is somebody believing it, so leaving is one tap and the label
    /// never goes away.
    @ViewBuilder
    private var demoBanner: some View {
        if store.isDemo {
            HStack(spacing: 8) {
                Image(systemName: "eye.fill")
                Text("Sample workspace. These agents are not real.")
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                Button("Exit") { store.exitDemo() }
                    .font(.footnote.weight(.semibold))
            }
            .font(.footnote)
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(Color.accentColor)
        }
    }

    private var stack: some View {
        NavigationStack(path: $path) {
            // Its toolbar (wordmark, filters, settings) lives inside the
            // list view now, next to the state it controls.
            ConversationListView(path: $path)
        }
    }

}
