// Workspace extensions, the page's half (server/extensions.ts has the
// rules, src/components/extensions/ the frames and the screens).
//
// The page is the only thing an extension's documents can talk to. Each
// runs in a frame with an opaque origin and no network, and passes
// messages to the page through `window.bloks`; here they are read into a
// few shapes, checked against what the owner granted, and answered: some
// by the page itself, the rest by the server, which checks again. Nothing
// here is the boundary on its own. It is where a message becomes a shape
// rather than a surprise, and where the page decides which workspace
// events a frame hears at all.
import { useSyncExternalStore } from "react";
import type { Bot } from "@/state/reducer";

export type Permission = "agents:read" | "turns:read" | "agents:message" | "composer:write" | "storage" | "notifications";

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  bloks: string;
  enabled: boolean;
  permissions: Array<{ id: Permission; words: string; high: boolean }>;
  panels: Array<{ id: string; title: string }>;
  background: boolean;
  commands: Array<{ id: string; title: string; description?: string }>;
  events: string[];
  settings: Array<{ key: string; label: string; type: "text" | "boolean" | "number"; default: string | boolean | number }>;
  values: Record<string, string | boolean | number>;
  source: { kind: "folder"; path: string; name: string } | { kind: "github"; url: string };
  installedAt: number;
  updatedAt: number;
  intact: boolean;
}

/** Every call a document can make, and the permission it needs: the same
 * table as the server's SERVER_METHODS and PAGE_METHODS (a test holds the
 * two to each other). */
export const METHODS: Record<string, Permission | null> = {
  "agents.list": "agents:read",
  "agents.message": "agents:message",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.remove": "storage",
  "settings.get": null,
  "agents.selected": "agents:read",
  "composer.insert": "composer:write",
  notify: "notifications",
  "panel.open": null,
};

/** The ones the page answers itself. */
export const PAGE_METHODS = new Set(["agents.selected", "composer.insert", "notify", "panel.open"]);

/** The events, and the permission each needs (server/extensions.ts EVENTS). */
export const EVENTS: Record<string, Permission | null> = {
  "turn.started": "turns:read",
  "turn.finished": "turns:read",
  "agents.changed": "agents:read",
  "selection.changed": "agents:read",
  "theme.changed": null,
};

export const has = (ext: Pick<ExtensionInfo, "permissions">, permission: Permission) => ext.permissions.some((p) => p.id === permission);

/** Whether this extension may make this call; the reason if not. */
export function callVerdict(ext: Pick<ExtensionInfo, "permissions" | "enabled">, method: string): string | null {
  if (!ext.enabled) return "this extension is switched off";
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) return `${method.slice(0, 60)} is not something an extension can ask for`;
  const needs = METHODS[method];
  if (needs && !has(ext, needs)) return `that needs the permission ${needs}, which this extension was not given`;
  return null;
}

/** Whether this extension hears this event: one it asked for, and was
 * granted what it needs. The theme is everybody's. */
export function hears(ext: Pick<ExtensionInfo, "permissions" | "events" | "enabled">, name: string): boolean {
  if (!ext.enabled || !Object.prototype.hasOwnProperty.call(EVENTS, name)) return false;
  if (name !== "theme.changed" && !ext.events.includes(name)) return false;
  const needs = EVENTS[name];
  return !needs || has(ext, needs);
}

/** What a frame may say. Anything else it posts is dropped. */
export type FrameMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "call"; id: number; method: string; params: unknown };

/** The most a call's parameters may be, as JSON. */
export const MAX_CALL_BYTES = 64 * 1024;

export function parseFrameMessage(value: unknown): FrameMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.bloks !== 1) return null;
  if (v.type === "ready") return { type: "ready" };
  if (v.type === "error") return { type: "error", message: typeof v.message === "string" ? v.message.slice(0, 300) : "something went wrong" };
  if (v.type !== "call") return null;
  if (typeof v.id !== "number" || !Number.isSafeInteger(v.id) || v.id < 1) return null;
  if (typeof v.method !== "string" || !v.method || v.method.length > 60) return null;
  let size: number;
  try {
    size = JSON.stringify(v.params ?? null).length;
  } catch {
    return null;
  }
  if (size > MAX_CALL_BYTES) return null;
  return { type: "call", id: v.id, method: v.method, params: v.params ?? null };
}

/** An agent as an extension may see it: a name and whether it is at
 * work. The owner's own agents only, never a member's own. */
export interface AgentForExtension {
  id: string;
  name: string;
  working: boolean;
}

export function agentsFor(bots: readonly Bot[]): AgentForExtension[] {
  return bots
    .filter((b) => !b.hidden && !b.archivedAt && (!b.solo || b.solo.by === "owner"))
    .map((b) => ({ id: b.id, name: b.name.slice(0, 80), working: Boolean(b.busy || b.tasks?.some((t) => t.state === "working")) }));
}

/**
 * A frame off the server's event stream, as the workspace event an
 * extension hears, or null. A turn is named by its agent and its
 * conversation, and nothing it said; a conversation that is not one of
 * the owner's own agents' is not news to an extension.
 */
export function eventFromFrame(frame: unknown, bots: readonly Bot[]): { name: string; data: unknown } | null {
  const f = frame as { kind?: unknown; event?: { type?: unknown; threadId?: unknown } } | null;
  if (f?.kind !== "runtime" || typeof f.event?.threadId !== "string") return null;
  const type = f.event.type;
  if (type !== "turn.started" && type !== "turn.completed") return null;
  const threadId = f.event.threadId;
  const agents = new Set(agentsFor(bots).map((a) => a.id));
  const bot = bots.find((b) => agents.has(b.id) && (b.threadId === threadId || b.tasks?.some((t) => t.id === threadId)));
  if (!bot) return null;
  return { name: type === "turn.started" ? "turn.started" : "turn.finished", data: { agentId: bot.id, conversationId: threadId } };
}

// ── what the server says is installed ──

type Listener = () => void;

let installed: ExtensionInfo[] | null = null;
const listeners = new Set<Listener>();
const tell = () => listeners.forEach((fn) => fn());

export async function loadExtensions(): Promise<void> {
  try {
    const res = await fetch("/api/extensions", { headers: { "content-type": "application/json" } });
    const body = await res.json().catch(() => ({}));
    installed = res.ok && Array.isArray(body.extensions) ? body.extensions : [];
  } catch {
    installed = installed ?? [];
  }
  tell();
}

export function useExtensions(): ExtensionInfo[] | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => installed,
  );
}

/** The running ones: switched on, and with files still as approved. */
export const running = (list: readonly ExtensionInfo[] | null) => (list ?? []).filter((e) => e.enabled && e.intact);

// ── frames off the event stream ──

const frameListeners = new Set<(frame: unknown) => void>();

/** Called by the store for every frame it reads (src/state/store.tsx).
 * `news` is false for a frame replayed to catch up after a reconnect,
 * which no extension hears as if it had just happened. */
export function noteExtensionFrame(frame: unknown, news = true): void {
  const kind = (frame as { kind?: unknown } | null)?.kind;
  // the list changed, or the stream came back and it may have meanwhile
  if (kind === "extensions" || kind === "hello") void loadExtensions();
  if (!news) return;
  for (const fn of frameListeners) {
    try {
      fn(frame);
    } catch {
      /* one listener's trouble is not the stream's */
    }
  }
}

export function onExtensionFrame(fn: (frame: unknown) => void): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

// ── the dock ──

export interface DockState {
  open: boolean;
  /** "<extension id>/<panel id>" */
  shown: string | null;
  /** Panels opened since the window loaded, kept mounted so switching
   * between them keeps their state. */
  kept: string[];
}

let dock: DockState = { open: false, shown: null, kept: [] };
const dockListeners = new Set<Listener>();

export function setDock(next: Partial<DockState>): void {
  dock = { ...dock, ...next };
  if (dock.shown && !dock.kept.includes(dock.shown)) dock = { ...dock, kept: [...dock.kept, dock.shown] };
  dockListeners.forEach((fn) => fn());
}

export function openPanel(key: string): void {
  setDock({ open: true, shown: key });
}

export function useDock(): DockState {
  return useSyncExternalStore(
    (fn) => {
      dockListeners.add(fn);
      return () => dockListeners.delete(fn);
    },
    () => dock,
  );
}

/** Panels no longer installed or running drop out of what is kept. */
export function pruneDock(list: readonly ExtensionInfo[] | null): void {
  const live = new Set(running(list).flatMap((e) => e.panels.map((p) => `${e.id}/${p.id}`)));
  const kept = dock.kept.filter((k) => live.has(k));
  const shown = dock.shown && live.has(dock.shown) ? dock.shown : (kept[0] ?? null);
  if (kept.length !== dock.kept.length || shown !== dock.shown) setDock({ kept, shown, open: dock.open && shown !== null });
}

// ── messages to agents, only right after a command ──

/** How long after the owner runs a command its extension may send one
 * message to an agent. An extension never starts an agent's turn on its
 * own, from an event or a timer: only as the answer to a command. */
export const COMMAND_WINDOW_MS = 30_000;

export class CommandWindows {
  private open = new Map<string, number>();

  ran(extensionId: string, now = Date.now()): void {
    this.open.set(extensionId, now);
  }

  /** One message per command run, inside the window. */
  take(extensionId: string, now = Date.now()): boolean {
    const at = this.open.get(extensionId);
    if (at === undefined || now - at > COMMAND_WINDOW_MS) return false;
    this.open.delete(extensionId);
    return true;
  }
}

// ── the frames' address ──

/** Where a frame's document is served from, with the colours it starts in. */
export function frameUrl(extensionId: string, which: string, theme: unknown): string {
  return `/api/extensions/${encodeURIComponent(extensionId)}/frame/${encodeURIComponent(which)}?theme=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** Whether a frame that loaded again has left its own document: the
 * first load is the document; any other means it navigated, and a frame
 * that navigates is stopped (ExtensionFrame). */
export const leftItsDocument = (loads: number) => loads > 1;

/** A colour handed to a frame, checked the way the server checks one. */
const CSS_COLOR = /^[#a-zA-Z0-9(),.%\s/-]{0,64}$/;

export function cleanTheme(theme: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value === "string" && CSS_COLOR.test(value)) out[key] = value;
  }
  return out;
}
