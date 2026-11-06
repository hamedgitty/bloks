// The @ list in an agent's conversation, drawn: the person's other
// conversations, then the tabs of the Bloks browser (src/lib/mentions.ts
// decides which and in what order). The `/` list's frame, rows and keys,
// so the two read as one thing; only what each row shows is its own.
//
// A tab is shown by a globe, as the browser's own tab strip shows one:
// the browser says no tab's icon, and fetching one from each site would
// tell every site in the list that this page looked.
import { AgentAvatar } from "@/components/Avatar";
import { Globe } from "@/components/icons";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import type { MentionOption } from "@/lib/mentions";
import { t } from "@/lib/i18n";

export function MentionMenu({
  offered,
  pick,
  onHover,
  onChoose,
  browser,
  id,
}: {
  /** In the order drawn, which is the order the arrow keys walk. */
  offered: MentionOption[];
  pick: number;
  onHover: (index: number) => void;
  onChoose: (option: MentionOption) => void;
  /** Whether this page can see a browser's tabs at all, for what the
   * empty list says. */
  browser: boolean;
  /** Names the list and its rows, for the box's aria-activedescendant. */
  id: string;
}) {
  const { state } = useStore();
  const conversations = offered.filter((o) => o.kind === "conversation");
  const tabs = offered.filter((o) => o.kind === "tab");
  const groups = [
    { id: "conversations", label: t("mentions.conversations"), items: conversations },
    { id: "browser", label: t("mentions.browser"), items: tabs },
  ].filter((g) => g.items.length > 0);
  return (
    <div className="animate-pop-in origin-bottom overflow-hidden rounded-xl border bg-popover shadow-lg shadow-(color:--shadow-color)">
      <div role="listbox" id={id} aria-label={t("mentions.label")} className="max-h-[min(22rem,50vh)] overflow-y-auto overscroll-contain p-1">
        {offered.length === 0 ? (
          <div className="px-2 py-1.5 text-body text-muted-foreground">{browser ? t("mentions.nothingMatches") : t("mentions.nothingMatchesNoBrowser")}</div>
        ) : (
          groups.map((group) => (
            <div key={group.id} role="group" aria-label={group.label}>
              <div className="px-2 pb-0.5 pt-1.5 text-caption font-medium text-muted-foreground">{group.label}</div>
              {group.items.map((option) => {
                const i = offered.indexOf(option);
                const bot = option.kind === "conversation" ? state.bots.find((b) => b.id === option.botId) : undefined;
                return (
                  <button
                    key={option.kind === "conversation" ? `c:${option.laneId}` : `t:${option.id}`}
                    id={`${id}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === pick}
                    onMouseEnter={() => onHover(i)}
                    // mousedown, not click, so the textarea keeps its caret
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChoose(option);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100",
                      i === pick ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    {option.kind === "conversation" ? (
                      <>
                        {bot ? (
                          <AgentAvatar bot={bot} size={20} className="shrink-0" />
                        ) : (
                          <span className="size-5 shrink-0 rounded-full bg-muted" aria-hidden />
                        )}
                        {/* another agent's first conversation is that agent, so
                            its name leads; a list of Generals told nobody which */}
                        <span className="min-w-0 flex-1 truncate text-body text-foreground">{option.first && !option.own ? option.agent : option.title}</span>
                        <span className="max-w-[40%] shrink-0 truncate text-caption text-muted-foreground">{option.first && !option.own ? option.title : option.agent}</span>
                      </>
                    ) : (
                      <>
                        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden>
                          <Globe size={14} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-body text-foreground">{option.title || option.host}</span>
                        {option.host && option.title && option.title !== option.host && <span className="max-w-[40%] shrink-0 truncate text-caption text-muted-foreground">{option.host}</span>}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      {offered.length > 0 && (
        <div className="border-t px-3 py-1.5 text-caption text-muted-foreground max-sm:hidden" aria-hidden>
          {t("slashMenu.pickTabInsertEscClose")}
        </div>
      )}
    </div>
  );
}
