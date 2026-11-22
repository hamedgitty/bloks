// The window's top row: room for macOS's traffic lights over the rail,
// then back and forward and the sidebar toggle, then the workspace you
// are in (WorkspaceSwitcher.tsx). In a conversation the rest of the row is
// the conversation's: who you are talking to, its buttons, and over the
// side dock the dock's tabs (ChatView.tsx, dock/SideDock.tsx). The whole
// row is the window's handle; its buttons are not.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft } from "@/components/icons";
import { ArrowRight } from "@/components/icons";
import { PanelLeft } from "@/components/icons";
import { useStore } from "@/state/store";
import { useNavHistory } from "@/lib/navHistory";
import { useChatSidebar } from "@/lib/chatSidebar";
import { CHAT_COLUMN, toggleColumn, usePageColumn, useSideColumn } from "@/lib/sideColumn";
import { platformOf } from "@/lib/shortcuts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { TITLEBAR_TABS_ID } from "@/lib/titlebarSlot";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { t } from "@/lib/i18n";

const isElectron = navigator.userAgent.includes("Electron");
/** The main rail's width (AppRail.tsx, w-14). */
const RAIL = 56;

function BarButton({
  label,
  keys,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string;
  keys: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out",
            disabled ? "opacity-40" : "hover:bg-accent hover:text-foreground active:scale-[0.96]",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        {label}
        <kbd className="rounded bg-primary-foreground/15 px-1.5 py-px font-sans text-caption">{keys}</kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export function TitleBar() {
  const { state, dispatch } = useStore();
  const history = useNavHistory(state, dispatch);
  const sidebar = useChatSidebar();
  const mac = platformOf() === "mac";
  // an agent's settings cover the chat sidebar too
  const chat = !state.appSettingsOpen && !state.routinesOpen && !state.page && !state.settingsOpen;
  // The toggle and ⌘B fold the column of the place in view: the chat's
  // list in the chat, a page's own column on a page that keeps one
  // (SideColumn.tsx). A page with none, such as Overview, has nothing for
  // them to fold, and the toggle rests.
  const pageColumn = usePageColumn();
  const column = chat ? CHAT_COLUMN : pageColumn;
  const columnOpen = useSideColumn(column ?? CHAT_COLUMN).open;

  // ⌘[ and ⌘] as in a browser, and the mouse's own back and forward
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key === "[") (e.preventDefault(), history.back());
      else if (e.key === "]") (e.preventDefault(), history.forward());
      else if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (column) toggleColumn(column);
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) (e.preventDefault(), history.back());
      else if (e.button === 4) (e.preventDefault(), history.forward());
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [history, column]);

  // Where the buttons on the left end, so a conversation's tabs start
  // after them: the workspace's name is as long as its owner made it.
  const cluster = useRef<HTMLDivElement>(null);
  const [clusterEnd, setClusterEnd] = useState((isElectron ? 78 : 56) + 120);
  useLayoutEffect(() => {
    const el = cluster.current;
    if (!el) return;
    const measure = () => setClusterEnd(el.offsetLeft + el.offsetWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const mod = mac ? "⌘" : "Ctrl+";
  return (
    <TooltipProvider delayDuration={400}>
      <div className="titlebar-drag relative hidden h-11 shrink-0 items-center bg-sidebar md:flex">
        {/* room for the traffic lights on a Mac (BUTTONS in
            electron/main.mjs), which reach past the slim rail below; a
            browser has none, so its buttons start at the rail's edge */}
        <div className={cn("shrink-0", isElectron ? "w-[78px]" : "w-14")} />
        <div ref={cluster} className="flex min-w-0 items-center gap-0.5 pl-1.5">
          <BarButton label={t("common.back")} keys={`${mod}[`} disabled={!history.canBack} onClick={history.back}>
            <ArrowLeft size={17} strokeWidth={1.75} />
          </BarButton>
          <BarButton label={t("titleBar.forward")} keys={`${mod}]`} disabled={!history.canForward} onClick={history.forward}>
            <ArrowRight size={17} strokeWidth={1.75} />
          </BarButton>
          <BarButton
            label={t("titleBar.toggleSidebar")}
            keys={`${mod}B`}
            disabled={!column}
            pressed={Boolean(column) && columnOpen}
            onClick={() => column && toggleColumn(column)}
          >
            <PanelLeft size={17} strokeWidth={1.75} />
          </BarButton>
          {/* the workspace you are in, right after the buttons that move
              you around inside it, a hairline apart so the two read as
              different things; nothing at all outside the desktop app */}
          {/* and a hairline after it in a conversation, whose name and
              buttons fill the rest of the row (ChatView.tsx) */}
          <WorkspaceSwitcher divider trailing={chat} />
        </div>
        {/* An open conversation puts its header here (lib/titlebarSlot.ts),
            starting where the conversation itself starts so it sits over
            the page it names rather than the sidebar; with the sidebar
            closed it starts after these buttons instead. What it leaves
            empty stays a handle for moving the window. */}
        {/* It moves with the sidebar as it folds, at the fold's own pace,
            and with the pointer, at once, while the edge is dragged. */}
        <div
          id={TITLEBAR_TABS_ID}
          className={cn(
            "absolute inset-y-0 right-0 flex min-w-0 items-stretch",
            !sidebar.resizing && "transition-[left] duration-200 ease-out-quart",
          )}
          style={{ left: Math.max(RAIL + (chat && sidebar.open ? sidebar.width : 0) + 12, clusterEnd + 8) }}
        />
      </div>
    </TooltipProvider>
  );
}
