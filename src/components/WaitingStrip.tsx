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
import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "@/components/icons";
import { Hourglass } from "@/components/icons";
import { Pencil } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { api, type Message } from "@/state/store";
import { stamp } from "@/lib/when";
import { cn } from "@/lib/cn";
import { RANK, TrayButton, type Notice } from "@/components/composer/Tray";
import { confirm } from "@/components/ui/confirm";

/** Opens the editor on a queued message: the server holds back the turn
 * it waits for until the editor closes (GitHub 155). What comes back
 * closes it, saving the words given or cancelling without any. Either
 * one waits for the opening to land first, so a quick Escape never
 * arrives ahead of the hold it is meant to end. A save lets go on the
 * server's side, once the new words are in; one the server refuses lets
 * go here instead, rather than leaving the burst to its timeout. In a
 * room nothing is held, and the save is an ordinary edit, which the
 * room reads when the message goes. */
export function editQueued(threadId: string, messageId: string) {
  const path = `/api/threads/${threadId}/messages/${messageId}`;
  const editing = (on: boolean) => api(`${path}/editing`, { method: "POST", body: JSON.stringify({ editing: on }) });
  const opened = editing(true).catch(() => {});
  return (text?: string) => {
    void opened
      .then(() =>
        text
          ? api(path, { method: "PATCH", body: JSON.stringify({ text }) }).catch(() => editing(false))
          : editing(false),
      )
      .catch(() => {});
  };
}

function takeBack(threadId: string, messageId: string) {
  // No undo exists for this, so the question is asked once, as the
  // bubble's own Delete asks it.
  void confirm({
    title: "Take this message back?",
    body: "This can't be undone.",
    confirmLabel: "Take back",
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

function WaitingRow({
  message,
  threadId,
  sender,
  working,
  onSendNow,
  onSendAgain,
  editNow,
  onEditing,
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
}) {
  const yours = sender === null;
  const [editing, setEditingState] = useState<string | null>(null);
  const setEditing = (next: string | null) => {
    setEditingState(next);
    onEditing?.(message.id, next !== null);
  };
  // how an editor opened on this message closes again: with words to
  // save, or without them to cancel
  const close = useRef<((text?: string) => void) | null>(null);
  // Opened from the keyboard, it hands the keyboard back when it closes,
  // so the next thing typed lands in the composer again.
  const returnTo = useRef<HTMLElement | null>(null);
  const editable = yours && Boolean(message.queued) && Boolean(message.text);
  const startEditing = () => {
    if (!editable || editing !== null) return;
    setEditing(message.text ?? "");
    close.current = editQueued(threadId, message.id);
  };
  const stopEditing = (text?: string) => {
    const done = close.current;
    close.current = null;
    done?.(text);
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
      if (close.current) onEditing?.(message.id, false);
      close.current?.();
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const queuedAt = message.queuedAt ?? message.at;
  const status = message.unsent
    ? "Not sent. Bloks restarted before it could go."
    : editing !== null
      ? "Queued, waits until you save or cancel"
      : message.waitsFor === "restart"
        ? `Queued at ${stamp(queuedAt)}, sends after Bloks restarts`
        : message.waitsFor === "pause"
          ? `Queued at ${stamp(queuedAt)}, sends when the pause ends${message.waitsUntil ? ` at ${stamp(message.waitsUntil)}` : ""}`
        : working
          ? message.delivery?.route === "queued"
            ? // why it waits, when that was decided: read as work for
              // after this turn, chosen, or the agent's setting
              `${message.delivery.line}, queued at ${stamp(queuedAt)}`
            : `Queued at ${stamp(queuedAt)}, sends when this reply finishes`
          : `Queued at ${stamp(queuedAt)}`;

  return (
    <div
      className={cn(
        "flex animate-rise-in items-start gap-2 rounded-xl bg-muted/60 py-1.5 pl-3 pr-1",
        message.unsent && "bg-warning/8",
      )}
      data-waiting={message.id}
    >
      <div className="min-w-0 flex-1 py-0.5">
        {sender && <div className="text-small font-medium text-muted-foreground">From {sender}</div>}
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
              aria-label="Edit the waiting message"
              className="max-h-[calc(6lh+10px)] w-full resize-none rounded-lg border bg-background px-2 py-1 text-body text-foreground outline-none [field-sizing:content] focus:border-ring/50"
            />
            <div className="flex items-center gap-2 text-small text-muted-foreground">
              <button
                onClick={() => stopEditing(editing.trim() || undefined)}
                className="font-medium text-foreground underline underline-offset-2"
              >
                Save
              </button>
              <button onClick={() => stopEditing()} className="hover:text-foreground">
                Cancel
              </button>
              <span className="hidden opacity-70 sm:inline">Enter saves, Escape cancels</span>
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
            title={editable ? "Double-click to edit" : undefined}
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
              Send again
            </button>
          ) : null}
          {editable && (
            <IconButton label="Edit" onClick={startEditing}>
              <Pencil size={13} strokeWidth={1.8} />
            </IconButton>
          )}
          {yours && message.queued && onSendNow && (
            <IconButton label="Send now" onClick={onSendNow}>
              <ArrowUp size={14} strokeWidth={1.8} />
            </IconButton>
          )}
          {/* not yours to take back while it waits; one never sent, though,
              is only clutter if it stays, so anyone's can be cleared */}
          {(yours || message.unsent) && (
            <IconButton label={message.unsent ? "Delete" : "Take back"} onClick={() => takeBack(threadId, message.id)}>
              <Trash2 size={13} strokeWidth={1.8} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

/** Who queued a message in an agent's conversation, or null for you. */
export function waitingSender(m: Message): string | null {
  const sender = m.telegramPerson ?? m.telegramGroup;
  if (sender) return sender.name + (sender.group ? " in " + sender.group.title : "") + " (Telegram)";
  if (m.telegramDelegate) return `${m.telegramDelegate.name} (Telegram)`;
  if (m.agent?.dir === "in") return m.agent.peerName;
  switch (m.via) {
    case "watcher":
      return "your watcher";
    case "intent":
      return `your standing intent${m.intent?.name ? ` ${m.intent.name}` : ""}`;
    case "webhook":
      return "a webhook";
    case "email":
      return "email";
    case "goal":
      return "your goal";
    case "incident":
      return "Bloks, about something that failed";
    case "routine":
      return `your routine${m.routine?.name ? ` ${m.routine.name}` : ""}`;
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
  senderOf = waitingSender,
  working,
  onSendNow,
  onSendAgain,
  editAsk,
}: {
  messages: Message[] | undefined;
  threadId: string;
  senderOf?: (message: Message) => string | null;
  working: boolean;
  onSendNow?: () => void;
  onSendAgain?: (message: Message) => void;
  editAsk?: { id: string; nonce: number } | null;
}): Notice | null {
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  const onEditing = (id: string, on: boolean) =>
    setEditing((cur) => {
      if (cur.has(id) === on) return cur;
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  if (!messages?.length) return null;
  const unsent = messages.filter((m) => m.unsent).length;
  const mineQueued = messages.some((m) => m.queued && senderOf(m) === null);
  const asked = Boolean(editAsk && messages.some((m) => m.id === editAsk.id));
  return {
    id: "queued",
    tone: unsent ? "warn" : "info",
    rank: unsent ? RANK.unsent : RANK.queued,
    icon: <Hourglass size={14} />,
    title:
      unsent === messages.length
        ? `${unsent === 1 ? "A message" : `${unsent} messages`} didn't send.`
        : `${messages.length === 1 ? "A message is" : `${messages.length} messages are`} waiting to send.`,
    actions: mineQueued && working && onSendNow && <TrayButton onClick={onSendNow}>Send now</TrayButton>,
    keepOpen: asked || editing.size > 0,
    body: (
      <div className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto overscroll-contain" aria-label="Waiting to send">
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
          />
        ))}
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
  if (!messages.length) return null;
  return (
    <div className="px-4 md:px-6">
      <div
        className="mx-auto flex max-h-[40vh] max-w-[var(--transcript-width,760px)] flex-col gap-1.5 overflow-y-auto pb-1"
        aria-label="Waiting to send"
      >
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
          />
        ))}
      </div>
    </div>
  );
}
