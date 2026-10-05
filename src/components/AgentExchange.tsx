// Messages between two agents, in the person's chat.
//
// A manager agent that coordinates a team gets a lot of traffic from other
// agents, and it used to arrive as big right-aligned bubbles that looked
// exactly like the person's own words, while what the manager sent out
// left no trace in its chat at all. Now each one is a small attributed
// row: "Message from QA", "Messaged Engineer". The words are a click
// away, and either row opens the whole two-agent exchange, both
// directions, with the conversation each message sits in.
//
// What an agent then says in its own chat is not one of these. It reached
// nobody but the person (an agent answers another with \`bloks say\`), and
// it may well be a question for them, so it stays a full message with a
// small "after a message from QA" link above it. Compacting it as
// "Replied to QA" claimed a delivery that never happened.
import { useEffect, useRef, useState } from "react";
import ArrowDownLeft from "lucide-react/dist/esm/icons/arrow-down-left.mjs";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.mjs";
import CornerDownRight from "lucide-react/dist/esm/icons/corner-down-right.mjs";
import { api, useStore, type Message } from "@/state/store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AgentAvatar } from "./Avatar";
import { Markdownish } from "./Markdown";
import { queuedLine, stamp } from "@/lib/when";
import { cn } from "@/lib/cn";

interface ExchangeEntry {
  id: string;
  at: number;
  dir: "in" | "out" | "reply";
  status?: "sent" | "queued" | "failed";
  from: string;
  fromName: string;
  to: string;
  toName: string;
  laneId: string;
  laneTitle: string;
  text: string;
}

const STATUS_WORDS: Record<string, string> = { queued: "waiting for its turn", failed: "not delivered" };

/** One compact row in an agent's chat for a message to or from another agent. */
export function AgentExchangeRow({
  message,
  botId,
  fresh,
  onOpen,
}: {
  message: Message;
  botId: string;
  fresh?: boolean;
  onOpen: (peerId: string, messageId: string, text: string) => void;
}) {
  const { state } = useStore();
  const note = message.agent!;
  const peer = state.bots.find((b) => b.id === note.peerId);
  const name = peer?.name ?? note.peerName;
  const label = note.dir === "in" ? `Message from ${name}` : `Messaged ${name}`;
  const Icon = note.dir === "in" ? ArrowDownLeft : ArrowUpRight;
  const failed = note.status === "failed";
  const preview = (message.text ?? "").replace(/\s+/g, " ").trim();
  return (
    <div className={cn("flex justify-start", fresh && "animate-receive-in")} data-agent-row={botId}>
      <button
        onClick={() => onOpen(note.peerId, message.id, message.text ?? "")}
        title="Open the exchange"
        className="group flex max-w-[82%] min-w-0 items-center gap-2 rounded-xl px-2 py-1 text-left text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-[0.99] sm:max-w-[68%]"
      >
        <Icon size={13} className={cn("shrink-0", failed ? "text-destructive" : "text-brand")} />
        {peer && <AgentAvatar bot={peer} size={16} className="shrink-0" />}
        <span className="shrink-0 font-medium text-foreground/90">{label}</span>
        {note.status && STATUS_WORDS[note.status] && (
          <span className={cn("shrink-0", failed && "text-destructive")}>({STATUS_WORDS[note.status]})</span>
        )}
        {preview && <span className="min-w-0 truncate">{preview}</span>}
        {/* still one line: how long it waited is a hover away */}
        {message.at ? (
          <span
            title={message.deliveredAt ? queuedLine(message.queuedAt ?? message.at, message.deliveredAt) : undefined}
            className="shrink-0 tabular-nums text-muted-foreground/70"
          >
            {stamp(message.at)}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/** Above a full reply written in a turn another agent started: what
 * prompted it, and the way to the exchange. Says nothing about delivery,
 * because there was none. */
export function AfterAgentLink({ peerId, peerName, onOpen }: { peerId: string; peerName: string; onOpen: () => void }) {
  const { state } = useStore();
  const name = state.bots.find((b) => b.id === peerId)?.name ?? peerName;
  return (
    <div className="mb-1 flex justify-start">
      <button
        onClick={onOpen}
        title="Open the exchange"
        className="flex items-center gap-1 rounded-md px-1 text-[11.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <CornerDownRight size={11} className="shrink-0" />
        After a message from {name}
      </button>
    </div>
  );
}

/** The whole exchange between two agents, opened at one message. */
export function AgentExchangeDialog({
  botId,
  peerId,
  focusId,
  focusText,
  onClose,
}: {
  botId: string;
  peerId: string;
  focusId: string | null;
  /** A send that arrived is listed from the side it arrived on, under
   * that side's id, so the sender's row finds it by its words. */
  focusText?: string;
  onClose: () => void;
}) {
  const { state } = useStore();
  const [entries, setEntries] = useState<ExchangeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef<HTMLDivElement>(null);
  const me = state.bots.find((b) => b.id === botId);
  const peer = state.bots.find((b) => b.id === peerId);

  useEffect(() => {
    let alive = true;
    api(`/api/bots/${botId}/exchange/${peerId}`)
      .then((r) => alive && setEntries(r.messages ?? []))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "The exchange could not be loaded."));
    return () => {
      alive = false;
    };
  }, [botId, peerId]);

  useEffect(() => {
    focused.current?.scrollIntoView({ block: "center" });
  }, [entries]);

  const avatarOf = (id: string) => state.bots.find((b) => b.id === id);
  const target =
    entries?.find((e) => e.id === focusId)?.id ??
    entries?.find((e) => e.dir === "in" && e.from === botId && e.text === focusText)?.id ??
    null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-full max-w-[640px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-5">
          {me && <AgentAvatar bot={me} size={20} />}
          {peer && <AgentAvatar bot={peer} size={20} className="-ml-2 ring-2 ring-background" />}
          <DialogTitle className="min-w-0 flex-1 truncate text-[14px]">
            {me?.name ?? "This agent"} and {peer?.name ?? "the other agent"}
          </DialogTitle>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="text-[13px] text-destructive">{error}</p>}
          {!error && entries === null && <p className="text-[13px] text-muted-foreground">Loading…</p>}
          {entries?.length === 0 && <p className="text-[13px] text-muted-foreground">Nothing between them yet.</p>}
          <div className="flex flex-col gap-3">
            {entries?.map((entry, index) => {
              const who = avatarOf(entry.from);
              // whose conversation it sits in: the recipient's for a message
              // that arrived, the speaker's own for a reply or a failed send
              const newLane = index === 0 || entries[index - 1].laneId !== entry.laneId;
              const owner = entry.dir === "in" ? entry.toName : entry.fromName;
              return (
                <div
                  key={entry.id}
                  ref={entry.id === target ? focused : undefined}
                  className={cn("rounded-xl px-3 py-2", entry.id === target ? "bg-accent" : "")}
                >
                  <div className="mb-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                    {who && <AgentAvatar bot={who} size={16} />}
                    <span className="font-medium text-foreground">{entry.fromName}</span>
                    {/* context, not a message: it stayed in the speaker's own chat */}
                    <span>{entry.dir === "reply" ? `in its own chat, not sent to ${entry.toName}` : `to ${entry.toName}`}</span>
                    {entry.status === "failed" && <span className="text-destructive">not delivered</span>}
                    <span className="ml-auto shrink-0 tabular-nums">{stamp(entry.at)}</span>
                  </div>
                  {newLane && (
                    <div className="mb-1 text-[11px] text-muted-foreground/80">
                      in {owner}'s {entry.laneTitle}
                    </div>
                  )}
                  <div className="text-[13.5px] leading-relaxed text-foreground">
                    <Markdownish text={entry.text} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
