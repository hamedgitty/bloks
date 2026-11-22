// An agent and a room, as a member opens them.
//
// An agent has up to two conversations for a member: Team, the one shared
// thread everyone on its list writes in, and Private, theirs alone (with
// the line that says who else reads it, which is the owner's setting and
// never a surprise). A solo agent has just the one. A room is the room,
// with everyone in it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Settings, Trash2, Users } from "@/components/icons";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  memberApi,
  useMemberFrames,
  useStreaming,
  type Conversation,
  type MemberAgent,
  type MemberMessage,
  type MemberRoom,
  type MemberUsage,
  usageNotice,
} from "@/lib/memberMode";
import { seedReads } from "@/lib/readReceipts";
import { useLastRead } from "@/lib/lastRead";
import { distinctNames } from "@/lib/names";
import { ownerOrNull } from "@/lib/yourName";
import { AgentFace, MemberComposer, OnlyYou, PersonFace, Transcript } from "./MemberParts";
import { TopicBar } from "@/components/room/RoomTopics";
import { inThread, orderTopics, topicPowers, type RoomTopic, type TopicState } from "@/lib/roomTopics";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatList, t } from "@/lib/i18n";

/** A list of messages with one more folded in: added, or put in place of
 * the one with its id. */
export function withMessage(list: MemberMessage[], message: MemberMessage, moved = false): MemberMessage[] {
  const at = list.findIndex((m) => m.id === message.id);
  if (at === -1) return [...list, message];
  if (moved) return [...list.slice(0, at), ...list.slice(at + 1), message];
  const next = [...list];
  next[at] = message;
  return next;
}

/** Keeps one conversation's messages current from the live stream. */
function useLive<T extends { messages: MemberMessage[] }>(
  threadId: string | null,
  set: React.Dispatch<React.SetStateAction<T | null>>,
  reload: () => void,
  onBusy?: (busy: boolean) => void,
) {
  useMemberFrames(
    useCallback(
      (frame) => {
        if (frame.kind === "hello") return reload();
        if (!threadId) return;
        if ((frame.kind === "message" || frame.kind === "message.patch") && frame.threadId === threadId && frame.message) {
          const message = frame.message as MemberMessage;
          set((was) => (was ? { ...was, messages: withMessage(was.messages, message, frame.moved === true) } : was));
        }
        if (frame.kind === "member.lane" && frame.threadId === threadId) onBusy?.(frame.busy === true);
        const event = frame.event as { type?: string; threadId?: string } | undefined;
        if (frame.kind === "runtime" && event?.threadId === threadId) {
          if (event.type === "turn.started") onBusy?.(true);
          if (event.type === "turn.completed") onBusy?.(false);
        }
      },
      [threadId, set, reload, onBusy],
    ),
  );
}

export function AgentView({
  agent,
  lane,
  me,
  owner,
  usage,
  onLane,
  onDelete,
  onSettings,
  onSent,
  nameOf,
  known,
}: {
  /** Anybody's name in the workspace, for "Seen by". */
  nameOf?: (id: string) => string;
  /** Everybody in the workspace, for telling this conversation's people
   * apart from anybody who shares a first name (src/lib/names.ts). */
  known?: ReadonlyArray<{ id: string; name: string }>;
  agent: MemberAgent;
  lane: "team" | "private";
  me: string;
  owner: string;
  usage: MemberUsage | null;
  onLane: (lane: "team" | "private") => void;
  onDelete: () => void;
  onSettings: () => void;
  onSent: () => void;
}) {
  const [data, setData] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // which conversation the messages in hand are, so the New line is never
  // asked of the last one while the next one loads
  const key = `${agent.id}:${lane}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const load = useCallback(() => {
    memberApi
      .conversation(agent.id, lane)
      .then((c) => {
        seedReads(c.threadId, c.reads);
        setData(c);
        setLoaded(`${agent.id}:${lane}`);
        setBusy(c.busy);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [agent.id, lane]);
  useEffect(() => {
    setData(null);
    setLoaded(null);
    load();
  }, [load]);
  useLive(data?.threadId ?? null, setData, load, setBusy);
  const streaming = useStreaming(data?.threadId ?? null);
  // Where they left off (src/lib/lastRead.ts): the line above what came
  // since, and their place said as they read on. Words still waiting to
  // go are not read yet, by anybody.
  const said = data?.messages.filter((m) => !m.queued) ?? [];
  const lastRead = useLastRead({
    key,
    threadId: data?.threadId ?? null,
    lastId: said[said.length - 1]?.id,
    ready: Boolean(data) && loaded === key,
    post: memberApi.lastRead,
  });
  // their own words, from here or another screen of theirs: what was new
  // is read, and the line goes
  const lastSaid = said[said.length - 1];
  useEffect(() => {
    if (lastSaid?.role === "user" && lastSaid.author === me) lastRead.clear();
  }, [lastSaid?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const lanes = [
    ...(agent.team && !agent.solo ? [{ value: "team" as const, label: <><Users size={13} />{t("memberViews.team")}</> }] : []),
    ...(agent.private && !agent.solo ? [{ value: "private" as const, label: t("memberViews.private") }] : []),
  ];
  const team = lane === "team" && !agent.solo;
  const told = useTold(data?.people, owner, known);
  const header =
    !team && data?.privacy ? (
      <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">{data.privacy}</p>
    ) : team ? (
      <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">
        {t("memberViews.header.team", { agent: agent.name, owner })}
      </p>
    ) : agent.solo ? (
      <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">
        {t("memberViews.header.solo", { agent: agent.name, owner })}
      </p>
    ) : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b px-5 py-2 sm:h-14 sm:flex-nowrap sm:py-0">
        <AgentFace agent={agent} size={28} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 className="truncate text-ui font-semibold text-foreground">{agent.name}</h1>
          {agent.title && <span className="truncate text-body text-muted-foreground">{agent.title}</span>}
          {agent.solo && <OnlyYou className="self-center" />}
        </div>
        {lanes.length > 1 && (
          <Segmented aria-label={t("memberViews.conversation")} size="sm" value={lane} onChange={(v) => onLane(v)} options={lanes} className="w-full sm:w-[190px]" />
        )}
        {lanes.length === 1 && !agent.solo && <span className="text-body text-muted-foreground">{lane === "team" ? t("memberViews.team") : t("memberViews.private")}</span>}
        {/* everyone gets the menu: Settings for whoever may change them,
            and for anyone else the item off with who does */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("memberViews.moreFor", { agent: agent.name })}>
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[280px]">
            <DropdownMenuItem disabled={!agent.settings} onSelect={onSettings}>
              <Settings />
              {t("common.settings")}
            </DropdownMenuItem>
            {!agent.settings && (
              <p className="px-2 pb-1.5 pt-0.5 text-pretty text-small text-muted-foreground">{t("memberViews.settingsNotYours", { owner, agent: agent.name })}</p>
            )}
            {agent.solo && agent.mine && (
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                {t("memberViews.deleteAgent", { agent: agent.name })}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {data ? (
        <Transcript
          messages={data.messages}
          me={me}
          people={told.people}
          owner={told.owner}
          shared={team}
          agentName={() => agent.name}
          threadId={data.threadId}
          agentFace={() => <AgentFace agent={agent} size={28} />}
          nameOf={nameOf}
          onRead={memberApi.read}
          newFrom={lastRead.from}
          streaming={streaming}
          busy={busy}
          header={header}
          empty={
            <div className="mt-[18vh] flex flex-col items-center gap-3 text-center">
              <AgentFace agent={agent} size={48} />
              <p className="max-w-[340px] text-pretty text-ui text-muted-foreground">
                {team ? t("memberViews.empty.team", { agent: agent.name }) : t("memberViews.empty.private", { agent: agent.name })}
              </p>
            </div>
          }
          onAnswer={async (messageId, answer) => {
            await memberApi.answer(agent.id, lane, messageId, answer);
          }}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-5 px-6 pt-8" aria-busy="true">
          {error ? (
            <p role="alert" className="text-body text-destructive">{error}</p>
          ) : (
            <>
              <Skeleton className="ml-auto h-10 w-56 rounded-2xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </>
          )}
        </div>
      )}
      <MemberComposer
        autoFocusKey={`${agent.id}:${lane}`}
        placeholder={team ? t("memberViews.placeholder.team", { agent: agent.name }) : t("memberViews.placeholder.agent", { agent: agent.name })}
        notice={usageNotice(usage)}
        onSend={async (text) => {
          const sent = await memberApi.say(agent.id, lane, text);
          setData((was) => (was ? { ...was, messages: withMessage(was.messages, sent.message) } : was));
          if (!sent.queued) setBusy(true);
          lastRead.clear();
          onSent();
        }}
      />
    </main>
  );
}

export function RoomView({
  roomId,
  me,
  usage,
  nameOf,
  known,
  admin = false,
}: {
  roomId: string;
  me: string;
  usage: MemberUsage | null;
  nameOf?: (id: string) => string;
  known?: ReadonlyArray<{ id: string; name: string }>;
  /** A workspace admin, who opens and closes the room's topics. */
  admin?: boolean;
}) {
  const [data, setData] = useState<MemberRoom | null>(null);
  // the room's topics and the thread being read: a topic's, or the main
  // stream (server/room-topics.ts)
  const [thread, setThread] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [topicError, setTopicError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    memberApi
      .room(roomId)
      .then((r) => {
        seedReads(roomId, r.reads);
        setData(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [roomId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useLive(roomId, setData, load);
  useMemberFrames(
    useCallback(
      (frame) => {
        if ((frame.kind === "room.people" || frame.kind === "room.activity") && frame.roomId === roomId) load();
        // a topic opened, closed or changed by someone else, live
        if (frame.kind === "room.topics" && frame.roomId === roomId && Array.isArray(frame.topics)) {
          const topics = frame.topics as RoomTopic[];
          setData((was) => (was ? { ...was, room: { ...was.room, topics } } : was));
        }
      },
      [roomId, load],
    ),
  );
  const people = useMemo(() => Object.fromEntries((data?.room.people ?? []).map((p) => [p.id, p.name])), [data]);
  const told = useTold(people, data?.room.owner.name ?? "", known);
  const agentName = (id: string | undefined) => data?.room.agents.find((a) => a.id === id)?.name ?? t("memberViews.anAgent");
  const busy = Boolean(data?.room.agents.some((a) => a.busy));
  const viewer = data?.room.role === "viewer";
  const topics = orderTopics(data?.room.topics);
  const topic = thread ? (topics.find((tp) => tp.id === thread) ?? null) : null;
  const powers = topicPowers(viewer ? { kind: "viewer", personId: me } : admin ? { kind: "admin", personId: me } : { kind: "collaborator", personId: me });
  const shownMessages = (data?.messages ?? []).filter((m) => inThread(m, topic?.id ?? null));
  const topicStates = new Map<string, TopicState>(topics.map((tp) => [tp.id, tp.status === "closed" ? "closed" : "idle"]));
  const topicCountMap = new Map<string, number>();
  for (const m of data?.messages ?? []) if (m.topicId) topicCountMap.set(m.topicId, (topicCountMap.get(m.topicId) ?? 0) + 1);
  // a topic changed elsewhere arrives with the room, so it is asked again
  const changeTopic = (run: () => Promise<unknown>) => {
    setTopicError(null);
    run()
      .then(load)
      .catch((e: Error) => setTopicError(e.message));
  };
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <h1 className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground">{data?.room.name ?? t("memberViews.room")}</h1>
        {data && (
          <div className="flex items-center -space-x-1" aria-label={t("memberViews.roomFaces", { agents: data.room.agents.length, people: data.room.people.length + 1 })}>
            {data.room.agents.slice(0, 4).map((a) => (
              <span key={a.id} className="rounded-[9px] ring-2 ring-background">
                <AgentFace agent={a} size={22} />
              </span>
            ))}
            {data.room.people.slice(0, 4).map((p) => (
              <span key={p.id} className="rounded-full ring-2 ring-background">
                <PersonFace id={p.id} name={p.name} size={22} />
              </span>
            ))}
          </div>
        )}
      </header>
      {data && (topics.length > 0 || powers.open) && (
        <TopicBar
          topics={topics}
          current={topic?.id ?? null}
          states={topicStates}
          counts={topicCountMap}
          canOpen={powers.open}
          onPick={setThread}
          onNew={() => setNaming(true)}
        />
      )}
      {topic && powers.close && (
        <div className="flex shrink-0 items-center gap-2 border-b px-5 py-1.5 text-small text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{topic.category ?? topic.title}</span>
          {topicError && <span role="alert" className="text-destructive">{topicError}</span>}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-small"
            onClick={() => changeTopic(() => memberApi.topicStatus(roomId, topic.id, topic.status === "open" ? "closed" : "open"))}
          >
            {topic.status === "open" ? t("roomTopics.close") : t("roomTopics.reopen")}
          </Button>
        </div>
      )}
      {naming && (
        <MemberTopicDialog
          onClose={() => setNaming(false)}
          onOpen={async (title, category) => {
            const made = (await memberApi.openTopic(roomId, { title, category: category || null })) as { topic: { id: string } };
            setNaming(false);
            load();
            setThread(made.topic.id);
          }}
        />
      )}
      {data ? (
        <Transcript
          messages={shownMessages}
          me={me}
          people={told.people}
          owner={told.owner}
          shared
          agentName={agentName}
          threadId={roomId}
          agentFace={(id) => {
            const a = data.room.agents.find((x) => x.id === id);
            return a ? <AgentFace agent={a} size={28} /> : null;
          }}
          nameOf={(id) => told.people[id] ?? nameOf?.(id) ?? t("memberViews.someone")}
          onRead={memberApi.read}
          streaming=""
          busy={busy}
          header={
            <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">
              {t("memberViews.header.room", { agents: formatList(data.room.agents.map((a) => a.name), { type: "unit", style: "short" }), count: data.room.people.length + 1 })}
            </p>
          }
          onAnswer={async (messageId, answer) => {
            await memberApi.answerRoom(roomId, messageId, answer);
          }}
        />
      ) : (
        <div className="mx-auto w-full max-w-[760px] px-6 pt-8" aria-busy="true">
          {error ? <p role="alert" className="text-body text-destructive">{error}</p> : <Skeleton className="h-4 w-2/3" />}
        </div>
      )}
      <MemberComposer
        autoFocusKey={roomId}
        placeholder={data?.room.name ? t("memberViews.placeholder.room", { room: data.room.name }) : t("memberViews.placeholder.theRoom")}
        disabled={viewer ? t("memberViews.viewerOnly") : topic?.status === "closed" ? t("roomComposer.topicClosed", { name: topic.title }) : null}
        notice={usageNotice(usage)}
        onSend={async (text) => {
          const said = await memberApi.post(roomId, text, topic?.id);
          setData((was) => (was ? { ...was, messages: withMessage(was.messages, said.message) } : was));
        }}
      />
    </main>
  );
}

/** An admin opening a topic from the member's app: its title and, if
 * wanted, a category. Which agents work in it, its folder and its branch
 * are set from the owner's app. */
function MemberTopicDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (title: string, category: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-24px)] max-w-[420px] gap-3 p-5">
        <DialogTitle className="text-ui">{t("roomTopics.newTitle")}</DialogTitle>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || busy) return;
            setBusy(true);
            onOpen(title, category)
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <Input autoFocus value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={t("roomTopics.field.title")} aria-label={t("roomTopics.field.title")} />
          <Input value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} placeholder={t("roomTopics.field.category")} aria-label={t("roomTopics.field.category")} />
          {error && <p role="alert" className="text-small text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!title.trim() || busy}>
              {t("roomTopics.open")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A conversation's people and its owner as it calls them: first names,
 * told apart from everybody in the workspace who shares one
 * (src/lib/names.ts), the room's own guests included.
 */
function useTold(people: Record<string, string> | undefined, owner: string, known: ReadonlyArray<{ id: string; name: string }> = []) {
  return useMemo(() => {
    const here = Object.entries(people ?? {}).map(([id, name]) => ({ id, name }));
    const named = ownerOrNull(owner);
    const called = distinctNames([...(named ? [{ id: "owner", name: named }] : []), ...known, ...here]);
    return {
      people: Object.fromEntries(here.map((p) => [p.id, called.get(p.id) ?? p.name])),
      owner: called.get("owner") ?? owner,
    };
  }, [people, owner, known]);
}
