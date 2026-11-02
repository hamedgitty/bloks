// The main rail: the app's few places, one icon each, always the same
// width. Chat is where the agents are (its own sidebar beside this one,
// folded from the title bar);
// the rest are full pages. Settings sits at the foot with Usage and the
// update button above it, the way a desktop app keeps the things you
// visit rarely out of the way of the things you visit all day.
import { MessageCircle } from "@/components/icons";
import { LayoutGrid } from "@/components/icons";
import { Zap } from "@/components/icons";
import { Brain } from "@/components/icons";
import { Puzzle } from "@/components/icons";
import { Settings as SettingsIcon } from "@/components/icons";
import { Usage as UsageIcon } from "@/components/icons";
import { useStore, type RailPage } from "@/state/store";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { UpdateRailButton } from "./UpdateCard";
import { useRehearsalsReady, useSecurityRisky } from "./Sidebar";
import { useActivityCount } from "@/lib/activityCount";
import { useBriefs } from "./BriefPanel";
import { useProfileNotes } from "./AboutYou";
import { t } from "@/lib/i18n";

export type RailPlace = "chat" | RailPage | "automations" | "settings";


/** Where the app is, as the rail sees it. */
export function useRailPlace(): RailPlace {
  const { state } = useStore();
  if (state.appSettingsOpen) return "settings";
  if (state.routinesOpen) return "automations";
  return state.page ?? "chat";
}

function RailButton({
  label,
  hint,
  active,
  dot,
  onClick,
  children,
}: {
  label: string;
  /** What the tooltip says when it is more than the name. */
  hint?: string;
  active: boolean;
  dot?: "brand" | "warning" | "destructive" | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={hint ?? label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative flex size-9 items-center justify-center rounded-[10px] outline-none transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96]",
            active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {children}
          {dot && (
            <span
              className={cn(
                "absolute right-1.5 top-1.5 size-1.5 rounded-full ring-2 ring-sidebar",
                dot === "destructive" ? "bg-destructive" : dot === "warning" ? "bg-warning" : "bg-brand",
              )}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}

export function AppRail() {
  const { dispatch } = useStore();
  const place = useRailPlace();
  const activity = useActivityCount();
  const rehearsalsReady = useRehearsalsReady();
  const securityRisky = useSecurityRisky();
  const latestBrief = useBriefs().data?.briefs[0];
  const briefNew = Boolean(latestBrief && !latestBrief.readAt && !latestBrief.quiet);
  const notesWaiting = (useProfileNotes().notes ?? []).filter((n) => n.state === "suggested").length;

  const go = (to: RailPlace) => {
    if (to === "chat") {
      // a full page of any kind closes for the chat; the title bar's
      // toggle is what folds the chat's sidebar
      dispatch({ type: "openPage", page: null });
      dispatch({ type: "toggleAppSettings", open: false });
      dispatch({ type: "toggleRoutines", open: false });
      dispatch({ type: "toggleSettings", open: false });
    } else if (to === "settings") dispatch({ type: "toggleAppSettings", open: true });
    else if (to === "automations") dispatch({ type: "toggleRoutines", open: true });
    else dispatch({ type: "openPage", page: to });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <nav
        aria-label="Bloks"
        className="flex h-full w-14 shrink-0 flex-col items-center bg-sidebar pb-3"
      >
        {/* the title bar above holds the traffic lights; the icons start
            level with the panel's top */}
        <div className="h-1.5 shrink-0" />
        <div
          className="flex flex-col items-center gap-1.5"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <RailButton label={t("appRail.chat")} active={place === "chat"} onClick={() => go("chat")}>
            <MessageCircle size={18} strokeWidth={1.75} />
          </RailButton>
          <RailButton
            label={t("appRail.overview")}
            hint={
              activity.waiting > 0
                ? t("appRail.overviewWaiting", { count: activity.waiting })
                : activity.failed > 0
                  ? t("appRail.overviewFailed", { count: activity.failed })
                  : activity.todos > 0
                  ? t("appRail.overviewOnYourList", { count: activity.todos })
                  : briefNew
                  ? t("appRail.overviewANewMorningBrief")
                  : rehearsalsReady > 0
                    ? t("appRail.overviewRehearsals", { count: rehearsalsReady })
                    : undefined
            }
            active={place === "overview"}
            dot={activity.waiting > 0 || activity.failed > 0 ? "warning" : briefNew || rehearsalsReady > 0 ? "brand" : null}
            onClick={() => go("overview")}
          >
            <LayoutGrid size={18} strokeWidth={1.75} />
          </RailButton>
          <RailButton label={t("appRail.automations")} active={place === "automations"} onClick={() => go("automations")}>
            <Zap size={18} strokeWidth={1.75} />
          </RailButton>
          <RailButton
            label={t("common.memory")}
            active={place === "memory"}
            hint={notesWaiting > 0 ? t("appRail.memoryNotes", { count: notesWaiting }) : undefined}
            dot={notesWaiting > 0 ? "warning" : null}
            onClick={() => go("memory")}
          >
            <Brain size={18} strokeWidth={1.75} />
          </RailButton>
          <RailButton
            label={t("common.plugins")}
            hint={activity.suggested > 0 ? t("appRail.skillsSuggested", { count: activity.suggested }) : t("appRail.pluginsAndSkills")}
            active={place === "plugins"}
            dot={activity.suggested > 0 ? "warning" : null}
            onClick={() => go("plugins")}
          >
            <Puzzle size={18} strokeWidth={1.75} />
          </RailButton>
        </div>

        <div className="flex-1" />

        <div
          className="flex flex-col items-center gap-2.5"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <UpdateRailButton />
          <RailButton label={t("appRail.usage")} active={place === "usage"} onClick={() => go("usage")}>
            <UsageIcon size={18} strokeWidth={1.75} />
          </RailButton>
          <RailButton
            label={t("common.settings")}
            hint={securityRisky > 0 ? t("appRail.settingsSecurityIssueFound") : undefined}
            active={place === "settings"}
            dot={securityRisky > 0 ? "destructive" : null}
            onClick={() => go("settings")}
          >
            <SettingsIcon size={18} strokeWidth={1.75} />
          </RailButton>
        </div>
      </nav>
    </TooltipProvider>
  );
}
