// "Recalled 2 notes" under one of your messages: what Bloks found in the
// agent's other conversations and memory files and put ahead of your
// words for that turn, and where each one came from.
//
// Quiet until asked, since the agent may well not have needed them, and
// one press away, because something added to what you said should never
// be invisible. A note from a conversation or a room opens it.
import { useState } from "react";
import BookOpen from "lucide-react/dist/esm/icons/book-open.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import MessagesSquare from "lucide-react/dist/esm/icons/messages-square.mjs";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import { useStore, type RecalledNote } from "@/state/store";
import { stamp } from "@/lib/when";
import { cn } from "@/lib/cn";

const ICONS = { conversation: MessagesSquare, room: Users, memory: FileText } as const;

export function RecalledNotes({ notes }: { notes: RecalledNote[] }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  if (!notes.length) return null;

  // Where a note can take you: its room, or the agent's conversation it
  // came from while that conversation is still open. A memory file is
  // read in the agent's settings, not jumped to.
  const destination = (note: RecalledNote): (() => void) | null => {
    if (!note.threadId) return null;
    if (note.kind === "room") {
      return state.bloks.some((room) => room.id === note.threadId) ? () => dispatch({ type: "select", id: note.threadId! }) : null;
    }
    const owner = state.bots.find((bot) => bot.tasks?.some((task) => task.id === note.threadId));
    return owner ? () => dispatch({ type: "select", id: owner.id, lane: note.threadId }) : null;
  };

  return (
    <div className="mt-1 flex w-full flex-col items-end">
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
      >
        <BookOpen size={12} />
        Recalled {notes.length === 1 ? "1 note" : `${notes.length} notes`}
        <ChevronDown size={12} className={cn("transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1 w-[420px] max-w-full animate-fade-in rounded-2xl border bg-card p-2 text-left shadow-sm">
          <p className="px-1.5 pb-1.5 pt-0.5 text-[11.5px] leading-snug text-muted-foreground">
            Found by matching your words and added ahead of them for this turn only. The agent was told it could ignore them.
          </p>
          <ul className="flex flex-col gap-1">
            {notes.map((note, i) => {
              const Icon = ICONS[note.kind] ?? MessagesSquare;
              const go = destination(note);
              return (
                <li key={`${note.threadId ?? note.memory}-${note.messageId ?? i}`} className="rounded-xl bg-muted/60 px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <Icon size={12} className="shrink-0" />
                    {go ? (
                      <button
                        onClick={go}
                        className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        {note.where}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate font-medium text-foreground">{note.where}</span>
                    )}
                    <span aria-hidden>·</span>
                    <time dateTime={new Date(note.at).toISOString()} className="shrink-0 tabular-nums">
                      {stamp(note.at)}
                    </time>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground">
                    {note.who && <span className="font-medium">{note.who}: </span>}
                    {note.text}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
