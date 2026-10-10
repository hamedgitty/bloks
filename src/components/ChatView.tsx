import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import History from "lucide-react/dist/esm/icons/history.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Monitor from "lucide-react/dist/esm/icons/monitor.mjs";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore, laneHasMessages, openLaneWorking, type Bot, type Message } from "@/state/store";
import { CarryOn } from "@/components/CarryOn";
import { AgentAvatar } from "./Avatar";
import { OptionCard } from "./OptionCard";
import { MessageComponent } from "./Gallery";
import { Composer } from "./Composer";
import { TerminalPanel } from "./Terminal";
import { lastEditable, shouldLoadEarlier, showTypingDots, splitWaiting, windowStart, TRANSCRIPT_WINDOW } from "@/lib/transcript";
import { useEarlier } from "@/lib/useEarlier";
import { useLanesInSidebar } from "@/lib/conversationsView";
import { findHits, stepHit } from "@/lib/find";
import { dayLine, queuedLine, stamp, timeSaidBelow } from "@/lib/when";
import { attachmentBasename, splitAttachments } from "@/lib/attachments";
import { TaskStrip } from "./TaskStrip";
import { WaitingStrip } from "./WaitingStrip";
import { AfterAgentLink, AgentExchangeDialog, AgentExchangeRow } from "./AgentExchange";
import { CallButton } from "./Voice";
import { ArtifactCard } from "./Artifacts";
import { ConnectorCard } from "./ConnectorCard";
import { SecretCard } from "./SecretCard";
import { ChangesCard } from "./ChangesCard";
import { ToolRun } from "./ToolRun";
import { MeetingPanel } from "./MeetingPanel";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import Mic from "lucide-react/dist/esm/icons/mic.mjs";
import {
  ForwardDialog,
  MessageActionBar,
  Reactions,
  ReplyContext,
  useTapToShow,
  type ReplyDraft,
} from "./MessageActions";
import { ModelPicker } from "./ModelPicker";
import { EngineSetupActions } from "./EngineSetup";
import { Markdownish, withHighlight } from "./Markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useStickToBottom } from "@/lib/useStickToBottom";

/**
 * A user bubble's text with its attachment tags lifted out: images come
 * back as thumbnails, files as small name chips, and what remains is
 * the sentence the user actually typed.
 */
function UserText({ text, highlight }: { text: string; highlight?: string }) {
  const { display, images, files, voice } = splitAttachments(text);
  return (
    <>
      {/* a voice message: what it was heard as is the text below, and the
          recording stays playable, because a transcript can be wrong */}
      {voice.map((path, i) => (
        <div key={i} className="mb-1 flex flex-col gap-1">
          <span className="flex items-center gap-1 text-[11.5px] opacity-80">
            <Mic size={12} />
            Voice message, transcribed
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
              alt="attached image"
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
              className="rounded-lg bg-black/15 px-1.5 py-0.5 text-[12px]"
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
function Rewound({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const words = messages.filter((m) => m.kind === "text" && m.text);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-[12px] text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground"
      >
        <History size={12} />
        {/* what was said, not the cards and notes around it */}
        {(() => {
          const n = words.length || messages.length;
          return n === 1 ? "1 message rewound" : `${n} messages rewound`;
        })()}
        {words.length > 0 && <ChevronDown size={12} className={cn("transition-transform duration-200", open && "rotate-180")} />}
      </button>
      {open && words.length > 0 && (
        <div className="flex w-full animate-fade-in flex-col gap-1.5">
          {words.map((m) => (
            <div key={m.id} className={cn("flex w-full", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className="max-w-[82%] whitespace-pre-wrap rounded-2xl border border-dashed px-3 py-1.5 text-[13px] text-muted-foreground line-through decoration-muted-foreground/50 sm:max-w-[68%]">
                {m.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TakenBack({ user }: { user: boolean }) {
  return (
    <div className={cn("flex w-full", user ? "justify-end" : "justify-start")}>
      <div className="rounded-2xl border border-dashed px-3 py-1.5 text-[13px] italic text-muted-foreground">
        Message taken back
      </div>
    </div>
  );
}

function Bubble({
  message,
  fresh,
  author,
  onReply,
  onForward,
  onReact,
  onEdit,
  onDelete,
  onRewind,
  nameOf,
  highlight = "",
  isHit,
  hideTime,
  editNow,
}: {
  message: Message;
  /** The next bubble says the same time, so this one leaves it out. */
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
    returnTo.current?.focus();
    returnTo.current = null;
  };
  // where nothing hovers, a tap on the bubble shows the bar
  const tap = useTapToShow();

  return (
    <div
      className={cn(
        "flex flex-col",
        user ? "items-end" : "items-start",
        // arriving messages rise into place from the side they belong to
        fresh && (user ? "animate-send-in" : "animate-receive-in"),
      )}
    >
      {/* On a phone the bar floats over the bubble, as it does in rooms:
          beside it, an invisible bar held 200px of every row and squeezed
          a message to a few words a line. */}
      <div ref={tap.row} className={cn("group relative flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActionBar
            className="max-sm:absolute max-sm:-top-8 max-sm:right-0 max-sm:z-10"
            open={tap.open}
            message={message}
            author={author}
            onReply={onReply}
            onForward={onForward}
            onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
            onEdit={user && onEdit ? startEditing : undefined}
            onDelete={onDelete ? () => onDelete(message.id) : undefined}
            onRewind={onRewind ? () => onRewind(message.id) : undefined}
          />
        )}
        {/* A column, so reactions hang under the bubble they belong to
            rather than beside it where they would push the text around. */}
        <div className={cn("flex max-w-[82%] flex-col sm:max-w-[68%]", user && "items-end")}>
          {user && (message.via === "watcher" || message.via === "email" || message.via === "webhook" || message.via === "routine") && (
            <div className="mb-0.5 px-1 text-[11px] text-muted-foreground">
              {message.via === "routine" ? `From your routine${message.routine?.name ? ` ${message.routine.name}` : ""}` : message.via === "watcher" ? "From your watcher" : message.via === "webhook" ? "From a webhook" : "By email"}
            </div>
          )}
          <div
            onPointerUp={tap.onPointerUp}
            className={cn(
              "px-3.5 py-2 text-[14.5px] leading-relaxed",
              user
                ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary text-primary-foreground"
                : "rounded-2xl rounded-bl-md bg-muted text-foreground",
              // the hit you are standing on, so n and N feel like movement
              isHit && "ring-2 ring-warning/70",
            )}
          >
            {message.replyTo && <ReplyContext replyTo={message.replyTo} onDark={user} />}
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
                  rows={Math.min(8, editing.split("\n").length + 1)}
                  className="w-full resize-none rounded-lg bg-black/15 px-2 py-1 text-[14.5px] leading-relaxed outline-none"
                />
                <div className="flex items-center gap-2 text-[11.5px] opacity-80">
                  <button
                    onClick={() => stopEditing(editing.trim() || undefined)}
                    className="font-medium underline underline-offset-2"
                  >
                    Save
                  </button>
                  <button onClick={() => stopEditing()}>Cancel</button>
                  <span className="opacity-70">Enter saves, Escape cancels</span>
                </div>
              </div>
            ) : user ? (
              <UserText text={message.text ?? ""} highlight={highlight} />
            ) : (
              <Markdownish text={message.text ?? ""} highlight={highlight} />
            )}
            {message.editedAt && editing === null && (
              <span className="ml-1.5 align-baseline text-[10.5px] opacity-60">edited</span>
            )}
          </div>
          <Reactions
            reactions={message.reactions}
            onToggle={(emoji: string) => onReact?.(message.id, emoji)}
            nameOf={nameOf ?? ((id) => (id === "user" ? "You" : author))}
          />
        </div>
        {!user && (
          <MessageActionBar
            className="max-sm:absolute max-sm:-top-8 max-sm:left-0 max-sm:z-10"
            open={tap.open}
            message={message}
            author={author}
            onReply={onReply}
            onForward={onForward}
            onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
            onDelete={onDelete ? () => onDelete(message.id) : undefined}
          />
        )}
      </div>
      {/* Under the row rather than in it, so the action bar stays centred
          on the words. One that waited for a turn says both times; it
          joined the conversation when it went, which is why it is here. */}
      {message.at && !hideTime ? (
        <time
          dateTime={new Date(message.at).toISOString()}
          className="mt-0.5 px-1 text-[11px] leading-4 tabular-nums text-muted-foreground"
        >
          {message.deliveredAt
            ? queuedLine(message.queuedAt ?? message.at, message.deliveredAt)
            : stamp(message.at)}
        </time>
      ) : null}
    </div>
  );
}

/** Something the agent did, as one quiet line. Spinning while it runs,
 * then a tick or a cross. */
/**
 * The lane mail from senders the person has not listed is answered in.
 * It looks like any other conversation, but the person's own words never
 * run beside those mails: what is typed here goes to the first
 * conversation (typedLane), and this says so before anything is typed.
 */
function GuestMailLine({ bot }: { bot: Bot }) {
  const open = bot.activeTaskId ?? bot.threadId;
  if (!bot.tasks?.some((t) => t.id === open && t.guestMail)) return null;
  const first = bot.tasks.find((t) => !t.guestMail);
  return (
    <p className="mx-auto w-full max-w-[760px] px-4 pb-1 text-center text-[12px] leading-snug text-muted-foreground md:px-6">
      Mail from senders you have not listed is answered here, in conversation only. What you write goes to{" "}
      {first ? `"${first.title}"` : "the first conversation"}.
    </p>
  );
}

/**
 * Another of this agent's conversations stopped on a question or an
 * approval. The card lives in that conversation's transcript, so from this
 * one it could be listed as waiting and still not be anywhere on screen.
 */
function OtherLaneWaiting({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const open = bot.activeTaskId ?? bot.threadId;
  const waiting = (bot.tasks ?? []).filter((t) => t.state === "needs-you" && t.id !== open);
  if (!waiting.length) return null;
  const first = waiting[0];
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 md:px-6">
      <button
        onClick={() => dispatch({ type: "selectTask", botId: bot.id, taskId: first.id })}
        className="mb-2 flex w-full items-center gap-2 rounded-xl bg-warning/10 px-3.5 py-2 text-left text-[13px] text-warning transition-colors duration-150 hover:bg-warning/15"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-warning" />
        <span className="min-w-0 flex-1 truncate">
          {waiting.length === 1
            ? `"${first.title}" is waiting on you`
            : `${waiting.length} other conversations are waiting on you`}
        </span>
        <span className="shrink-0 font-medium">Open</span>
      </button>
    </div>
  );
}

/**
 * Said before the first message rather than after it: this agent's engine
 * is missing or signed out, so anything sent now would come back as an
 * error. The fix is right here, the same Install or Sign in the first-run
 * check has, or Settings for an engine that runs on a key.
 */
function EngineBanner({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection?.instanceId);
  const missing = instance ? instance.snapshot.state !== "available" : false;
  const signedOut = Boolean(instance) && !missing && instance!.snapshot.authenticated === false;
  const refresh = () => {
    api("/api/instances")
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch(() => {});
  };
  // Signing in happens in Terminal; coming back to this window is the
  // moment to look again, so the warning goes without a click.
  const showing = missing || signedOut;
  // Dismissed per engine and per problem, so closing "not signed in" does
  // not also hide a later "not installed" for the same engine.
  const dismissKey = instance ? `bloks.engineBanner.${instance.instanceId}.${missing ? "missing" : "signedOut"}` : "";
  const [dismissed, setDismissed] = useState(() => {
    try {
      return Boolean(dismissKey) && localStorage.getItem(dismissKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      setDismissed(Boolean(dismissKey) && localStorage.getItem(dismissKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [dismissKey]);
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissKey, "1");
    } catch {
      /* hidden for this visit only */
    }
  };
  useEffect(() => {
    if (!showing) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing]);
  if (!instance || !showing || dismissed) return null;
  // Another engine that would answer right now, preferring one that runs
  // tools, so the quickest fix is a single click rather than a setup.
  const ready = state.instances.filter(
    (i) =>
      i.instanceId !== instance.instanceId &&
      i.snapshot.state === "available" &&
      i.snapshot.authenticated !== false &&
      Boolean(i.models.default),
  );
  const agentic = new Set(state.providers.filter((p) => p.agentic).map((p) => p.kind));
  const alternative = ready.find((i) => agentic.has(i.driverKind)) ?? ready[0];
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 md:px-6">
      <div className="mb-2 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-[13px] leading-relaxed">
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <span className="text-foreground">
              {missing
                ? `${instance.displayName} isn't ready on this computer, so ${bot.name} can't answer yet.`
                : `${instance.displayName} isn't signed in yet, so ${bot.name} can't answer.`}
            </span>{" "}
            <span className="text-muted-foreground">Set it up here, or pick another engine at the top right.</span>
            {alternative && (
              <div className="mt-2">
                <Button
                  size="sm"
                  onClick={() =>
                    dispatch({
                      type: "setModel",
                      botId: bot.id,
                      selection: { instanceId: alternative.instanceId, model: alternative.models.default },
                    })
                  }
                >
                  Use {alternative.displayName} instead
                </Button>
              </div>
            )}
            <EngineSetupActions
              kind={instance.driverKind}
              name={instance.displayName}
              installed={!missing}
              signedOut={signedOut}
              onChanged={refresh}
            />
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, page: "engines" })}
              className="mt-1.5 text-[12px] text-muted-foreground underline hover:text-foreground"
            >
              Open engine settings
            </button>
          </div>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            title="Dismiss"
            className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-150 hover:bg-warning/10 hover:text-foreground"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Something stopped the turn from running: no engine installed, a CLI
 * that is not signed in, a machine out of file handles. The message is
 * usually instructions, so it is readable prose in a card rather than a
 * truncated line of monospace.
 */
function Notice({ message, fresh }: { message: Message; fresh?: boolean }) {
  // a compaction is a fact about the conversation, marked like a date line
  if (message.compaction) {
    return <div className="py-1 text-center text-[12px] text-muted-foreground">{message.text}</div>;
  }
  return (
    <div className={cn("flex justify-start", fresh && "animate-receive-in")}>
      <div className="flex max-w-[560px] gap-2.5 rounded-2xl border border-warning/30 bg-warning/5 px-3.5 py-2.5">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
          {message.text}
          <CarryOn message={message} />
        </div>
      </div>
    </div>
  );
}

/** Frames arrive as base64 from the agent's computer. The mime type is
 * pinned to an image allowlist so a frame can never widen into some
 * other kind of data URI. */
const FRAME_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  const safeMime = mime && FRAME_MIMES.has(mime) ? mime : "image/png";
  return (
    <div className="flex animate-rise-in justify-start">
      <img
        src={`data:${safeMime};base64,${png}`}
        alt="Agent screen"
        className="max-w-[82%] rounded-xl border sm:max-w-[68%]"
      />
    </div>
  );
}

/** The agent's browser while it works: the latest frame, and a way in.
 * A click on the picture clicks the page at the same spot, and the line
 * under it types into whatever has focus. For the logins and cookie
 * walls an agent cannot get past on its own. */
function LiveBrowser({ botId, frame }: { botId: string; frame: { png: string; mime: string } }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const safeMime = FRAME_MIMES.has(frame.mime) ? frame.mime : "image/png";
  const send = (action: "click" | "type", body: Record<string, unknown>) =>
    api(`/api/bots/${botId}/browser/${action}`, { method: "POST", body: JSON.stringify(body) })
      .then(() => setError(null))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  return (
    <div className="flex animate-rise-in justify-start">
      <div className="max-w-[82%] overflow-hidden rounded-xl border sm:max-w-[68%]">
        <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-success" />
          Live browser. Click or type to help it along.
        </div>
        <img
          src={`data:${safeMime};base64,${frame.png}`}
          alt="The agent's browser"
          className="block w-full cursor-pointer"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            void send("click", { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
          }}
        />
        <form
          className="border-t"
          onSubmit={(e) => {
            e.preventDefault();
            void send("type", { text, enter: true });
            setText("");
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type into the page, Enter to send"
            aria-label="Type into the agent's browser"
            className="w-full bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-muted-foreground"
          />
        </form>
        {error && <div className="border-t px-2.5 py-1 text-[11.5px] text-destructive">{error}</div>}
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="streaming-text max-w-[82%] rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-[14.5px] leading-relaxed text-foreground sm:max-w-[68%]">
        <Markdownish text={text} />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex animate-rise-in justify-start">
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-muted px-3.5 py-3">
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
      </div>
    </div>
  );
}

/**
 * Which messages should animate in: ones that arrive while you're
 * watching, never the backlog when you open a thread. Opening a chat and
 * seeing forty bubbles fly in would be noise, not feedback.
 */
function useArrivals(botId: string, messages: Message[]): Set<string> {
  const seen = useRef<Set<string>>(new Set());
  const [arrivals, setArrivals] = useState<Set<string>>(new Set());

  useEffect(() => {
    // switching threads: adopt the whole transcript silently
    seen.current = new Set(messages.map((m) => m.id));
    setArrivals(new Set());
  }, [botId]); // eslint-disable-line react-hooks/exhaustive-deps

  // a message that waited arrives here when it goes, so it rises into
  // the conversation like anything else said now
  useEffect(() => {
    const fresh = messages.filter((m) => !seen.current.has(m.id)).map((m) => m.id);
    if (!fresh.length) return;
    fresh.forEach((id) => seen.current.add(id));
    setArrivals(new Set(fresh));
  }, [messages]);

  return arrivals;
}

/** Toggling a reaction is a fire and forget write: the server answers
 * with a patched message and the event stream puts it on every screen,
 * so there is nothing local to keep in step. */
function editMessage(threadId: string, messageId: string, text: string) {
  void api(`/api/threads/${threadId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

function deleteMessage(threadId: string, messageId: string) {
  void api(`/api/threads/${threadId}/messages/${messageId}`, { method: "DELETE" }).catch(() => {});
}

function reactTo(threadId: string, messageId: string, emoji: string) {
  void api(`/api/threads/${threadId}/messages/${messageId}/react`, {
    method: "POST",
    body: JSON.stringify({ emoji }),
  }).catch(() => {});
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  // Only a frame that arrived during this turn is live. The one held from
  // the last turn is already in the transcript, and showing it again as
  // live would be a picture of the past with a click handler on it.
  const frame = state.screens[bot.id];
  const frameAtTurnStart = useMemo(() => state.screens[bot.id], [bot.busy, bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveBrowser =
    bot.busy && frame?.source === "browser" && frame !== frameAtTurnStart ? frame : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The conversation, and what waits to join it above the composer.
  const { said, waiting } = useMemo(() => splitWaiting(bot.messages), [bot.messages]);
  const arrivals = useArrivals(bot.id, said);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const [forwarding, setForwarding] = useState<{ message: Message; author: string } | null>(null);
  // A rewind hands your message back to the composer, to send again or
  // change first. The nonce makes the same words land twice in a row.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  // ↑ in the empty composer opens your last message for editing in its
  // bubble, the same edit as the bubble's own Edit button. The bubble
  // watches the nonce, so every press is heard.
  const [editAsk, setEditAsk] = useState<{ id: string; nonce: number } | null>(null);
  const editLast = () => {
    const mine = lastEditable(bot.messages);
    if (!mine) return false;
    setEditAsk({ id: mine.id, nonce: Date.now() });
    return true;
  };
  // Asked once. The bubble has opened by the time this runs (a child's
  // effects run first), and one drawn again later, after a trip to
  // another agent, must not open itself a second time.
  useEffect(() => {
    if (editAsk) setEditAsk(null);
  }, [editAsk]);
  // Sent again as what it says now, at the end of the conversation like
  // anything said now, and the one that never went is cleared from the
  // strip once the new one is in.
  const sendAgain = (message: Message) => {
    const threadId = bot.threadId;
    api(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: message.text, taskId: threadId }),
    })
      .then(() => api(`/api/threads/${threadId}/messages/${message.id}`, { method: "DELETE" }))
      .catch((e) => dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  const rewindTo = (threadId: string, messageId: string) => {
    api(`/api/threads/${threadId}/rewind`, { method: "POST", body: JSON.stringify({ messageId }) })
      .then((r) => setPrefill({ text: r.text ?? "", nonce: Date.now() }))
      .catch((e) => dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  // The terminal drawer. Only whether it is on screen lives here: the
  // shell itself is on the server and outlives this component, so closing
  // the drawer is closing a window onto it rather than ending it.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const saved = Number(localStorage.getItem("bloks-terminal-height"));
    return Number.isFinite(saved) && saved >= 140 ? saved : 260;
  });

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];

  // the rendered slice of a long thread; the boundary is an absolute
  // index so appends grow the window instead of sliding rows away
  const [boundary, setBoundary] = useState<number | null>(null);
  const preExpand = useRef<number | null>(null);
  const threadKey = `${bot.id}:${bot.threadId}`;
  const lastThreadKey = useRef(threadKey);
  if (lastThreadKey.current !== threadKey) {
    lastThreadKey.current = threadKey;
    setBoundary(null);
    // A quote is of a message in the conversation it was picked in, and a
    // rewind's words belong to theirs: neither goes with you to another.
    setReplyTo(null);
    setPrefill(null);
  }
  // ── find within this conversation ──
  // The palette answers "which thread was that in"; this answers "where
  // in this one", which is a different question and needs the whole
  // thread rather than the rendered tail of it.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [hitAt, setHitAt] = useState(0);
  const hits = useMemo(() => findHits(said, query), [said, query]);

  // Approvals stacked up while the user was away. One or two are a
  // conversation; several are a queue, and a queue deserves queue
  // controls rather than a scroll of identical presses.
  const pendingApprovals = useMemo(
    () =>
      bot.messages.filter(
        (m) =>
          m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed,
      ),
    [bot.messages],
  );
  const currentHit = hits.length ? hits[Math.min(hitAt, hits.length - 1)] : -1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const start = windowStart(said.length, boundary);
  // A hit above the rendered slice would be invisible and unscrollable,
  // so finding one opens the window far enough back to show it.
  const visibleStart = currentHit >= 0 && currentHit < start ? Math.max(0, currentHit - 4) : start;
  const visibleMessages = said.slice(visibleStart);

  // follow the tail only while the reader is actually at the tail
  const pinned = useRef(true);
  useStickToBottom(scrollRef, pinned);
  const scrolledTo = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // scrolling up near the top brings the next page in without a press
    const lastTop = scrolledTo.current;
    scrolledTo.current = el.scrollTop;
    // Only the reader scrolling up lets go of the end. Content that grew
    // under a reader who was there (a font, a card laying out) reaches
    // this as a scroll too, and used to leave them short of the last line.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 || (pinned.current && el.scrollTop >= lastTop);
    if (shouldLoadEarlier({ top: el.scrollTop, lastTop, more: start > 0 || earlier.remaining > 0, loading: earlier.loading })) showEarlier();
  };

  useEffect(() => {
    if (pinned.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [bot.id, said.length, waiting.length, streaming, bot.busy]);

  // expanding restores the reader's place: the same row stays under the
  // cursor while the earlier window mounts above it
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && preExpand.current !== null) {
      el.scrollTop += el.scrollHeight - preExpand.current;
      preExpand.current = null;
    }
    // a page from the server lands above with start still at 0
  }, [start, said.length]);

  // Walk to a hit: render it, then bring it to the middle of the view.
  useEffect(() => {
    if (currentHit < 0) return;
    const row = document.querySelector(`[data-msg-index="${currentHit}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentHit, visibleStart]);

  // the two-agent exchange opened from one of its rows, if any
  const [exchange, setExchange] = useState<{ peerId: string; messageId: string; text: string } | null>(null);
  const earlier = useEarlier("bot", bot);
  const lanesInSidebar = useLanesInSidebar();
  // One conversation is the usual agent (GitHub 237): with nothing to
  // switch to, the strip would only be a "+" inviting a second. New
  // conversation and Clear stay on the agent's row in the sidebar.
  const strip = !lanesInSidebar && (bot.tasks?.length ?? 0) > 1;
  const showEarlier = () => {
    preExpand.current = scrollRef.current?.scrollHeight ?? null;
    pinned.current = false;
    if (start > 0) return setBoundary(Math.max(0, start - TRANSCRIPT_WINDOW));
    // everything here is showing; the rest is still on the computer
    setBoundary(0);
    void earlier.load();
  };

  const first = said[0];
  // this conversation, not the agent: another one may be the one working
  const working = openLaneWorking(bot);

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header. Its line comes from the tab strip below it when there is
          one; with the conversations in the sidebar, or only one of them,
          there is no strip, so the header draws its own. */}
      <div
        className={cn(
          "titlebar-drag flex h-[52px] shrink-0 items-center justify-between gap-2 px-3 md:px-4",
          !strip && "border-b",
        )}
      >
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors duration-150 hover:bg-accent"
          title="Agent settings"
        >
          <AgentAvatar bot={bot} size={28} />
          <span className="flex min-w-0 items-baseline gap-2 text-left">
            <span className="truncate text-[14px] font-semibold text-foreground">{bot.name}</span>
            {(working || bot.title) && (
              <span className="hidden truncate text-[12px] text-muted-foreground sm:block">
                {working ? "working…" : bot.title}
              </span>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <ModelPicker bot={bot} />
          <CallButton bot={bot} />
          {window.bloks?.meetingStart && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => dispatch({ type: "openMeeting", botId: bot.id })}
              title={`${bot.name} takes meeting notes`}
              aria-label="Meeting notes"
            >
              <AudioLines size={17} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTerminalOpen((open) => !open)}
            className={cn(terminalOpen && "bg-accent text-foreground")}
            title={`Terminal in ${bot.name}'s folder`}
          >
            <SquareTerminal size={17} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(state.computerOpen && "bg-accent text-foreground")}
            title="Agent computer"
          >
            <Monitor size={17} />
          </Button>
        </div>
      </div>

      {/* Messages. The strip repeats what the sidebar lists when it lists
          conversations, so it only shows when the sidebar does not, and
          only once there is more than one to choose between. */}
      {strip && <TaskStrip
        tasks={bot.tasks ?? []}
        activeId={bot.activeTaskId ?? bot.threadId}
        onSelect={(taskId) => taskId !== bot.activeTaskId && dispatch({ type: "selectTask", botId: bot.id, taskId })}
        onNew={() => dispatch({ type: "newTask", botId: bot.id })}
        onClose={(taskId) => {
          // Closing deletes the transcript, and on a phone the X sits right
          // where a thumb lands, so a lane with anything in it asks first,
          // in the words the sidebar's Close uses. An empty one just goes.
          const lane = bot.tasks?.find((t) => t.id === taskId);
          const open = taskId === (bot.activeTaskId ?? bot.threadId);
          const said = laneHasMessages(lane) || (open && bot.messages.length > 0);
          if (said && !window.confirm(`Close "${lane?.title ?? "this conversation"}"? Its messages are deleted.`)) return;
          dispatch({ type: "closeTask", botId: bot.id, taskId });
        }}
        onClear={(taskId) => {
          if (window.confirm("Clear this conversation? Its messages are deleted.")) {
            dispatch({ type: "clearTask", botId: bot.id, taskId });
          }
        }}
        onRename={(taskId, title) => dispatch({ type: "renameTask", botId: bot.id, taskId, title })}
      />}
      {finding && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-background/95 px-4 py-2 md:px-6">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHitAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFinding(false);
                setQuery("");
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                setHitAt((at) => stepHit(at, hits.length, e.shiftKey ? -1 : 1));
              }
            }}
            placeholder={`Find in this conversation`}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
            {query.trim().length < 2
              ? ""
              : hits.length === 0
                ? "No matches"
                : `${Math.min(hitAt, hits.length - 1) + 1} of ${hits.length}`}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => setHitAt((at) => stepHit(at, hits.length, -1))}
              disabled={hits.length === 0}
              aria-label="Previous match"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronUp size={15} />
            </button>
            <button
              onClick={() => setHitAt((at) => stepHit(at, hits.length, 1))}
              disabled={hits.length === 0}
              aria-label="Next match"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronDown size={15} />
            </button>
            <button
              onClick={() => {
                setFinding(false);
                setQuery("");
              }}
              aria-label="Close find"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 md:px-6 [overflow-anchor:none]"
      >
        <div className="mx-auto flex max-w-[760px] flex-col gap-2.5 pb-4 pt-2">
          {start > 0 || earlier.remaining > 0 ? (
            <button
              onClick={showEarlier}
              disabled={earlier.loading}
              className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground disabled:opacity-60"
            >
              {earlier.loading && <Loader2 size={12} className="animate-spin" />}
              Show earlier messages ({start + earlier.remaining} more)
            </button>
          ) : (
            first && (
              <div className="py-3 text-center text-[12px] text-muted-foreground">
                {dayLine(first.at)}
              </div>
            )
          )}
          {visibleMessages.map((m, offset) => {
            const fresh = arrivals.has(m.id);
            const absolute = visibleStart + offset;
            if (m.deleted && m.rewound) {
              // a run of one rewind shows once, at its first message
              const before = visibleMessages[offset - 1];
              if (before?.deleted && before.rewound === m.rewound) return null;
              const run: Message[] = [];
              for (let i = offset; i < visibleMessages.length; i++) {
                const next = visibleMessages[i];
                if (!next.deleted || next.rewound !== m.rewound) break;
                run.push(next);
              }
              return <Rewound key={m.id} messages={run} />;
            }
            if (m.deleted) return <TakenBack key={m.id} user={m.role === "user"} />;
            // to or from another agent: a compact row, not a bubble that
            // looks like the person's own words
            // A reply the agent wrote in its own chat is never compacted,
            // whoever started the turn (older ones were marked dir "reply").
            if (m.agent && m.agent.dir !== "reply" && (m.kind === "text" || m.kind === "activity")) {
              return (
                <div key={m.id} data-msg-index={absolute}>
                  <AgentExchangeRow
                    message={m}
                    botId={bot.id}
                    fresh={fresh}
                    onOpen={(peerId, messageId, text) => setExchange({ peerId, messageId, text })}
                  />
                </div>
              );
            }
            switch (m.kind) {
              case "options":
                return <OptionCard key={m.id} botId={bot.id} message={m} />;
              case "activity": {
                // a run of tool calls is one line; it starts at the first
                const before = visibleMessages[offset - 1];
                if (before?.kind === "activity" && !before.deleted && !before.agent) return null;
                const run: Message[] = [];
                for (let i = offset; i < visibleMessages.length; i++) {
                  const next = visibleMessages[i];
                  if (next.kind !== "activity" || next.deleted || next.agent) break;
                  run.push(next);
                }
                return <ToolRun key={m.id} messages={run} fresh={fresh} />;
              }
              case "notice":
                return <Notice key={m.id} message={m} fresh={fresh} />;
              case "screen":
                return m.png ? <ScreenFrame key={m.id} png={m.png} mime={m.mime} /> : null;
              case "artifact":
                return m.artifact ? (
                  <div key={m.id} className={cn("flex", fresh && "animate-receive-in")}>
                    <ArtifactCard botId={bot.id} artifact={m.artifact} />
                  </div>
                ) : null;
              case "component":
                return m.component ? (
                  <div key={m.id} className={cn("flex", fresh && "animate-receive-in")}>
                    <MessageComponent message={m} threadId={bot.threadId} />
                  </div>
                ) : null;
              case "connector":
                return <ConnectorCard key={m.id} botId={bot.id} message={m} />;
              case "secret":
                return <SecretCard key={m.id} botId={bot.id} message={m} />;
              case "changes":
                return <ChangesCard key={m.id} message={m} fresh={fresh} />;
              default: {
                // context for a reply in a turn another agent started: what
                // prompted it, a click from the exchange, and nothing more
                const after = m.afterAgent ?? (m.agent?.dir === "reply" ? m.agent : undefined);
                return (
                  <div key={m.id} data-msg-index={absolute}>
                  {after && (
                    <AfterAgentLink
                      peerId={after.peerId}
                      peerName={after.peerName}
                      onOpen={() => setExchange({ peerId: after.peerId, messageId: m.id, text: m.text ?? "" })}
                    />
                  )}
                  <Bubble
                    message={m}
                    hideTime={timeSaidBelow(m, visibleMessages[offset + 1])}
                    fresh={fresh}
                    author={m.role === "user" ? "You" : bot.name}
                    onReply={setReplyTo}
                    onForward={(message, author) => setForwarding({ message, author })}
                    onReact={(messageId, emoji) => reactTo(bot.threadId, messageId, emoji)}
                    onEdit={(messageId, next) => editMessage(bot.threadId, messageId, next)}
                    onDelete={(messageId) => deleteMessage(bot.threadId, messageId)}
                    onRewind={(messageId) => rewindTo(bot.threadId, messageId)}
                    highlight={finding ? query : ""}
                    isHit={absolute === currentHit}
                    editNow={editAsk?.id === m.id ? editAsk.nonce : undefined}
                    nameOf={(id) => (id === "user" ? "You" : (state.bots.find((b) => b.id === id)?.name ?? bot.name))}
                  />
                  </div>
                );
              }
            }
          })}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 px-1.5 py-0.5 text-[12px] text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                Setting up this agent's computer…
              </div>
            </div>
          )}
          {liveBrowser && <LiveBrowser botId={bot.id} frame={liveBrowser} />}
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            showTypingDots(working, streaming, said[said.length - 1]) && (
              <TypingIndicator />
            )
          )}
        </div>
      </div>

      {terminalOpen && (
        <div
          className="flex shrink-0 flex-col border-t"
          style={{ height: terminalHeight }}
        >
          {/* Drag to resize. Pointer capture rather than window listeners
              so a fast drag that leaves the strip keeps working. */}
          <div
            role="separator"
            aria-label="Resize the terminal"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const startY = e.clientY;
              const startHeight = terminalHeight;
              const move = (event: PointerEvent) => {
                const next = Math.max(140, Math.min(window.innerHeight - 220, startHeight - (event.clientY - startY)));
                setTerminalHeight(next);
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                setTerminalHeight((height) => {
                  localStorage.setItem("bloks-terminal-height", String(height));
                  return height;
                });
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
            className="h-1.5 shrink-0 cursor-ns-resize bg-transparent transition-colors duration-150 hover:bg-accent"
          />
          <TerminalPanel bot={bot} onClose={() => setTerminalOpen(false)} />
        </div>
      )}
      {pendingApprovals.length > 1 && (
        <div className="flex items-center justify-center gap-2 px-4 pb-1">
          <span className="text-[12px] text-muted-foreground">
            {pendingApprovals.length} approvals waiting
          </span>
          <button
            onClick={() => {
              for (const m of pendingApprovals) {
                dispatch({ type: "answerCard", botId: bot.id, messageId: m.id, answer: "Allow" });
              }
            }}
            className="rounded-lg bg-brand-soft px-2.5 py-1 text-[12px] font-medium text-brand-ink transition-colors hover:opacity-90"
          >
            Allow all
          </button>
          <button
            onClick={() => {
              for (const m of pendingApprovals) {
                dispatch({ type: "answerCard", botId: bot.id, messageId: m.id, answer: "Deny" });
              }
            }}
            className="rounded-lg px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Deny all
          </button>
        </div>
      )}
      <OtherLaneWaiting bot={bot} />
      <EngineBanner bot={bot} />
      <WaitingStrip
        messages={waiting}
        threadId={bot.threadId}
        senderOf={(m) =>
          m.agent?.dir === "in"
            ? m.agent.peerName
            : m.via === "watcher"
              ? "your watcher"
              : m.via === "webhook"
                ? "a webhook"
                : m.via === "email"
                  ? "email"
                  : m.via === "routine"
                    ? `your routine${m.routine?.name ? ` ${m.routine.name}` : ""}`
                    : null
        }
        working={working}
        // the same stop Cmd+Enter makes before it sends: the turn ends,
        // and what waited behind it goes together in the next one, as
        // when a turn ends on its own
        onSendNow={working ? () => dispatch({ type: "interrupt", botId: bot.id }) : undefined}
        onSendAgain={sendAgain}
        editAsk={editAsk}
      />
      <GuestMailLine bot={bot} />
      <Composer
        key={`${bot.id}:${bot.activeTaskId ?? bot.threadId}`}
        bot={bot}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        prefill={prefill}
        onEditLast={editLast}
      />
      {exchange && (
        <AgentExchangeDialog
          botId={bot.id}
          peerId={exchange.peerId}
          focusId={exchange.messageId}
          focusText={exchange.text}
          onClose={() => setExchange(null)}
        />
      )}
      {state.meetingFor === bot.id && <MeetingPanel bot={bot} />}
      {forwarding && (
        <ForwardDialog
          message={forwarding.message}
          author={forwarding.author}
          onClose={() => setForwarding(null)}
        />
      )}
    </main>
  );
}
