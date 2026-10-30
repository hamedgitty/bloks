// One message in a conversation as it is read: the bubble, its words,
// its cards, and the quiet lines that stand in for messages taken back
// or folded away. Split out of ChatView.tsx, which only wires them in.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "@/components/icons";
import { BellOff } from "@/components/icons";
import { ChevronDown } from "@/components/icons";
import { History } from "@/components/icons";
import { Target } from "@/components/icons";
import { Zap } from "@/components/icons";
import type { Message } from "@/state/store";
import { CarryOn } from "@/components/CarryOn";
import { quietLine } from "@/lib/transcript";
import { queuedLine, stamp } from "@/lib/when";
import { attachmentBasename, splitAttachments } from "@/lib/attachments";
import { RecalledNotes } from "@/components/RecalledNotes";
import { Mic } from "@/components/icons";
import { MessageActionBar, Reactions, ReplyContext, useTapToShow, type ReplyDraft } from "@/components/MessageActions";
import { Markdownish, withHighlight } from "@/components/Markdown";
import { cn } from "@/lib/cn";
import { goalNoteForPerson } from "@/lib/goalNote";
import { redoLine, type RedoPreview } from "@/lib/redo";
import { FailingNotice, IncidentNotice } from "./IncidentCard";
import { GroupMessage } from "./Group";
import { t } from "@/lib/i18n";

/** How a message sits in a conversation of more than two
 * (src/lib/participants.ts): whose side, where in its sender's run, the
 * sender's face, and who has read up to it. Absent, the message is drawn
 * as a chat with one agent always has. */
export interface GroupPlace {
  mine: boolean;
  first: boolean;
  last: boolean;
  face?: React.ReactNode;
  receipts?: React.ReactNode;
  /** The id this row says the reader's place with. */
  readId?: string;
}

/** Whether an answer holds something that needs the whole bubble: a
 * table, code, a picture, a list of any length. */
export function richText(text: string): boolean {
  return /```|^\s*\|.+\|\s*$|!\[[^\]]*\]\(|^\s*(?:[-*]|\d+\.)\s.+\n(?:.*\n){3,}/m.test(text);
}


/** The line over a goal turn: from Bloks, and which turn of how many. */
export function goalLabel(text: string): string {
  const { turn } = goalNoteForPerson(text);
  return turn ? t("bubble.goalStep", { step: turn.of, budget: turn.budget }) : t("bubble.goal");
}

/** The line over a message that came from somewhere other than the
 * person typing it: a routine, a watcher, an intent, a webhook, a goal,
 * a failure, or email. */
function viaLabel(message: Message): string {
  switch (message.via) {
    case "routine":
      return message.routine?.name ? t("bubble.fromRoutineNamed", { name: message.routine.name }) : t("bubble.fromRoutine");
    case "watcher":
      return t("bubble.fromYourWatcher");
    case "intent":
      return message.intent?.name ? t("bubble.fromIntentNamed", { name: message.intent.name }) : t("bubble.fromIntent");
    case "webhook":
      return t("bubble.fromAWebhook");
    case "goal":
      return goalLabel(message.text ?? "");
    case "incident":
      return t("bubble.fromBloksAboutSomethingThat");
    default:
      return t("bubble.byEmail");
  }
}

/**
 * A user bubble's text with its attachment tags lifted out: images come
 * back as thumbnails, files as small name chips, and what remains is
 * the sentence the user actually typed.
 */
export function UserText({ text, highlight }: { text: string; highlight?: string }) {
  const { display, images, files, voice } = splitAttachments(text);
  return (
    <>
      {/* a voice message: what it was heard as is the text below, and the
          recording stays playable, because a transcript can be wrong */}
      {voice.map((path, i) => (
        <div key={i} className="mb-1 flex flex-col gap-1">
          <span className="flex items-center gap-1 text-small opacity-80">
            <Mic size={12} />
            {t("bubble.voiceMessageTranscribed")}
          </span>
          <audio controls preload="none" src={`/api/attachments/${attachmentBasename(path)}`} className="h-8 max-w-full" />
        </div>
      ))}
      {images.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1.5">
          {images.map((path, i) => (
            <img
              key={i}
              src={`/api/attachments/${attachmentBasename(path)}`}
              alt={t("bubble.attachedImage")}
              className="max-h-[220px] max-w-full rounded-xl object-contain"
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {files.map((path, i) => (
            <span
              key={i}
              title={path}
              className="rounded-lg bg-foreground/[0.07] px-1.5 py-0.5 text-small"
            >
              {attachmentBasename(path)}
            </span>
          ))}
        </div>
      )}
      {withHighlight([display], highlight ?? "")}
    </>
  );
}

/**
 * A message taken back, whatever shape it used to be.
 *
 * The row stays so replies pointing at it still make sense and the
 * transcript keeps its shape. A card, a chart or an artifact that is
 * taken back gets the same line as a sentence does: anything else means
 * some kinds vanish silently and others leave a gap.
 */
/** One line for a whole rewind, however many messages it took back.
 * Opens to show them, faded, because "what did I throw away" is a
 * question people ask a minute later. */
export function Rewound({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const words = messages.filter((m) => m.kind === "text" && m.text);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-small text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground"
      >
        <History size={12} />
        {/* what was said, not the cards and notes around it */}
        {(() => {
          const n = words.length || messages.length;
          return t("bubble.rewound", { count: n });
        })()}
        {words.length > 0 && <ChevronDown size={12} className={cn("transition-transform duration-200", open && "rotate-180")} />}
      </button>
      {open && words.length > 0 && (
        <div className="flex w-full animate-fade-in flex-col gap-1.5">
          {words.map((m) => (
            <div key={m.id} className={cn("flex w-full", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("min-w-0 whitespace-pre-wrap rounded-2xl border border-dashed px-3 py-1.5 text-body text-muted-foreground line-through decoration-muted-foreground/50 [overflow-wrap:anywhere]", m.role === "user" ? "max-w-[82%] sm:max-w-[68%]" : "max-w-full")}>
                {m.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A run of quiet check-ins as one muted line. It opens to show what was
 * asked and answered, for whoever wants to see that the routine really is
 * running, and stays out of the way otherwise. */
export function QuietCheckIns({ messages }: { messages: Array<Pick<Message, "id" | "at" | "role" | "text"> & { kind: string }> }) {
  const [open, setOpen] = useState(false);
  const words = messages.filter((m) => m.kind === "text" && m.text);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-small text-muted-foreground/80 transition-colors duration-150 hover:bg-accent/60 hover:text-foreground"
      >
        <BellOff size={12} className="shrink-0" />
        <span className="truncate">{quietLine(messages, (at) => stamp(at))}</span>
        {words.length > 0 && <ChevronDown size={12} className={cn("shrink-0 transition-transform duration-200", open && "rotate-180")} />}
      </button>
      {open && words.length > 0 && (
        <div className="flex w-full animate-fade-in flex-col gap-1">
          {words.map((m) => (
            <div key={m.id} className={cn("flex w-full", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("min-w-0 whitespace-pre-wrap rounded-2xl border border-dashed px-3 py-1.5 text-body text-muted-foreground [overflow-wrap:anywhere]", m.role === "user" ? "max-w-[82%] sm:max-w-[68%]" : "max-w-full")}>
                {m.text}
                <span className="ml-2 text-caption text-muted-foreground/70">{stamp(m.at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TakenBack({ user }: { user: boolean }) {
  return (
    <div className={cn("flex w-full", user ? "justify-end" : "justify-start")}>
      <div className="rounded-2xl border border-dashed px-3 py-1.5 text-body italic text-muted-foreground">
        {t("bubble.messageTakenBack")}
      </div>
    </div>
  );
}

export function Bubble({
  message,
  fresh,
  author,
  onReply,
  onForward,
  onReact,
  onEdit,
  onDelete,
  onRewind,
  previewRedo,
  onRedo,
  redoTick,
  agentName,
  nameOf,
  highlight = "",
  isHit,
  editNow,
  group,
}: {
  message: Message;
  /** Drawn as one of several voices: see GroupPlace. */
  group?: GroupPlace;
  /** The next bubble says the same time. The time now shows only with a
   * message's actions, one message at a time, so nothing repeats and
   * every message can still say when it was sent. Kept so callers that
   * work it out need not change. */
  hideTime?: boolean;
  /** Changes when ↑ in the empty composer asks to edit this message. */
  editNow?: number;
  fresh?: boolean;
  author: string;
  onReply: (draft: ReplyDraft) => void;
  onForward: (message: Message, author: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onEdit?: (messageId: string, text: string) => void;
  onDelete?: (messageId: string) => void;
  onRewind?: (messageId: string) => void;
  /** What redoing this message would take back, or that it is not
   * offered: asked of the server, which holds the turns and the files. */
  previewRedo?: (messageId: string) => Promise<RedoPreview>;
  /** Redo from the new words. Resolves to why it did not happen, or null. */
  onRedo?: (messageId: string, text: string) => Promise<string | null>;
  /** Changes as the conversation moves, so an open editor asks again. */
  redoTick?: string;
  agentName?: string;
  nameOf?: (id: string) => string;
  highlight?: string;
  isHit?: boolean;
}) {
  const user = message.role === "user";
  // Editing happens where the message already is. Sending it back to
  // the composer would lose your place and pretend it is a new message.
  const [editing, setEditing] = useState<string | null>(null);
  // Opened from the keyboard, it hands the keyboard back when it closes,
  // so the next thing typed lands in the composer again.
  const returnTo = useRef<HTMLElement | null>(null);
  // A message the agent has already read can be redone from its editor:
  // the agent stops, the conversation and the folder go back to before
  // the message, and the new words are sent (GitHub 258). Saving alone
  // only rewrites the stored words, which the agent never hears. Whether
  // Redo is offered, and the line that says what it takes back, come
  // from the server, asked when the editor opens and again as the
  // conversation moves under it, so the line stays true while the agent
  // works.
  const [redo, setRedo] = useState<RedoPreview | null>(null);
  const [redoing, setRedoing] = useState(false);
  const [redoError, setRedoError] = useState<string | null>(null);
  const asked = useRef<Promise<RedoPreview | null> | null>(null);
  const startEditing = () => {
    if (editing !== null) return;
    setEditing(message.text ?? "");
  };
  useEffect(() => {
    if (!editNow) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    startEditing();
  }, [editNow]); // eslint-disable-line react-hooks/exhaustive-deps
  const stopEditing = (text?: string) => {
    if (text) onEdit?.(message.id, text);
    setEditing(null);
    setRedoError(null);
    returnTo.current?.focus();
    returnTo.current = null;
  };
  const editorOpen = editing !== null;
  useEffect(() => {
    if (!editorOpen || !user || !previewRedo) {
      asked.current = null;
      setRedo(null);
      return;
    }
    let live = true;
    const ask = previewRedo(message.id).catch(() => null);
    asked.current = ask;
    void ask.then((preview) => {
      if (live) setRedo(preview);
    });
    return () => {
      live = false;
    };
  }, [editorOpen, message.id, redoTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const offer = redo?.offered && onRedo ? redo : null;
  const redoNow = (text: string) => {
    if (!onRedo || redoing) return;
    setRedoing(true);
    setRedoError(null);
    void onRedo(message.id, text).then((problem) => {
      setRedoing(false);
      // refused with nothing taken back: the editor keeps the words
      if (problem) return setRedoError(problem);
      // done: the message was rewound, and the keyboard goes back to
      // the composer it came from
      stopEditing();
    });
  };
  // Enter presses the editor's main button. Which one that is is the
  // server's answer, so a quick Enter waits for it rather than saving
  // words the person meant to redo.
  const submit = async () => {
    const text = editing?.trim();
    if (!text) return stopEditing();
    if (redoing) return;
    const preview = redo ?? (await asked.current);
    if (preview?.offered && onRedo) redoNow(text);
    else stopEditing(text);
  };
  // where nothing hovers, a tap on the message shows the bar
  const tap = useTapToShow();
  // A message that waited its turn says so under it, always: that is
  // news about the message, not a timestamp. A goal's note goes through
  // the queue only to wait its turn; nobody queued it, so it never does.
  // The incident desk's note to a lead is the same: Bloks', never queued
  // by anybody.
  const queued = Boolean(message.deliveredAt && message.via !== "goal" && message.via !== "incident");

  if (!user && group) {
    return (
      <GroupMessage
        mine={false}
        first={group.first}
        last={group.last}
        face={group.face}
        name={author}
        at={message.at}
        rich={richText(message.text ?? "")}
        readId={group.readId}
        rowRef={tap.row}
        onPointerUp={tap.onPointerUp}
        className={cn(fresh && "animate-fade-in")}
        bubbleClassName={cn(isHit && "ring-2 ring-warning/70")}
        bubble={
          <>
            {message.replyTo && <ReplyContext replyTo={message.replyTo} />}
            <Markdownish text={message.text ?? ""} highlight={highlight} />
            {message.editedAt && <span className="ml-1.5 align-baseline text-caption text-muted-foreground">{t("bubble.edited")}</span>}
          </>
        }
        under={
          <Reactions
            reactions={message.reactions}
            onToggle={(emoji: string) => onReact?.(message.id, emoji)}
            nameOf={nameOf ?? ((id) => (id === "user" ? "You" : author))}
          />
        }
        actions={
          <MessageActionBar
            look="pill"
            at={message.at}
            open={tap.open}
            message={message}
            author={author}
            onReply={onReply}
            onForward={onForward}
            onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
            onDelete={onDelete ? () => onDelete(message.id) : undefined}
          />
        }
        receipts={group.receipts}
      />
    );
  }

  if (!user) {
    return (
      <div
        ref={tap.row}
        data-bubble="agent"
        // an arriving reply fades in where it will stay: it is often the
        // streamed words settling, and those should not move
        className={cn("group relative flex flex-col items-start pt-1", fresh && "animate-fade-in")}
      >
        <div
          onPointerUp={tap.onPointerUp}
          className={cn(
            // no bubble: a reply is the page you are reading, set as prose
            "w-full min-w-0 text-lead text-foreground",
            // the hit you are standing on, so n and N feel like movement
            isHit && "rounded-lg ring-2 ring-warning/70 ring-offset-4 ring-offset-background",
          )}
        >
          {message.replyTo && <ReplyContext replyTo={message.replyTo} />}
          <Markdownish text={message.text ?? ""} highlight={highlight} />
          {message.editedAt && <span className="ml-1.5 align-baseline text-caption text-muted-foreground">{t("bubble.edited")}</span>}
        </div>
        <Reactions
          reactions={message.reactions}
          onToggle={(emoji: string) => onReact?.(message.id, emoji)}
          nameOf={nameOf ?? ((id) => (id === "user" ? "You" : author))}
        />
        {/* Under the words and lined up with them, in a row that keeps its
            height when it is not showing, so a hover never moves the page.
            Its icons carry padding of their own, so it lends a little of
            that to the gap below rather than doubling it. */}
        <MessageActionBar
          look="row"
          align="start"
          at={message.at}
          // shown only while the pointer is over the message or focus is in it,
          // the newest included: a resting transcript is words and nothing else
          className="mt-0.5 -mb-1.5"
          open={tap.open}
          message={message}
          author={author}
          onReply={onReply}
          onForward={onForward}
          onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
          onDelete={onDelete ? () => onDelete(message.id) : undefined}
        />
      </div>
    );
  }

  // The editor, opened where the message is, and the words otherwise:
  // the same in a chat with one agent and in a group.
  const draft = editing ?? "";
  const editor = (
            <div className="flex flex-col gap-1.5">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") stopEditing();
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={Math.min(8, draft.split("\n").length + 1)}
                className="w-full resize-none rounded-lg border bg-background px-2.5 py-1.5 text-lead outline-none"
              />
              {offer ? (
                <>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-muted-foreground">
                    <button
                      onClick={() => draft.trim() && redoNow(draft.trim())}
                      disabled={redoing}
                      className="font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
                    >
                      {t("bubble.redo")}
                    </button>
                    {/* the smaller way out: the words change, and the
                        agent goes on with the ones it read */}
                    <button onClick={() => stopEditing(draft.trim() || undefined)} disabled={redoing} className="text-caption hover:text-foreground">
                      {t("bubble.saveOnly")}
                    </button>
                    <button onClick={() => stopEditing()} className="text-caption hover:text-foreground">
                      {t("common.cancel")}
                    </button>
                    <span>{redoing ? t("bubble.redoing") : t("bubble.enterRedoesEscapeCancels")}</span>
                  </div>
                  <div className="text-small leading-snug text-muted-foreground" role="status">
                    {redoError ?? redoLine(offer, agentName ?? t("bubble.theAgent"))}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-small text-muted-foreground">
                  <button
                    onClick={() => stopEditing(draft.trim() || undefined)}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    {t("common.save")}
                  </button>
                  <button onClick={() => stopEditing()} className="hover:text-foreground">
                    {t("common.cancel")}
                  </button>
                  <span>{t("bubble.enterSavesEscapeCancels")}</span>
                </div>
              )}
            </div>
  );
  const words = <UserText text={message.via === "goal" ? goalNoteForPerson(message.text ?? "").body : (message.text ?? "")} highlight={highlight} />;

  if (group) {
    const fromSomewhere = message.via === "watcher" || message.via === "email" || message.via === "webhook" || message.via === "routine" || message.via === "goal" || message.via === "intent" || message.via === "incident";
    return (
      <GroupMessage
        mine={group.mine}
        first={group.first}
        last={group.last}
        face={group.face}
        name={author}
        at={message.at}
        // an editor gets the room the words may grow into
        rich={editing !== null}
        readId={group.readId}
        rowRef={tap.row}
        onPointerUp={tap.onPointerUp}
        className={cn(fresh && (group.mine ? "animate-send-in" : "animate-receive-in"))}
        bubbleClassName={cn(
          "whitespace-pre-wrap",
          // Bloks keeping a goal going, or handing a lead what failed: a
          // quieter bubble, so it never reads as the person's words
          (message.via === "goal" || message.via === "incident") && "border border-brand/25 bg-brand-soft text-foreground",
          editing !== null && "bg-muted text-foreground",
          isHit && "ring-2 ring-warning/70",
        )}
        bubble={
          <>
            {fromSomewhere && (
              <div className="mb-0.5 text-caption opacity-80">
                {viaLabel(message)}
              </div>
            )}
            {message.replyTo && <ReplyContext replyTo={message.replyTo} onAccent={group.mine && editing === null && message.via !== "goal" && message.via !== "incident"} />}
            {editing !== null ? editor : words}
            {message.editedAt && editing === null && <span className="ml-1.5 align-baseline text-caption opacity-75">{t("bubble.edited")}</span>}
          </>
        }
        under={
          <>
            <Reactions
              reactions={message.reactions}
              onToggle={(emoji: string) => onReact?.(message.id, emoji)}
              nameOf={nameOf ?? ((id) => (id === "user" ? "You" : author))}
            />
            {message.recalled?.length ? <RecalledNotes notes={message.recalled} /> : null}
            {queued && message.at && message.deliveredAt && (
              <div className="mt-1 px-1 text-caption tabular-nums text-muted-foreground">{queuedLine(message.queuedAt ?? message.at, message.deliveredAt)}</div>
            )}
            {message.delivery && message.delivery.route !== "queued" && !message.queued && (
              <div className="mt-1 px-1 text-caption text-muted-foreground">{message.delivery.line}</div>
            )}
          </>
        }
        actions={
          editing === null ? (
            <MessageActionBar
              look="pill"
              at={message.at}
              open={tap.open}
              message={message}
              author={author}
              onReply={onReply}
              onForward={onForward}
              onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
              onEdit={group.mine && onEdit && message.via !== "goal" && message.via !== "incident" ? startEditing : undefined}
              onDelete={onDelete ? () => onDelete(message.id) : undefined}
              onRewind={group.mine && onRewind ? () => onRewind(message.id) : undefined}
            />
          ) : null
        }
        receipts={group.receipts}
      />
    );
  }

  return (
    <div
      ref={tap.row}
      data-bubble="user"
      className={cn(
        "group flex flex-col items-end",
        // your own words rise into place from your side
        fresh && "animate-send-in",
      )}
    >
      {/* A column, so reactions hang under the bubble they belong to
          rather than beside it where they would push the text around. */}
      <div className={cn("flex max-w-[82%] flex-col items-end sm:max-w-[68%]", editing !== null && "w-full")}>
        {(message.via === "watcher" || message.via === "email" || message.via === "webhook" || message.via === "routine" || message.via === "goal" || message.via === "intent" || message.via === "incident") && (
          <div className="mb-1 px-1 text-caption text-muted-foreground">
            {viaLabel(message)}
          </div>
        )}
        <div
          onPointerUp={tap.onPointerUp}
          className={cn(
            // a soft bubble on your side: set apart from the replies
            // around it without shouting louder than them. Capped at its
            // column, as a group bubble is: a reply's one-line excerpt
            // would otherwise widen it past the conversation (GitHub 415).
            "min-w-0 max-w-full whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-lead text-foreground [overflow-wrap:anywhere]",
            // an editor gets the room the words may grow into
            editing !== null && "w-full",
            message.via === "goal" || message.via === "incident"
              ? // Bloks keeping a goal going, or handing a lead what
                // failed, not the person: a quieter bubble on their side,
                // so it never reads as their words
                "border border-brand/25 bg-brand-soft"
              : "bg-secondary",
            // the hit you are standing on, so n and N feel like movement
            isHit && "ring-2 ring-warning/70",
          )}
        >
          {message.replyTo && <ReplyContext replyTo={message.replyTo} />}
          {editing !== null ? editor : words}
          {message.editedAt && editing === null && (
            <span className="ml-1.5 align-baseline text-caption text-muted-foreground">{t("bubble.edited")}</span>
          )}
        </div>
        <Reactions
          reactions={message.reactions}
          onToggle={(emoji: string) => onReact?.(message.id, emoji)}
          nameOf={nameOf ?? ((id) => (id === "user" ? "You" : author))}
        />
        {/* what recall put ahead of these words for the agent */}
        {message.recalled?.length ? <RecalledNotes notes={message.recalled} /> : null}
        {queued && message.at && message.deliveredAt && (
          <div className="mt-1 px-1 text-caption tabular-nums text-muted-foreground">
            {queuedLine(message.queuedAt ?? message.at, message.deliveredAt)}
          </div>
        )}
        {/* Sent while the agent worked, and taken into that turn or
            stopping it: said once, quietly, so a person who expected it
            to wait can see it did not (server/delivery.ts). */}
        {message.delivery && message.delivery.route !== "queued" && !message.queued && (
          <div className="mt-1 px-1 text-caption text-muted-foreground">{message.delivery.line}</div>
        )}
      </div>
      {/* The same row as a reply's, under your bubble and lined up with
          its right edge. While the editor has the keyboard the row keeps
          its place and stays out of the way. */}
      <MessageActionBar
        look="row"
        align="end"
        at={message.at}
        className={cn("mt-0.5 -mb-1.5", editing !== null && "invisible")}
        open={tap.open}
        message={message}
        author={author}
        onReply={onReply}
        onForward={onForward}
        onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
        onEdit={onEdit && message.via !== "goal" && message.via !== "incident" ? startEditing : undefined}
        onDelete={onDelete ? () => onDelete(message.id) : undefined}
        onRewind={onRewind ? () => onRewind(message.id) : undefined}
      />
    </div>
  );
}


/**
 * Something stopped the turn from running: no engine installed, a CLI
 * that is not signed in, a machine out of file handles. The message is
 * usually instructions, so it is readable prose in a card rather than a
 * truncated line of monospace.
 */
/** A note a standing intent posted (server/intents.ts), with its name
 * over it so it never reads as something the agent said. */
export function IntentNote({ message, fresh }: { message: Message; fresh?: boolean }) {
  return (
    <div className={cn("flex justify-start", fresh && "animate-receive-in")}>
      <div className="flex max-w-[560px] gap-2.5 rounded-2xl border bg-card px-3.5 py-2.5">
        <Zap size={15} className="mt-0.5 shrink-0 text-brand-ink" aria-hidden />
        <div className="min-w-0">
          <div className="text-caption text-muted-foreground">
            {message.intent?.name ? t("bubble.intentNamed", { name: message.intent.name }) : t("bubble.intent")}
          </div>
          <div className="whitespace-pre-wrap text-ui leading-relaxed text-foreground">{message.text}</div>
        </div>
      </div>
    </div>
  );
}

export function Notice({ message, fresh }: { message: Message; fresh?: boolean }) {
  if (message.sessionReset) {
    return <div className="whitespace-pre-line py-2 text-center text-small leading-relaxed text-muted-foreground">{message.text}</div>;
  }
  // a compaction is a fact about the conversation, marked like a date
  // line, and so is a standing intent saying who it brought in
  if (message.compaction || (message.intent && message.event)) {
    return <div className="py-1 text-center text-small text-muted-foreground">{message.text}</div>;
  }
  // A standing intent's own note: the person's words, said back when the
  // thing they were about came up. Not a warning, so it does not wear one.
  if (message.intent && !message.event) return <IntentNote message={message} fresh={fresh} />;
  // Where a conversation brought over from before Bloks came from, and
  // how it carries on. A fact about the conversation, not a warning.
  if (message.imported) {
    return (
      <div className={cn("flex justify-start", fresh && "animate-receive-in")}>
        <div className="flex max-w-[560px] gap-2.5 rounded-2xl border bg-card px-3.5 py-2.5">
          <History size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="whitespace-pre-wrap text-ui leading-relaxed text-foreground">{message.text}</div>
        </div>
      </div>
    );
  }
  // what failed, put to the person (server/incidents.ts)
  if (message.incident && message.incident.kind !== "note") return <IncidentNotice message={message} fresh={fresh} />;
  if (message.failing) return <FailingNotice message={message} fresh={fresh} />;
  // The goal's own news. Set and done are not warnings, so they do not
  // wear one; where it stopped short (blocked, out, paused) still does.
  if (message.goal) {
    const short = message.goal === "blocked" || message.goal === "out" || message.goal === "paused";
    return (
      <div className={cn("flex justify-start", fresh && "animate-receive-in")}>
        <div
          className={cn(
            "flex max-w-[560px] gap-2.5 rounded-2xl border px-3.5 py-2.5",
            short ? "border-warning/30 bg-warning/5" : message.goal === "done" ? "border-success/30 bg-success/5" : "bg-card",
          )}
        >
          <Target
            size={15}
            className={cn("mt-0.5 shrink-0", short ? "text-warning" : message.goal === "done" ? "text-success" : "text-brand")}
            aria-hidden
          />
          <div className="whitespace-pre-wrap text-ui leading-relaxed text-foreground">{message.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex justify-start", fresh && "animate-receive-in")}>
      <div className="flex max-w-[560px] gap-2.5 rounded-2xl border border-warning/30 bg-warning/5 px-3.5 py-2.5">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="whitespace-pre-wrap text-ui leading-relaxed text-foreground">
          {message.text}
          <CarryOn message={message} />
        </div>
      </div>
    </div>
  );
}
