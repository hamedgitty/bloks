// Screen Recording TCC helper. CGRequestScreenCaptureAccess() is the only
// reliable way to register the app in the Screen & System Audio Recording
// pane on modern macOS (screencapture and thumbnail APIs silently degrade
// instead of prompting). Spawned by Electron main; TCC attributes the
// request to the app via the responsible-process chain.
import CoreGraphics
import Foundation

let mode = CommandLine.arguments.dropFirst().first ?? "request"
if mode == "check" {
  print(CGPreflightScreenCaptureAccess() ? "granted" : "not-granted")
} else {
  print(CGRequestScreenCaptureAccess() ? "granted" : "not-granted")
}
