// The page's side of every running extension (src/lib/extensions.ts has
// the rules, server/extensions.ts the reasons).
//
// One host for the owner's window. It keeps the list of what is
// installed, a hidden frame for each running extension that has a
// background document, and one listener for the messages every frame
// posts. A frame is known by its window, never by what it says about
// itself: an opaque-origin document posts as "null", so the source is the
// check, and a message from any other window is not an extension's.
//
// What a frame asks for is answered here when it is the page's to answer
// (the agent on screen, a draft in a message box, a notice, a panel to
// open) and otherwise sent on to the server, which checks the permission
// again. A frame's trouble stays the frame's: an error it reports is kept
// beside its name for the owner to see, and it never reaches a turn.
import { useEffect, useRef, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { useTheme } from "@/lib/theme";
import { boxFor, keepDraft, readDraft } from "@/lib/drafts";
import { toast } from "@/components/ui/toast";
import {
  CommandWindows,
  PAGE_METHODS,
  agentsFor,
  callVerdict,
  cleanTheme,
  eventFromFrame,
  frameUrl,
  hears,
  leftItsDocument,
  loadExtensions,
  onExtensionFrame,
  openPanel,
  parseFrameMessage,
  prunePanels,
  running,
  useExtensions,
  type ExtensionInfo,
} from "@/lib/extensions";
import { paletteNow } from "../McpApps";
import { t } from "@/lib/i18n";

interface LiveFrame {
  extensionId: string;
  /** "background", or a panel's id. */
  which: string;
  window: Window;
  ready: boolean;
  /** Commands waiting for the frame to say it is ready. */
  pending: Array<{ id: string; context: unknown }>;
}

/** Every frame on the page, by its window. */
const frames = new Map<Window, LiveFrame>();
/** The last error each extension reported, for its page in Settings. */
const errors = new Map<string, string>();
const errorListeners = new Set<() => void>();
const windows = new CommandWindows();

let current: { list: ExtensionInfo[]; bots: Bot[]; selectedId: string; dispatch: ReturnType<typeof useStore>["dispatch"] } = {
  list: [],
  bots: [],
  selectedId: "",
  dispatch: () => {},
};

const post = (target: Window, message: Record<string, unknown>) => {
  try {
    target.postMessage({ bloks: 1, ...message }, "*");
  } catch {
    /* the frame went */
  }
};

/** A workspace event, to every frame whose extension hears it. */
function emit(name: string, data: unknown) {
  for (const frame of frames.values()) {
    const ext = current.list.find((e) => e.id === frame.extensionId);
    if (ext && frame.ready && hears(ext, name)) post(frame.window, { type: "event", name, data });
  }
}

export function extensionError(id: string): string | undefined {
  return errors.get(id);
}

export function onExtensionErrors(fn: () => void): () => void {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

function noteError(id: string, message: string) {
  errors.set(id, message);
  errorListeners.forEach((fn) => fn());
}

/**
 * The owner ran one of an extension's commands: it goes to the
 * extension's background document, or failing that to a panel of its
 * (opened first, and given the command once it says it is ready). The
 * context names the agent on screen only for an extension that may see
 * agents.
 */
export function runExtensionCommand(ext: ExtensionInfo, commandId: string) {
  windows.ran(ext.id);
  const agent = agentsFor(current.bots).find((a) => a.id === current.selectedId);
  const context = ext.permissions.some((p) => p.id === "agents:read") && agent ? { agentId: agent.id, agentName: agent.name } : {};
  const mine = [...frames.values()].filter((f) => f.extensionId === ext.id);
  const target = mine.find((f) => f.which === "background") ?? mine[0];
  if (target) {
    if (target.ready) post(target.window, { type: "command", id: commandId, context });
    else target.pending.push({ id: commandId, context });
    return;
  }
  const panel = ext.panels[0];
  if (!panel) return;
  pendingCommands.set(`${ext.id}/${panel.id}`, { id: commandId, context });
  openPanel(`${ext.id}/${panel.id}`);
}

/** Commands for a panel that was not open yet, handed over at its ready. */
const pendingCommands = new Map<string, { id: string; context: unknown }>();

async function answerCall(frame: LiveFrame, id: number, method: string, params: unknown) {
  const reply = (ok: boolean, payload: unknown) => post(frame.window, { type: "reply", id, ok, ...(ok ? { result: payload } : { error: payload }) });
  const ext = current.list.find((e) => e.id === frame.extensionId);
  if (!ext) return reply(false, "this extension is not installed");
  const refused = callVerdict(ext, method);
  if (refused) return reply(false, refused);
  const p = (params ?? {}) as Record<string, unknown>;
  if (PAGE_METHODS.has(method)) {
    if (method === "agents.selected") {
      const agent = agentsFor(current.bots).find((a) => a.id === current.selectedId);
      return reply(true, agent ?? null);
    }
    if (method === "notify") {
      const text = typeof p.text === "string" ? p.text.trim().slice(0, 200) : "";
      if (!text) return reply(false, "text is the notice to show");
      toast(t("extensions.notice", { name: ext.name, text }));
      return reply(true, true);
    }
    if (method === "panel.open") {
      const panel = typeof p.panel === "string" ? ext.panels.find((x) => x.id === p.panel) : ext.panels[0];
      if (!panel) return reply(false, "no such panel");
      openPanel(`${ext.id}/${panel.id}`);
      return reply(true, true);
    }
    if (method === "composer.insert") {
      const text = typeof p.text === "string" ? p.text.trim().slice(0, 4_000) : "";
      if (!text) return reply(false, "text is what to put in the message box");
      const agents = agentsFor(current.bots);
      const agent = agents.find((a) => a.id === (typeof p.agentId === "string" ? p.agentId : current.selectedId));
      const bot = agent ? current.bots.find((b) => b.id === agent.id) : undefined;
      if (!bot) return reply(false, "no such agent of yours");
      // into the conversation's box, and the owner sends it or not. A box
      // on screen takes it the way it takes back a failed send: into the
      // box when it is empty, otherwise kept beside it to restore, so
      // nothing the owner is typing is written over. A box not on screen
      // finds it in its draft as it opens, below anything already there.
      const key = `${bot.id}:${bot.activeTaskId ?? bot.threadId}`;
      const box = boxFor(key);
      if (box) box({ text, attachments: [] });
      else {
        const draft = readDraft(key);
        keepDraft(key, { ...draft, text: draft.text.trim() ? `${draft.text.trimEnd()}\n\n${text}` : text });
      }
      current.dispatch({ type: "select", id: bot.id });
      return reply(true, true);
    }
  }
  // An extension never starts an agent's turn by itself: only as the
  // answer to a command the owner just ran, once for each run.
  if (method === "agents.message" && !windows.take(ext.id)) {
    return reply(false, "an extension can message an agent only right after you run one of its commands");
  }
  try {
    const res = await fetch(`/api/extensions/${encodeURIComponent(ext.id)}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return reply(false, typeof body.error === "string" ? body.error : `${res.status}`);
    return reply(true, body.result ?? null);
  } catch {
    return reply(false, "the workspace did not answer");
  }
}

function onMessage(event: MessageEvent) {
  const source = event.source as Window | null;
  const frame = source ? frames.get(source) : undefined;
  if (!frame) return;
  const message = parseFrameMessage(event.data);
  if (!message) return;
  if (message.type === "error") return noteError(frame.extensionId, message.message);
  if (message.type === "ready") {
    frame.ready = true;
    post(frame.window, { type: "hello", context: { extension: frame.extensionId, document: frame.which } });
    const waiting = pendingCommands.get(`${frame.extensionId}/${frame.which}`);
    if (waiting) {
      pendingCommands.delete(`${frame.extensionId}/${frame.which}`);
      frame.pending.push(waiting);
    }
    for (const command of frame.pending.splice(0)) post(frame.window, { type: "command", ...command });
    return;
  }
  void answerCall(frame, message.id, message.method, message.params);
}

/**
 * One extension document in a frame: a panel in the dock or a hidden
 * background one. `sandbox="allow-scripts"` and nothing else, so even
 * without the policy the server sends it would have an opaque origin;
 * adding allow-same-origin beside allow-scripts would undo all of it.
 * No popups, no top navigation, no forms, no downloads.
 *
 * A document that loads a second time has navigated away from what was
 * approved (a frame can always navigate itself), so it is taken down
 * rather than talked to; the desktop app refuses the navigation outright
 * (electron/navigation.mjs).
 */
export function ExtensionFrame({
  ext,
  which,
  title,
  hidden,
  className,
}: {
  ext: ExtensionInfo;
  which: string;
  title: string;
  hidden?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [stopped, setStopped] = useState(false);
  const { resolvedTheme } = useTheme();
  // the colours it starts in; a change later is an event, not a reload
  const [src] = useState(() => frameUrl(ext.id, which, paletteNow(resolvedTheme === "dark")));

  useEffect(() => {
    const win = ref.current?.contentWindow;
    if (!win || stopped) return;
    frames.set(win, { extensionId: ext.id, which, window: win, ready: false, pending: [] });
    return () => {
      frames.delete(win);
    };
  }, [ext.id, which, stopped]);

  if (stopped) {
    return hidden ? null : (
      <div className="flex h-full items-center justify-center p-6 text-center text-body text-muted-foreground">
        {t("extensions.stoppedNavigating", { name: ext.name })}
      </div>
    );
  }
  return (
    <iframe
      ref={ref}
      src={src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={title}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
      onLoad={() => {
        loads.current += 1;
        if (leftItsDocument(loads.current)) {
          const win = ref.current?.contentWindow;
          if (win) frames.delete(win);
          noteError(ext.id, t("extensions.stoppedNavigating", { name: ext.name }));
          setStopped(true);
        }
      }}
      className={hidden ? "pointer-events-none absolute size-0 border-0 opacity-0" : (className ?? "size-full border-0 bg-card")}
    />
  );
}

/** Mounted once in the owner's app (src/App.tsx). */
export function ExtensionHost() {
  const { state, dispatch } = useStore();
  const list = useExtensions();
  const { resolvedTheme } = useTheme();
  current = { list: list ?? [], bots: state.bots, selectedId: state.selectedId, dispatch };

  useEffect(() => {
    void loadExtensions();
    window.addEventListener("message", onMessage);
    const off = onExtensionFrame((frame) => {
      const event = eventFromFrame(frame, current.bots);
      if (event) emit(event.name, event.data);
    });
    return () => {
      window.removeEventListener("message", onMessage);
      off();
    };
  }, []);

  // a panel that is gone or switched off leaves the extensions panel
  useEffect(() => prunePanels(list), [list]);

  // the roster as an extension may see it, when that changes
  const roster = JSON.stringify(agentsFor(state.bots));
  useEffect(() => emit("agents.changed", { agents: JSON.parse(roster) }), [roster]);
  useEffect(() => {
    const agent = agentsFor(current.bots).find((a) => a.id === state.selectedId);
    emit("selection.changed", { agent: agent ?? null });
  }, [state.selectedId]);
  useEffect(() => {
    // read once the new theme's colours are on the page
    const id = requestAnimationFrame(() => emit("theme.changed", { scheme: resolvedTheme, ...cleanTheme(paletteNow(resolvedTheme === "dark")) }));
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme]);

  return (
    <div aria-hidden className="pointer-events-none fixed left-0 top-0 size-0 overflow-hidden">
      {running(list)
        .filter((ext) => ext.background)
        // keyed by when it was installed too, so an update starts afresh
        .map((ext) => (
          <ExtensionFrame key={`${ext.id}:${ext.updatedAt}`} ext={ext} which="background" title={ext.name} hidden />
        ))}
    </div>
  );
}
