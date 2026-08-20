// Pointing the camera at the Mac's pairing QR.
//
// The scanner recognizes QR codes only, locks on the first payload so a
// camera re-reporting the same code sixty times a second cannot spam,
// and hands a validated invite back to the settings screen. Scanning
// never pairs by itself; confirmation stays with the person.
import AVFoundation
import SwiftUI
import VisionKit

struct PairScanView: View {
    /// Called with a parsed invite; returning means the sheet closes.
    let onFound: (PairInvite) -> Void
    @Environment(\.dismiss) private var dismiss

    private enum CameraState {
        case checking
        case ready
        case denied
        case unsupported
    }

    @State private var camera: CameraState = .checking
    @State private var complaint: String?

    var body: some View {
        NavigationStack {
            Group {
                switch camera {
                case .checking:
                    ProgressView()
                case .ready:
                    ZStack(alignment: .bottom) {
                        QRScanner { payload in
                            guard let url = URL(string: payload), let invite = PairInvite.parse(url) else {
                                complaint = "That is not a Bloks pairing code."
                                return false
                            }
                            onFound(invite)
                            dismiss()
                            return true
                        }
                        .ignoresSafeArea()
                        if let complaint {
                            Text(complaint)
                                .font(.footnote)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(.black.opacity(0.7), in: Capsule())
                                .foregroundStyle(.white)
                                .padding(.bottom, 32)
                        }
                    }
                case .denied:
                    VStack(spacing: 10) {
                        Image(systemName: "camera.fill")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text("Bloks needs the camera to scan the pairing code.")
                            .multilineTextAlignment(.center)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                    }
                    .padding()
                case .unsupported:
                    VStack(spacing: 8) {
                        Image(systemName: "keyboard")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text("This device cannot scan. Enter the six digit code from your Mac instead.")
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                }
            }
            .navigationTitle("Scan to pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await resolveCamera() }
        }
    }

    private func resolveCamera() async {
        guard DataScannerViewController.isSupported else {
            camera = .unsupported
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            camera = .ready
        case .notDetermined:
            camera = await AVCaptureDevice.requestAccess(for: .video) ? .ready : .denied
        default:
            camera = .denied
        }
    }
}

/// The OS data scanner wrapped for SwiftUI, QR symbology only. The
/// coordinator locks on the first payload; a rejected one unlocks after
/// a beat so the complaint is readable before the next attempt.
private struct QRScanner: UIViewControllerRepresentable {
    let onPayload: (String) -> Bool

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .fast,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onPayload: (String) -> Bool
        private var locked = false

        init(onPayload: @escaping (String) -> Bool) {
            self.onPayload = onPayload
        }

        func dataScanner(
            _ scanner: DataScannerViewController,
            didAdd added: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !locked else { return }
            for item in added {
                if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                    locked = true
                    if !onPayload(payload) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                            self?.locked = false
                        }
                    }
                    return
                }
            }
        }
    }
}
