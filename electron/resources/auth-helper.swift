// Touch ID, for the moments that deserve one.
//
// Most of what an agent does is reversible and the approval card is the
// right amount of friction. A few things are not: handing over a stored
// key, or turning the approval gate off entirely. Those deserve proof
// that the person at the keyboard is the person who owns the machine,
// and on a Mac that proof is LocalAuthentication.
//
// Spawned by Electron main so the prompt is attributed to the app and
// carries its name. Two modes: `check` says whether biometry is usable
// at all, `ask <reason>` raises the prompt and answers with the result.
//
// Writes one word to stdout and nothing else, so the caller can read it
// without parsing. Failure is never fatal here: a Mac with no Touch ID
// says so, and the caller decides what to do about it rather than being
// handed an error it has to interpret.
import Foundation
import LocalAuthentication

let arguments = CommandLine.arguments.dropFirst()
let mode = arguments.first ?? "check"

// deviceOwnerAuthentication, not ...WithBiometrics: a Mac with no Touch
// ID, or a finger that will not read, should fall back to the login
// password rather than refusing outright. The point is proving who is
// there, not insisting on a particular sensor.
let policy = LAPolicy.deviceOwnerAuthentication

let context = LAContext()
context.localizedCancelTitle = "Cancel"

var problem: NSError?
let available = context.canEvaluatePolicy(policy, error: &problem)

if mode == "check" {
    // "biometry" when a sensor is present, "password" when the policy is
    // satisfiable some other way, "unavailable" when it is not.
    if available {
        print(context.biometryType == .none ? "password" : "biometry")
    } else {
        print("unavailable")
    }
    exit(0)
}

guard mode == "ask" else {
    print("unavailable")
    exit(0)
}

guard available else {
    print("unavailable")
    exit(0)
}

let reason = arguments.dropFirst().joined(separator: " ")
let semaphore = DispatchSemaphore(value: 0)
var answer = "denied"

context.evaluatePolicy(policy, localizedReason: reason.isEmpty ? "confirm this action" : reason) {
    granted, error in
    if granted {
        answer = "granted"
    } else if let code = (error as NSError?)?.code,
        code == LAError.userCancel.rawValue || code == LAError.appCancel.rawValue
            || code == LAError.systemCancel.rawValue
    {
        answer = "cancelled"
    }
    semaphore.signal()
}

// A prompt nobody answers must not hold a turn open forever.
if semaphore.wait(timeout: .now() + 120) == .timedOut {
    answer = "cancelled"
}
print(answer)
