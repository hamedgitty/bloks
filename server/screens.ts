// What an engine can be handed to see and act with: the agent's own
// browser, and a computer (the cloud box, the Local VM, or this Mac).
//
// The harness decides per turn what an agent may have (its settings, who
// started the turn), and the engine's driver turns that into tools. Not
// every engine can take every one: Claude Code mounts them all as MCP
// servers, most ACP agents do too, an API model reaches the cloud box
// through the harness's own tool loop and nothing else, and some engines
// take no MCP servers from Bloks at all. Each driver says which it takes
// (ProviderAdapter.capabilities.screens), and everything else follows
// from that one answer: a Local VM is never claimed for a turn that
// could not use it, a cloud box is not woken for one, the agent is never
// told of tools it does not have, and the agent's settings say so next
// to Its own browser and Computer (GitHub 472).
//
// Pure: no provider calls, no files.
import type { ComputerMode } from "./hosted.ts";

/** A computer an engine can be handed: the cloud box, the Local VM (saved
 * as "sandbox"), or the screen of the Mac Bloks runs on. */
export type ComputerKind = "cloud" | "vm" | "mac";

export interface EngineScreens {
  /** The agent's own browser (SendTurnInput.integrations.browser). */
  browser: boolean;
  /** The computers it can work, of the three. */
  computers: readonly ComputerKind[];
}

/** Every one of them, as MCP servers. */
export const ALL_SCREENS: EngineScreens = { browser: true, computers: ["cloud", "vm", "mac"] };

/** The cloud box alone: an API model's tool loop reaches it through the
 * box's own API, and the box's own agent runs on it. */
export const CLOUD_ONLY: EngineScreens = { browser: false, computers: ["cloud"] };

/** None: what an engine that does not say is taken to take. */
export const NO_SCREENS: EngineScreens = { browser: false, computers: [] };

/** What an engine takes, from its capabilities. An engine that does not
 * say takes nothing: an honest "no tools" beats a promise it cannot keep. */
export function engineScreens(capabilities: { screens?: EngineScreens } | undefined): EngineScreens {
  return capabilities?.screens ?? NO_SCREENS;
}

/** The kind of computer a saved Computer setting names, or null for
 * Automatic and Off. */
export function computerKind(mode: ComputerMode | null | undefined): ComputerKind | null {
  return mode === "cloud" ? "cloud" : mode === "sandbox" ? "vm" : mode === "local" ? "mac" : null;
}

/**
 * The computer an agent's setting asks for that its engine cannot take,
 * or null when there is none. "any" is Automatic on an engine that takes
 * none of what Automatic would have picked here. Off, a hosted workspace
 * (where the machine is the computer, and nothing is handed over as a
 * tool) and a turn whose computer is withheld anyway are never barred.
 */
export function barredComputer(
  wants: ComputerMode | null | undefined,
  screens: EngineScreens,
  o: { hosted: boolean; withheld: boolean; boxConfigured: boolean; ownScreen: boolean },
): ComputerKind | "any" | null {
  if (o.hosted || o.withheld || wants === "off") return null;
  const kind = computerKind(wants);
  // this computer's screen off a Mac is no screen on any engine, and
  // noComputerLine says why without blaming the engine
  if (kind === "mac" && !o.ownScreen) return null;
  if (kind) return screens.computers.includes(kind) ? null : kind;
  // Automatic picks the cloud box when there is one, and this Mac's own
  // screen when there is not. Barred only when the engine takes neither
  // of what was there to pick: one it can take is still picked.
  const candidates: ComputerKind[] = [...(o.boxConfigured ? ["cloud" as const] : []), ...(o.ownScreen ? ["mac" as const] : [])];
  return candidates.length && !candidates.some((candidate) => screens.computers.includes(candidate)) ? "any" : null;
}

/** Said with each line below: the screen is not where the agent runs. */
const SHELL_UNTOUCHED = "That is only about a screen: your commands and files are not affected, and run as usual.";

const COMPUTER_NAMES: Record<ComputerKind, string> = {
  cloud: "the cloud box",
  vm: "the Local VM",
  mac: "this computer's screen",
};

/** What an agent is told when its setting asks for a computer its engine
 * cannot take. `engine` is the engine's name as the person sees it. */
export function engineNoComputerLine(engine: string, barred: ComputerKind | "any"): string {
  const asked =
    barred === "any"
      ? `Your computer is left on Automatic, but ${engine}, the engine you run on, cannot be handed any computer Bloks has here`
      : `You are set to use ${COMPUTER_NAMES[barred]}, but ${engine}, the engine you run on, cannot be handed it`;
  return ` ${asked}, so you have no screen to see or click and no computer tools. ${SHELL_UNTOUCHED} If a task needs a screen, or you are asked whether you can see a computer, say so plainly: the person can move you to an engine that takes it, such as Claude Code, in your settings under Engine.`;
}

/** What an agent with Its own browser on is told when its engine cannot
 * take the browser. */
export function engineNoBrowserLine(engine: string): string {
  return ` Your settings give you a browser of your own, but ${engine}, the engine you run on, cannot be handed it, so you have no browser tools from Bloks. Your commands and files are not affected. If a task needs a real browser, say so plainly: the person can move you to an engine that takes it, such as Claude Code, in your settings under Engine.`;
}
