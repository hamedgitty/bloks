// The room, read as topics instead of as a stream.
//
// Same messages, same order underneath, grouped by what they answer. A
// room with four agents in it flattens badly: a reply to something from
// ten minutes ago lands at the bottom next to three unrelated things, and
// the reader reassembles the conversation from the shape of the
// sentences. This is the other way to look at it.
//
// It is a lens rather than a mode: nothing is stored differently, nothing
// is sent differently, and every message appears in both. Switching is a
// question of what you are trying to read right now.
import { useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.js";
import { preview, replyLabel, threadsFrom, type Thread } from "@/lib/threads";
import type { Bot, Message } from "@/state/reducer";
import { AgentAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

function when(at: number): string {
  if (!at) return "";
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ForumLens({
  messages,
  members,
  onOpenInStream,
}: {
  messages: Message[];
  members: Bot[];
  /** Jump to this message in the stream, because a topic worth reading is
   * often a topic worth answering, and answering happens there. */
  onOpenInStream: (messageId: string) => void;
}) {
  const nameOf = (message: Message) =>
    message.role === "user" ? "You" : (members.find((b) => b.id === message.from)?.name ?? "Agent");
  const threads = threadsFrom(messages, nameOf);
  const [open, setOpen] = useState<string | null>(null);

  if (!threads.length) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-16 text-center text-[13px] text-muted-foreground md:px-6">
        Nothing said yet. Topics appear here as the room fills up.
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-1.5 px-4 pb-6 pt-3 md:px-6">
      {threads.map((thread) => (
        <ThreadRow
          key={thread.root.id}
          thread={thread}
          members={members}
          nameOf={nameOf}
          open={open === thread.root.id}
          onToggle={() => setOpen(open === thread.root.id ? null : thread.root.id)}
          onOpenInStream={onOpenInStream}
        />
      ))}
    </div>
  );
}

function ThreadRow({
  thread,
  members,
  nameOf,
  open,
  onToggle,
  onOpenInStream,
}: {
  thread: Thread;
  members: Bot[];
  nameOf: (message: Message) => string;
  open: boolean;
  onToggle: () => void;
  onOpenInStream: (messageId: string) => void;
}) {
  const author = members.find((b) => b.id === thread.root.from);
  const replies = replyLabel(thread.replies.length);

  return (
    <div className={cn("rounded-2xl border bg-card transition-colors duration-150", open && "border-foreground/20")}>
      <button onClick={onToggle} className="flex w-full items-start gap-3 p-3 text-left">
        <span className="mt-0.5 shrink-0">
          {author ? (
            <AgentAvatar bot={author} size={26} />
          ) : (
            <span className="flex size-[26px] items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <MessageSquare size={13} />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium text-foreground">{nameOf(thread.root)}</span>
            <span className="text-[11.5px] text-muted-foreground">{when(thread.root.at)}</span>
          </span>
          <span className={cn("mt-0.5 block text-[13px] leading-relaxed text-foreground", !open && "line-clamp-2")}>
            {open ? (thread.root.text ?? preview(thread.root)) : preview(thread.root)}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
            {replies ? <span className="text-brand-ink">{replies}</span> : <span>no replies yet</span>}
            {thread.participants.length > 1 && <span>· {thread.participants.join(", ")}</span>}
            {thread.replies.length > 0 && <span>· last {when(thread.lastAt)}</span>}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
      </button>

      {open && (
        <div className="border-t px-3 pb-3 pt-2">
          {thread.replies.length === 0 ? (
            <p className="py-2 text-[12.5px] text-muted-foreground">
              Nobody has answered this yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {thread.replies.map((reply) => {
                const from = members.find((b) => b.id === reply.from);
                return (
                  <div key={reply.id} className="flex items-start gap-2.5">
                    <span className="mt-0.5 shrink-0">
                      {from ? (
                        <AgentAvatar bot={from} size={20} />
                      ) : (
                        <span className="flex size-5 items-center justify-center rounded-md bg-muted text-[10px] text-muted-foreground">
                          You
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[12px] font-medium text-foreground">{nameOf(reply)}</span>
                        <span className="text-[11px] text-muted-foreground">{when(reply.at)}</span>
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground">
                        {reply.text ?? preview(reply)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <button
            onClick={() => onOpenInStream(thread.root.id)}
            className="mt-3 rounded-lg px-2 py-1 text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            Find it in the stream
          </button>
        </div>
      )}
    </div>
  );
}
