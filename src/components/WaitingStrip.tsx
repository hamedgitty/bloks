// What is waiting to be said (GitHub 170).
//
// A message written while the agent works is not part of the
// conversation yet. Shown where it was sent, it sat above minutes of the
// agent's posts and read as if they answered it. So it waits here, above
// the composer, in the order it was sent, and enters the conversation
// when it goes, after everything said meanwhile. Your own can still be
// reworded (a double-click, as on the bubble it used to be), sent now,
// or taken back; what another agent or a person in a room queued is
// shown with who sent it, and is theirs, not yours to change.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp } from "@/components/icons";
import { Hourglass } from "@/components/icons";
import { Pencil } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { api, type Message } from "@/state/store";
import { stamp } from "@/lib/when";
import { cn } from "@/lib/cn";
import { RANK, TrayButton, type Notice } from "@/components/composer/Tray";
import { confirm } from "@/components/ui/confirm";
import { t } from "@/lib/i18n";

/** Opens the editor on a queued message: the server holds back the turn
 * it waits for until the editor closes (GitHub 155). What comes back
 * closes it, saving the words given or cancelling without any. Either
 * one waits for the opening to land first, so a quick Escape never
 * arrives ahead of the hold it is meant to end. A save lets go on the
 * server's side once the new words are in. When the save fails, its
 * outcome may be unknown, so the existing hold expires on its own. A
 * definite client rejection releases the hold. In a
 * room nothing is held, and the save is an ordinary edit, which the
 * room reads when the message goes. */
export function editQueued(threadId: string, messageId: string) {
  const path = `/api/threads/${threadId}/messages/${messageId}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const editId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const editing = (on: boolean) => api(`${path}/editing`, { method: "POST", body: JSON.stringify({ editing: on, editId }) });
  const opened = editing(true).catch(() => null);
  return async (text?: string) => {
    const hold = await opened;
    if (!text) return void (await editing(false).catch(() => {}));
    // If the opening response was lost, this editor may or may not own
    // the server hold. Keep its replacement words instead of writing
    // without an identity that could overwrite a newer edit.
    if (!hold) throw new Error();
    try {
      await api(path, { method: "PATCH", body: JSON.stringify({ text, ...(hold?.holding ? { editId } : {}) }) });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
      if (typeof status === "number" && status >= 400 && status < 500) await editing(false).catch(() => {});
      throw error;
    }
  };
}

type EditOutcome = "saving" | "rejected" | "unknown" | "interrupted";
type FailedEdit = { id: number; text: string; outcome: EditOutcome };
const noFailedEdits: readonly FailedEdit[] = [];
// A row can leave while its save is in flight. Keep the words with this
// conversation in this window, even when its composer is temporarily gone.
const failedEdits = new Map<string, readonly FailedEdit[]>();
const editListeners = new Set<() => void>();
let failedEditId = 0;

function keepFailedEdit(key: string, text: string, outcome: EditOutcome) {
  const id = ++failedEditId;
  failedEdits.set(key, [...(failedEdits.get(key) ?? noFailedEdits), { id, text, outcome }]);
  editListeners.forEach((listener) => listener());
  return id;
}

function dismissFailedEdit(key: string, id: number) {
  const rest = (failedEdits.get(key) ?? noFailedEdits).filter((edit) => edit.id !== id);
  if (rest.length) failedEdits.set(key, rest);
  else failedEdits.delete(key);
  editListeners.forEach((listener) => listener());
}

function watchEditSave(key: string, text: string, request: Promise<void>) {
  const id = keepFailedEdit(key, text, "saving");
  void request.then(
    () => dismissFailedEdit(key, id),
    (error: unknown) => {
      const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
      const rejected = typeof status === "number" && status >= 400 && status < 500;
      const edits = failedEdits.get(key) ?? noFailedEdits;
      failedEdits.set(key, edits.map((edit) => edit.id === id ? { ...edit, outcome: rejected ? "rejected" : "unknown" } : edit));
      editListeners.forEach((listener) => listener());
    },
  );
}

function useFailedEdits(key: string) {
  return useSyncExternalStore(
    (listener) => {
      editListeners.add(listener);
      return () => editListeners.delete(listener);
    },
    () => failedEdits.get(key) ?? noFailedEdits,
    () => noFailedEdits,
  );
}

function FailedEdits({ edits, recoveryKey }: { edits: readonly FailedEdit[]; recoveryKey: string }) {
  return edits.map((edit) => (
    <div key={edit.id} role={edit.outcome === "saving" ? "status" : "alert"} className="rounded-xl bg-warning/8 px-3 py-2 text-body">
      <p>
        {edit.outcome === "saving"
          ? t("waitingStrip.edit.saving")
          : edit.outcome === "rejected"
            ? t("waitingStrip.edit.rejected")
            : edit.outcome === "unknown"
              ? t("waitingStrip.edit.unknown")
              : t("waitingStrip.edit.interrupted")}
      </p>
      {edit.outcome === "unknown" && (
        <p className="mt-1 text-small text-muted-foreground">{t("waitingStrip.edit.timeout")}</p>
      )}
      <textarea
        readOnly
        aria-label={t("waitingStrip.edit.replacement")}
        value={edit.text}
        rows={Math.min(6, edit.text.split("\n").length + 1)}
        className="mt-1.5 max-h-[calc(6lh+10px)] w-full resize-y rounded-lg border bg-background px-2 py-1 text-body text-foreground"
      />
      <div className="mt-1 flex items-center gap-2 text-small text-muted-foreground">
        <span>{t("waitingStrip.edit.copy")}</span>
        {edit.outcome !== "saving" && (
          <button onClick={() => dismissFailedEdit(recoveryKey, edit.id)} className="font-medium text-foreground underline underline-offset-2">
            {t("common.dismiss")}
          </button>
        )}
      </div>
    </div>
  ));
}

function takeBack(threadId: string, messageId: string) {
  // No undo exists for this, so the question is asked once, as the
  // bubble's own Delete asks it.
  void confirm({
    title: t("waitingStrip.takeBackTitle"),
    body: t("waitingStrip.cantUndo"),
    confirmLabel: t("waitingStrip.takeBack"),
    destructive: true,
  }).then((yes) => {
    if (yes) void api(`/api/threads/${threadId}/messages/${messageId}`, { method: "DELETE" }).catch(() => {});
  });
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
    >
      {children}
    </button>
  );
}

/** The preparation lines are made by the server; other server reasons
 * still go through as written, as they did before. */
function preparationLine(line: string): string {
  switch (line) {
    case "Waiting for this turn to start": return t("waitingStrip.status.waitingStart");
    case "Waiting to join this turn": return t("waitingStrip.status.waitingToJoin");
    case "Waiting for an earlier input's receipt": return t("waitingStrip.status.waitingEarlier");
    case "Sending to this turn": return t("waitingStrip.status.sending");
    case "Not sent": return t("waitingStrip.status.notSent");
    default: return line;
  }
}

function WaitingRow({
  message,
  threadId,
  sender,
  working,
  onSendNow,
  onSendAgain,
  editNow,
  onEditing,
  onEditFailure,
  onEditSave,
}: {
  message: Message;
  threadId: string;
  /** Who sent it, when it was not you: then it is shown, not changed. */
  sender: string | null;
  working: boolean;
  onSendNow?: () => void;
  onSendAgain?: (message: Message) => void;
  editNow?: number;
  /** Told when the editor opens and closes, so whatever holds the row
   * keeps it on screen while it has the words. */
  onEditing?: (id: string, on: boolean) => void;
  onEditFailure: (text: string, outcome: EditOutcome) => void;
  onEditSave: (text: string, request: Promise<void>) => void;
}) {
  const yours = sender === null;
  const [editing, setEditingState] = useState<string | null>(null);
  const setEditing = (next: string | null) => {
    setEditingState(next);
    draft.current = next;
    onEditing?.(message.id, next !== null);
  };
  const draft = useRef<string | null>(null);
  const original = useRef("");
  // how an editor opened on this message closes again: with words to
  // save, or without them to cancel
  const close = useRef<((text?: string) => Promise<void>) | null>(null);
  // Opened from the keyboard, it hands the keyboard back when it closes,
  // so the next thing typed lands in the composer again.
  const returnTo = useRef<HTMLElement | null>(null);
  const unresolved = message.preparation?.state === "dispatching" || message.preparation?.state === "uncertain";
  const sendable = !message.preparation || message.preparation.state === "next";
  const editable = yours && Boolean(message.queued) && Boolean(message.text) &&
    (!message.preparation || message.preparation.state === "pending" || message.preparation.state === "next");
  const startEditing = () => {
    if (!editable || editing !== null) return;
    original.current = message.text ?? "";
    setEditing(message.text ?? "");
    close.current = editQueued(threadId, message.id);
  };
  const stopEditing = (text?: string) => {
    const done = close.current;
    close.current = null;
    const request = done?.(text);
    if (text && request) onEditSave(text, request);
    setEditing(null);
    returnTo.current?.focus();
    returnTo.current = null;
  };
  useEffect(() => {
    if (!editNow) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    startEditing();
  }, [editNow]); // eslint-disable-line react-hooks/exhaustive-deps
  // a row that goes mid-edit, because its turn took it or it was taken
  // back elsewhere, lets go of what it held
  useEffect(
    () => () => {
      if (close.current) {
        onEditing?.(message.id, false);
        if (draft.current?.trim() && draft.current !== original.current) onEditFailure(draft.current, "interrupted");
        void close.current();
      }
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const queuedAt = message.queuedAt ?? message.at;
  const time = stamp(queuedAt);
  const status = message.delivery?.route === "uncertain"
    ? t("waitingStrip.status.unconfirmed")
    : message.delivery?.route === "pending" || message.delivery?.route === "not-sent"
    ? preparationLine(message.delivery.line)
    : message.unsent
    ? t("waitingStrip.status.unsent")
    : editing !== null
      ? t("waitingStrip.status.editing")
      : message.waitsFor === "restart"
        ? t("waitingStrip.status.restart", { time })
        : message.waitsFor === "pause"
          ? message.waitsUntil
            ? t("waitingStrip.status.pauseUntil", { time, until: stamp(message.waitsUntil) })
            : t("waitingStrip.status.pause", { time })
        : working
          ? message.delivery?.route === "queued"
            ? message.preparation?.state === "next"
              ? t("waitingStrip.status.afterReply", { time })
              : // why it waits, when that was decided: read as work for
              // after this turn, chosen, or the agent's setting (the
              // server's words)
              t("waitingStrip.status.why", { why: message.delivery.line, time })
            : t("waitingStrip.status.afterReply", { time })
          : t("waitingStrip.status.queued", { time });

  return (
    <div
      className={cn(
        "flex animate-rise-in items-start gap-2 rounded-xl bg-muted/60 py-1.5 pl-3 pr-1",
        message.unsent && "bg-warning/8",
      )}
      data-waiting={message.id}
    >
      <div className="min-w-0 flex-1 py-0.5">
        {sender && <div className="text-small font-medium text-muted-foreground">{t("waitingStrip.from", { sender })}</div>}
        {editing !== null ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              autoFocus
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") stopEditing();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  stopEditing(editing.trim() || undefined);
                }
              }}
              rows={Math.min(6, editing.split("\n").length + 1)}
              aria-label={t("waitingStrip.editTheWaitingMessage")}
              className="max-h-[calc(6lh+10px)] w-full resize-none rounded-lg border bg-background px-2 py-1 text-body text-foreground outline-none [field-sizing:content] focus:border-ring/50"
            />
            <div className="flex items-center gap-2 text-small text-muted-foreground">
              <button
                onClick={() => stopEditing(editing.trim() || undefined)}
                className="font-medium text-foreground underline underline-offset-2"
              >
                {t("common.save")}
              </button>
              <button onClick={() => stopEditing()} className="hover:text-foreground">
                {t("common.cancel")}
              </button>
              <span className="hidden opacity-70 sm:inline">{t("waitingStrip.enterSavesEscapeCancels")}</span>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "line-clamp-3 whitespace-pre-wrap break-words text-body text-foreground",
              editable && "cursor-text",
            )}
            // the second press of a double-click would select a word
            // just before the editor takes its place
            onMouseDown={
              editable
                ? (e) => {
                    if (e.detail > 1) e.preventDefault();
                  }
                : undefined
            }
            onDoubleClick={editable ? startEditing : undefined}
            title={editable ? t("waitingStrip.doubleClickToEdit") : undefined}
          >
            {message.text}
          </div>
        )}
        <div
          className={cn(
            "mt-0.5 flex items-start gap-1 text-caption font-medium",
            message.unsent ? "text-warning" : "text-muted-foreground",
          )}
          role="status"
        >
          {!message.unsent && <span className="mt-[5px] inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-current" />}
          <span className="min-w-0">{status}</span>
        </div>
      </div>
      {editing === null && (
        <div className="flex shrink-0 items-center">
          {message.unsent && yours && onSendAgain && message.text ? (
            <button
              onClick={() => onSendAgain(message)}
              className="mr-0.5 h-7 rounded-full px-2.5 text-small font-medium text-foreground transition-colors duration-150 hover:bg-accent"
            >
              {t("waitingStrip.sendAgain")}
            </button>
          ) : null}
          {editable && (
            <IconButton label={t("common.edit")} onClick={startEditing}>
              <Pencil size={13} strokeWidth={1.8} />
            </IconButton>
          )}
          {yours && message.queued && sendable && onSendNow && (
            <IconButton label={t("waitingStrip.sendNow")} onClick={onSendNow}>
              <ArrowUp size={14} strokeWidth={1.8} />
            </IconButton>
          )}
          {unresolved && (
            <button
              onClick={() => void api(`/api/threads/${threadId}/messages/${message.id}/dismiss-preparation`, { method: "POST" }).catch(() => {})}
              className="mr-0.5 h-7 rounded-full px-2.5 text-small font-medium text-foreground transition-colors duration-150 hover:bg-accent"
            >
              {t("common.dismiss")}
            </button>
          )}
          {/* not yours to take back while it waits; one never sent, though,
              is only clutter if it stays, so anyone's can be cleared */}
          {(yours || message.unsent) && !unresolved && (
            <IconButton label={message.unsent ? t("common.delete") : t("waitingStrip.takeBack")} onClick={() => takeBack(threadId, message.id)}>
              <Trash2 size={13} strokeWidth={1.8} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

/** Who queued a message in an agent's conversation, or null for you:
 * a name, or what stands for one, read after "From". */
export function waitingSender(m: Message): string | null {
  const sender = m.telegramPerson ?? m.telegramGroup;
  if (sender) {
    return sender.group
      ? t("waitingStrip.sender.telegramIn", { name: sender.name, group: sender.group.title })
      : t("waitingStrip.sender.telegram", { name: sender.name });
  }
  if (m.telegramDelegate) return t("waitingStrip.sender.telegram", { name: m.telegramDelegate.name });
  if (m.agent?.dir === "in") return m.agent.peerName;
  switch (m.via) {
    case "watcher":
      return t("waitingStrip.sender.watcher");
    case "intent":
      return m.intent?.name ? t("waitingStrip.sender.intentNamed", { name: m.intent.name }) : t("waitingStrip.sender.intent");
    case "webhook":
      return t("waitingStrip.sender.webhook");
    case "email":
      return t("waitingStrip.sender.email");
    case "goal":
      return t("waitingStrip.sender.goal");
    case "incident":
      return t("waitingStrip.sender.incident");
    case "routine":
      return m.routine?.name ? t("waitingStrip.sender.routineNamed", { name: m.routine.name }) : t("waitingStrip.sender.routine");
    default:
      return null;
  }
}

/**
 * What waits to be said, as one line in the composer's tray with the
 * messages under it. Send now sits on the line, not on each message: it
 * is about all of your waiting words together, which go into the running
 * turn in the order they were said when its engine can take them, or
 * stop it and go together in the next one when it cannot. A message
 * being edited keeps the line open, even when more pressing things would
 * fold it away.
 */
export function useQueuedNotice({
  messages,
  threadId,
  recoveryKey = threadId,
  senderOf = waitingSender,
  working,
  onSendNow,
  onSendAgain,
  editAsk,
}: {
  messages: Message[] | undefined;
  threadId: string;
  /** The composer's conversation key, including its lane. */
  recoveryKey?: string;
  senderOf?: (message: Message) => string | null;
  working: boolean;
  onSendNow?: () => void;
  onSendAgain?: (message: Message) => void;
  editAsk?: { id: string; nonce: number } | null;
}): Notice | null {
  const failed = useFailedEdits(recoveryKey);
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  const onEditing = (id: string, on: boolean) =>
    setEditing((cur) => {
      if (cur.has(id) === on) return cur;
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  if (!messages?.length && !failed.length) return null;
  messages ??= [];
  const unsent = messages.filter((m) => m.unsent).length;
  const editNeedsAttention = failed.some((edit) => edit.outcome !== "saving");
  const mineQueued = messages.some((m) => m.queued && senderOf(m) === null && (!m.preparation || m.preparation.state === "next"));
  const unresolved = messages.filter((m) => m.preparation?.state === "dispatching" || m.preparation?.state === "uncertain").length;
  const asked = Boolean(editAsk && messages.some((m) => m.id === editAsk.id));
  return {
    id: "queued",
    tone: unsent || editNeedsAttention ? "warn" : "info",
    rank: editNeedsAttention ? RANK.feedback : unsent ? RANK.unsent : RANK.queued,
    icon: <Hourglass size={14} />,
    title:
      editNeedsAttention
        ? t("waitingStrip.edit.needsAttention")
        : failed.length
          ? t("waitingStrip.edit.savingTitle")
        : unresolved === messages.length
        ? t("waitingStrip.status.unresolved")
        : unresolved
          ? t("waitingStrip.status.mixedUnresolved")
        : unsent === messages.length
        ? t("waitingStrip.didntSend", { count: unsent })
        : t("waitingStrip.waiting", { count: messages.length }),
    actions: mineQueued && working && onSendNow && <TrayButton onClick={onSendNow}>{t("waitingStrip.sendNow")}</TrayButton>,
    keepOpen: asked || editing.size > 0 || failed.length > 0,
    body: (
      <div className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto overscroll-contain">
        <FailedEdits edits={failed} recoveryKey={recoveryKey} />
        <div aria-label={t("waitingStrip.waitingToSend")} className="flex flex-col gap-1">
          {messages.map((m) => (
            <WaitingRow
              key={m.id}
              message={m}
              threadId={threadId}
              sender={senderOf(m)}
              working={working}
              onSendAgain={onSendAgain}
              editNow={editAsk?.id === m.id ? editAsk.nonce : undefined}
              onEditing={onEditing}
              onEditFailure={(text, outcome) => keepFailedEdit(recoveryKey, text, outcome)}
              onEditSave={(text, request) => watchEditSave(recoveryKey, text, request)}
            />
          ))}
        </div>
      </div>
    ),
  };
}

/**
 * The strip above a room's composer. Nothing at all when nothing waits.
 * A long queue scrolls inside it rather than pushing the conversation
 * off a phone's screen. An agent's conversation shows the same rows in
 * its composer's tray instead (useQueuedNotice).
 */
export function WaitingStrip({
  messages,
  threadId,
  senderOf,
  working,
  onSendNow,
  onSendAgain,
  editAsk,
}: {
  /** Waiting messages, in the order they were sent. */
  messages: Message[];
  threadId: string;
  /** Who sent a message that is not yours, or null for yours. */
  senderOf: (message: Message) => string | null;
  /** A turn is running, so what is queued goes when it finishes. */
  working: boolean;
  /** Stops the running turn, so everything queued goes now, together. */
  onSendNow?: () => void;
  onSendAgain?: (message: Message) => void;
  /** ↑ in the empty composer asked to edit this one. */
  editAsk?: { id: string; nonce: number } | null;
}) {
  const failed = useFailedEdits(threadId);
  if (!messages.length && !failed.length) return null;
  return (
    <div className="px-4 md:px-6">
      <div
        className="mx-auto flex max-h-[40vh] max-w-[var(--transcript-width,760px)] flex-col gap-1.5 overflow-y-auto pb-1"
        aria-label={t("waitingStrip.waitingToSend")}
      >
        <FailedEdits edits={failed} recoveryKey={threadId} />
        {messages.map((m) => (
          <WaitingRow
            key={m.id}
            message={m}
            threadId={threadId}
            sender={senderOf(m)}
            working={working}
            onSendNow={onSendNow}
            onSendAgain={onSendAgain}
            editNow={editAsk?.id === m.id ? editAsk.nonce : undefined}
            onEditFailure={(text, outcome) => keepFailedEdit(threadId, text, outcome)}
            onEditSave={(text, request) => watchEditSave(threadId, text, request)}
          />
        ))}
      </div>
    </div>
  );
}
