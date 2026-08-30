import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Monitor from "lucide-react/dist/esm/icons/monitor.mjs";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore, formatTime, type Bot, type Message } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { OptionCard } from "./OptionCard";
import { GalleryComponent } from "./Gallery";
import { Composer } from "./Composer";
import { TerminalPanel } from "./Terminal";
import { showTypingDots, windowStart, TRANSCRIPT_WINDOW } from "@/lib/transcript";
import { findHits, splitHighlight, stepHit } from "@/lib/find";
import { splitBlocks, type TableBlock } from "@/lib/markdownTable";
import { attachmentBasename, splitAttachments } from "@/lib/attachments";
import { TaskStrip } from "./TaskStrip";
import { CallButton } from "./Voice";
import { ArtifactCard } from "./Artifacts";
import { ConnectorCard } from "./ConnectorCard";
import { SecretCard } from "./SecretCard";
import {
  ForwardDialog,
  MessageActionBar,
  Reactions,
  ReplyContext,
  type ReplyDraft,
} from "./MessageActions";
import { ModelPicker } from "./ModelPicker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

// Minimal markdown for bot bubbles: **bold**, `code`, headings, lists.
// Rendered as React nodes, model output never reaches the DOM as HTML.
/**
 * A user bubble's text with its attachment tags lifted out: images come
 * back as thumbnails, files as small name chips, and what remains is
 * the sentence the user actually typed.
 */
function UserText({ text, highlight }: { text: string; highlight?: string }) {
  const { display, images, files } = splitAttachments(text);
  return (
    <>
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

/** Wraps every occurrence of the query in the plain-text parts of an
 * already-rendered line. Elements are left alone: breaking a code span
 * to paint it yellow trades a working transcript for a search result. */
function withHighlight(nodes: React.ReactNode[], query: string): React.ReactNode[] {
  if (!query.trim()) return nodes;
  const out: React.ReactNode[] = [];
  nodes.forEach((node, i) => {
    if (typeof node !== "string") {
      out.push(node);
      return;
    }
    for (const [j, part] of splitHighlight(node, query).entries()) {
      out.push(
        part.hit ? (
          <mark key={`h-${i}-${j}`} className="rounded-[3px] bg-warning/40 px-px text-inherit">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      );
    }
  });
  return out;
}

function inlineMd(text: string, keyBase: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <code
          key={`${keyBase}-${i++}`}
          className="rounded bg-foreground/[0.07] px-1 py-px font-mono text-[12.5px]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * A table a model wrote, drawn as one.
 *
 * Scrolls inside its own box rather than widening the bubble: a
 * six-column comparison should not decide how wide the transcript is.
 */
function MarkdownTable({ block, highlight }: { block: TableBlock; highlight: string }) {
  const align = (i: number) => {
    const a = block.aligns[i] ?? "left";
    return a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  };
  return (
    <div className="my-1.5 max-w-full overflow-x-auto rounded-xl border">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b bg-foreground/[0.04]">
            {block.columns.map((column, i) => (
              <th
                key={i}
                className={cn("px-2.5 py-1.5 font-semibold whitespace-nowrap", align(i))}
              >
                {withHighlight(inlineMd(column, `th${i}`), highlight)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-b last:border-b-0">
              {row.map((cell, c) => (
                <td key={c} className={cn("px-2.5 py-1.5 align-top", align(c))}>
                  {withHighlight(inlineMd(cell, `td${r}-${c}`), highlight)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Markdownish({ text, highlight = "" }: { text: string; highlight?: string }) {
  const blocks = splitBlocks(text);
  if (blocks.some((block) => block.kind === "table")) {
    return (
      <>
        {blocks.map((block, b) =>
          block.kind === "table" ? (
            <MarkdownTable key={`t${b}`} block={block} highlight={highlight} />
          ) : (
            <Markdownish key={`l${b}`} text={block.lines.join("\n")} highlight={highlight} />
          ),
        )}
      </>
    );
  }
  return (
    <>
      {text.split("\n").map((line, i) => {
        const heading = line.match(/^#{1,4}\s+(.*)$/);
        if (heading) {
          return (
            <div key={i} className="mt-1.5 font-semibold">
              {withHighlight(inlineMd(heading[1], `h${i}`), highlight)}
            </div>
          );
        }
        const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="text-muted-foreground">•</span>
              <span className="min-w-0">{withHighlight(inlineMd(bullet[1], `b${i}`), highlight)}</span>
            </div>
          );
        }
        const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
        if (numbered) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="text-muted-foreground">{numbered[1]}.</span>
              <span className="min-w-0">{withHighlight(inlineMd(numbered[2], `n${i}`), highlight)}</span>
            </div>
          );
        }
        // A quoted line: what an agent is answering, or a forward's
        // original. Left rule and quieter text, because the point is that
        // it is somebody else's words, not this message's own.
        const quoted = line.match(/^\s*>\s?(.*)$/);
        if (quoted) {
          return (
            <div
              key={i}
              className="my-0.5 border-l-2 border-current/25 pl-2.5 text-current/70"
            >
              {quoted[1] ? withHighlight(inlineMd(quoted[1], `q${i}`), highlight) : null}
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-2.5" />;
        return <div key={i}>{withHighlight(inlineMd(line, `p${i}`), highlight)}</div>;
      })}
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
  nameOf,
  highlight = "",
  isHit,
}: {
  message: Message;
  fresh?: boolean;
  author: string;
  onReply: (draft: ReplyDraft) => void;
  onForward: (message: Message, author: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onEdit?: (messageId: string, text: string) => void;
  onDelete?: (messageId: string) => void;
  nameOf?: (id: string) => string;
  highlight?: string;
  isHit?: boolean;
}) {
  const user = message.role === "user";
  // Editing happens where the message already is. Sending it back to
  // the composer would lose your place and pretend it is a new message.
  const [editing, setEditing] = useState<string | null>(null);


  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1.5",
        user ? "justify-end" : "justify-start",
        // arriving messages rise into place from the side they belong to
        fresh && (user ? "animate-send-in" : "animate-receive-in"),
      )}
    >
      {user && (
        <MessageActionBar
          message={message}
          author={author}
          onReply={onReply}
          onForward={onForward}
          onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
          onEdit={user && onEdit ? () => setEditing(message.text ?? "") : undefined}
          onDelete={onDelete ? () => onDelete(message.id) : undefined}
        />
      )}
      {/* A column, so reactions hang under the bubble they belong to
          rather than beside it where they would push the text around. */}
      <div className={cn("flex max-w-[82%] flex-col sm:max-w-[68%]", user && "items-end")}>
        <div
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
                  if (e.key === "Escape") setEditing(null);
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (editing.trim()) onEdit?.(message.id, editing.trim());
                    setEditing(null);
                  }
                }}
                rows={Math.min(8, editing.split("\n").length + 1)}
                className="w-full resize-none rounded-lg bg-black/15 px-2 py-1 text-[14.5px] leading-relaxed outline-none"
              />
              <div className="flex items-center gap-2 text-[11.5px] opacity-80">
                <button
                  onClick={() => {
                    if (editing.trim()) onEdit?.(message.id, editing.trim());
                    setEditing(null);
                  }}
                  className="font-medium underline underline-offset-2"
                >
                  Save
                </button>
                <button onClick={() => setEditing(null)}>Cancel</button>
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
          {user && message.queued && (
            <div className="mt-1 flex items-center gap-1 text-[10.5px] font-medium opacity-70">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
              Queued, sends when this turn finishes
            </div>
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
          message={message}
          author={author}
          onReply={onReply}
          onForward={onForward}
          onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
          onDelete={onDelete ? () => onDelete(message.id) : undefined}
        />
      )}
    </div>
  );
}

/** Something the agent did, as one quiet line. Spinning while it runs,
 * then a tick or a cross. */
/**
 * Something stopped the turn from running: no engine installed, a CLI
 * that is not signed in, a machine out of file handles. The message is
 * usually instructions, so it is readable prose in a card rather than a
 * truncated line of monospace.
 */
function Notice({ message, fresh }: { message: Message; fresh?: boolean }) {
  return (
    <div className={cn("flex justify-start", fresh && "animate-receive-in")}>
      <div className="flex max-w-[560px] gap-2.5 rounded-2xl border border-warning/30 bg-warning/5 px-3.5 py-2.5">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
          {message.text}
        </div>
      </div>
    </div>
  );
}

function ActivityChip({ message, fresh }: { message: Message; fresh?: boolean }) {
  const tool = message.tool;
  if (!tool) return null;
  const failed = tool.ok === false;
  return (
    <div className={cn("flex justify-start", fresh && "animate-receive-in")}>
      <div
        className={cn(
          "flex items-center gap-2 px-1.5 py-0.5 text-[12px]",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {tool.ok === undefined ? (
          <Loader2 size={12} className="animate-spin" />
        ) : failed ? (
          <X size={12} />
        ) : (
          <Check size={12} className="text-success" />
        )}
        <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
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

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[82%] rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-[14.5px] leading-relaxed text-foreground sm:max-w-[68%]">
        <Markdownish text={text} />
        <span className="ml-0.5 inline-block h-[14px] w-[2px] animate-pulse bg-muted-foreground align-middle" />
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
function useArrivals(bot: Bot): Set<string> {
  const seen = useRef<Set<string>>(new Set());
  const [arrivals, setArrivals] = useState<Set<string>>(new Set());

  useEffect(() => {
    // switching threads: adopt the whole transcript silently
    seen.current = new Set(bot.messages.map((m) => m.id));
    setArrivals(new Set());
  }, [bot.id]);

  useEffect(() => {
    const fresh = bot.messages.filter((m) => !seen.current.has(m.id)).map((m) => m.id);
    if (!fresh.length) return;
    fresh.forEach((id) => seen.current.add(id));
    setArrivals(new Set(fresh));
  }, [bot.messages]);

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const arrivals = useArrivals(bot);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const [forwarding, setForwarding] = useState<{ message: Message; author: string } | null>(null);
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
  }
  // ── find within this conversation ──
  // The palette answers "which thread was that in"; this answers "where
  // in this one", which is a different question and needs the whole
  // thread rather than the rendered tail of it.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [hitAt, setHitAt] = useState(0);
  const hits = useMemo(() => findHits(bot.messages, query), [bot.messages, query]);

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

  const start = windowStart(bot.messages.length, boundary);
  // A hit above the rendered slice would be invisible and unscrollable,
  // so finding one opens the window far enough back to show it.
  const visibleStart = currentHit >= 0 && currentHit < start ? Math.max(0, currentHit - 4) : start;
  const visibleMessages = bot.messages.slice(visibleStart);

  // follow the tail only while the reader is actually at the tail
  const pinned = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (pinned.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [bot.id, bot.messages.length, streaming, bot.busy]);

  // expanding restores the reader's place: the same row stays under the
  // cursor while the earlier window mounts above it
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && preExpand.current !== null) {
      el.scrollTop += el.scrollHeight - preExpand.current;
      preExpand.current = null;
    }
  }, [start]);

  // Walk to a hit: render it, then bring it to the middle of the view.
  useEffect(() => {
    if (currentHit < 0) return;
    const row = document.querySelector(`[data-msg-index="${currentHit}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentHit, visibleStart]);

  const showEarlier = () => {
    preExpand.current = scrollRef.current?.scrollHeight ?? null;
    pinned.current = false;
    setBoundary(Math.max(0, start - TRANSCRIPT_WINDOW));
  };

  const first = bot.messages[0];

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="titlebar-drag flex h-[52px] shrink-0 items-center justify-between gap-2 px-3 md:px-4">
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors duration-150 hover:bg-accent"
          title="Agent settings"
        >
          <AgentAvatar bot={bot} size={28} />
          <span className="flex min-w-0 items-baseline gap-2 text-left">
            <span className="truncate text-[14px] font-semibold text-foreground">{bot.name}</span>
            {(bot.busy || bot.title) && (
              <span className="hidden truncate text-[12px] text-muted-foreground sm:block">
                {bot.busy ? "working…" : bot.title}
              </span>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {bot.busy && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              title="Stop this turn"
            >
              <Square size={11} className="fill-current" />
              Stop
            </Button>
          )}
          <ModelPicker bot={bot} />
          <CallButton bot={bot} />
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

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[760px] px-4">
          <div className="mt-2 animate-rise-in rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {state.error}
          </div>
        </div>
      )}

      {/* Messages */}
      <TaskStrip
        tasks={bot.tasks ?? []}
        activeId={bot.activeTaskId ?? bot.threadId}
        onSelect={(taskId) => taskId !== bot.activeTaskId && dispatch({ type: "selectTask", botId: bot.id, taskId })}
        onNew={() => dispatch({ type: "newTask", botId: bot.id })}
        onClose={(taskId) => dispatch({ type: "closeTask", botId: bot.id, taskId })}
      />
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
          {start > 0 ? (
            <button
              onClick={showEarlier}
              className="mx-auto mt-3 rounded-full border px-3.5 py-1.5 text-[12px] text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground"
            >
              Show earlier messages ({start} more)
            </button>
          ) : (
            first && (
              <div className="py-3 text-center text-[12px] text-muted-foreground">
                Today {formatTime(first.at)}
              </div>
            )
          )}
          {visibleMessages.map((m, offset) => {
            const fresh = arrivals.has(m.id);
            const absolute = visibleStart + offset;
            if (m.deleted) return <TakenBack key={m.id} user={m.role === "user"} />;
            switch (m.kind) {
              case "options":
                return <OptionCard key={m.id} botId={bot.id} message={m} />;
              case "activity":
                return <ActivityChip key={m.id} message={m} fresh={fresh} />;
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
                    <GalleryComponent component={m.component as never} />
                  </div>
                ) : null;
              case "connector":
                return <ConnectorCard key={m.id} botId={bot.id} message={m} />;
              case "secret":
                return <SecretCard key={m.id} botId={bot.id} message={m} />;
              default:
                return (
                  <div key={m.id} data-msg-index={absolute}>
                  <Bubble
                    message={m}
                    fresh={fresh}
                    author={m.role === "user" ? "You" : bot.name}
                    onReply={setReplyTo}
                    onForward={(message, author) => setForwarding({ message, author })}
                    onReact={(messageId, emoji) => reactTo(bot.threadId, messageId, emoji)}
                    onEdit={(messageId, next) => editMessage(bot.threadId, messageId, next)}
                    onDelete={(messageId) => deleteMessage(bot.threadId, messageId)}
                    highlight={finding ? query : ""}
                    isHit={absolute === currentHit}
                    nameOf={(id) => (id === "user" ? "You" : (state.bots.find((b) => b.id === id)?.name ?? bot.name))}
                  />
                  </div>
                );
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
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            showTypingDots(bot.busy, streaming, bot.messages[bot.messages.length - 1]) && (
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
      <Composer bot={bot} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
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
