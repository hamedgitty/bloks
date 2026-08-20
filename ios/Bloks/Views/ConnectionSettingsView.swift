// Where the Mac is, and pairing with it.
//
// On the Simulator none of this is needed: the request comes from the Mac's
// own loopback and the harness waves it through. On a real phone the server
// has to be answering the network at all (off by default, and turning it on
// needs a restart of Bloks on the Mac), and this device needs a token it can
// only get by reading a six digit code off the Mac's screen.
//
// The copy here does a lot of work, because every failure in this flow looks
// identical from the phone: "it did not connect". Saying which of the four
// things is missing is most of the feature.
import SwiftUI

struct ConnectionSettingsView: View {
    @AppStorage("bloksRoleBadges") private var showRoleBadges = true
    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var host = ""
    @State private var port = ""
    @State private var code = ""
    @State private var showScanner = false
    @State private var working = false
    @State private var message: String?
    @State private var failed = false

    #if DEBUG
    @State private var showGallery = false
    #endif

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NavigationLink {
                        UsageView()
                    } label: {
                        Label("Usage", systemImage: "chart.bar.fill")
                    }
                } footer: {
                    Text("What your agents have spent.")
                }

                Section {
                    LabeledContent("Status") {
                        switch store.status {
                        case .connected:
                            Label("Connected", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .labelStyle(.titleAndIcon)
                        case .connecting:
                            Text("Connecting")
                                .foregroundStyle(.secondary)
                        case .offline:
                            Label("Not reachable", systemImage: "exclamationmark.circle.fill")
                                .foregroundStyle(.orange)
                                .labelStyle(.titleAndIcon)
                        }
                    }
                    if case .offline(let why) = store.status {
                        Text(why)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Your Mac")
                }

                Section {
                    Toggle("Role badges", isOn: $showRoleBadges)
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("Show each agent's position beside its name in the conversation list.")
                }

                Section {
                    // Clear buttons, because the common case is replacing a
                    // whole address rather than editing one character of it,
                    // and an IP is miserable to backspace through on a phone.
                    HStack {
                        TextField("127.0.0.1", text: $host)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        if !host.isEmpty {
                            Button {
                                host = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Clear address")
                        }
                    }
                    HStack {
                        TextField("8799", text: $port)
                            .keyboardType(.numberPad)
                        if !port.isEmpty {
                            Button {
                                port = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Clear port")
                        }
                    }
                } header: {
                    Text("Address")
                } footer: {
                    Text("Bloks on your Mac shows the address to use under Settings, once you turn on pairing. Leave this as 127.0.0.1 when running in the Simulator.")
                }

                Section {
                    if store.connection.token != nil {
                        LabeledContent("This device") {
                            if store.pairingRejected {
                                // Holding a token is not the same as being
                                // paired. If the Mac revoked this device,
                                // say so rather than showing a green tick.
                                Label("Revoked on your Mac", systemImage: "xmark.seal.fill")
                                    .foregroundStyle(.orange)
                                    .labelStyle(.titleAndIcon)
                            } else {
                                Label("Paired", systemImage: "checkmark.seal.fill")
                                    .foregroundStyle(.green)
                                    .labelStyle(.titleAndIcon)
                            }
                        }
                        if store.pairingRejected {
                            Text("Forget this pairing, then start a new code on your Mac.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Button("Forget this pairing", role: .destructive) {
                            store.unpair()
                            message = "Pairing forgotten on this device. Revoke it on the Mac too if the phone was lost."
                            failed = false
                        }
                    } else if let invite = store.pendingPairInvite {
                        // the scanned invite, spelled out; pairing is a tap,
                        // not a side effect of scanning
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Pair with \(invite.name)?")
                                .font(.system(size: 15, weight: .semibold))
                            Text("\(invite.host):\(String(invite.port))")
                                .font(.system(.footnote, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        HStack {
                            Button {
                                Task { await pairWithInvite(invite) }
                            } label: {
                                if working { ProgressView() } else { Text("Pair this device") }
                            }
                            .disabled(working)
                            Spacer()
                            Button("Not now", role: .cancel) {
                                store.pendingPairInvite = nil
                            }
                            .foregroundStyle(.secondary)
                        }
                    } else {
                        Button {
                            showScanner = true
                        } label: {
                            Label("Scan the QR on your Mac", systemImage: "qrcode.viewfinder")
                        }
                        TextField("000000", text: $code)
                            .keyboardType(.numberPad)
                            .font(.system(.title2, design: .monospaced))
                            .onChange(of: code) { _, new in
                                // Six digits, nothing else. The field is the
                                // only place a typo is recoverable, and a
                                // wrong guess burns one of five tries.
                                let digits = new.filter(\.isNumber)
                                code = String(digits.prefix(6))
                            }
                        Button {
                            Task { await pair() }
                        } label: {
                            if working {
                                ProgressView()
                            } else {
                                Text("Pair this device")
                            }
                        }
                        .disabled(code.count != 6 || working)
                    }
                } header: {
                    Text("Pairing")
                } footer: {
                    Text("On your Mac, open Bloks, turn on pairing, and start a new code. Codes last five minutes and work once.")
                }

                if let message {
                    Section {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(failed ? Color.red : Color.secondary)
                    }
                }

                Section {
                    Button("Apply and reconnect") {
                        apply()
                    }
                } footer: {
                    Text("Bloks reads your agents from the app on your Mac. Nothing leaves your network.")
                }

                #if DEBUG
                Section("Debug") {
                    Button("Avatar gallery") { showGallery = true }
                }
                #endif
            }
            .sheet(isPresented: $showScanner) {
                PairScanView { invite in
                    store.pendingPairInvite = invite
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            #if DEBUG
            .sheet(isPresented: $showGallery) { AvatarGallery() }
            #endif
        }
        .onAppear {
            host = store.connection.host
            port = String(store.connection.port)
        }
    }

    private func apply() {
        let cleanHost = host.trimmed.isEmpty ? BloksConnection.simulator.host : host.trimmed
        let cleanPort = Int(port.trimmed) ?? BloksConnection.simulator.port
        store.reconnect(host: cleanHost, port: cleanPort)
        message = "Reconnecting to \(cleanHost):\(cleanPort)."
        failed = false
    }

    private func pairWithInvite(_ invite: PairInvite) async {
        working = true
        defer { working = false }
        host = invite.host
        port = String(invite.port)
        do {
            try await store.pair(host: invite.host, port: invite.port, code: invite.credential)
            store.pendingPairInvite = nil
            message = "Paired with \(invite.name). This device can now reach your agents."
            failed = false
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }

    private func pair() async {
        working = true
        defer { working = false }
        // Apply the address first: a code is claimed against a specific
        // Mac, and pairing against the old one would fail confusingly.
        let cleanHost = host.trimmed.isEmpty ? BloksConnection.simulator.host : host.trimmed
        let cleanPort = Int(port.trimmed) ?? BloksConnection.simulator.port
        do {
            try await store.pair(host: cleanHost, port: cleanPort, code: code)
            message = "Paired. This device can now reach your agents."
            failed = false
            code = ""
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }
}
