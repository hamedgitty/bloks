// The conversation verbs: reply, forward, copy, react and the rest.
//
// Shared by solo chats and rooms: in both they sit in a quiet row
// under each message. The row shows on hover, on keyboard focus, or
// on a tap where nothing hovers (useTapToShow). Here too are the two
// pieces that complete the loop: the chip a composer shows while a
// reply is being written, and the picker a forward opens. Reply carries
// structured context to the agent and renders as a quoted card on the
// bubble; forward re-posts the message into another conversation with
// its origin named.
import { Fragment, forwardRef, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check } from "@/components/icons";
import { CornerUpLeft } from "@/components/icons";
import { Copy } from "@/components/icons";
import { SmilePlus } from "@/components/icons";
import { Pencil } from "@/components/icons";
import { History } from "@/components/icons";
import { GitBranch } from "@/components/icons";
import { MoreHorizontal } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { Send } from "@/components/icons";
import { Users } from "@/components/icons";
import { X } from "@/components/icons";
import { useStore, type Message } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { stamp } from "@/lib/when";
import { cn } from "@/lib/cn";
import { formatDate, formatLocale, t } from "@/lib/i18n";
import { plainMentions } from "@/lib/mentions";

/** `quote` is the exact words selected in that message, when the person
 * quoted part of it rather than replying to the whole. */
export type ReplyDraft = { id?: string; author: string; excerpt: string; quote?: string };

export function excerptOf(message: Message): string {
  // an @ chip reads as its label, never as the link it travels as
  return plainMentions(message.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
}

/**
 * The actions on a touch screen, where nothing hovers and they never showed,
 * so reply, react, copy and the rest could not be reached from a phone.
 * A tap on the message shows it and a tap anywhere else puts it away.
 * Only a finger or a pen gets here: a mouse keeps the hover, and a tap on
 * a link or a button inside the message still does its own thing.
 *
 * `row` holds the message and its actions, so a tap on them is not a tap
 * away; `onPointerUp` goes on the message itself.
 */
export function useTapToShow() {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!row.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    if ((e.target as Element).closest("a, button, input, textarea, select, audio, [role=button]")) return;
    // words held down to copy are a selection, not a tap
    if (window.getSelection()?.toString()) return;
    setOpen((was) => !was);
  };
  return { open, row, onPointerUp };
}

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
    <div data-copy="skip" className="mt-1 flex flex-wrap gap-1">
      {entries.map(([emoji, who]) => {
        const mine = who.includes("user");
        return (
          <button
            key={emoji}
            onClick={() => onToggle(emoji)}
            title={who.map(nameOf).join(", ")}
            className={cn(
              "flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-small leading-5 transition-colors duration-150 active:scale-95",
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

/** When a message was said, the way a person says it a minute later:
 * "9 minutes ago", "yesterday", then the date. The exact moment is a
 * hover away, so this can afford to be loose. */
export function sinceLine(at: number, now = Date.now(), locale?: string): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return t("messageActions.justNow");
  // `locale` is for tests; the app says it in the chosen language
  const say = new Intl.RelativeTimeFormat(locale ?? formatLocale(), { numeric: "auto" });
  if (minutes < 60) return say.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say.format(-hours, "hour");
  // calendar days from here, not lots of 24 hours, so "yesterday" means
  // the day before today even across a change of the clocks
  const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);
  if (days < 7) return say.format(-days, "day");
  return stamp(at, now, locale);
}

// One clock for every "minutes ago" on the page, so a long conversation
// does not keep a timer per message. Half a minute is close enough for
// words that only count minutes.
let minuteNow = Date.now();
const ticking = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;
function onMinute(change: () => void) {
  ticking.add(change);
  if (!ticker) {
    minuteNow = Date.now();
    ticker = setInterval(() => {
      minuteNow = Date.now();
      for (const tell of ticking) tell();
    }, 30_000);
  }
  return () => {
    ticking.delete(change);
    if (ticking.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

function SaidAt({ at }: { at: number }) {
  const now = useSyncExternalStore(onMinute, () => minuteNow);
  return (
    <Tip label={formatDate(at, { dateStyle: "full", timeStyle: "short" })}>
      <time
        dateTime={new Date(at).toISOString()}
        className="px-1.5 text-caption tabular-nums whitespace-nowrap text-muted-foreground"
      >
        {sinceLine(at, Math.max(now, at))}
      </time>
    </Tip>
  );
}

/** A name for an icon, shown under it after a moment's rest. `quiet`
 * holds it back, for an icon whose menu is open or has just handed the
 * focus back to it: the name would only cover what was chosen. */
function Tip({ label, quiet, side = "bottom", children }: { label: string; quiet?: boolean; side?: "bottom" | "right"; children: React.ReactNode }) {
  return (
    <Tooltip open={quiet ? false : undefined}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className={side === "right" ? "max-w-[260px]" : undefined}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One quiet icon: muted until the pointer is on it, in a hit target a
 * finger can find. */
const Verb = forwardRef<HTMLButtonElement, React.ComponentProps<"button"> & { label: string }>(
  ({ label, className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95 data-[state=open]:bg-accent data-[state=open]:text-foreground motion-reduce:transition-none",
        className,
      )}
      {...rest}
    />
  ),
);
Verb.displayName = "Verb";

/** `blocked` is why it cannot be done now: the verb stays where it is,
 * greyed, saying why on hover, and on a press where nothing hovers. */
type Action = { label: string; icon: React.ReactNode; run: () => void; destructive?: boolean; blocked?: string | null };

/**
 * What can be done with a message, in one of two looks.
 *
 * "row" is the chat's: a line of small icons under the message, lined up
 * with its words, then when it was said. It holds its height whether it
 * shows or not, so nothing in the transcript moves when the pointer
 * arrives; it only fades in. The few verbs people reach for sit in the
 * row and the rest wait behind the ⋯.
 *
 * "pill" floats beside a message with every verb in it. Rooms used it
 * before they took the row; nothing draws it now.
 */
export function MessageActionBar({
  message,
  author,
  onReply,
  onForward,
  onReact,
  onEdit,
  onDelete,
  onRewind,
  onBranch,
  branchBlocked,
  open,
  className,
  look = "pill",
  align = "start",
  at,
}: {
  message: Message;
  author: string;
  onReply: (draft: ReplyDraft) => void;
  onForward: (message: Message, author: string) => void;
  onReact?: (emoji: string) => void;
  /** Only your own words; an agent's message is a record, not a draft. */
  onEdit?: () => void;
  onDelete?: () => void;
  /** Your own message, in a conversation with one agent. */
  onRewind?: () => void;
  /** One of the agent's answers, in a conversation with one agent: a new
   * conversation from here (src/lib/branch.ts). */
  onBranch?: () => void;
  /** Why it cannot branch right now, shown on the greyed item. */
  branchBlocked?: string | null;
  /** Shown without a hover: the message was tapped (useTapToShow). */
  open?: boolean;
  className?: string;
  look?: "row" | "pill";
  /** Which edge of the message the row lines up with: an agent's words
   * start at the left, yours end at the right. */
  align?: "start" | "end";
  /** When it was said, shown at the end of the row. */
  at?: number;
}) {
  const [copied, setCopied] = useState(false);
  // A menu that is open keeps its row in view: the pointer has left the
  // message for the menu, and the icon it hangs from should not fade
  // out from under it.
  const [menu, setMenu] = useState<"react" | "more" | null>(null);
  const [settling, setSettling] = useState<"react" | "more" | null>(null);
  const toggle = (which: "react" | "more") => (opening: boolean) => {
    setMenu(opening ? which : null);
    if (!opening) setSettling(which);
  };
  const settled = { onPointerLeave: () => setSettling(null), onBlur: () => setSettling(null) };
  if (!message.text || message.deleted) return null;
  const draft: ReplyDraft = { id: message.id, author, excerpt: excerptOf(message) };
  const copy = () => {
    void navigator.clipboard.writeText(plainMentions(message.text ?? ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  // Asked after the menu has closed and handed focus back, so the
  // question keeps the keyboard rather than losing it to the ⋯.
  const ask = (question: Parameters<typeof confirm>[0], then: () => void) =>
    setTimeout(() => void confirm(question).then((yes) => yes && then()), 0);
  const size = look === "row" ? 16 : 14;
  const copyAction: Action = {
    label: copied ? t("common.copied") : t("common.copy"),
    icon: copied ? (
      <Check size={size} strokeWidth={2.2} className="text-success" />
    ) : (
      <Copy size={size} strokeWidth={1.8} />
    ),
    run: copy,
  };
  const reply: Action = { label: t("messageActions.reply"), icon: <CornerUpLeft size={size} strokeWidth={1.8} />, run: () => onReply(draft) };
  const forward: Action = {
    label: t("messageActions.forward"),
    icon: <Send size={size - 1} strokeWidth={1.8} />,
    run: () => onForward(message, author),
  };
  const edit: Action | null = onEdit ? { label: t("common.edit"), icon: <Pencil size={size - 1} strokeWidth={1.8} />, run: onEdit } : null;
  const rewind: Action | null = onRewind
    ? {
        label: t("messageActions.rewindToHere"),
        icon: <History size={size - 1} strokeWidth={1.8} />,
        run: () =>
          ask(
            {
              title: t("messageActions.rewindTitle"),
              body: t("messageActions.rewindBody"),
              confirmLabel: t("messageActions.rewind"),
              destructive: true,
            },
            onRewind,
          ),
      }
    : null;
  // No question first: nothing is taken back or changed, and the new
  // conversation is one close away from never having been made.
  const branch: Action | null = onBranch
    ? {
        label: t("messageActions.branchFromHere"),
        icon: <GitBranch size={size - 1} strokeWidth={1.8} />,
        run: branchBlocked ? () => toast.info(branchBlocked, { id: "branch-blocked" }) : onBranch,
        blocked: branchBlocked,
      }
    : null;
  const remove: Action | null = onDelete
    ? {
        label: t("common.delete"),
        icon: <Trash2 size={size - 1} strokeWidth={1.8} />,
        // No undo exists for this, so the question is asked once and
        // names what goes.
        run: () =>
          ask(
            { title: t("messageActions.deleteTitle"), body: t("messageActions.cantUndo"), confirmLabel: t("common.delete"), destructive: true },
            onDelete,
          ),
        destructive: true,
      }
    : null;

  const mine = message.role === "user";
  // The row keeps to the four verbs people reach for. Your own message
  // swaps forward for edit, since words you sent are the ones you fix.
  const shown: Action[] =
    look === "pill"
      ? [reply, forward, ...(edit ? [edit] : []), ...(rewind ? [rewind] : []), ...(branch ? [branch] : []), ...(remove ? [remove] : []), copyAction]
      : mine
        ? [copyAction, ...(edit ? [edit] : []), reply]
        : [copyAction, reply, forward];
  // Branch waits behind the ⋯ next to where Rewind waits on your own
  // words: the two ways to go somewhere else from a point in the chat.
  const more: Action[] =
    look === "pill"
      ? []
      : [...(mine ? [forward] : []), ...(rewind ? [rewind] : []), ...(branch ? [branch] : []), ...(remove ? [remove] : [])];

  const react = onReact ? (
    <DropdownMenu modal={false} open={menu === "react"} onOpenChange={toggle("react")}>
      <Tip label={t("messageActions.react")} quiet={menu === "react" || settling === "react"}>
        <DropdownMenuTrigger asChild>
          <Verb label={t("messageActions.react")} {...settled} className={look === "pill" ? "rounded-full" : undefined}>
            <SmilePlus size={size} strokeWidth={1.8} />
          </Verb>
        </DropdownMenuTrigger>
      </Tip>
      {/* the six, in a row of their own above the icon */}
      <DropdownMenuContent
        side="top"
        align={align === "end" ? "end" : "start"}
        className="flex min-w-0 gap-0.5 rounded-full p-1"
      >
        {QUICK_REACTIONS.map((emoji) => (
          <DropdownMenuItem
            key={emoji}
            onSelect={() => onReact(emoji)}
            className="size-8 justify-center rounded-full p-0 text-lead transition-transform duration-150 data-[highlighted]:scale-110 motion-reduce:transition-none"
          >
            {emoji}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const icons = (
    <>
      {shown.map((action) => (
        <Tip key={action.label === "Copied" ? "Copy" : action.label} label={action.blocked ?? action.label}>
          <Verb
            label={action.blocked ? `${action.label}. ${action.blocked}` : action.label}
            onClick={action.run}
            aria-disabled={action.blocked ? true : undefined}
            className={cn(look === "pill" && "rounded-full", action.blocked && "opacity-40")}
          >
            {action.icon}
          </Verb>
        </Tip>
      ))}
      {react}
      {more.length > 0 && (
        <DropdownMenu modal={false} open={menu === "more"} onOpenChange={toggle("more")}>
          <Tip label={t("messageActions.more")} quiet={menu === "more" || settling === "more"}>
            <DropdownMenuTrigger asChild>
              <Verb label={t("messageActions.moreActions")} {...settled}>
                <MoreHorizontal size={size} strokeWidth={1.8} />
              </Verb>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent side="bottom" align={align === "end" ? "end" : "start"} className="min-w-[168px]">
            {more.map((action) => {
              const item = (
                <DropdownMenuItem
                  variant={action.destructive ? "destructive" : "default"}
                  onSelect={action.run}
                  aria-disabled={action.blocked ? true : undefined}
                  className={cn(action.blocked && "opacity-40")}
                >
                  {action.icon}
                  {action.label}
                  {action.blocked && <span className="sr-only">{action.blocked}</span>}
                </DropdownMenuItem>
              );
              return (
                <Fragment key={action.label}>
                  {/* the one with no undo stands apart from the rest */}
                  {action.destructive && more.length > 1 && <DropdownMenuSeparator />}
                  {action.blocked ? <Tip label={action.blocked} side="right">{item}</Tip> : item}
                </Fragment>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );

  // Hidden is see-through and out of the pointer's way, never gone: the
  // row's height stays put, and Tab still reaches a hidden icon, which
  // then shows its row because focus is inside the message.
  const showing = cn(
    "pointer-events-none opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
    "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
    (open || menu) && "pointer-events-auto opacity-100",
  );

  if (look === "row") {
    const when = at ? <SaidAt at={at} /> : null;
    return (
      <TooltipProvider delayDuration={500}>
        <div
          data-actions=""
          // the row and its time are the app's, never part of a copied reply
          data-copy="skip"
          className={cn(
            "flex h-7 shrink-0 items-center",
            // the icons' own padding sits outside the words' edge, so
            // the first glyph lines up with the text above it
            align === "end" ? "-mr-1.5 justify-end" : "-ml-1.5",
            showing,
            className,
          )}
        >
          {align === "end" && when}
          {icons}
          {align === "start" && when}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={500}>
      <div
        data-copy="skip"
        className={cn(
          "relative flex shrink-0 items-center self-center rounded-full border border-border/70 bg-popover/95 p-[3px] shadow-[0_4px_14px_-6px_rgba(0,0,0,0.25)] backdrop-blur-md",
          showing,
          className,
        )}
      >
        {react}
        {shown.map((action) => (
          <Tip key={action.label === "Copied" ? "Copy" : action.label} label={action.blocked ?? action.label}>
            <Verb
              label={action.blocked ? `${action.label}. ${action.blocked}` : action.label}
              onClick={action.run}
              aria-disabled={action.blocked ? true : undefined}
              className={cn("rounded-full", action.blocked && "opacity-40")}
            >
              {action.icon}
            </Verb>
          </Tip>
        ))}
        {/* a bubble in a group says its time here, on hover, rather than
            under every message of a run */}
        {at ? <SaidAt at={at} /> : null}
      </div>
    </TooltipProvider>
  );
}

/** What a bubble shows when its message answered an earlier one. Two
 * tones, because one tint cannot sit right on both grounds: on the dark
 * user bubble the card lifts toward white, on the light agent bubble it
 * settles into a soft grey with the brand accent naming the author. */
export function ReplyContext({
  replyTo,
  onDark,
  onAccent,
}: {
  replyTo: NonNullable<Message["replyTo"]>;
  onDark?: boolean;
  /** Inside the reader's own bubble in a group, which wears the accent. */
  onAccent?: boolean;
}) {
  return (
    // an excerpt of another message, which a copy of this one leaves out
    <div
      data-copy="skip"
      className={cn(
        "mb-1.5 flex items-start gap-1.5 rounded-lg border-l-2 px-2 py-1",
        onAccent
          ? "border-brand-foreground/60 bg-brand-foreground/15"
          : onDark
            ? "border-primary-foreground/60 bg-primary-foreground/20"
            : "border-brand/50 bg-foreground/[0.05]",
      )}
    >
      <span className="min-w-0 text-small leading-snug">
        <span className={cn("font-medium", onAccent ? "text-brand-foreground" : onDark ? "text-primary-foreground" : "text-brand-ink")}>
          {replyTo.author}
        </span>
        {/* a quote is the words picked out of it, a few lines of them */}
        <span
          className={cn(
            replyTo.quote ? "line-clamp-3 whitespace-pre-line" : "block truncate",
            onAccent ? "text-brand-foreground/80" : onDark ? "text-primary-foreground/80" : "text-muted-foreground",
          )}
        >
          {replyTo.quote ? t("composer.quoted", { words: replyTo.quote }) : replyTo.excerpt}
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
      <span className="min-w-0 flex-1 text-small leading-snug">
        <span className="font-medium text-brand-ink">{t("messageActions.replyingTo", { name: draft.author })}</span>
        <span className="block truncate text-muted-foreground">{draft.excerpt}</span>
      </span>
      <button
        onClick={onClear}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        aria-label={t("messageActions.cancelReply")}
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

  // the person's own message, so its heading is in their language
  // what it linked with @ goes as words: a forward passes on what was
  // said, and is not the person linking those things again
  const body = `${t("messageActions.forwardedFrom", { name: author })}\n> ${plainMentions(message.text ?? "").trim().split("\n").join("\n> ")}`;

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
          <DialogTitle className="text-lead">{t("messageActions.forwardTo")}</DialogTitle>
        </div>
        <div className="border-b bg-muted/40 px-5 py-2.5">
          <div className="line-clamp-2 text-small text-muted-foreground">
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
              <span className="flex-1 truncate text-ui font-medium text-foreground">
                {room.name}
              </span>
              {sent === room.id && <span className="text-small text-success">{t("messageActions.sent")}</span>}
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
                <span className="block truncate text-ui font-medium text-foreground">
                  {bot.name}
                </span>
                {bot.title && (
                  <span className="block truncate text-small text-muted-foreground">
                    {bot.title}
                  </span>
                )}
              </span>
              {sent === bot.id && <span className="text-small text-success">{t("messageActions.sent")}</span>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
