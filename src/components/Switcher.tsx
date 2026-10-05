// Ctrl+Tab: back to the conversation you were just in.
//
// Tap it and you are back where you were. Hold Ctrl and the list of what
// this window has shown appears, newest first, with the one you would
// land on marked; each Tab moves the mark one further back (Shift+Tab one
// nearer), and letting go of Ctrl opens it. Escape, or leaving the
// window, puts the list away and goes nowhere. Ctrl on every platform,
// a Mac included, because that is where browsers and editors keep it.
//
// The list itself lives in src/lib/recent.ts. Only this window keeps it,
// and only for as long as it is open.
import { useEffect, useRef, useState } from "react";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import { useStore } from "@/state/store";
import { cycle, prune, sameView, visit, type Viewed } from "@/lib/recent";
import { AgentAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

/** How long a conversation has to stay on screen to count as seen.
 * Passing through on the way somewhere is not a visit: ⌥↓ held down, or
 * the moment between picking an agent and the conversation that pinged
 * opening in its place. */
const SETTLE_MS = 400;

/** How long Ctrl+Tab is held before the list shows. A quick tap goes
 * straight back, with no list flashing up and away again. */
const HOLD_MS = 150;

interface Choosing {
  /** The list as it stood at the first press; it does not reorder while
   * the mark is moving through it. */
  list: Viewed[];
  at: number;
  shown: boolean;
}

export function Switcher({ shown }: { shown: Viewed | null }) {
  const { state, dispatch } = useStore();
  const [choosing, setChoosing] = useState<Choosing | null>(null);

  // Everything the listeners read, current, without attaching them again.
  const recent = useRef<Viewed[]>([]);
  const settling = useRef<Viewed | null>(null);
  const choosingRef = useRef<Choosing | null>(null);
  const live = useRef({ state, shown });
  live.current = { state, shown };

  const shownKey = shown ? `${shown.id}/${shown.lane ?? ""}` : "";
  useEffect(() => {
    if (!shown) return;
    settling.current = shown;
    const timer = setTimeout(() => {
      recent.current = visit(recent.current, shown);
      settling.current = null;
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [shownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let hold: ReturnType<typeof setTimeout> | undefined;
    const set = (next: Choosing | null) => {
      choosingRef.current = next;
      setChoosing(next);
    };

    /** Still there to go back to: an agent not archived, a room not
     * deleted, a conversation not closed. */
    const alive = (v: Viewed) => {
      const { bots, bloks } = live.current.state;
      if (bloks.some((room) => room.id === v.id)) return true;
      const bot = bots.find((b) => b.id === v.id && !b.hidden);
      return Boolean(bot && (!v.lane || !bot.tasks || bot.tasks.some((t) => t.id === v.lane)));
    };

    const open = (to: Viewed) => {
      recent.current = visit(recent.current, to);
      settling.current = null;
      if (sameView(to, live.current.shown) && !live.current.state.appSettingsOpen && !live.current.state.routinesOpen) {
        return;
      }
      dispatch({ type: "select", id: to.id, lane: to.lane });
    };

    const finish = (go: boolean) => {
      clearTimeout(hold);
      const now = choosingRef.current;
      if (!now) return;
      set(null);
      if (go && now.list[now.at]) open(now.list[now.at]);
    };

    const onDown = (e: KeyboardEvent) => {
      // Ctrl was let go somewhere we could not hear it
      if (choosingRef.current && !e.ctrlKey) finish(true);
      if (e.key === "Escape" && choosingRef.current) {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        return;
      }
      if (e.key !== "Tab" || !e.ctrlKey || e.metaKey || e.altKey) return;
      // Ctrl+Tab means nothing anywhere else in the app, so it is taken
      // before a text field or a list can make it mean something.
      e.preventDefault();
      e.stopPropagation();
      const now = choosingRef.current;
      if (now) {
        const at = cycle(now.at, now.list.length, e.shiftKey);
        // a press after the first means Ctrl is being held: show the list
        if (at !== null) set({ ...now, at, shown: true });
        return;
      }
      // whatever is on screen counts as seen from here, settled or not
      if (settling.current) recent.current = visit(recent.current, settling.current);
      settling.current = null;
      const list = prune(recent.current, alive);
      recent.current = list;
      // Settings or Automations covering the conversation means the
      // newest one is not on screen, and the first press goes back to it
      const { shown: here, state: current } = live.current;
      const onScreen = sameView(list[0], here) && !current.appSettingsOpen && !current.routinesOpen;
      const at = cycle(null, list.length, e.shiftKey, onScreen);
      if (at === null) return;
      set({ list, at, shown: false });
      hold = setTimeout(() => {
        if (choosingRef.current) set({ ...choosingRef.current, shown: true });
      }, HOLD_MS);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Control") finish(true);
    };
    const onBlur = () => finish(false);

    // the capture phase, so the key is ours before anything on the page
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(hold);
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [dispatch]);

  if (!choosing?.shown) return null;

  // Drawn and gone at once, with nothing to point at: Ctrl is held the
  // whole time it is up, and Ctrl and a click is a right-click on a Mac.
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[14vh]">
      <div
        role="listbox"
        aria-label="Recent conversations"
        className="w-[340px] max-w-[92vw] rounded-2xl border bg-popover p-1.5 shadow-2xl"
      >
        {choosing.list.map((v, index) => {
          const room = state.bloks.find((r) => r.id === v.id);
          const bot = room ? undefined : state.bots.find((b) => b.id === v.id);
          // which conversation, once the agent has more than one
          const lane = bot && (bot.tasks?.length ?? 0) > 1 ? bot.tasks?.find((t) => t.id === v.lane)?.title : undefined;
          const active = index === choosing.at;
          return (
            <div
              key={`${v.id}/${v.lane ?? ""}`}
              role="option"
              aria-selected={active}
              className={cn("flex items-center gap-2.5 rounded-xl px-2.5 py-1.5", active && "bg-accent")}
            >
              {bot ? (
                <AgentAvatar bot={bot} size={26} />
              ) : (
                <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Users size={13} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground">
                  {room?.name ?? bot?.name ?? ""}
                </span>
                {lane && <span className="block truncate text-[11.5px] text-muted-foreground">{lane}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
