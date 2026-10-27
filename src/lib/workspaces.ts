// The workspaces on this computer, as the window sees them.
//
// The list belongs to the main process (electron/workspaces.mjs); this
// keeps one copy of it for every component that draws a workspace, and
// says the small things those components say the same way: "Just me" or
// how many people, how long a mute lasts, which number key reaches which
// workspace. Outside the desktop app there are no workspaces, and every
// piece of this answers as if there were one.
import { useSyncExternalStore } from "react";
import type { WorkspaceInfo, WorkspacesState } from "@/types/bridge";
import { formatDate, t, type MessageKey } from "./i18n.ts";

let state: WorkspacesState = { available: false };
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function start() {
  if (started) return;
  started = true;
  const bridge = typeof window === "undefined" ? undefined : window.bloks;
  if (!bridge?.workspacesState) return;
  bridge.onWorkspaces?.((next) => {
    state = next;
    emit();
  });
  void bridge
    .workspacesState()
    .then((next) => {
      state = next;
      emit();
    })
    .catch(() => {});
}

const subscribe = (l: () => void) => {
  start();
  listeners.add(l);
  return () => listeners.delete(l);
};
const read = () => state;

export function useWorkspaces(): WorkspacesState {
  return useSyncExternalStore(subscribe, read, read);
}

/** The plan the app keeps for its one licence, the same in every
 * workspace on this computer; undefined outside the app or before
 * anyone has said. */
export function appPlanOf(s: WorkspacesState): "cloud" | "team" | null | undefined {
  return s.available ? s.plan : undefined;
}

/** The workspace this window shows, when there are workspaces. */
export function currentWorkspace(s: WorkspacesState): WorkspaceInfo | null {
  return s.available ? (s.workspaces.find((w) => w.id === s.current) ?? null) : null;
}

/** "Just me", how many people, or "Team" before anyone has counted. A
 * workspace you joined says what you are there instead. */
export function peopleLabel(ws: Pick<WorkspaceInfo, "team" | "members" | "kind"> & { role?: "member" | "admin" }): string {
  if (ws.kind === "joined") return ws.role === "admin" ? t("workspaces.admin") : t("workspaces.member");
  if (!ws.team) return t("workspaces.justMe");
  if (ws.members === null) return t("workspaces.team");
  return t("workspaces.members", { count: ws.members });
}

/** The plain line a joined workspace reached only on its owner's own
 * network carries, or your hosted one, or null. */
export function reachLine(ws: Pick<WorkspaceInfo, "kind" | "host"> & { lanOnly?: boolean }): string | null {
  if (ws.kind === "hosted") return t("workspaces.reach.hosted");
  if (ws.kind !== "joined" || !ws.lanOnly) return null;
  return ws.host ? t("workspaces.reach.hostsNetwork", { host: ws.host }) : t("workspaces.reach.ownersNetwork");
}

/** What the kind is called on its own line, under a name. */
export function kindLabel(ws: Pick<WorkspaceInfo, "kind" | "team">): string {
  if (ws.kind === "joined") return t("workspaces.kind.joined");
  if (ws.kind === "hosted") return t("workspaces.kind.hosted");
  return ws.team ? t("workspaces.kind.team") : t("workspaces.justMe");
}

/** One mute choice. Its label is read when it is drawn, so the menu
 * speaks the language chosen after this module loaded. */
const muteChoice = (id: string, key: MessageKey) => ({
  id,
  get label(): string {
    return t(key);
  },
});

/** The mute menu's choices, in the order it lists them; the main process
 * holds the same list (electron/workspaces.mjs MUTE_CHOICES). */
export const MUTE_CHOICES: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  muteChoice("15m", "workspaces.mute.for15m"),
  muteChoice("1h", "workspaces.mute.for1h"),
  muteChoice("3h", "workspaces.mute.for3h"),
  muteChoice("8h", "workspaces.mute.for8h"),
  muteChoice("24h", "workspaces.mute.for24h"),
  muteChoice("forever", "workspaces.mute.forever"),
];

/** How a mute reads beside its switch: "Until 3:40 PM", "Until tomorrow,
 * 9:00 AM", "Until you turn it back on", or null when not muted. */
export function muteLabel(mute: WorkspaceInfo["mute"], now = Date.now()): string | null {
  if (!mute.muted) return null;
  if (mute.until === "forever" || mute.until === null) return t("workspaces.mute.untilBackOn");
  const at = new Date(mute.until);
  const time = formatDate(at, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  const sameDay = at.toDateString() === today.toDateString();
  if (sameDay) return t("workspaces.mute.until", { time });
  const tomorrow = new Date(now + 86_400_000);
  if (at.toDateString() === tomorrow.toDateString()) return t("workspaces.mute.untilTomorrow", { time });
  return t("workspaces.mute.untilDay", { day: formatDate(at, { weekday: "short" }), time });
}

/** The workspace number keys reach the nth in the list, as the switcher
 * lists them. */
export function workspaceForKey(s: WorkspacesState, digit: number): WorkspaceInfo | null {
  if (!s.available || digit < 1 || digit > 9) return null;
  return s.workspaces[digit - 1] ?? null;
}

// ── reordering the list ────────────────────────────────────────────────
// The order is the list's own (electron/workspaces.mjs reorder), kept by
// the app and used wherever workspaces are listed: the switcher, number
// keys, the command palette, and the list a paired phone is given.

/** Where a row being dragged would land: past every other row whose
 * middle its own middle has crossed. `centers` are the rows' middles as
 * they stood when it was lifted; `y` is the lifted row's middle now. */
export function dropIndex(centers: readonly number[], from: number, y: number): number {
  return centers.filter((c, i) => i !== from && c < y).length;
}

/** The ids with one of them moved to `to`, counted in the new order. */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids];
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id!);
  return next;
}

/** Whether anything is worth a dot beside a workspace in the switcher:
 * something waiting there, while you are somewhere else. */
export function hasWaiting(ws: WorkspaceInfo, current: string): boolean {
  return ws.id !== current && ws.waiting > 0;
}

// ── the dialogs a workspace opens from anywhere ────────────────────────
// New workspace and Join a workspace open from the switcher, the command
// palette and the settings, so whether each is open lives here rather
// than in any one of them (the way confirm() works, ui/confirm.tsx).

type Dialog = "new" | "join" | null;
let dialog: Dialog = null;
const dialogListeners = new Set<() => void>();
const subscribeDialog = (l: () => void) => {
  dialogListeners.add(l);
  return () => dialogListeners.delete(l);
};

export function openWorkspaceDialog(which: Dialog) {
  dialog = which;
  dialogListeners.forEach((l) => l());
}

export function useWorkspaceDialog(): Dialog {
  return useSyncExternalStore(subscribeDialog, () => dialog, () => dialog);
}

/** A workspace action's answer, as an error to show or nothing. */
export async function act(work: Promise<{ error?: string } | undefined> | undefined): Promise<string | null> {
  try {
    const said = await work;
    return said?.error ?? null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
