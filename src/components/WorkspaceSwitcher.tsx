// The workspace you are in, at the top left of the window, and the way to
// the others.
//
// A pill with the workspace's mark and name; its menu lists every
// workspace on this computer (a dot on one that has something waiting, a
// tick on the one you are in), then joining one and making one, then what
// belongs to the one you are in: its settings and its mute. ⌥⌘1 to ⌥⌘9 go
// straight to the first nine, in the menu's order, without opening it.
//
// Switching is the main process pointing the window at another
// workspace's server, which is already running, so the page loads afresh
// and this component is drawn again by the workspace it now shows.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { BellOff, Check, ChevronsUpDown, Loader2, LogIn, Plus, RefreshCw, Settings, Sparkles, Wifi, LogOut } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useOptionalStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { platformOf } from "@/lib/shortcuts";
import { numberKeysAvailable, workspaceNumberKey } from "@/lib/numberKeys";
import {
  MUTE_CHOICES,
  act,
  currentWorkspace,
  dropIndex,
  hasWaiting,
  moveId,
  muteLabel,
  openWorkspaceDialog,
  peopleLabel,
  reachLine,
  useWorkspaces,
  workspaceForKey,
} from "@/lib/workspaces";
import type { WorkspaceInfo, WorkspacesState } from "@/types/bridge";
import { WorkspaceMark } from "./WorkspaceMark";
import { t } from "@/lib/i18n";

/** Goes to another workspace, saying so if it cannot. */
export async function goToWorkspace(id: string, options?: { open?: "join" }) {
  const error = await act(window.bloks?.workspaceSwitch?.(id, options));
  if (error) toast.error(error);
}

/** ⌥⌘1 to ⌥⌘9 on Mac (Ctrl elsewhere): the first nine workspaces. Not while the
 * key has already been taken by what has focus, such as the command
 * palette's own Ctrl+number. */
function useWorkspaceKeys(s: WorkspacesState) {
  useEffect(() => {
    if (!s.available || s.workspaces.length < 2) return;
    const mac = platformOf() === "mac";
    const onKey = (e: KeyboardEvent) => {
      const number = workspaceNumberKey(e, mac ? "mac" : "other");
      if (!number || (mac && !numberKeysAvailable())) return;
      const target = workspaceForKey(s, number);
      if (!target) return;
      e.preventDefault();
      if (target.id !== s.current) void goToWorkspace(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);
}

/** How long a press is held before the row lifts to be dragged: long
 * enough that a click is still a click, short enough not to feel stuck. */
const HOLD_MS = 280;
/** How far the pointer may wander during the hold before it is not a
 * hold at all, but somebody moving to another row. */
const HOLD_SLOP = 6;

interface Lift {
  id: string;
  from: number;
  /** How far the row has been dragged, in pixels. */
  dy: number;
  /** Where it would land, in the new order. */
  to: number;
  /** The lifted row's height: what the others step aside by. */
  height: number;
}

/** How far a row that is not lifted steps aside: up when the lifted one
 * passes it going down, down when it passes going up, so the gap left
 * open is where it lands. */
function stepAside(lift: Lift | null, index: number): number {
  if (!lift || index === lift.from) return 0;
  if (lift.from < lift.to && index > lift.from && index <= lift.to) return -lift.height;
  if (lift.to < lift.from && index >= lift.to && index < lift.from) return lift.height;
  return 0;
}

/** One workspace in the menu: mark, name, then what is true of it. */
function WorkspaceRow({
  ws,
  current,
  index,
  rowRef,
  lift,
  still,
  onHold,
  onMove,
}: {
  ws: WorkspaceInfo;
  current: string;
  index: number;
  rowRef: (el: HTMLDivElement | null) => void;
  lift: Lift | null;
  /** The frame a drop lands in: rows take their new places without
   * sliding there from where they stood aside. */
  still: boolean;
  onHold: (e: React.PointerEvent, index: number) => void;
  /** Option and an arrow key: the keyboard's way to reorder. */
  onMove: (index: number, by: -1 | 1) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const here = ws.id === current;
  const failed = ws.status === "failed";
  const starting = ws.status === "starting" || retrying;
  const mod = platformOf() === "mac" ? "⌥⌘" : "Ctrl+";
  const lifted = lift?.id === ws.id;
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={rowRef}
      value={ws.id}
      disabled={starting && !here}
      aria-roledescription={t("workspaceSwitcher.workspaceCanBeReordered")}
      onPointerDown={(e) => onHold(e, index)}
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        // the menu's own arrows move the highlight; with Option they move
        // the workspace, and the highlight goes with it
        e.preventDefault();
        e.stopPropagation();
        onMove(index, e.key === "ArrowUp" ? -1 : 1);
      }}
      onSelect={(e) => {
        if (!failed) return;
        // a workspace that would not start is tried again from right here,
        // with the menu left open to show how that goes
        e.preventDefault();
        setRetrying(true);
        void act(window.bloks?.workspaceRetry?.(ws.id)).then((error) => {
          setRetrying(false);
          if (error) toast.error(error);
        });
      }}
      style={
        lifted
          ? { transform: `translateY(${lift.dy}px) scale(1.02)` }
          : stepAside(lift, index)
            ? { transform: `translateY(${stepAside(lift, index)}px)` }
            : undefined
      }
      className={cn(
        "group/row relative flex touch-none select-none items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-ui font-medium text-foreground outline-none data-[disabled]:opacity-60 data-[highlighted]:bg-accent",
        // lifted: above the others, with a shadow, following the pointer
        // exactly (no easing while held, or it lags behind the hand)
        lifted
          ? "z-20 cursor-grabbing bg-popover shadow-[0_10px_28px_-8px_rgb(0_0_0/0.35),0_0_0_1px_var(--border)] data-[highlighted]:bg-popover"
          : still
            ? "transition-none"
            : "transition-transform duration-200 ease-out",
        lift && !lifted && "data-[highlighted]:bg-transparent",
      )}
    >
      <WorkspaceMark mark={ws.mark} logo={ws.logo} size={24} />
      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
      {ws.lanOnly && <Wifi size={13} className="shrink-0 text-muted-foreground" aria-label={t("workspaceSwitcher.onlyOnItsOwnersNetwork")} />}
      {hasWaiting(ws, current) && (
        <span className="size-1.5 shrink-0 rounded-full bg-brand-ink" role="img" aria-label={t("workspaceSwitcher.somethingIsWaiting")} />
      )}
      {ws.mute.muted && !here && <BellOff size={13} className="shrink-0 text-muted-foreground" aria-label={t("workspaceSwitcher.muted")} />}
      {starting ? (
        <span className="flex shrink-0 items-center gap-1.5 text-small font-normal text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          {t("workspaceSwitcher.starting")}
        </span>
      ) : failed ? (
        <span className="flex shrink-0 items-center gap-1 text-small font-normal text-destructive" title={ws.problem ?? undefined}>
          <RefreshCw size={12} />
          {t("workspaceSwitcher.couldntStart")}
        </span>
      ) : here ? null : (
        <>
          {/* the people count, or its key once you are reaching for one */}
          <span className="shrink-0 text-small font-normal text-muted-foreground group-data-[highlighted]/row:hidden">
            {peopleLabel(ws)}
          </span>
          {index < 9 && (
            <kbd className="hidden shrink-0 font-sans text-small font-normal tabular-nums text-muted-foreground group-data-[highlighted]/row:inline">
              {mod}
              {index + 1}
            </kbd>
          )}
        </>
      )}
      <DropdownMenuPrimitive.ItemIndicator className="flex shrink-0 items-center">
        <Check size={16} strokeWidth={2.4} className="text-foreground" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
}

/**
 * The workspaces in the menu, in the list's order, which is theirs to
 * change: press and hold a row until it lifts, drag it, and let go where
 * the line shows; or Option and the arrow keys on the row that has the
 * highlight. The new order goes to the app at once, and everything else
 * that lists workspaces follows it.
 */
function WorkspaceList({ s }: { s: Extract<WorkspacesState, { available: true }> }) {
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const press = useRef<{ index: number; x: number; y: number; pointerId: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const centers = useRef<number[]>([]);
  /** Each row's top, from the list's own top, as they stood at the lift. */
  const tops = useRef<number[]>([]);
  const dropped = useRef(0);
  const [lift, setLift] = useState<Lift | null>(null);
  const [still, setStill] = useState(false);
  /** The order just chosen, shown until the app's list says the same. */
  const [order, setOrder] = useState<string[] | null>(null);
  const [said, setSaid] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);

  const listed = useMemo(() => {
    if (!order) return s.workspaces;
    const byId = new Map(s.workspaces.map((w) => [w.id, w]));
    const mine = order.map((id) => byId.get(id)).filter((w): w is WorkspaceInfo => Boolean(w));
    return mine.length === s.workspaces.length ? mine : s.workspaces;
  }, [order, s.workspaces]);
  const ids = listed.map((w) => w.id);
  // the app's list caught up
  useEffect(() => setOrder(null), [s.workspaces]);
  // a row moved by keyboard keeps the highlight, wherever it went
  useLayoutEffect(() => {
    if (!focusId) return;
    rows.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId, listed]);

  const commit = (next: string[], moved: WorkspaceInfo) => {
    if (next.join() === ids.join()) return;
    setOrder(next);
    const at = next.indexOf(moved.id);
    setSaid(t("workspaceSwitcher.movedTo", { name: moved.name, position: at + 1, total: next.length }));
    void act(window.bloks?.workspaceReorder?.(next)).then((error) => {
      if (!error) return;
      setOrder(null);
      toast.error(error);
    });
  };

  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const onHold = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0 || listed.length < 2) return;
    endPress();
    const pointerId = e.pointerId;
    press.current = {
      index,
      x: e.clientX,
      y: e.clientY,
      pointerId,
      timer: setTimeout(() => {
        const list = listRef.current;
        if (!list || !press.current) return;
        // held still long enough: the row lifts, and the list takes the
        // pointer so the menu's rows stop answering it while it moves
        const top = list.getBoundingClientRect().top;
        const rects = listed.map((w) => rows.current.get(w.id)?.getBoundingClientRect());
        centers.current = rects.map((r) => (r ? r.top + r.height / 2 : 0));
        tops.current = rects.map((r) => (r ? r.top - top : 0));
        try {
          list.setPointerCapture(pointerId);
        } catch {
          /* the pointer already went: no drag */
          return;
        }
        setLift({ id: listed[index]!.id, from: index, dy: 0, to: index, height: rects[index]?.height ?? 36 });
      }, HOLD_MS),
    };
  };

  const onMovePointer = (e: React.PointerEvent) => {
    const held = press.current;
    if (!held) return;
    if (!lift) {
      if (Math.hypot(e.clientX - held.x, e.clientY - held.y) > HOLD_SLOP) endPress();
      return;
    }
    // the first and last rows go no further than the list's ends
    const top = centers.current[0]! - centers.current[lift.from]!;
    const bottom = centers.current.at(-1)! - centers.current[lift.from]!;
    const dy = Math.max(top - 8, Math.min(bottom + 8, e.clientY - held.y));
    setLift({ ...lift, dy, to: dropIndex(centers.current, lift.from, centers.current[lift.from]! + dy) });
  };

  const onRelease = () => {
    const was = lift;
    endPress();
    if (!was) return;
    // the rows that stood aside are already where the new order puts
    // them: for this frame they arrive without sliding
    setStill(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setStill(false)));
    setLift(null);
    dropped.current = Date.now();
    commit(moveId(ids, was.from, was.to), listed[was.from]!);
  };

  // Escape while a row is lifted puts it back, and keeps the menu open
  useEffect(() => {
    if (!lift) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      endPress();
      setLift(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lift]);
  useEffect(() => endPress, []);

  // the place it will land: the gap the others opened, outlined so it
  // reads as a place and not as a row that went missing
  const slot = lift ? { top: tops.current[lift.to] ?? 0, height: lift.height } : null;

  return (
    <div
      ref={listRef}
      className="relative"
      onPointerMove={onMovePointer}
      onPointerUp={onRelease}
      onPointerCancel={() => {
        endPress();
        setLift(null);
      }}
      // the release that ends a drag is not a choice of workspace
      onClickCapture={(e) => {
        if (Date.now() - dropped.current > 400) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {slot && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-[9px] border border-dashed border-brand-ink/50 bg-brand-soft/50 transition-[top] duration-200 ease-out"
          style={{ top: slot.top, height: slot.height }}
        />
      )}
      {listed.map((ws, i) => (
        <WorkspaceRow
          key={ws.id}
          ws={ws}
          current={s.current}
          index={i}
          lift={lift}
          still={still}
          rowRef={(el) => {
            if (el) rows.current.set(ws.id, el);
            else rows.current.delete(ws.id);
          }}
          onHold={onHold}
          onMove={(index, by) => {
            const to = index + by;
            if (to < 0 || to >= ids.length) return;
            setFocusId(ws.id);
            commit(moveId(ids, index, to), ws);
          }}
        />
      ))}
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  );
}

export function WorkspaceSwitcher({
  className,
  divider = false,
  onSettings,
  onLeave,
}: {
  className?: string;
  divider?: boolean;
  /** Where Workspace settings goes in a member's app, which has no
   * owner's settings to open. */
  onSettings?: () => void;
  /** Leaving the joined workspace on screen, in a member's app. */
  onLeave?: () => void;
}) {
  const s = useWorkspaces();
  const toDialog = useRef(false);
  const store = useOptionalStore();
  useWorkspaceKeys(s);
  const current = currentWorkspace(s);
  if (!s.available || !current) return null;

  const waitingElsewhere = s.workspaces.some((w) => hasWaiting(w, s.current));
  const muted = muteLabel(current.mute);
  const reach = reachLine(current);
  // Joining runs on a server of this computer's own, which a joined or a
  // hosted workspace's window does not have: it is done from Personal.
  const joinHere = current.kind !== "joined" && current.kind !== "hosted";
  const home = s.workspaces.find((w) => w.kind === "personal") ?? s.workspaces.find((w) => w.kind !== "joined" && w.kind !== "hosted");

  const mute = async (choice: string) => {
    const error = await act(window.bloks?.workspaceMute?.(current.id, choice));
    if (error) toast.error(error);
  };

  return (
    <DropdownMenu>
      {divider && <span aria-hidden className="mx-2.5 h-4 w-px shrink-0 bg-border" />}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("workspaceSwitcher.switchWorkspace", { name: current.name })}
          className={cn(
            // the height of the bar's own buttons, so it sits in their row
            // as one of them rather than as a heading above them
            "flex h-7 min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg pl-1 pr-1.5 text-body font-medium text-foreground outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-accent focus-visible:bg-accent active:scale-[0.97] data-[state=open]:bg-accent",
            className,
          )}
        >
          <WorkspaceMark mark={current.mark} logo={current.logo} size={18} />
          <span className="min-w-0 truncate">{current.name}</span>
          {current.mute.muted && <BellOff size={12} className="shrink-0 text-muted-foreground" aria-label={t("workspaceSwitcher.muted")} />}
          <span className="relative flex shrink-0">
            <ChevronsUpDown size={12} strokeWidth={2} className="text-muted-foreground" />
            {/* something waiting in another workspace: the dot that says
                look in here, on the one thing that leads there */}
            {waitingElsewhere && (
              <span
                className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-brand-ink ring-2 ring-sidebar"
                role="img"
                aria-label={t("workspaceSwitcher.somethingIsWaitingInAnother")}
              />
            )}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-[300px] rounded-[14px] p-1.5"
        // A dialog opened from here keeps the focus it starts with: the
        // menu handing it back to its button would take it from the field
        // the person is about to type in.
        onCloseAutoFocus={(e) => {
          if (!toDialog.current) return;
          toDialog.current = false;
          e.preventDefault();
        }}
      >
        <DropdownMenuLabel className="px-2.5 pb-1.5 pt-2" title={t("workspaceSwitcher.holdAWorkspaceToDrag")}>
          {t("workspaceSwitcher.workspaces")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={s.current}
          aria-description={t("workspaceSwitcher.holdAWorkspaceAndDrag")}
          onValueChange={(id) => {
            const target = s.workspaces.find((w) => w.id === id);
            if (target && target.status !== "failed" && id !== s.current) void goToWorkspace(id);
          }}
        >
          <WorkspaceList s={s} />
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator className="mx-1 my-1.5" />
        <DropdownMenuItem className="gap-2.5 rounded-[9px] py-2 text-ui font-medium" onSelect={() => {
            if (!joinHere && home) return void goToWorkspace(home.id, { open: "join" });
            toDialog.current = true;
            openWorkspaceDialog("join");
          }}>
          <LogIn />
          {t("workspaceSwitcher.joinAWorkspace")}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 rounded-[9px] py-2 text-ui font-medium" onSelect={() => {
            toDialog.current = true;
            openWorkspaceDialog("new");
          }}>
          <Plus />
          {t("workspaceSwitcher.newWorkspace")}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-1 my-1.5" />
        {reach && <p className="max-w-[270px] text-pretty px-2.5 pb-1.5 pt-0.5 text-small text-muted-foreground">{reach}</p>}
        <DropdownMenuItem
          className="gap-2.5 rounded-[9px] py-2 text-ui font-medium"
          onSelect={() => (onSettings ? onSettings() : store?.dispatch({ type: "toggleAppSettings", open: true, page: "workspace:general" }))}
        >
          <Settings />
          {t("workspaceSwitcher.workspaceSettings")}
        </DropdownMenuItem>
        {/* the plan is the person's, for every workspace here; only the
            owner's window has the page, so a joined one does not offer it */}
        {store && !onSettings && (
          <DropdownMenuItem
            className="gap-2.5 rounded-[9px] py-2 text-ui font-medium"
            onSelect={() => store.dispatch({ type: "toggleAppSettings", open: true, page: "plan" })}
          >
            <Sparkles />
            {t("workspaceSwitcher.plan")}
            <span className="ml-auto pl-3 text-small font-normal text-muted-foreground">{s.plan === "team" ? t("workspaceSwitcher.bloksTeam") : s.plan === "cloud" ? t("workspaceSwitcher.bloksCloud") : s.plan === null ? t("workspaceSwitcher.selfHosted") : ""}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            icon={<BellOff />}
            value={current.mute.muted ? t("workspaceSwitcher.on") : undefined}
            className="gap-2.5 rounded-[9px] py-2 text-ui font-medium"
          >
            {t("workspaceSwitcher.mute")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[230px] rounded-[14px] p-1.5">
            {muted && (
              <>
                <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 font-normal">{muted}</DropdownMenuLabel>
                <DropdownMenuItem className="rounded-[9px]" onSelect={() => void mute("off")}>
                  {t("workspaceSwitcher.turnNotificationsBackOn")}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="mx-1 my-1.5" />
              </>
            )}
            {MUTE_CHOICES.map((choice) => (
              <DropdownMenuItem key={choice.id} className="rounded-[9px]" onSelect={() => void mute(choice.id)}>
                {choice.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {current.kind === "joined" && onLeave && (
          <DropdownMenuItem variant="destructive" className="gap-2.5 rounded-[9px] py-2 text-ui font-medium" onSelect={onLeave}>
            <LogOut />
            {t("workspaceSwitcher.leave", { name: current.name })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
