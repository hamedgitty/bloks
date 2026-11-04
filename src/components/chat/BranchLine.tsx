// The line at the top of a branch, under the messages it was copied with
// (server/branch.ts): where it came from, as a way back to that answer,
// and the one thing a branch does not copy. Marked like a date line, a
// fact about the conversation rather than something said in it.
import { GitBranch } from "@/components/icons";
import { useStore, type Bot, type Message } from "@/state/store";
import { askChat } from "@/lib/chatAsk";
import { branchSource } from "@/lib/branch";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function BranchLine({ message, bot, fresh }: { message: Message; bot: Bot; fresh?: boolean }) {
  const { dispatch } = useStore();
  const branch = message.branch!;
  const source = branchSource(branch, bot.tasks);
  // the conversation it came from, opened and landed on the answer, the
  // way a search hit in the palette lands (src/lib/chatAsk.ts)
  const open = () => {
    askChat({ kind: "land", botId: bot.id, threadId: branch.from, messageId: branch.messageId });
    dispatch({ type: "select", id: bot.id, lane: branch.from });
  };
  return (
    <div className={cn("flex items-center gap-3 py-2", fresh && "animate-fade-in")} data-branch-line>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      <div className="flex min-w-0 max-w-[85%] flex-col items-center gap-0.5 text-center">
        {/* wraps rather than cut off: on a phone the deleted line is
            longer than the space between the rules */}
        <span className="max-w-full text-balance text-small text-muted-foreground [overflow-wrap:anywhere]">
          <GitBranch size={13} className="mr-1.5 inline-block align-[-2px]" aria-hidden />
          {source ? (
            <button
              type="button"
              onClick={open}
              aria-label={t("branch.openSource", { title: source.title })}
              className="rounded-sm font-medium text-foreground underline-offset-2 transition-colors duration-150 hover:underline"
            >
              {t("branch.from", { title: source.title })}
            </button>
          ) : (
            t("branch.fromDeleted")
          )}
        </span>
        <span className="text-caption text-muted-foreground">{t("branch.sharedFiles")}</span>
      </div>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}
