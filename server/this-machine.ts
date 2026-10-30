// What the machine this harness runs on is, and what to call it, in the
// words the app uses for it (src/lib/thisComputer.ts). Bloks ships on
// Windows and Linux too, where "this Mac" reads as a copy-paste slip
// rather than a description. thisMachine is only for the machine this
// process is on: a phone, the hosted machine or a move's other end may be
// something else entirely.
//
// The desktop app has its own copy of thisMachine (electron/hosting-move.mjs),
// because it cannot import this file; test/this-machine.test.ts holds the two
// to each other.

/** A desktop's kind: Mac, PC, or the neutral word for anything else. */
export const MACHINE_KINDS = ["mac", "pc", "computer"] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];

/** What a person joined from, as their app said it. A desktop says its
 * kind; older ones said "mac" whatever they ran on. */
export const DEVICE_KINDS = ["iphone", ...MACHINE_KINDS, "browser"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export function machineKind(platform: string = process.platform): MachineKind {
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "computer";
}

const WORDS: Record<MachineKind, string> = { mac: "this Mac", pc: "this PC", computer: "this computer" };

export function thisMachine(platform?: string): string {
  return WORDS[machineKind(platform)];
}
