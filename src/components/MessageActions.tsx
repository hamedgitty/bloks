// The conversation verbs: reply, forward, copy.
//
// One hover pill shared by solo chats and rooms, plus the two pieces
// that complete the loop: the chip a composer shows while a reply is
// being written, and the picker a forward opens. Reply carries
// structured context to the agent and renders as a quoted card on the
// bubble; forward re-posts the message into another conversation with
// its origin named.
import { useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import CornerUpLeft from "lucide-react/dist/esm/icons/corner-up-left.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import SmilePlus from "lucide-react/dist/esm/icons/smile-plus.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import Send from "lucide-react/dist/esm/icons/send.mjs";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useStore, type Message } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

export type ReplyDraft = { id?: string; author: string; excerpt: string };

export function excerptOf(message: Message): string {
  return (message.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
}

/** The hover pill. Quiet until the row is hovered, then it rises in
 * beside the bubble. Copy confirms in place with a tick, because a copy
 * that says nothing feels like a copy that did nothing. */
/** The six a person actually reaches for. A full picker is a search box
 * in disguise, and nobody searches for how they feel about a message. */
export const QUICK_REACTIONS = ["👍", "🎉", "👀", "❤️", "😂", "🤔"];

/** The chips under a message, and the toggle that owns them. */
export function Reactions({
  reactions,
  onToggle,
  nameOf,
}: {
  reactions?: Record<string, string[]>;
  onToggle: (emoji: string) => void;
  /** Turns a reactor id into something readable for the tooltip. */
  nameOf: (id: string) => string;
}) {
  const entries = Object.entries(reactions ?? {}).filter(([, who]) => who.length > 0);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([emoji, who]) => {
        const mine = who.includes("user");
        return (
          <button
            key={emoji}
            onClick={() => onToggle(emoji)}
            title={who.map(nameOf).join(", ")}
            className={cn(
              "flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[12px] leading-5 transition-colors duration-150 active:scale-95",
              mine
                ? "border-brand/40 bg-brand-soft text-foreground"
                : "border-border bg-muted/60 text-muted-foreground hover:border-foreground/25",
            )}
          >
            <span>{emoji}</span>
            {who.length > 1 && <span className="tabular-nums">{who.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function MessageActionBar({
  message,
  author,
  onReply,
  onForward,
  onReact,
  onEdit,
  onDelete,
  className,
}: {
  message: Message;
  author: string;
  onReply: (draft: ReplyDraft) => void;
  onForward: (message: Message, author: string) => void;
  onReact?: (emoji: string) => void;
  /** Only your own words; an agent's message is a record, not a draft. */
  onEdit?: () => void;
  onDelete?: () => void;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);
  if (!message.text || message.deleted) return null;
  const draft: ReplyDraft = { id: message.id, author, excerpt: excerptOf(message) };
  const copy = () => {
    void navigator.clipboard.writeText(message.text ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const buttons: Array<[string, React.ReactNode, () => void]> = [
    ...(onReact
      ? ([["React", <SmilePlus key="e" size={14} strokeWidth={1.8} />, () => setPicking((p) => !p)]] as Array<
          [string, React.ReactNode, () => void]
        >)
      : []),
    ["Reply", <CornerUpLeft key="r" size={14} strokeWidth={1.8} />, () => onReply(draft)],
    ["Forward", <Send key="f" size={13} strokeWidth={1.8} />, () => onForward(message, author)],
    ...(onEdit
      ? ([["Edit", <Pencil key="e" size={13} strokeWidth={1.8} />, onEdit]] as Array<
          [string, React.ReactNode, () => void]
        >)
      : []),
    ...(onDelete
      ? ([
          [
            "Delete",
            <Trash2 key="d" size={13} strokeWidth={1.8} />,
            () => {
              // No undo exists for this, so the question is asked once
              // and names what goes.
              if (window.confirm("Take this message back? The words are removed for good.")) {
                onDelete();
              }
            },
          ],
        ] as Array<[string, React.ReactNode, () => void]>)
      : []),
    [
      copied ? "Copied" : "Copy",
      copied ? (
        <Check key="c" size={13} strokeWidth={2.2} className="text-success" />
      ) : (
        <Copy key="c" size={13} strokeWidth={1.8} />
      ),
      copy,
    ],
  ];
  return (
    <div
      className={cn(
        "pointer-events-none relative flex shrink-0 translate-y-1 items-center self-center rounded-full border border-border/70 bg-popover/95 p-[3px] opacity-0 shadow-[0_4px_14px_-6px_rgba(0,0,0,0.25)] backdrop-blur-md transition-[opacity,transform] duration-200 ease-out group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100",
        className,
      )}
    >
      {picking && onReact && (
        <div className="absolute bottom-full right-0 mb-1.5 flex gap-0.5 rounded-full border bg-popover p-1 shadow-lg shadow-[--shadow-color]">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                onReact(emoji);
                setPicking(false);
              }}
              className="flex size-7 items-center justify-center rounded-full text-[15px] transition-transform duration-150 hover:scale-110 hover:bg-accent active:scale-95"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {buttons.map(([label, icon, run]) => (
        <button
          key={label}
          title={label}
          aria-label={label}
          onClick={run}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-90"
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

/** What a bubble shows when its message answered an earlier one. Two
 * tones, because one tint cannot sit right on both grounds: on the dark
 * user bubble the card lifts toward white, on the light agent bubble it
 * settles into a soft grey with the brand accent naming the author. */
export function ReplyContext({
  replyTo,
  onDark,
}: {
  replyTo: NonNullable<Message["replyTo"]>;
  onDark?: boolean;
}) {
  return (
    <div
      className={cn(
        "mb-1.5 flex items-start gap-1.5 rounded-lg border-l-2 px-2 py-1",
        onDark
          ? "border-primary-foreground/60 bg-primary-foreground/20"
          : "border-brand/50 bg-foreground/[0.05]",
      )}
    >
      <span className="min-w-0 text-[11.5px] leading-snug">
        <span className={cn("font-medium", onDark ? "text-primary-foreground" : "text-brand-ink")}>
          {replyTo.author}
        </span>
        <span
          className={cn(
            "block truncate",
            onDark ? "text-primary-foreground/80" : "text-muted-foreground",
          )}
        >
          {replyTo.excerpt}
        </span>
      </span>
    </div>
  );
}

/** The chip above a composer while a reply is being written. */
export function ReplyChip({ draft, onClear }: { draft: ReplyDraft; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-brand/30 bg-brand-soft px-3 py-1.5">
      <CornerUpLeft size={13} className="shrink-0 text-brand-ink" />
      <span className="min-w-0 flex-1 text-[12px] leading-snug">
        <span className="font-medium text-brand-ink">Replying to {draft.author}</span>
        <span className="block truncate text-muted-foreground">{draft.excerpt}</span>
      </span>
      <button
        onClick={onClear}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Cancel reply"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Pick where a forwarded message goes. Sends immediately on pick, with
 * the original speaker named, the way a forward reads anywhere else. */
export function ForwardDialog({
  message,
  author,
  onClose,
}: {
  message: Message;
  author: string;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const [sent, setSent] = useState<string | null>(null);

  const body = `(Forwarded from ${author})\n> ${(message.text ?? "").trim().split("\n").join("\n> ")}`;

  const forward = (target: { id: string; kind: "agent" | "room" }) => {
    if (sent) return;
    setSent(target.id);
    if (target.kind === "agent") {
      dispatch({ type: "send", botId: target.id, text: body });
    } else {
      dispatch({ type: "sendToRoom", blokId: target.id, text: body });
    }
    setTimeout(onClose, 350);
  };

  const agents = state.bots.filter((b) => !b.hidden);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[70vh] w-full max-w-[400px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center border-b px-5">
          <DialogTitle className="text-[14.5px]">Forward to…</DialogTitle>
        </div>
        <div className="border-b bg-muted/40 px-5 py-2.5">
          <div className="line-clamp-2 text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">{author}:</span> {excerptOf(message)}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {state.bloks.map((room) => (
            <button
              key={room.id}
              onClick={() => forward({ id: room.id, kind: "room" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Users size={14} />
              </span>
              <span className="flex-1 truncate text-[13.5px] font-medium text-foreground">
                {room.name}
              </span>
              {sent === room.id && <span className="text-[11.5px] text-success">Sent</span>}
            </button>
          ))}
          {agents.map((bot) => (
            <button
              key={bot.id}
              onClick={() => forward({ id: bot.id, kind: "agent" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
            >
              <AgentAvatar bot={bot} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground">
                  {bot.name}
                </span>
                {bot.title && (
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {bot.title}
                  </span>
                )}
              </span>
              {sent === bot.id && <span className="text-[11.5px] text-success">Sent</span>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
