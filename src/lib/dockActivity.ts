// What the side dock reads off a conversation to know what its panels are
// doing (GitHub 522): which of an agent's calls are its computer, whether
// one is running or waiting on the person, and the dot each ribbon icon
// carries for it.
//
// Three dots, one colour each, the strongest shown when a panel has more
// than one:
//
//   waiting    orange   the agent is held on the person: an approval for
//                       a computer action, the browser taken over while an
//                       agent waits to have it back, a page dialog an
//                       agent cannot answer.
//   teammate   purple   another person is at it: typing in a shared room.
//   working    blue     an agent is at it now.
//
// None at all when nothing is happening, so a quiet ribbon stays quiet.
//
// The terminal has no dot and is not read here: its shells are the
// person's, in the agent's folder, and an agent's commands run elsewhere,
// so a dot or an opening on them would point at something the agent is
// not doing. No React and no page: the tests read it.
import type { Message } from "../state/reducer.ts";

export type DockStatus = "waiting" | "teammate" | "working";

const RANK: Record<DockStatus, number> = { waiting: 3, teammate: 2, working: 1 };

/** The one dot to show of several: waiting over a teammate over work. */
export function strongest(...statuses: ReadonlyArray<DockStatus | null | undefined>): DockStatus | null {
  let top: DockStatus | null = null;
  for (const s of statuses) if (s && (!top || RANK[s] > RANK[top])) top = s;
  return top;
}

// The computer is one tool surface whichever engine mounts it: Claude Code
// names its calls mcp__computer__*, Codex's server is bloks_computer, the
// OpenAI-compatible driver says computer_exec, and Claude's own computer
// tool is "computer".
const COMPUTER = /^(?:mcp__(?:bloks_)?computer__|bloks_computer[._]|computer(?:_exec)?(?::|$))/i;

/** Whether a call, by its name, is the agent working its computer. */
export function isComputerCall(name: string | undefined): boolean {
  return COMPUTER.test((name ?? "").trim());
}

/** The rows of the turn in progress: everything after the person's last
 * message, and the id of that message, which names the turn. */
export function currentTurn(messages: readonly Message[]): { turn: string; rows: readonly Message[] } {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return { turn: messages[i].id, rows: messages.slice(i + 1) };
  }
  return { turn: "start", rows: messages };
}

/** What the turn in progress has done with the computer: its newest call,
 * by its row's id, and whether one has not said how it went yet. */
export function turnComputerUse(messages: readonly Message[]): { turn: string; latest: string | null; running: boolean } {
  const { turn, rows } = currentTurn(messages);
  let latest: string | null = null;
  let running = false;
  for (const m of rows) {
    if (m.kind !== "activity" || !m.tool || !isComputerCall(m.tool.name)) continue;
    latest = m.id;
    if (m.tool.ok === undefined && !m.tool.stopped) running = true;
  }
  return { turn, latest, running };
}

/** Whether an unanswered approval holds the agent on a computer action. */
export function computerWaiting(messages: readonly Message[]): boolean {
  return messages.some((m) => {
    const card = m.kind === "options" ? m.card : undefined;
    if (!card?.requestId || !card.tool || card.runId) return false;
    if (card.answered || card.dismissed || card.closed || card.cutOff || card.withdrawn) return false;
    return isComputerCall(card.tool);
  });
}

/** The computer's dot, from the conversation it is in. `working` is
 * whether the conversation's turn is still going: a call left without an
 * answer by a turn that ended is not work. */
export function computerStatus(messages: readonly Message[], working: boolean): DockStatus | null {
  if (computerWaiting(messages)) return "waiting";
  return working && turnComputerUse(messages).running ? "working" : null;
}

/** The browser as far as its dot goes (src/lib/appBrowser.ts). */
interface BrowserLike {
  control:
    | { by: "idle" }
    | { by: "agent"; botId: string }
    | { by: "person"; waiting?: { botId: string } };
  tabs: ReadonlyArray<{ dialog?: unknown }>;
}

/** The browser's dot: an agent waiting to have it back, or held by a page's
 * dialog, is waiting; an agent driving it is working. */
export function browserStatus(state: BrowserLike | null | undefined): DockStatus | null {
  if (!state) return null;
  if (state.control.by === "person") return state.control.waiting ? "waiting" : null;
  if (state.control.by !== "agent") return null;
  return state.tabs.some((tab) => tab.dialog) ? "waiting" : "working";
}

/** Whether the browser's tab in front has a page in it, which is when it
 * can be minimized to a picture of it (dock/MiniDock.tsx). */
export function pageOpen(state: { activeTabId: string | null; tabs: ReadonlyArray<{ id: string; url?: string }> } | null | undefined): boolean {
  const url = state?.tabs.find((tab) => tab.id === state.activeTabId)?.url;
  return Boolean(url && url !== "about:blank");
}

/** How long someone's last keystroke in a room counts as them being at it,
 * the same few seconds the room's "typing" line keeps. */
export const TEAMMATE_MS = 6_000;

/** Another person typing in a shared room, recently enough to say so. */
export function teammateActive(typing: { at: number } | undefined, now = Date.now()): boolean {
  return Boolean(typing && now - typing.at < TEAMMATE_MS);
}

// ── this chat's agent, or everyone's ───────────────────────────────────

/** Which browser tabs the dock lists in a chat: every tab (the browser is
 * the workspace's, shared by every agent and the person), or only the
 * ones this chat's agent opened. The tab in front stays listed either
 * way, since its page is the one on screen. Tabs know the agent that
 * opened them, not the conversation, so the agent is as close to "this
 * session" as the browser can say. */
export type TabScope = "agent" | "all";

export function tabsInScope<T extends { id: string; by: { kind: string; botId?: string } }>(
  tabs: readonly T[],
  scope: TabScope,
  botId: string | null | undefined,
  activeId: string | null,
): T[] {
  if (scope === "all" || !botId) return [...tabs];
  return tabs.filter((tab) => tab.id === activeId || (tab.by.kind === "agent" && tab.by.botId === botId));
}
