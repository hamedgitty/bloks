// Back and forward, the way a browser has them: every place the app has
// been, in order, so the title bar's arrows go to whatever was on screen
// before. A place is a chat (an agent's conversation, or a room) or one of
// the full pages; moving between them is recorded as it happens, whoever
// moved, so a link that opened Settings counts the same as a click.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Action, AppState, CustomizeTab, MemoryTarget, PluginFocus } from "@/state/reducer";

export type Place =
  | { kind: "chat"; id: string; lane?: string }
  | { kind: "agent"; id: string }
  | { kind: "overview" }
  | { kind: "usage" }
  | { kind: "agents" }
  | { kind: "memory"; target: MemoryTarget | null }
  | { kind: "customize"; tab: CustomizeTab; app?: string }
  | { kind: "automations" }
  | { kind: "settings"; page: string; focus?: PluginFocus };

const LIMIT = 100;

export function placeOf(state: AppState): Place | null {
  if (state.appSettingsOpen)
    return {
      kind: "settings",
      page: state.settingsPage,
      ...(state.settingsPage === "plugins" && state.pluginFocus ? { focus: state.pluginFocus } : {}),
    };
  if (state.routinesOpen) return { kind: "automations" };
  // a page's own tab is part of where you were: Back from Skills to
  // Plugins is a step, the same as Back from one chat to another, and
  // from one agent's memory to another's
  if (state.page === "overview") return { kind: "overview" };
  if (state.page === "usage") return { kind: "usage" };
  if (state.page === "agents") return { kind: "agents" };
  if (state.page === "memory") return { kind: "memory", target: state.memoryTarget };
  if (state.page === "plugins")
    return { kind: "customize", tab: state.customize, ...(state.customizeApp ? { app: state.customizeApp } : {}) };
  if (!state.selectedId) return null;
  const bot = state.bots.find((b) => b.id === state.selectedId);
  // an agent's settings are a page of their own, so Back from them is
  // the chat they were opened over, not whatever came before that
  if (state.settingsOpen && bot) return { kind: "agent", id: bot.id };
  return { kind: "chat", id: state.selectedId, lane: bot?.activeTaskId ?? undefined };
}

export function samePlace(a: Place | null, b: Place | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What puts the app back at a place. */
export function goTo(place: Place): Action[] {
  switch (place.kind) {
    case "chat":
      return [{ type: "select", id: place.id, lane: place.lane }];
    case "agent":
      // selecting closes the settings page, so it is opened after
      return [{ type: "select", id: place.id }, { type: "toggleSettings", open: true }];
    case "overview":
      return [{ type: "openPage", page: "overview" }];
    case "usage":
      return [{ type: "openPage", page: "usage" }];
    case "agents":
      return [{ type: "openPage", page: "agents" }];
    case "memory":
      return [{ type: "openMemory", target: place.target }];
    case "customize":
      return [{ type: "openCustomize", tab: place.tab, app: place.app ?? null }];
    case "automations":
      return [{ type: "toggleRoutines", open: true }];
    case "settings":
      return place.page === "plugins"
        ? [{ type: "openPluginSettings", focus: place.focus ?? null }]
        : [{ type: "toggleAppSettings", open: true, page: place.page }];
  }
}

export function useNavHistory(state: AppState, dispatch: React.Dispatch<Action>) {
  const entries = useRef<Place[]>([]);
  const index = useRef(-1);
  // set while back or forward moves the app, so the move is not recorded
  // as a new place that would cut the forward list short
  const travelling = useRef<Place | null>(null);
  const [, redraw] = useState(0);

  const here = placeOf(state);
  const key = JSON.stringify(here);
  useEffect(() => {
    if (!here) return;
    if (travelling.current) {
      // arrived, or the place could not be reached (an agent since
      // archived): either way the list stays as it was
      if (samePlace(travelling.current, here)) travelling.current = null;
      return;
    }
    if (samePlace(entries.current[index.current] ?? null, here)) return;
    entries.current = [...entries.current.slice(0, index.current + 1), here].slice(-LIMIT);
    index.current = entries.current.length - 1;
    redraw((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const travel = useCallback(
    (step: -1 | 1) => {
      // a place that no longer exists is stepped over rather than stopped at
      let next = index.current + step;
      while (next >= 0 && next < entries.current.length) {
        const place = entries.current[next];
        const gone =
          (place.kind === "chat" &&
            !state.bots.some((b) => b.id === place.id && !b.hidden) &&
            !state.bloks.some((r) => r.id === place.id)) ||
          (place.kind === "agent" && !state.bots.some((b) => b.id === place.id && !b.hidden));
        if (!gone) break;
        next += step;
      }
      if (next < 0 || next >= entries.current.length) return;
      index.current = next;
      const place = entries.current[next];
      travelling.current = place;
      for (const action of goTo(place)) dispatch(action);
      redraw((n) => n + 1);
    },
    [dispatch, state.bots, state.bloks],
  );

  return {
    back: () => travel(-1),
    forward: () => travel(1),
    canBack: index.current > 0,
    canForward: index.current < entries.current.length - 1,
  };
}
