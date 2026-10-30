// What to call the machine this harness runs on, in the words the app
// uses for it (src/lib/thisComputer.ts). Bloks ships on Windows and Linux
// too, where "this Mac" reads as a copy-paste slip rather than a
// description. Only for the machine this process is on: a phone, the
// hosted machine or a move's other end may be something else entirely.
export function thisMachine(platform: string = process.platform): string {
  return platform === "darwin" ? "this Mac" : platform === "win32" ? "this PC" : "this computer";
}
