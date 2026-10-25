// An agent and a room, as a member opens them.
//
// An agent has up to two conversations for a member: Team, the one shared
// thread everyone on its list writes in, and Private, theirs alone (with
// the line that says who else reads it, which is the owner's setting and
// never a surprise). A solo agent has just the one. A room is the room,
// with everyone in it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Trash2, Users } from "@/components/icons";
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
import { distinctNames } from "@/lib/names";
import { ownerOrNull } from "@/lib/yourName";
import { AgentFace, MemberComposer, OnlyYou, PersonFace, Transcript } from "./MemberParts";

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
  onSent: () => void;
}) {
  const [data, setData] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    memberApi
      .conversation(agent.id, lane)
      .then((c) => {
        seedReads(c.threadId, c.reads);
        setData(c);
        setBusy(c.busy);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [agent.id, lane]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useLive(data?.threadId ?? null, setData, load, setBusy);
  const streaming = useStreaming(data?.threadId ?? null);

  const lanes = [
    ...(agent.team && !agent.solo ? [{ value: "team" as const, label: <><Users size={13} />Team</> }] : []),
    ...(agent.private && !agent.solo ? [{ value: "private" as const, label: "Private" }] : []),
  ];
  const team = lane === "team" && !agent.solo;
  const told = useTold(data?.people, owner, known);
  const header =
    !team && data?.privacy ? (
      <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">{data.privacy}</p>
    ) : team ? (
      <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">
        Everyone on {agent.name}'s team list reads and writes here, {owner} included.
      </p>
    ) : agent.solo ? (
      <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">
        Only you talk with {agent.name}. It is kept on {owner}'s computer.
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
          <Segmented aria-label="Conversation" size="sm" value={lane} onChange={(v) => onLane(v)} options={lanes} className="w-full sm:w-[190px]" />
        )}
        {lanes.length === 1 && !agent.solo && <span className="text-body text-muted-foreground">{lane === "team" ? "Team" : "Private"}</span>}
        {agent.solo && agent.mine && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More for ${agent.name}`}>
                <MoreHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                Delete {agent.name}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
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
          streaming={streaming}
          busy={busy}
          header={header}
          empty={
            <div className="mt-[18vh] flex flex-col items-center gap-3 text-center">
              <AgentFace agent={agent} size={48} />
              <p className="max-w-[340px] text-pretty text-ui text-muted-foreground">
                {team ? `Nothing in ${agent.name}'s team conversation yet. Say hello.` : `Ask ${agent.name} anything. This conversation is yours.`}
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
        placeholder={team ? `Message the team and ${agent.name}` : `Message ${agent.name}`}
        notice={usageNotice(usage)}
        onSend={async (text) => {
          const said = await memberApi.say(agent.id, lane, text);
          setData((was) => (was ? { ...was, messages: withMessage(was.messages, said.message) } : was));
          if (!said.queued) setBusy(true);
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
}: {
  roomId: string;
  me: string;
  usage: MemberUsage | null;
  nameOf?: (id: string) => string;
  known?: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [data, setData] = useState<MemberRoom | null>(null);
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
      },
      [roomId, load],
    ),
  );
  const people = useMemo(() => Object.fromEntries((data?.room.people ?? []).map((p) => [p.id, p.name])), [data]);
  const told = useTold(people, data?.room.owner.name ?? "", known);
  const agentName = (id: string | undefined) => data?.room.agents.find((a) => a.id === id)?.name ?? "An agent";
  const busy = Boolean(data?.room.agents.some((a) => a.busy));
  const viewer = data?.room.role === "viewer";
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <h1 className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground">{data?.room.name ?? "Room"}</h1>
        {data && (
          <div className="flex items-center -space-x-1" aria-label={`${data.room.agents.length} agents and ${data.room.people.length + 1} people`}>
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
      {data ? (
        <Transcript
          messages={data.messages}
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
          nameOf={(id) => told.people[id] ?? nameOf?.(id) ?? "Someone"}
          onRead={memberApi.read}
          streaming=""
          busy={busy}
          header={
            <p className="mx-auto max-w-[520px] text-balance text-center text-small text-muted-foreground">
              {data.room.agents.map((a) => a.name).join(", ")} and {data.room.people.length + 1} people. Everyone here reads every line.
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
        placeholder={`Message ${data?.room.name ?? "the room"}`}
        disabled={viewer ? "You can read this room. Writing in it is for its collaborators." : null}
        notice={usageNotice(usage)}
        onSend={async (text) => {
          const said = await memberApi.post(roomId, text);
          setData((was) => (was ? { ...was, messages: withMessage(was.messages, said.message) } : was));
        }}
      />
    </main>
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
