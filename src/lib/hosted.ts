// Where an agent may act, as the computer settings offer it.
//
// The agent's settings card and the Computer panel both list these, and
// they must never disagree, so both read this. On a Mac it is the four
// homes the app has always offered. A hosted workspace sends its own,
// shorter list (server/hosted.ts): this machine and off, since the
// machine is the agents' computer already and a box or a VM would be a
// computer inside it. Windows and Linux send three: their own screen is
// not something an agent can work there.

export type ComputerMode = "cloud" | "sandbox" | "local" | "off";

const MAC_COMPUTERS: ReadonlyArray<readonly [ComputerMode, string]> = [
  ["cloud", "Cloud box"],
  ["sandbox", "Local VM"],
  ["local", "This computer"],
  ["off", "Off"],
];

/** The choices to show: the server's when it sent any, else a Mac's. */
export function computerOptions(fromServer?: Array<{ id: ComputerMode; label: string }> | null): ReadonlyArray<readonly [ComputerMode, string]> {
  return fromServer?.length ? fromServer.map((choice) => [choice.id, choice.label] as const) : MAC_COMPUTERS;
}

/** Whether an agent can be given the computer Bloks runs on. Off a Mac
 * the server leaves "This computer" out, since nothing there can work
 * its screen (GitHub 377), so Automatic must not promise it either. */
export function offersThisComputer(fromServer?: Array<{ id: ComputerMode; label: string }> | null): boolean {
  return computerOptions(fromServer).some(([mode]) => mode === "local");
}
