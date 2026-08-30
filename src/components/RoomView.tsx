// A room: several agents and you, in one transcript. Unlike a solo chat,
// every line is attributed, because who said it is half the meaning.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import BookmarkPlus from "lucide-react/dist/esm/icons/bookmark-plus.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Crown from "lucide-react/dist/esm/icons/crown.mjs";
import Rows3 from "lucide-react/dist/esm/icons/rows-3.mjs";
import MessagesSquare from "lucide-react/dist/esm/icons/messages-square.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import { api, useStore, formatTime, type Blok, type Bot, type Message } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { RoutinesDialog } from "./RoutinesDialog";
import { GroupCallButton } from "./Voice";
import { windowStart, TRANSCRIPT_WINDOW } from "@/lib/transcript";
import { ArtifactCard } from "./Artifacts";
import {
  ForwardDialog,
  MessageActionBar,
  Reactions,
  ReplyChip,
  ReplyContext,
  type ReplyDraft,
} from "./MessageActions";
import { OptionCard } from "./OptionCard";
import { Button } from "@/components/ui/button";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { ForumLens } from "./ForumLens";
import { GalleryComponent } from "./Gallery";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { replyCounts, replyLabel } from "@/lib/threads";
import { cn } from "@/lib/cn";

/** A reaction in a room is the cheapest thing anyone can say, and often
 * the right thing: agreeing with a plan should not wake six agents. */
function deleteRoomMessage(roomId: string, messageId: string) {
  void api(`/api/threads/${roomId}/messages/${messageId}`, { method: "DELETE" }).catch(() => {});
}

function reactTo(roomId: string, messageId: string, emoji: string) {
  void api(`/api/threads/${roomId}/messages/${messageId}/react`, {
    method: "POST",
    body: JSON.stringify({ emoji }),
  }).catch(() => {});
}

function seniorityOf(bot: Bot) {
  return bot.seniority ?? 1;
}

/** One line of a room message: a quote reads as a quote, everything
 * else keeps its @mention highlighting. Agents answering each other
 * quote what they are answering, and a bare ">" in the middle of a
 * sentence is the least useful way to show that. */
function RoomLine({ line, names }: { line: string; names: string[] }) {
  const quoted = line.match(/^\s*>\s?(.*)$/);
  if (quoted) {
    return (
      <div className="my-0.5 border-l-2 border-border pl-2.5 text-muted-foreground">
        {quoted[1] ? withMentions(quoted[1], names) : null}
      </div>
    );
  }
  if (!line.trim()) return <div className="h-2" />;
  return <div>{withMentions(line, names)}</div>;
}

/** Highlight @mentions so it's obvious who a line was aimed at. */
function withMentions(text: string, names: string[]): React.ReactNode[] {
  if (!names.length) return [text];
  const pattern = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "gi");
  return text.split(pattern).map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="font-medium text-brand-ink">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function RoomMessage({
  message,
  members,
  showSpeaker,
  roomId,
  onReply,
  onForward,
}: {
  message: Message;
  members: Bot[];
  showSpeaker: boolean;
  roomId: string;
  onReply: (draft: ReplyDraft) => void;
  onForward: (message: Message, author: string) => void;
}) {
  const names = members.map((m) => m.name);
  const speaker = message.from ? members.find((m) => m.id === message.from) : null;
  const nameOfReactor = (id: string) =>
    id === "user" ? "You" : (members.find((m) => m.id === id)?.name ?? "An agent");

  const verbs = (author: string) => (
    <MessageActionBar
      message={message}
      author={author}
      onReply={onReply}
      onForward={onForward}
      onReact={(emoji) => reactTo(roomId, message.id, emoji)}
      onDelete={() => deleteRoomMessage(roomId, message.id)}
    />
  );

  if (message.deleted) {
    return (
      <div className={cn("flex", message.role === "user" ? "justify-end" : "justify-start pl-11")}>
        <div className="rounded-2xl border border-dashed px-3 py-1.5 text-[13px] italic text-muted-foreground">
          Message taken back
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="group flex items-center justify-end gap-1.5">
        {verbs("You")}
        <div className="flex max-w-[76%] flex-col items-end">
          <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[14.5px] leading-relaxed text-primary-foreground">
            {message.replyTo && <ReplyContext replyTo={message.replyTo} onDark />}
            {message.text}
          </div>
          <Reactions
            reactions={message.reactions}
            onToggle={(emoji: string) => reactTo(roomId, message.id, emoji)}
            nameOf={nameOfReactor}
          />
        </div>
      </div>
    );
  }

  if (message.kind === "notice") {
    return (
      <div className="flex gap-2.5 pl-11">
        <div className="flex max-w-[560px] gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
            {message.text}
          </div>
        </div>
      </div>
    );
  }

  if (message.kind === "artifact" && message.artifact) {
    return (
      <div className="pl-11">
        <ArtifactCard botId={message.from ?? ""} artifact={message.artifact} />
      </div>
    );
  }

  if (message.kind === "activity" && message.tool) {
    return (
      <div className="flex items-center gap-2 pl-11 text-[12px] text-muted-foreground">
        {message.tool.ok === undefined ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <span className={cn("size-1.5 rounded-full", message.tool.ok ? "bg-success" : "bg-destructive")} />
        )}
        <span className="truncate font-mono">{message.tool.name}</span>
      </div>
    );
  }

  // the room's own opening line has no speaker
  if (!speaker) {
    return (
      <div className="py-1 text-center text-[12px] text-muted-foreground">{message.text}</div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <div className="w-8 shrink-0 pt-0.5">
        {showSpeaker && (
          <AgentAvatar bot={speaker} size={30} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {showSpeaker && (
          <div className="mb-0.5 flex items-baseline gap-1.5">
            <span className="text-[13px] font-semibold text-foreground">{speaker.name}</span>
            <span className="text-[11px] text-muted-foreground">{formatTime(message.at)}</span>
          </div>
        )}
        {message.kind === "component" && message.component ? (
          <GalleryComponent component={message.component as never} />
        ) : message.kind === "options" ? (
          // an agent can need you mid-room; the ask has to be answerable here
          <OptionCard botId={speaker.id} roomId={roomId} message={message} />
        ) : (
          <div className="group flex items-center gap-1.5">
            <div className="min-w-0 text-[14.5px] leading-relaxed text-foreground">
              {message.replyTo && <ReplyContext replyTo={message.replyTo} />}
              {(message.text ?? "").split("\n").map((line, i) => (
                <RoomLine key={i} line={line} names={names} />
              ))}
              <Reactions
                reactions={message.reactions}
                onToggle={(emoji: string) => reactTo(roomId, message.id, emoji)}
                nameOf={nameOfReactor}
              />
            </div>
            {verbs(speaker.name)}
          </div>
        )}
      </div>
    </div>
  );
}

export function RoomView({ blok }: { blok: Blok }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState("");
  // Typing @ opens a list of the people in this room. Naming somebody is
  // how a room decides who answers, so guessing the spelling should
  // never be part of it: the list filters as you type, Tab or Enter
  // completes, Escape gets out of the way.
  const [closing, setClosing] = useState(false);
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const [mentionPick, setMentionPick] = useState(0);
  // Two ways to read the same transcript. A device preference rather than
  // a room setting: which one helps depends on what you are doing, not on
  // which room you are in.
  const [lens, setLens] = useState<"stream" | "forum">(
    () => (localStorage.getItem("bloks-room-lens") === "forum" ? "forum" : "stream"),
  );
  const setLensAnd = (next: "stream" | "forum") => {
    setLens(next);
    try {
      localStorage.setItem("bloks-room-lens", next);
    } catch {
      /* private mode: the choice still holds for this session */
    }
  };
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const members = blok.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter(Boolean) as Bot[];
  // Who is in the room and who can answer are two different lists. An
  // archived member keeps its place, so an old transcript still names
  // somebody, but the roster and the crown and the mention list all
  // describe the present.
  const answering = members.filter((m) => !m.archivedAt);
  const mentionQuery =
    mentionAt === null ? null : text.slice(mentionAt + 1, inputRef.current?.selectionStart ?? text.length);
  const mentionMatches =
    mentionQuery === null || /\s/.test(mentionQuery)
      ? []
      : answering
          .filter((m) => m.name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
          .slice(0, 6);

  /** Replace the half-typed @name with the chosen one. */
  const completeMention = (name: string) => {
    if (mentionAt === null) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mentionAt)}@${name} ${text.slice(caret)}`;
    setText(next);
    setMentionAt(null);
    requestAnimationFrame(() => {
      const at = mentionAt + name.length + 2;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(at, at);
    });
  };
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const [forwarding, setForwarding] = useState<{ message: Message; author: string } | null>(null);
  const [showRoutines, setShowRoutines] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The crown goes to whoever the server would actually route to, which
   // is the most senior of the ones that can answer.
  const lead = answering.reduce<Bot | null>(
    (best, m) => (!best || seniorityOf(m) > seniorityOf(best) ? m : best),
    null,
  );
  const working = members.filter((m) => m.busy);

  const [boundary, setBoundary] = useState<number | null>(null);
  const preExpand = useRef<number | null>(null);
  const lastRoomKey = useRef(blok.id);
  if (lastRoomKey.current !== blok.id) {
    lastRoomKey.current = blok.id;
    setBoundary(null);
  }
  const start = windowStart(blok.messages.length, boundary);
  // which messages have answers hanging off them, for the stream's hint
  const counts = replyCounts(blok.messages);
  const visibleMessages = blok.messages.slice(start);

  const pinned = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && preExpand.current !== null) {
      el.scrollTop += el.scrollHeight - preExpand.current;
      preExpand.current = null;
    }
  }, [start]);

  const showEarlier = () => {
    preExpand.current = scrollRef.current?.scrollHeight ?? null;
    pinned.current = false;
    setBoundary(Math.max(0, start - TRANSCRIPT_WINDOW));
  };

  useEffect(() => {
    if (!pinned.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blok.id, blok.messages.length, working.length]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const send = () => {
    if (!text.trim()) return;
    dispatch({
      type: "sendToRoom",
      blokId: blok.id,
      text: text.trim(),
      replyTo: replyTo ?? undefined,
    });
    setText("");
    setReplyTo(null);
  };

  // Named rather than inline, because the header shows them as buttons on
  // a desktop and as menu items on a phone, and the two must not drift.
  const saveToLibrary = () => {
    // Banking the room in the library makes it repeatable: the same roles
    // can be hired again as a fresh team later.
    if (justSaved) return;
    api(`/api/bloks/${blok.id}/manifest`)
      .then((manifest) =>
        api("/api/team-library", {
          method: "POST",
          body: JSON.stringify({ name: blok.name, members: manifest.members }),
        }),
      )
      .then(() => {
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1600);
      })
      .catch(() => {});
  };

  const exportManifest = () => {
    // The manifest is the room's roles as a file, for handing to someone
    // else. It downloads rather than opens: the point is to leave with it.
    api(`/api/bloks/${blok.id}/manifest`)
      .then((manifest) => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `${blok.name.replace(/[^\w-]+/g, "-").toLowerCase() || "team"}.bloks-team.json`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => {});
  };

  const toggleLeadOnly = () => {
    api(`/api/bloks/${blok.id}`, {
      method: "PATCH",
      body: JSON.stringify({ leadOnly: !blok.leadOnly }),
    }).catch(() => {});
  };

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="titlebar-drag flex h-[52px] shrink-0 items-center justify-between gap-2 border-b px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Users size={15} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold text-foreground">{blok.name}</span>
            <span className="block truncate text-[11.5px] text-muted-foreground">
              {answering.map((m) => m.name).join(", ")}
              {answering.length < members.length &&
                ` · ${members.length - answering.length} archived`}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="hidden items-center -space-x-1.5 sm:flex">
            {answering.map((m) => (
              <span key={m.id} title={m.id === lead?.id ? `${m.name} (most senior)` : m.name}>
                <AgentAvatar bot={m} size={24} className="rounded-lg ring-2 ring-background" />
              </span>
            ))}
          </div>
          <RoomFolderButton blok={blok} />
          <GroupCallButton blok={blok} members={answering} />
          {/* Eight controls fit a desktop header and not a phone one,
              where they leave about ninety pixels for the room's own
              name. Below sm the management set moves into a menu; the
              lens and the folder stay out, because those are what you
              reach for while reading rather than while tidying up. */}
          <span className="hidden items-center gap-1.5 sm:flex">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowRoutines(true)}
            title="Routines this room runs on a schedule"
          >
            <CalendarClock size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={saveToLibrary}
            title="Save this team to your library"
          >
            {justSaved ? <Check size={16} className="text-success" /> : <BookmarkPlus size={16} />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={exportManifest}
            title="Export this team as a file"
          >
            <Download size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleLeadOnly}
            className={cn(blok.leadOnly && "bg-accent text-foreground")}
            title={
              blok.leadOnly
                ? "Lead-only is on: unaddressed messages wake just the most senior agent"
                : "Everyone answers unaddressed messages. Click so only the most senior does"
            }
          >
            <Crown size={16} />
          </Button>
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLensAnd(lens === "stream" ? "forum" : "stream")}
            className={cn(lens === "forum" && "bg-accent text-foreground")}
            title={
              lens === "stream"
                ? "Read it as topics: replies gathered under what they answer"
                : "Read it as it happened, in order"
            }
          >
            {lens === "stream" ? <MessagesSquare size={16} /> : <Rows3 size={16} />}
          </Button>
          <span className="hidden sm:inline-flex">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setClosing(true)}
              title="Archive or delete this room"
            >
              <Trash2 size={16} />
            </Button>
          </span>
          <RoomMenu
            blok={blok}
            justSaved={justSaved}
            onRoutines={() => setShowRoutines(true)}
            onSave={saveToLibrary}
            onExport={exportManifest}
            onLeadOnly={toggleLeadOnly}
            onClose={() => setClosing(true)}
          />
        </div>
      </div>

      {closing && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setClosing(false)}
        >
          <div
            className="w-[400px] max-w-[92vw] animate-pop-in rounded-2xl border bg-popover p-4 shadow-2xl sm:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold text-foreground">
              Close {blok.name}?
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Archiving takes the room off your list and keeps everything: the transcript, the
              members, the work. You can bring it back later. Deleting cannot be undone.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                onClick={() => {
                  dispatch({ type: "patchRoom", blokId: blok.id, patch: { archived: true } });
                  setClosing(false);
                }}
              >
                Archive room
              </Button>
              <Button
                variant="secondary"
                className="text-destructive"
                onClick={() => {
                  // the second decision, in its own words, naming the room
                  if (
                    window.confirm(
                      `Permanently delete ${blok.name} and its entire transcript?\n\nThis cannot be undone. Archive instead if you might want it back.`,
                    )
                  ) {
                    dispatch({ type: "deleteRoom", blokId: blok.id });
                  }
                }}
              >
                Delete permanently
              </Button>
              <Button variant="ghost" onClick={() => setClosing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {lead && members.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 border-b bg-muted/30 py-1.5 text-[11.5px] text-muted-foreground">
          <Crown size={11} />
          {lead.name} is most senior here and has the final call
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 md:px-6 [overflow-anchor:none]"
      >
        {lens === "forum" ? (
          <ForumLens
            messages={blok.messages}
            members={members}
            onOpenInStream={(messageId) => {
              setLensAnd("stream");
              setHighlightId(messageId);
              // the stream may be windowed to its tail, so open the whole
              // thing rather than scrolling to something not rendered
              setBoundary(0);
              requestAnimationFrame(() => {
                document
                  .querySelector(`[data-room-msg="${messageId}"]`)
                  ?.scrollIntoView({ block: "center", behavior: "smooth" });
              });
            }}
          />
        ) : (
        <div className="mx-auto flex max-w-[760px] flex-col gap-2 pb-4 pt-3">
          {start > 0 && (
            <button
              onClick={showEarlier}
              className="mx-auto mt-3 rounded-full border px-3.5 py-1.5 text-[12px] text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground"
            >
              Show earlier messages ({start} more)
            </button>
          )}
          {visibleMessages.map((m, i) => {
            const prev = visibleMessages[i - 1];
            const showSpeaker = !prev || prev.from !== m.from || prev.role !== m.role;
            const answers = replyLabel(counts.get(m.id) ?? 0);
            return (
              <div
                key={m.id}
                data-room-msg={m.id}
                className={cn(
                  "rounded-2xl transition-colors duration-700",
                  highlightId === m.id && "bg-brand/10",
                )}
              >
                <RoomMessage
                  message={m}
                  members={members}
                  showSpeaker={showSpeaker}
                  roomId={blok.id}
                  onReply={setReplyTo}
                  onForward={(message, author) => setForwarding({ message, author })}
                />
                {answers && (
                  <button
                    onClick={() => setLensAnd("forum")}
                    className="ml-11 mt-0.5 rounded-md px-1.5 py-0.5 text-[11.5px] text-brand-ink transition-colors duration-150 hover:bg-accent"
                  >
                    {answers}
                  </button>
                )}
              </div>
            );
          })}
          {working.map((m) => (
            <div key={m.id} className="flex animate-rise-in items-center gap-2.5 pl-11 text-[12px] text-muted-foreground">
              <Loader2 size={11} className="animate-spin" />
              {m.name} is thinking
            </div>
          ))}
        </div>
        )}
      </div>

      <div className="relative px-4 pb-4 pt-1 md:px-6 md:pb-5">
        {replyTo && (
          <div className="mx-auto mb-2 max-w-[760px]">
            <ReplyChip draft={replyTo} onClear={() => setReplyTo(null)} />
          </div>
        )}
        {mentionMatches.length > 0 && (
          <div className="mx-auto mb-1.5 max-w-[760px]">
            <div className="overflow-hidden rounded-xl border bg-popover p-1 shadow-lg shadow-[--shadow-color]">
              {mentionMatches.map((m, i) => (
                <button
                  key={m.id}
                  onMouseEnter={() => setMentionPick(i)}
                  onClick={() => completeMention(m.name)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    i === mentionPick ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <AgentAvatar bot={m} size={22} />
                  <span className="text-[13px] font-medium text-foreground">{m.name}</span>
                  {m.title && (
                    <span className="truncate text-[12px] text-muted-foreground">{m.title}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mx-auto flex max-w-[760px] items-end gap-1 rounded-[22px] border bg-background p-1.5 pl-4 shadow-[0_1px_3px_var(--shadow-color)] transition-[border-color,box-shadow] duration-150 focus-within:border-ring/50">
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            onChange={(e) => {
              const value = e.target.value;
              setText(value);
              // an @ that starts a word opens the picker; anything that
              // ends the word closes it again
              const caret = e.target.selectionStart ?? value.length;
              const at = value.lastIndexOf("@", caret - 1);
              const startsWord = at === 0 || /\s/.test(value[at - 1] ?? "");
              const stillTyping = at !== -1 && startsWord && !/\s/.test(value.slice(at + 1, caret));
              setMentionAt(stillTyping ? at : null);
              setMentionPick(0);
            }}
            onKeyDown={(e) => {
              if (mentionMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  return setMentionPick((i) => (i + 1) % mentionMatches.length);
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  return setMentionPick((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  return completeMention(mentionMatches[mentionPick].name);
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  return setMentionAt(null);
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              replyTo ? `Reply to ${replyTo.author}…` : `Message ${blok.name}, or @name someone`
            }
            className="w-full min-w-0 resize-none self-center bg-transparent py-1 text-[14.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={send}
            disabled={!text.trim()}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity] duration-150 active:scale-95",
              text.trim()
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "cursor-not-allowed bg-muted text-muted-foreground/60",
            )}
            title="Send"
          >
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      {forwarding && (
        <ForwardDialog
          message={forwarding.message}
          author={forwarding.author}
          onClose={() => setForwarding(null)}
        />
      )}
      {showRoutines && (
        <RoutinesDialog
          initialTarget={{ id: blok.id, kind: "room" }}
          onClose={() => setShowRoutines(false)}
        />
      )}
    </main>
  );
}


/** The room's shared desk: one folder every member's room turns run in.
 * Settable until the first turn pins it; a chip afterwards. */
function RoomFolderButton({ blok }: { blok: Blok }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(blok.cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  const pinned = blok.pinnedCwd !== undefined;
  const shown = blok.pinnedCwd ?? blok.cwd;

  const save = () => {
    setError(null);
    // straight fetch: a rejected path must not stick in local state
    api(`/api/bloks/${blok.id}`, {
      method: "PATCH",
      body: JSON.stringify({ cwd: draft.trim() || null }),
    })
      .then(() => setOpen(false))
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        title={shown ? `Shared folder: ${shown}` : "Shared working folder"}
      >
        <FolderOpen size={16} className={shown ? "text-brand-ink" : undefined} />
      </Button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-[320px] max-w-[92vw] animate-pop-in rounded-2xl border bg-popover p-3.5 shadow-xl shadow-[--shadow-color]">
          <div className="text-[13px] font-semibold text-foreground">Shared working folder</div>
          {pinned ? (
            <>
              <div className="mt-1 break-all text-[12.5px] text-muted-foreground">
                {blok.pinnedCwd ?? "Each member uses its own folder."}
              </div>
              <div className="mt-1.5 text-[11.5px] text-muted-foreground/70">
                Fixed since this room first worked. Make a new room to work elsewhere.
              </div>
            </>
          ) : (
            <>
              <div className="mt-1 text-[12px] text-muted-foreground">
                Every member's room turns run here. Set it before the room's first task.
              </div>
              <div className="mt-2 flex gap-1.5">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                  placeholder="/Users/you/Projects/launch  (empty = own folders)"
                  className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-ring/60"
                />
                <BrowseFolderButton onPick={setDraft} />
              </div>
              {error && <div className="mt-1.5 text-[12px] text-destructive">{error}</div>}
              <div className="mt-2 flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={save}>
                  Save
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The room's management actions, for a window too narrow to show them.
 *
 * Only below sm: a desktop header has room for the buttons and they are
 * quicker there. The same handlers either way, so what the menu does and
 * what the buttons do cannot come apart.
 */
function RoomMenu({
  blok,
  justSaved,
  onRoutines,
  onSave,
  onExport,
  onLeadOnly,
  onClose,
}: {
  blok: Blok;
  justSaved: boolean;
  onRoutines: () => void;
  onSave: () => void;
  onExport: () => void;
  onLeadOnly: () => void;
  onClose: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="sm:hidden" title="More">
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[210px]">
        <DropdownMenuItem onClick={onRoutines}>
          <CalendarClock size={15} />
          Routines
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSave}>
          {justSaved ? <Check size={15} className="text-success" /> : <BookmarkPlus size={15} />}
          Save this team
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onExport}>
          <Download size={15} />
          Export as a file
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onLeadOnly}>
          <Crown size={15} />
          {blok.leadOnly ? "Everyone answers" : "Only the lead answers"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onClose}>
          <Trash2 size={15} />
          Archive or delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
