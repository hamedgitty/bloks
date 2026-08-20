// A thread, solo or a room.
//
// One view serves both, because on the server they are the same thing: a
// room's id and an agent's threadId share one key space and one transcript
// format. The only real difference is that a room attributes every line
// and a solo chat does not need to.
//
// The view is driven by an id rather than a value so it keeps rendering the
// live record from the store as frames arrive, instead of the snapshot that
// happened to be current when it was pushed.
import SwiftUI

struct ChatView: View {
    let conversationId: String

    @Environment(BloksStore.self) private var store
    @State private var showDetails = false
    @State private var replyingTo: ReplyRef?
    @State private var showLanes = false
    @State private var showComputer = false
    @State private var showCall = false
    @State private var forwarding: ForwardPayload?

    var body: some View {
        Group {
            if let conversation = store.conversation(id: conversationId) {
                content(for: conversation)
            } else {
                // The agent was deleted on the Mac while this was open.
                ContentUnavailableView(
                    "This conversation is gone",
                    systemImage: "bubble.left.and.exclamationmark.bubble.right",
                    description: Text("It was deleted in Bloks on your Mac.")
                )
            }
        }
    }

    @ViewBuilder
    private func content(for conversation: Conversation) -> some View {
        let members = membersOf(conversation)
        let isRoom = { if case .room = conversation { return true } else { return false } }()

        // The transcript owns the whole height and the composer floats over
        // it as a bottom inset, so messages scroll underneath the glass
        // instead of stopping above an opaque bar.
        transcript(conversation: conversation, members: members, isRoom: isRoom)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if isRoom, let room = store.room(id: conversationId),
                       let lead = store.lead(of: room), members.count > 1 {
                        Text("\(lead.name) is most senior here and has the final call")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(.thinMaterial)
                    }

                    if let reply = replyingTo {
                        HStack(spacing: 8) {
                            Image(systemName: "arrowshape.turn.up.left")
                                .font(.system(size: 12))
                                .foregroundStyle(Color.accentColor)
                            VStack(alignment: .leading, spacing: 0) {
                                Text("Replying to \(reply.author)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.accentColor)
                                Text(reply.excerpt)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Button {
                                replyingTo = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 16))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(.thinMaterial)
                    }

                    ComposerView(
                placeholder: replyingTo != nil
                    ? "Reply to \(replyingTo?.author ?? "")…"
                    : isRoom ? "Message \(conversation.name), or @name someone" : "Message \(conversation.name)",
                isBusy: busyAgent(in: conversation) != nil,
                onSend: { text in
                    let reply = replyingTo
                    replyingTo = nil
                    Task { await store.send(to: conversation, text: text, replyTo: reply) }
                },
                onInterrupt: {
                    if let busy = busyAgent(in: conversation) {
                        Task { await store.interrupt(bot: busy) }
                    }
                }
                    )
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $forwarding) { payload in
                ForwardSheet(payload: payload) { forwarding = nil }
            }
            .sheet(isPresented: $showComputer) {
                if case .agent(let bot) = conversation {
                    ComputerPeek(bot: bot)
                }
            }
            .fullScreenCover(isPresented: $showCall) {
                if case .agent(let bot) = conversation {
                    CallView(bot: bot)
                } else if case .room(let room) = conversation {
                    GroupCallView(room: room)
                }
            }
        .toolbar {
            ToolbarItem(placement: .principal) {
                // The face is the door to everything about this agent:
                // model, routines, membership. One target instead of a row
                // of glyphs nobody could name.
                Button { showDetails = true } label: {
                    header(for: conversation, members: members)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Details for \(conversation.name)")
            }
            if case .room(let room) = conversation,
               members.contains(where: { $0.voice != nil }) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showCall = true
                    } label: {
                        Image(systemName: "phone")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.primary)
                            .frame(width: 34, height: 34)
                    }
                    .glassCircle()
                    .tint(.primary)
                    .accessibilityLabel("Call \(room.name)")
                }
            }
            if case .agent(let bot) = conversation {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 8) {
                        if bot.voice != nil {
                            Button {
                                showCall = true
                            } label: {
                                Image(systemName: "phone")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Color.primary)
                                    .frame(width: 34, height: 34)
                            }
                            .glassCircle()
                            .tint(.primary)
                            .accessibilityLabel("Call \(bot.name)")
                        }
                        Button {
                            showComputer = true
                        } label: {
                            Image(systemName: "desktopcomputer")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.primary)
                                .frame(width: 34, height: 34)
                        }
                        .glassCircle()
                        .tint(.primary)
                        .accessibilityLabel("What \(bot.name) is doing")
                        Button {
                            withAnimation(.spring(duration: 0.25)) { showLanes.toggle() }
                        } label: {
                            Image(systemName: "line.3.horizontal")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Color.primary)
                                .frame(width: 34, height: 34)
                        }
                        .glassCircle()
                        .tint(.primary)
                        .accessibilityLabel("Tasks for \(bot.name)")
                    }
                }
            }
        }
        .sheet(isPresented: $showDetails) {
            ConversationDetailView(conversationId: conversationId)
        }
        .task(id: conversationId) {
            await store.markRead(conversation)
        }
        .overlay(alignment: .topTrailing) {
            if showLanes, case .agent(let bot) = conversation {
                LaneDropdown(bot: bot) { showLanes = false }
                    .padding(.trailing, 12)
                    .padding(.top, 4)
                    .transition(.scale(scale: 0.92, anchor: .topTrailing).combined(with: .opacity))
                    .zIndex(2)
            }
        }
        .overlay(alignment: .top) {
            if let error = store.error {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.dangerForeground)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    // Opaque, and the palette's red rather than the
                    // system one. At nine tenths over a white page the
                    // system red carried this sentence at 3.3 to 1, and
                    // a message about something going wrong is the last
                    // one that should be hard to read.
                    .background(Color.danger, in: Capsule())
                    .padding(.top, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: store.error)
    }

    // MARK: header

    @ViewBuilder
    private func header(for conversation: Conversation, members: [Bot]) -> some View {
        VStack(spacing: 1) {
            switch conversation {
            case .agent(let bot):
                AgentAvatar(bot: bot, size: 30, tile: .circle)
            case .room:
                RoomAvatar(members: members, size: 30)
            }
            Text(conversation.name)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            if let busy = busyAgent(in: conversation) {
                Text(members.count > 1 ? "\(busy.name) is working" : "working\u{2026}")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: transcript

    @ViewBuilder
    private func transcript(conversation: Conversation, members: [Bot], isRoom: Bool) -> some View {
        let entries = timeline(for: conversation)
        let streamingText = store.streaming[streamingKey(for: conversation)]

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    ForEach(entries) { entry in
                        switch entry.kind {
                        case .separator(let label):
                            Text(label)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)

                        case .message(let message, let position):
                            MessageRow(
                                message: message,
                                position: position,
                                speaker: speaker(of: message, in: conversation, members: members),
                                showsAttribution: isRoom,
                                mentionNames: isRoom ? members.map(\.name) : [],
                                artifactBotId: isRoom ? nil : conversation.botId,
                                onReply: { m in
                                    let author = m.role == .user
                                        ? "You"
                                        : speaker(of: m, in: conversation, members: members)?.name
                                            ?? conversation.name
                                    replyingTo = ReplyRef(
                                        author: author,
                                        excerpt: String((m.text ?? "").replacingOccurrences(of: "\n", with: " ").prefix(140))
                                    )
                                },
                                onForward: { m in
                                    let author = m.role == .user
                                        ? "You"
                                        : speaker(of: m, in: conversation, members: members)?.name
                                            ?? conversation.name
                                    forwarding = ForwardPayload(author: author, text: m.text ?? "")
                                },
                                onAnswer: { answer in
                                    guard let speaker = speaker(of: message, in: conversation, members: members)
                                    else { return }
                                    Task {
                                        await store.answer(
                                            card: message,
                                            in: conversation,
                                            speaker: speaker,
                                            with: answer
                                        )
                                    }
                                },
                                onDismiss: {
                                    guard let speaker = speaker(of: message, in: conversation, members: members)
                                    else { return }
                                    Task {
                                        await store.dismiss(card: message, in: conversation, speaker: speaker)
                                    }
                                }
                            )
                            .padding(.top, position.isFirst ? 6 : 0)
                            .id(message.id)
                        }
                    }

                    if let streamingText, !streamingText.isEmpty {
                        streamingBubble(streamingText)
                            .id("streaming")
                    } else if busyAgent(in: conversation) != nil {
                        TypingIndicator()
                            .padding(.top, 6)
                            .id("typing")
                    }

                    Color.clear.frame(height: 8).id("bottom")
                }
                .padding(.horizontal, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: entries.count) { _, _ in
                withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: streamingText) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    private func streamingBubble(_ text: String) -> some View {
        HStack(alignment: .bottom, spacing: 6) {
            MarkdownishText(text: text)
                .font(.body)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(
                    BubbleShape(isOutgoing: false, hasTail: true)
                        .fill(Color(uiColor: .secondarySystemFill))
                )
            Spacer(minLength: 60)
        }
        .padding(.top, 6)
    }

    // MARK: helpers

    private func routineCount(for conversation: Conversation) -> Int {
        store.routines(for: conversation).filter(\.enabled).count
    }

    private func membersOf(_ conversation: Conversation) -> [Bot] {
        guard case .room(let room) = conversation else {
            if case .agent(let bot) = conversation { return [bot] }
            return []
        }
        return store.members(of: room)
    }

    /// Streaming is keyed by the agent's own threadId even inside a room,
    /// because the provider session belongs to the agent. In a room the
    /// buffer therefore lands under whichever member is speaking.
    private func streamingKey(for conversation: Conversation) -> String {
        switch conversation {
        case .agent(let bot): return bot.threadId
        case .room(let room):
            let busy = store.members(of: room).first { $0.busy == true }
            return busy?.threadId ?? room.id
        }
    }

    private func busyAgent(in conversation: Conversation) -> Bot? {
        switch conversation {
        case .agent(let bot): return bot.busy == true ? bot : nil
        case .room(let room): return store.members(of: room).first { $0.busy == true }
        }
    }

    private func speaker(of message: Message, in conversation: Conversation, members: [Bot]) -> Bot? {
        if let from = message.from { return members.first { $0.id == from } }
        if case .agent(let bot) = conversation { return bot }
        // A room's own opening line has no speaker. Fall back to the lead so
        // a card raised there still has an agent to answer against.
        if case .room(let room) = conversation { return store.lead(of: room) }
        return nil
    }

    // MARK: timeline

    private struct Entry: Identifiable {
        enum Kind {
            case separator(String)
            case message(Message, RunPosition)
        }
        let id: String
        let kind: Kind
    }

    /// Messages, plus a date separator whenever the conversation resumes
    /// after a gap, plus where each message sits in its run so only the
    /// last of a run gets a tail.
    private func timeline(for conversation: Conversation) -> [Entry] {
        let messages = conversation.messages.filter { $0.isRenderable }
        guard !messages.isEmpty else { return [] }

        /// An hour of silence is a new stretch of conversation. Same
        /// instinct as Messages, which stamps a resumed thread rather than
        /// letting yesterday and today run together.
        let gap: TimeInterval = 3600

        var entries: [Entry] = []
        for (index, message) in messages.enumerated() {
            let previous = index > 0 ? messages[index - 1] : nil

            if previous == nil || message.timestamp.timeIntervalSince(previous!.timestamp) > gap {
                entries.append(
                    Entry(id: "sep-\(message.id)", kind: .separator(Stamp.separator(message.timestamp)))
                )
            }

            let next = index + 1 < messages.count ? messages[index + 1] : nil
            let isFirst = previous == nil
                || !sameRun(previous!, message)
                || message.timestamp.timeIntervalSince(previous!.timestamp) > gap
            let isLast = next == nil || !sameRun(message, next!)

            entries.append(
                Entry(
                    id: message.id,
                    kind: .message(message, RunPosition(isFirst: isFirst, isLast: isLast))
                )
            )
        }
        return entries
    }

    /// Two messages belong to one run when the same speaker said both, in
    /// the same shape. A card or a tool run breaks a run of bubbles.
    private func sameRun(_ a: Message, _ b: Message) -> Bool {
        a.role == b.role && a.from == b.from && a.kind == .text && b.kind == .text
    }
}

/// Three dots in a bubble, while an agent is thinking and has not produced
/// a token yet.
struct TypingIndicator: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 7, height: 7)
                    .opacity(0.35 + 0.65 * bounce(index))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            BubbleShape(isOutgoing: false, hasTail: true)
                .fill(Color(uiColor: .secondarySystemFill))
        )
        .onAppear {
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
        .accessibilityLabel("Agent is typing")
    }

    private func bounce(_ index: Int) -> Double {
        let offset = Double(index) * 0.22
        let t = (phase + offset).truncatingRemainder(dividingBy: 1)
        return max(0, sin(t * .pi))
    }
}


/// What a forward carries: who said it and the words, re-posted into
/// another conversation with the origin named.
struct ForwardPayload: Identifiable {
    let author: String
    let text: String
    var id: String { author + text }
}

struct ForwardSheet: View {
    let payload: ForwardPayload
    let onDone: () -> Void
    @Environment(BloksStore.self) private var store
    @State private var sentTo: String?

    private var body_: String {
        "(Forwarded from \(payload.author))\n> " +
            payload.text.trimmed.replacingOccurrences(of: "\n", with: "\n> ")
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.rooms) { room in
                    Button {
                        send(.room(room))
                    } label: {
                        row(name: room.name, subtitle: "\(room.memberIds.count) agents", id: room.id)
                    }
                }
                ForEach(store.bots.filter { !($0.hidden ?? false) }) { bot in
                    Button {
                        send(.agent(bot))
                    } label: {
                        row(name: bot.name, subtitle: bot.title, id: bot.id)
                    }
                }
            }
            .navigationTitle("Forward to…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDone)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(name: String, subtitle: String, id: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.body.weight(.medium)).foregroundStyle(.primary)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if sentTo == id {
                Text("Sent").font(.caption).foregroundStyle(Color.accentColor)
            }
        }
    }

    private func send(_ target: Conversation) {
        guard sentTo == nil else { return }
        sentTo = target.id
        Task {
            await store.send(to: target, text: body_)
            try? await Task.sleep(for: .seconds(0.4))
            onDone()
        }
    }
}


/// The lane switcher: existing tasks with their live state, and a way to
/// open a new one. A custom panel rather than a system menu so the state
/// dots, the check, and the cap all read the way the desktop strip does.
struct LaneDropdown: View {
    let bot: Bot
    let onClose: () -> Void
    @Environment(BloksStore.self) private var store

    private var lanes: [TaskSummary] {
        bot.tasks ?? [TaskSummary(id: bot.threadId, title: "General", state: "idle")]
    }

    private func dot(_ state: String) -> Color {
        switch state {
        case "working": return .accentColor
        case "needs-you": return .orange
        default: return Color(.systemFill)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(lanes) { lane in
                Button {
                    onClose()
                    if lane.id != bot.activeTaskId {
                        Task { await store.activateTask(bot: bot, taskId: lane.id) }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Circle().fill(dot(lane.state)).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(lane.title)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            if lane.state == "needs-you" {
                                Text("Waiting on you").font(.caption2).foregroundStyle(.orange)
                            } else if lane.state == "working" {
                                Text("Working…").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 12)
                        if lane.id == (bot.activeTaskId ?? bot.threadId) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if lane.id != lanes.last?.id { Divider().padding(.leading, 32) }
            }

            if lanes.count < 3 {
                Divider()
                Button {
                    onClose()
                    Task { await store.createTask(bot: bot) }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(Color.accentColor)
                        Text("New task")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                        Spacer()
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(width: 250)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Color.primary.opacity(0.08))
        )
        .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }
}


/// A porthole into the agent's computer: the latest screen frame the
/// harness captured, refreshed live as new frames land in the thread.
struct ComputerPeek: View {
    let bot: Bot
    @Environment(\.dismiss) private var dismiss

    private var latestFrame: Message? {
        bot.messages.last(where: { $0.kind == .screen && !($0.png ?? "").isEmpty })
    }

    var body: some View {
        NavigationStack {
            Group {
                if let frame = latestFrame,
                   let data = Data(base64Encoded: frame.png ?? ""),
                   let image = UIImage(data: data) {
                    ScrollView {
                        VStack(spacing: 10) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 14)
                                        .strokeBorder(Color.primary.opacity(0.1))
                                )
                            HStack(spacing: 6) {
                                if bot.busy ?? false {
                                    Circle().fill(Color.green).frame(width: 7, height: 7)
                                    Text("Working now")
                                } else {
                                    Text("From its last turn, \(frame.timestamp.formatted(date: .omitted, time: .shortened))")
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding()
                    }
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "desktopcomputer")
                            .font(.system(size: 34))
                            .foregroundStyle(.tertiary)
                        Text("Nothing on screen yet")
                            .font(.headline)
                        Text("When \(bot.name) works on a computer, what it sees shows up here.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 40)
                    }
                }
            }
            .navigationTitle("\(bot.name)'s computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
