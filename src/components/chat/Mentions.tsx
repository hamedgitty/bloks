// The conversations and tabs a person's message linked with @, as the
// message reads (src/lib/mentions.ts, server/mentions.ts): a chip in the
// words for each, which opens what it names, and a quiet line under the
// bubble for any the agent was not given, saying why. Nothing here is an
// error: the words went either way.
import { Globe, MessagesSquare } from "@/components/icons";
import { useStore, type Message } from "@/state/store";
import { toast } from "@/components/ui/toast";
import { showPage, useBrowserState } from "@/components/browser/BrowserPanel";
import { hrefTarget, type Mention } from "@/lib/mentions";
import { t, type MessageKey } from "@/lib/i18n";

/** One chip in a sent message. A button that copies as its label. */
export function MentionChip({ mention }: { mention: Mention }) {
  const { state, dispatch } = useStore();
  const tabs = useBrowserState()?.tabs;
  const target = hrefTarget(mention.href);
  const open = () => {
    if (!target) return;
    if (target.kind === "tab") return void showPage(target.url, tabs);
    const bot = state.bots.find((b) => b.id === target.botId);
    if (!bot?.tasks?.some((task) => task.id === target.laneId)) {
      toast.info(t("mentions.conversationGone"), { id: "mention-gone" });
      return;
    }
    dispatch({ type: "select", id: bot.id, lane: target.laneId });
  };
  const Icon = mention.kind === "tab" ? Globe : MessagesSquare;
  return (
    <button
      type="button"
      data-copy="keep"
      onClick={open}
      title={mention.kind === "tab" ? (target?.kind === "tab" ? target.url : mention.label) : t("mentions.openConversation", { name: mention.label })}
      className="mx-px inline-flex max-w-full items-center gap-1 rounded-md bg-foreground/[0.07] px-1.5 align-baseline font-medium leading-snug transition-colors duration-150 hover:bg-foreground/[0.12] active:scale-[0.98] motion-reduce:transition-none"
    >
      <Icon size={12} className="shrink-0 opacity-70" aria-hidden />
      <span className="truncate">{mention.label}</span>
    </button>
  );
}

const DROPPED: Record<NonNullable<NonNullable<Message["mentions"]>[number]["dropped"]>, MessageKey> = {
  unreadable: "mentions.dropped.unreadable",
  closed: "mentions.dropped.closed",
  unavailable: "mentions.dropped.unavailable",
  denied: "mentions.dropped.denied",
  limit: "mentions.dropped.limit",
};

/** Under a message: each mention the agent was not given, and why. */
export function MentionNotes({ notes, agent }: { notes: NonNullable<Message["mentions"]>; agent: string }) {
  const left = notes.filter((note) => note.dropped);
  if (!left.length) return null;
  return (
    <div data-copy="skip" className="mt-1 flex flex-col items-end gap-0.5 px-1 text-caption text-muted-foreground">
      {left.map((note, i) => (
        <span key={`${note.href}-${i}`}>{t(DROPPED[note.dropped!], { label: note.label, name: agent })}</span>
      ))}
    </div>
  );
}
