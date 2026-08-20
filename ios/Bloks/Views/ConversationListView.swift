// The conversation list: agents and rooms together, newest first, pinned
// on top. The shape of Messages, because the product really is a messaging
// app and borrowing a convention people already know is free.
import SwiftUI

struct ConversationListView: View {
    @Environment(BloksStore.self) private var store
    @Binding var path: NavigationPath
    @State private var search = ""
    @State private var showNewRoom = false
    @State private var searchDictation = Dictation()
    @State private var filter: ListFilter = .all
    @State private var showConnection = false
    @State private var showActivity = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var store = store

        List {
            // Pinned live in the grid, not in the list, so nothing appears
            // twice. Hidden while searching: a search should show matches,
            // not a layout.
            if !pinned.isEmpty, search.trimmed.isEmpty {
                PinnedGrid(
                    conversations: pinned,
                    members: membersFor,
                    onUnpin: { bot in Task { await store.setPinned(bot: bot, pinned: false) } },
                    onOpen: { path.append($0) }
                )
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }

            ForEach(unpinned) { conversation in
                ZStack {
                    NavigationLink(value: conversation) { EmptyView() }.opacity(0)
                    ConversationRow(
                        conversation: conversation,
                        members: membersFor(conversation)
                    )
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .contextMenu {
                    if case .agent(let bot) = conversation {
                        Button {
                            Task { await store.setPinned(bot: bot, pinned: !(bot.pinned ?? false)) }
                        } label: {
                            Label(bot.pinned == true ? "Unpin" : "Pin",
                                  systemImage: bot.pinned == true ? "pin.slash" : "pin")
                        }
                        Button {
                            Task { await store.markUnread(bot: bot) }
                        } label: {
                            Label("Mark as Unread", systemImage: "message.badge")
                        }
                    }
                }
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    if case .agent(let bot) = conversation {
                        Button {
                            Task { await store.setPinned(bot: bot, pinned: !(bot.pinned ?? false)) }
                        } label: {
                            Label(
                                bot.pinned == true ? "Unpin" : "Pin",
                                systemImage: bot.pinned == true ? "pin.slash.fill" : "pin.fill"
                            )
                        }
                        .tint(.orange)
                    }
                }
            }
        }
        .listStyle(.plain)
        // The header is drawn by hand rather than through the navigation
        // bar: the bar clamps its items to control size, and a wordmark
        // shrunk to control size reads as an afterthought. This screen owns
        // its chrome; pushed screens keep their system bars.
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .sheet(isPresented: $showConnection) { ConnectionSettingsView() }
        .sheet(isPresented: $showActivity) { ActivityView() }
        // a pairing deep link walks straight to the pairing screen
        .onChange(of: store.pendingPairInvite) {
            if store.pendingPairInvite != nil { showConnection = true }
        }
        // POST /api/bots does not broadcast, so an agent made on the Mac
        // reaches this device on the next hydrate rather than instantly.
        // Foregrounding covers it; this is the manual path for when the app
        // was already open.
        .refreshable { await store.hydrate() }
        .sheet(isPresented: $showNewRoom) {
            NewRoomView { id in
                if let made = store.conversation(id: id) { path.append(made) }
            }
        }
        .navigationDestination(for: Conversation.self) { conversation in
            ChatView(conversationId: conversation.id)
        }
        // a widget tap lands here once the roster knows the id
        .onChange(of: store.pendingOpenId) {
            guard let id = store.pendingOpenId else { return }
            store.pendingOpenId = nil
            if let made = store.conversation(id: id) { path.append(made) }
        }
        .overlay {
            if store.conversations.isEmpty {
                emptyState
            } else if filtered.isEmpty {
                ContentUnavailableView.search(text: search)
            }
        }
        .safeAreaInset(edge: .bottom) { connectionBanner }
        .safeAreaInset(edge: .bottom) { bottomBar }
    }

    private var pinned: [Conversation] {
        store.conversations.filter(\.isPinned)
    }

    /// Everything the list itself shows. While searching, pins come back
    /// into the list so a match is never hidden behind the grid.
    private var unpinned: [Conversation] {
        search.trimmed.isEmpty ? filtered.filter { !$0.isPinned } : filtered
    }

    private var filtered: [Conversation] {
        let all = store.conversations.filter(filter.admits)
        let needle = search.trimmed.lowercased()
        guard !needle.isEmpty else { return all }
        return all.filter { conversation in
            if conversation.name.lowercased().contains(needle) { return true }
            if case .agent(let bot) = conversation, bot.title.lowercased().contains(needle) { return true }
            return conversation.messages.contains { ($0.text ?? "").lowercased().contains(needle) }
        }
    }

    private func membersFor(_ conversation: Conversation) -> [Bot] {
        guard case .room(let room) = conversation else { return [] }
        return store.members(of: room)
    }

    @ViewBuilder
    private var emptyState: some View {
        switch store.status {
        case .connecting:
            ProgressView()
        case .offline(let why):
            ContentUnavailableView {
                Label("Bloks is not reachable", systemImage: "wifi.exclamationmark")
            } description: {
                // Say what is actually wrong rather than "something went
                // wrong". This app is useless without the Mac, so the
                // failure has to be legible.
                Text(why)
            } actions: {
                Button("Try again") { Task { await store.hydrate() } }
                // The way out for anyone who has not installed the Mac app
                // yet, and the way App Review sees the product at all.
                Button("Look around a sample") { store.enterDemo() }
            }
        case .connected:
            ContentUnavailableView(
                "No agents yet",
                systemImage: "person.crop.circle.badge.plus",
                description: Text("Make one in Bloks on your Mac and it will show up here.")
            )
        }
    }

    /// A thin, honest strip when the stream is down. The app keeps showing
    /// the transcript it has, but it must not pretend that transcript is
    /// live.
    @ViewBuilder
    private var connectionBanner: some View {
        if case .offline(let why) = store.status, !store.conversations.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "wifi.exclamationmark")
                Text(why)
                    .lineLimit(1)
                Spacer()
                Button("Retry") { Task { await store.hydrate() } }
                    .font(.system(size: 14, weight: .semibold))
            }
            .font(.system(size: 13))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.thinMaterial)
        }
    }

    // ── the bottom bar ─────────────────────────────────────────────────
    // Search and compose live at the bottom, glass over the list, the way
    // Messages arranges them: a thumb reaches the bottom of a phone, not
    // the top. The search capsule carries the magnifier, the field, and a
    // mic that dictates straight into the query; the circle beside it
    // starts a new room.

    private var bottomBar: some View {
        VStack(spacing: 8) {
            if case .unavailable(let why) = searchDictation.state {
                HStack(spacing: 8) {
                    Image(systemName: "mic.slash.fill")
                    Text(why).font(.footnote).lineLimit(2)
                    Button("OK") { searchDictation.clearError() }
                        .font(.footnote.weight(.semibold))
                }
                .foregroundStyle(.orange)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .glassCapsule()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            GlassGroup(spacing: 12) {
                HStack(spacing: 12) {
                    HStack(spacing: 7) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)

                        TextField("Search", text: $search)
                            .focused($searchFocused)
                            .submitLabel(.search)
                            .autocorrectionDisabled()

                        searchTrailing
                    }
                    .padding(.horizontal, 13)
                    .frame(height: 44)
                    .glassCapsule(interactive: true)

                    Button {
                        showNewRoom = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Color.primary)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .glassCircle()
                    .accessibilityLabel("New room")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .animation(.snappy(duration: 0.2), value: searchDictation.isListening)
        .animation(.snappy(duration: 0.2), value: search.isEmpty)
        .onChange(of: searchDictation.transcript) { _, heard in
            guard searchDictation.isListening else { return }
            search = heard
        }
    }

    /// Mic when the field is empty, clear when it is not, stop while
    /// listening. One slot, whichever action is the useful one.
    @ViewBuilder
    private var searchTrailing: some View {
        if searchDictation.isListening {
            Button {
                searchDictation.stop()
                searchFocused = true
            } label: {
                Image(systemName: "mic.fill")
                    .foregroundStyle(Color.accentColor)
                    .symbolEffect(.pulse, isActive: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop dictating")
        } else if search.isEmpty {
            Button {
                Task { await searchDictation.start() }
            } label: {
                Image(systemName: "mic.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dictate a search")
        } else {
            Button {
                search = ""
            } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear search")
        }
    }

    private var header: some View {
        VStack(spacing: 0) {
            HStack {
                Image("BloksWordmark")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 28)
                    .accessibilityLabel("Bloks")

                Spacer()

                Menu {
                    Picker("Filter", selection: $filter) {
                        ForEach(ListFilter.allCases) { choice in
                            Label(choice.label, systemImage: choice.icon).tag(choice)
                        }
                    }
                    Divider()
                    Button {
                        showActivity = true
                    } label: {
                        Label("Activity", systemImage: "waveform.path.ecg")
                    }
                    Button {
                        showConnection = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                } label: {
                    Image(systemName: connectionTrouble
                          ? "exclamationmark.triangle.fill"
                          : "line.3.horizontal.decrease")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(connectionTrouble ? Color.orange : Color.primary)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .glassCircle()
                .accessibilityLabel("Filters and settings")
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 10)

            // A hairline that lets go before the edges, so the header
            // reads as part of the page rather than a bar bolted onto it.
            Rectangle()
                .fill(
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: Color(uiColor: .separator), location: 0.14),
                            .init(color: Color(uiColor: .separator), location: 0.86),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(height: 0.5)
        }
        .background(Color(uiColor: .systemBackground))
    }

    private var connectionTrouble: Bool {
        if case .offline = store.status { return true }
        return false
    }
}

/// The list filters, shaped like the Filter By section in Messages.
enum ListFilter: String, CaseIterable, Identifiable {
    case all, unread, agents, rooms

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All"
        case .unread: return "Unread"
        case .agents: return "Agents"
        case .rooms: return "Rooms"
        }
    }

    var icon: String {
        switch self {
        case .all: return "bubble.left.and.bubble.right"
        case .unread: return "message.badge"
        case .agents: return "person.crop.circle"
        case .rooms: return "person.3"
        }
    }

    func admits(_ conversation: Conversation) -> Bool {
        switch self {
        case .all: return true
        case .unread: return conversation.isUnread
        case .agents: if case .agent = conversation { return true } else { return false }
        case .rooms: if case .room = conversation { return true } else { return false }
        }
    }
}
