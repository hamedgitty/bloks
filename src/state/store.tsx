// All of the app's state, and the only place it talks to anything.
//
// The split that matters: the reducer next door is pure and knows nothing
// about the network, and every asynchronous thing happens here, either in
// the dispatch wrapper or in the event fold below. That is what makes the
// interesting logic testable without mounting a component or standing up
// a server.
//
// The app also owns no provider connections of its own. It sends typed
// commands and folds one event stream; anything that talks to a model
// happens in the harness.
import { takeReadFrame } from "@/lib/readReceipts";
import { consumeSettingsRequest } from "@/lib/settings-client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BRIEF_TARGET, CONVERSATION_TARGET, conversationOf, briefNoticeFor, CheckInHold, NoticeDelivery, noticeFor, settlesReplies } from "@/lib/notify";
import { itemProgress, isProgressText } from "@/lib/codexProgress";
import { sendBotArchive } from "@/lib/botArchive";
import { sendCardAnswer } from "@/lib/cardAnswer";
import { sendMessage } from "@/lib/sendMessage";
import { sendRoomPatch } from "@/lib/roomPatch";
import { keepTrying } from "@/lib/retry";
import { serverSeq, snapshotOrder, type SnapshotLoad } from "./snapshotOrder";
import { sendHeld, takeWake, wakeFetch, wakeGaveUp } from "@/lib/waking";
import { placeRow, type Listed } from "@/lib/sections";
import { askLaneFocus, dropLaneFocus } from "@/lib/drafts";
import { followMenuKeys } from "@/lib/conversationKeys";
import { platformOf } from "@/lib/shortcuts";
import { maybeAutoSpeak } from "@/components/Voice";
import {
  configFromFrame,
  findCard,
  openLaneUnread,
  pingedLane,
  readOpenLane,
  initialState,
  reducer,
  settleUnanswered,
  typedLane,
  withoutEdits,
  type Action,
  type AppState,
  type Bot,
  type CreditsSummary,
  type Message,
  type OptionCardData,
} from "./reducer";
import { toast } from "@/components/ui/toast";
import { openJoinDialog, workspaceFrame } from "@/lib/members";
import { loadPlan } from "@/lib/planClient";
import { hasOwnBrowser, noteBrowserState } from "@/lib/appBrowser";
import { formatDate, t } from "../lib/i18n.ts";

export * from "./reducer";

/** Every row the sidebar could show, as placing one needs it. */
export function sidebarRows(state: Pick<AppState, "bots" | "bloks">): Listed[] {
  return [
    ...state.bloks.map((b) => ({
      kind: "room" as const,
      id: b.id,
      section: b.section ?? null,
      pinned: b.pinned,
      pinOrder: b.pinOrder,
      activeWithYouAt: b.activeWithYouAt,
      createdAt: b.createdAt,
    })),
    ...state.bots
      .filter((b) => !b.hidden)
      .map((b) => ({
        kind: "agent" as const,
        id: b.id,
        section: b.section ?? null,
        pinned: b.pinned,
        pinOrder: b.pinOrder,
        activeWithYouAt: b.activeWithYouAt,
        createdAt: b.createdAt,
      })),
  ];
}

/** The section order this device kept before the workspace kept one
 * (it lived here until GitHub 156). Read once, to hand it over. */
const LOCAL_SECTION_ORDER = "bloks-section-order";
function localSectionOrder(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_SECTION_ORDER) ?? "[]");
    return Array.isArray(saved) ? saved.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}
function forgetLocalSectionOrder() {
  try {
    localStorage.removeItem(LOCAL_SECTION_ORDER);
  } catch {
    /* nothing to forget */
  }
}

// ── talking to the harness ─────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  // a read waits in the page while a hosted workspace wakes (src/lib/waking.ts)
  const res = await wakeFetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  // the status rides along, for a caller deciding whether trying again
  // could ever help (a 404 will not), and the code, for one that can do
  // something about it (a name to ask for, src/components/YourNameDialog),
  // and the mark of a hosted workspace that never woke (src/lib/waking.ts)
  if (!res.ok) {
    throw Object.assign(new Error(body.error ?? `${res.status} ${res.statusText}`), {
      status: res.status,
      code: typeof body.code === "string" ? body.code : undefined,
      ...(body.waking === true ? { waking: true } : {}),
    });
  }
  return body;
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

/** How long a finished turn's streamed text waits for its message. */
const STREAM_LINGER_MS = 8_000;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** The conversation on screen that the person marked unread on purpose.
   * Opening a conversation reads it, so a frame for the open one clears
   * its dot at once, and that also undid "mark as unread" the instant it
   * was pressed. A flag set by hand stays until the person leaves the
   * conversation and comes back, as in a mail app. */
  const keptUnread = useRef<{ botId: string; laneId: string } | null>(null);

  /** The sequence of the last bot frame applied for each agent. An answer
   * to a conversation action carries the sequence it was built at; one
   * older than a frame already shown would put an older record back (a
   * rename from elsewhere undone by a slow answer), so only its
   * conversation's messages are taken. */
  const botSeq = useRef(new Map<string, number>());
  /** The frames that touch the agents, kept while the agent list is being
   * asked for, so a list made before them cannot undo them (GitHub 398). */
  const listOrder = useRef(snapshotOrder<Action>());
  /** The agent list, and over it what the stream said after it was made.
   * `seq` is where the server says it made the list; a server too old to
   * say gets everything since the request went out. */
  const hydrateFrom = (bots: Bot[], seq?: unknown, load?: SnapshotLoad<Action>) => {
    const made = typeof seq === "number" ? seq : undefined;
    rawDispatch({ type: "hydrate", bots, after: load?.settle(made) });
    // a conversation action's answer made before the list is older than it
    // too, and is taken the way adoptAnswer takes any older answer
    if (made !== undefined) for (const b of bots) botSeq.current.set(b.id, Math.max(botSeq.current.get(b.id) ?? 0, made));
  };
  const adoptAnswer = (r: { bot?: Bot; seq?: number }) => {
    if (!r?.bot) return;
    const seen = botSeq.current.get(r.bot.id);
    if (typeof r.seq !== "number" || seen === undefined || seen <= r.seq) {
      rawDispatch({ type: "botPatched", bot: r.bot });
      return;
    }
    const shown = stateRef.current.bots.find((b) => b.id === r.bot!.id);
    if (shown && shown.activeTaskId === r.bot.activeTaskId) {
      rawDispatch({
        type: "botPatched",
        bot: { id: r.bot.id, messages: r.bot.messages, olderMessages: r.bot.olderMessages } as Partial<Bot> & { id: string },
      });
    }
  };

  /** Lane requests out from this window, by agent (see switchLane), and a
   * count bumped as each one settles, for the lane asking below. */
  const switching = useRef(new Map<string, number>());
  const [switchesSettled, setSwitchesSettled] = useState(0);

  // Text fields save as you type, so edits are coalesced per agent
  // rather than sending a request per keystroke.
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>());
  /** Latest unanswered save generation per agent and field. Together with
   * the waiting patches, these are the fields a broadcast must not
   * overwrite, because the person has typed past what the server has. */
  const unanswered = useRef(new Map<string, Map<string, number>>());
  /** Monotonic per-agent, per-field save counter. Kept separate from
   * unanswered so a settled mark does not let an older save reuse a
   * generation and clear a newer one. */
  const saveSeq = useRef(new Map<string, Map<string, number>>());
  const editing = (botId: string) =>
    new Set([
      ...Object.keys(patchTimers.current.get(botId)?.patch ?? {}),
      ...(unanswered.current.get(botId)?.keys() ?? []),
    ]);

  const dispatch = useMemo(() => {
    // The shell shows it over every view and takes it down again (App.tsx).
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
    };
    // A request that opens, makes or closes one of an agent's
    // conversations. Its answer brings the open conversation's messages,
    // so while it is out, the frame that announces the switch first does
    // not ask for them a second time (see laneLoads below).
    const switchLane = (botId: string, request: Promise<any>) => {
      switching.current.set(botId, (switching.current.get(botId) ?? 0) + 1);
      request
        .then(adoptAnswer)
        .catch(showError)
        .finally(() => {
          const left = (switching.current.get(botId) ?? 1) - 1;
          if (left > 0) switching.current.set(botId, left);
          else switching.current.delete(botId);
          // an answer that brought nothing (a refusal) leaves the lane to ask for
          setSwitchesSettled((n) => n + 1);
        });
    };
    // Remembering that a card was dealt with is a nicety, not a
  // correctness requirement, so a failure here is allowed to pass.
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      // the card is in the conversation on screen, which is not always
      // the agent's first
      const bot = stateRef.current.bots.find((b) => b.id === botId);
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...patch, ...(bot ? { taskId: bot.activeTaskId ?? bot.threadId } : {}) }),
      }).catch(() => {});
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      rawDispatch(action);
      switch (action.type) {
        case "send": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const typedIn = bot ? (bot.activeTaskId ?? bot.threadId) : undefined;
          const taskId = bot ? typedLane(bot) : undefined;
          // kept with the conversation it was typed in (the composer's key)
          // until it has gone, which on a hosted workspace that is asleep
          // is once it wakes (src/lib/waking.ts)
          sendHeld(`${action.botId}:${typedIn}`, action.text, () => sendMessage(api, { ...action, taskId }), {
            after: bot?.messages[bot.messages.length - 1]?.id ?? null,
          }).then(
            (r) => {
              // Typed in the lane strangers' mail is answered in, the words
              // went to the first conversation, so the screen goes there
              // too, while it is still on the lane they were typed in.
              // Left where it was, they seemed to vanish.
              if (taskId || typeof r?.taskId !== "string" || r.taskId === typedIn) return;
              const now = stateRef.current.bots.find((b) => b.id === action.botId);
              if (stateRef.current.selectedId !== action.botId || !now || (now.activeTaskId ?? now.threadId) !== typedIn) return;
              wrapped({ type: "selectTask", botId: action.botId, taskId: r.taskId });
            },
            (e) => {
              // a hosted workspace that never woke is said by the composer,
              // beside the words it hands back, not in a toast
              if (!wakeGaveUp(e)) showError(e);
              action.onFailed?.();
            },
          );
          break;
        }
        case "answerCard": {
          // An answer typed into a card is words to the agent like any
          // other, so it goes to the lane the card is in, by the same rule.
          const bot = action.roomId ? undefined : stateRef.current.bots.find((b) => b.id === action.botId);
          void sendCardAnswer(
            api,
            { ...action, taskId: bot ? typedLane(bot) : undefined },
            findCard(stateRef.current, action),
            () => rawDispatch({ type: "cardReopened", botId: action.botId, messageId: action.messageId, roomId: action.roomId }),
            showError,
          );
          break;
        }
        // connecting an engine reloads the fleet server-side, so the model
        // picker has to be refetched alongside the provider list
        case "connectProvider":
          api(`/api/providers/${action.kind}/connect`, {
            method: "POST",
            body: JSON.stringify({ key: action.key ?? "", url: action.url ?? "" }),
          })
            .then(({ providers }) => {
              rawDispatch({ type: "providers", providers });
              return api("/api/instances").then(({ instances }) =>
                rawDispatch({ type: "instances", instances }),
              );
            })
            .catch(showError);
          break;
        case "disconnectProvider":
          api(`/api/providers/${action.kind}`, { method: "DELETE" })
            .then(({ providers }) => {
              rawDispatch({ type: "providers", providers });
              return api("/api/instances").then(({ instances }) =>
                rawDispatch({ type: "instances", instances }),
              );
            })
            .catch(showError);
          break;
        case "hireTeam":
          // the server creates the agents, opens the room and posts the
          // lead's brief; we just need to land the user in it
          api(`/api/teams/${action.messageId}/hire`, {
            method: "POST",
            body: JSON.stringify({ botId: action.botId }),
          })
            .then(({ blok }) =>
              api("/api/bloks").then(({ bloks }) => {
                rawDispatch({ type: "hydrateBloks", bloks });
                rawDispatch({ type: "select", id: blok.id });
              }),
            )
            .catch(showError);
          break;
        case "dismissCard": {
          const card = findCard(stateRef.current, action);
          // Putting aside a card an agent still waits on tells it so. One
          // that has settled is only being tidied away: nothing is
          // listening, and telling the server anyway wrote "that request
          // had already closed" into the conversation.
          if (card?.requestId && !card.answered) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else if (!action.roomId) {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          // one call: the server seeds the role's greeting and setup
          // question, so the agent never flashes as "New Agent"
          api("/api/bots", {
            method: "POST",
            body: JSON.stringify(action.profile ?? {}),
          })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: `${source.name} copy`,
                  title: source.title,
                  description: source.description,
                  notifications: source.notifications,
                  modelSelection: source.modelSelection,
                  ...(source.computer ? { computer: source.computer } : {}),
                }),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          // Archived unless the caller says otherwise. Everything that
          // presses this from a row means "put it away"; only the drawer
          // asks for the other thing, and it asks in as many words.
          void sendBotArchive(
            api,
            action.botId,
            action.forget ? "forget" : "archive",
            hydrateFrom,
            (error) => {
              // the "Archived" toast went up on the click; a refusal takes
              // it back down so it never sits beside the error saying why
              toast.dismiss(`archive-${action.botId}`);
              showError(error);
            },
            listOrder.current.begin,
          );
          break;
        case "restoreBot":
          void sendBotArchive(api, action.botId, "restore", hydrateFrom, showError, listOrder.current.begin);
          break;
        case "createRoom":
          api("/api/bloks", {
            method: "POST",
            // the crown goes with the room rather than after it, so no
            // turn ever runs under a lead nobody chose
            body: JSON.stringify({
              name: action.name,
              memberIds: action.memberIds,
              ...(action.leadId ? { leadId: action.leadId } : {}),
            }),
          })
            .then(({ blok }) => {
              // shown at once, and the list read again around it, never
              // emptied first: a read that failed left no rooms at all
              rawDispatch({ type: "blokPatched", blok });
              // The settings chosen with it, each sent on its own: a folder
              // the server refuses is said, and the room still opens
              // without it rather than not at all.
              const settings: Array<Promise<unknown>> = [];
              const patch = (body: Record<string, unknown>) =>
                settings.push(
                  api(`/api/bloks/${blok.id}`, { method: "PATCH", body: JSON.stringify(body) }).catch(showError),
                );
              if (action.answers && action.answers !== "everyone") patch({ answers: action.answers });
              if (action.cwd?.trim()) patch({ cwd: action.cwd.trim() });
              return Promise.all(settings)
                .then(() => api("/api/bloks"))
                .then(({ bloks }) => {
                  rawDispatch({ type: "hydrateBloks", bloks });
                  rawDispatch({ type: "select", id: blok.id });
                  rawDispatch({ type: "toggleNewRoom", open: false });
                });
            })
            .catch(showError);
          break;
        case "patchRoom":
          void sendRoomPatch(api, action.blokId, action.patch, (bloks) => rawDispatch({ type: "hydrateBloks", bloks }), showError);
          break;
        case "placeRow": {
          // Shown at once, neighbours and all, by the same steps the server
          // takes; its broadcasts then say what this already shows. Sent
          // straight away rather than with the agent's typing, which waits
          // for a pause: a drop is one act, and the list should hold still
          // after it.
          const to = { section: action.section, pinned: action.pinned, position: action.position };
          rawDispatch({ type: "placed", rows: placeRow(sidebarRows(stateRef.current), action.id, to) });
          api(action.kind === "agent" ? `/api/bots/${action.id}` : `/api/bloks/${action.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              section: action.section,
              pinned: action.pinned,
              ...(action.pinned && action.position !== undefined ? { position: action.position } : {}),
            }),
          }).catch(showError);
          break;
        }
        case "moveSections":
          api("/api/sidebar/sections", { method: "PUT", body: JSON.stringify({ order: action.order }) }).catch(showError);
          break;
        case "deleteRoom":
          api(`/api/bloks/${action.blokId}`, { method: "DELETE" })
            .then(() => rawDispatch({ type: "blokDeleted", blokId: action.blokId }))
            .catch(showError);
          break;
        case "newTask": {
          // The new conversation's box takes the keyboard once it shows
          // (drafts.ts), on a computer: on a phone that would be the
          // keyboard sliding up over the conversation it just opened.
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const had = document.activeElement === document.body ? null : document.activeElement;
          const asked =
            bot && window.matchMedia?.("(pointer: fine)").matches
              ? askLaneFocus(bot.id, bot.activeTaskId ?? bot.threadId, had)
              : null;
          const made = api(`/api/bots/${action.botId}/tasks`, { method: "POST", body: "{}" });
          // refused, or answered with nothing to open: no box is coming
          if (asked) made.then((r) => !r?.bot && dropLaneFocus(asked), () => dropLaneFocus(asked));
          switchLane(action.botId, made);
          break;
        }
        case "selectTask":
          keptUnread.current = null;
          switchLane(action.botId, api(`/api/bots/${action.botId}/tasks/${action.taskId}/activate`, { method: "POST" }));
          break;
        case "closeTask":
          switchLane(action.botId, api(`/api/bots/${action.botId}/tasks/${action.taskId}`, { method: "DELETE" }));
          break;
        case "clearTask":
          switchLane(action.botId, api(`/api/bots/${action.botId}/tasks/${action.taskId}/clear`, { method: "POST" }));
          break;
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.taskId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          })
            .then(adoptAnswer)
            .catch(showError);
          break;
        case "sendToRoom": {
          const room = stateRef.current.bloks.find((b) => b.id === action.blokId);
          sendHeld(
            `room:${action.blokId}`,
            action.text,
            () =>
              api(`/api/bloks/${action.blokId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.text, replyTo: action.replyTo }),
              }),
            { after: room?.messages[room.messages.length - 1]?.id ?? null },
          ).catch((e) => {
            if (!wakeGaveUp(e)) showError(e);
            action.onFailed?.();
          });
          break;
        }
        case "markLaneUnread": {
          const shown = stateRef.current.bots.find((b) => b.id === action.botId);
          if (action.botId === stateRef.current.selectedId && shown && (shown.activeTaskId ?? shown.threadId) === action.taskId) {
            keptUnread.current = { botId: action.botId, laneId: action.taskId };
          }
          api(`/api/bots/${action.botId}/tasks/${action.taskId}`, {
            method: "PATCH",
            body: JSON.stringify({ unread: true }),
          }).catch(() => {});
          break;
        }
        case "select": {
          // coming back to a conversation is reading it again
          keptUnread.current = null;
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          if (!bot) break;
          // The dot on an agent is about one conversation; go to it, and
          // opening it reads it. Otherwise read the one that is open. A
          // conversation picked by name wins over both.
          const open = bot.activeTaskId ?? bot.threadId;
          const pinged = action.lane ? (action.lane === open ? null : action.lane) : pingedLane(bot);
          if (pinged) {
            switchLane(bot.id, api(`/api/bots/${bot.id}/tasks/${pinged}/activate`, { method: "POST" }));
          } else if (openLaneUnread(bot)) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          break;
        }
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              const sent = unanswered.current.get(action.botId) ?? new Map<string, number>();
              unanswered.current.set(action.botId, sent);
              const seq = saveSeq.current.get(action.botId) ?? new Map<string, number>();
              saveSeq.current.set(action.botId, seq);
              // One generation per field per save from a counter that is
              // never cleared, so an older response cannot reuse a settled
              // generation and wipe a newer mark.
              const saveGens = new Map<string, number>();
              for (const key of Object.keys(patch)) {
                const gen = (seq.get(key) ?? 0) + 1;
                seq.set(key, gen);
                sent.set(key, gen);
                saveGens.set(key, gen);
              }
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) })
                .then((r) => {
                  // Drop this save's marks when it is still the latest for
                  // that field, so server-normalized values (a trimmed
                  // section name, for example) can land. Only fields this
                  // save sent are merged: the PATCH body returns the whole
                  // bot, and adopting other fields would let an older save
                  // overwrite a newer edit on a different key.
                  const stale = settleUnanswered(sent, saveGens);
                  if (r?.bot) {
                    const blocked = new Set([...editing(action.botId), ...stale]);
                    const bot: Partial<Bot> & { id: string } = { id: r.bot.id };
                    for (const key of Object.keys(patch)) {
                      if (!blocked.has(key) && key in r.bot) {
                        (bot as Record<string, unknown>)[key] = (r.bot as Record<string, unknown>)[key];
                      }
                    }
                    rawDispatch({ type: "botPatched", bot });
                  }
                })
                .catch((e) => {
                  settleUnanswered(sent, saveGens);
                  showError(e);
                });
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, []);

  // An agent's open conversation can change with no transcript to show,
  // when a lane is opened on another device or a rehearsal opens one. The
  // reducer empties the old lane's messages and names the new lane in
  // laneLoads; this asks for them. A message said in the new lane just
  // before the switch reached no conversation here, and the page has it.
  // Only the latest ask for an agent is taken, and the reducer drops an
  // answer for a lane that is no longer open. A switch made here waits
  // for its own answer instead (switchLane).
  const laneAsks = useRef(new Map<string, { threadId: string; n: number }>());
  const laneAskCount = useRef(0);
  // A load that failed is asked for again, further apart each time, while
  // the conversation still waits for it; nothing else would ask, and it
  // would stay empty until some unrelated switch or a reconnect.
  const laneFailures = useRef(new Map<string, number>());
  const [laneRetry, setLaneRetry] = useState(0);
  useEffect(() => {
    for (const [botId, threadId] of Object.entries(state.laneLoads)) {
      if (switching.current.has(botId)) continue;
      if (laneAsks.current.get(botId)?.threadId === threadId) continue;
      const n = ++laneAskCount.current;
      laneAsks.current.set(botId, { threadId, n });
      const latest = () => laneAsks.current.get(botId)?.n === n;
      api(`/api/bots/${botId}/messages?thread=${encodeURIComponent(threadId)}`)
        .then((page) => {
          if (!latest()) return;
          laneFailures.current.delete(`${botId}:${threadId}`);
          rawDispatch({
            type: "laneLoaded",
            id: botId,
            threadId,
            messages: Array.isArray(page.messages) ? page.messages : [],
            olderMessages: typeof page.olderMessages === "number" ? page.olderMessages : 0,
          });
        })
        .catch((e) => {
          if (!latest() || stateRef.current.laneLoads[botId] !== threadId) return;
          const key = `${botId}:${threadId}`;
          const failures = (laneFailures.current.get(key) ?? 0) + 1;
          laneFailures.current.set(key, failures);
          // an empty conversation needs a reason, said once rather than on
          // every try
          if (failures === 1) rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
          // Tried again only when that could help: the line, or the
          // server, having a moment. A conversation that is gone stays gone.
          const status = (e as { status?: number }).status;
          const final = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
          if (!final) setTimeout(() => setLaneRetry((t) => t + 1), Math.min(15_000, 1_000 * 2 ** (failures - 1)));
        })
        .finally(() => {
          if (latest()) laneAsks.current.delete(botId);
        });
    }
  }, [state.laneLoads, switchesSettled, laneRetry]);

  // ── first load, then live updates ────────────────────────────────────
  /**
   * Raise a banner when something happens that is worth looking up for.
   * The decision lives in src/lib/notify.ts so it can be reasoned about
   * and tested on its own; this only supplies the context it needs and
   * hands the result to the shell.
   */
  /** Frames at or below this sequence are catch-up, not news. */
  const replayUntil = useRef(0);
  const noticeDelivery = useRef(new NoticeDelivery());
  /** A check-in's replies, waiting for its turn to end (CheckInHold). */
  const checkIns = useRef(new CheckInHold<Message>());
  /** Whether the server says each turn's reply once it is over
   * (reply.settled). Our own server always does; one on another computer
   * may be older, and is asked on every hello (settlesReplies). */
  const settledReplies = useRef(true);
  /** For an older server only: when each thread last raised a reply
   * banner, to keep a chatty turn to one. */
  const lastBanner = useRef(new Map<string, number>());

  const announce = useCallback((threadId: string, message: unknown, replySettled = false): boolean => {
    const bridge = window.bloks;
    if (!bridge || !message || itemProgress(message as Message)) return false;
    const current = stateRef.current;
    const bot = current.bots.find((b) => b.tasks?.some((t) => t.id === threadId));
    const room = current.bloks.find((r) => r.id === threadId);
    if (!bot && !room) return false;
    const notice = noticeFor(message as never, {
      replySettled,
      focused: document.hasFocus() && document.visibilityState === "visible",
      selectedId: current.selectedId,
      threadId,
      ...(bot ? { bot: { id: bot.id, name: bot.name, notifications: bot.notifications } } : {}),
      ...(room ? { room: { id: room.id, name: room.name } } : {}),
      goalRunning: bot?.tasks?.find((t) => t.id === threadId)?.goal?.status === "active",
    });
    if (!notice) return false;
    if (bot?.avatarAt) notice.avatar = `/api/bots/${bot.id}/avatar?v=${bot.avatarAt}`;
    void bridge.notifyShow(notice).catch(() => {});
    return true;
  }, []);

  /** A reply as it landed, from a server too old to say when its turn was
   * over. A single turn can settle several messages: the first one is the
   * news, and the rest would be the same news again. */
  const announceLanded = useCallback((threadId: string, message: Message) => {
    const now = Date.now();
    if (now - (lastBanner.current.get(threadId) ?? 0) < 4000) return;
    if (announce(threadId, message, true)) lastBanner.current.set(threadId, now);
  }, [announce]);

  /** Agents that opted in read their settled replies aloud, even when
   * their chat is not the one on screen. Never a quiet check-in's: it
   * said nothing to you. */
  const speak = useCallback((threadId: string, message: Message | undefined) => {
    if (message?.role !== "bot" || message.kind !== "text" || !message.text || message.quiet || itemProgress(message)) return;
    const owner = stateRef.current.bots.find((b) => b.tasks?.some((t) => t.id === threadId));
    if (owner) maybeAutoSpeak(owner, message.text);
  }, []);

  // "Add to Bloks" on the website: a gallery team opens in the hire
  // review (NewRoomDialog), whether the app was running or not. A
  // workspace invite opens the join dialog the same way.
  useEffect(() => {
    const bridge = window.bloks;
    if (!bridge?.onLink) return;
    const open = (link: { kind?: string; slug?: string; fragment?: string; url?: string } | null) => {
      if (link?.kind === "team" && link.slug) rawDispatch({ type: "openTeamLink", slug: link.slug });
      // bloks://install?url=: the catalogue's review of whatever it points
      // at, fetched and checked by the server; nothing installs from it
      if (link?.kind === "install" && link.url) rawDispatch({ type: "openInstallLink", url: link.url });
      // a workspace invite from bloks.dev or a scanned QR: the join dialog,
      // filled in (src/components/members/JoinWorkspaceDialog.tsx)
      if (link?.kind === "join" && link.fragment) openJoinDialog(`bloks://join#${link.fragment}`);
      // bloks://plan: the site sending somebody back after a checkout or
      // a change in billing, so the plan is asked fresh as the page opens
      if (link?.kind === "plan") {
        rawDispatch({ type: "toggleAppSettings", open: true, page: "plan" });
        void loadPlan(true);
      }
    };
    void bridge.pendingLink?.().then(open).catch(() => {});
    return bridge.onLink(open);
  }, []);

  // The macOS menu bar's own items (electron/app-menu.mjs): Settings…,
  // and Keyboard Shortcuts under Help. One chosen while no window was
  // open is waiting for this one. The conversation tabs' items are their
  // keys, heard where those are (conversationKeys.ts).
  useEffect(() => {
    const bridge = window.bloks;
    if (!bridge?.onMenuCommand) return;
    const run = (command: string | null) => {
      if (command === "settings") rawDispatch({ type: "toggleAppSettings", open: true });
      if (command === "shortcuts") rawDispatch({ type: "toggleShortcuts", open: true });
    };
    void bridge.pendingMenuCommand?.().then(run).catch(() => {});
    const stopRun = bridge.onMenuCommand(run);
    const stopKeys = followMenuKeys(platformOf(), (handler) => bridge.onMenuCommand!(handler));
    return () => {
      stopRun();
      stopKeys();
    };
  }, []);

  // Clicking a banner opens what it was about. A banner from another
  // workspace switched the window here first, so this page loaded after
  // the click and asks for it once it is listening.
  useEffect(() => {
    const bridge = window.bloks;
    if (!bridge?.onNotifyActivate) return;
    // somebody asking to join opens Members, where their request is
    const open = (target: string | null | undefined) => {
      if (!target) return;
      if (target === "workspace:members") rawDispatch({ type: "toggleAppSettings", open: true, page: "workspace:members" });
      // the morning brief's notification opens that brief on Overview
      else if (target.startsWith(BRIEF_TARGET)) rawDispatch({ type: "openBrief", id: target.slice(BRIEF_TARGET.length) });
      // a page of Settings by name: a pairing made from another
      // workspace's phone opens this one's Phone and devices
      else if (target.startsWith("settings:")) rawDispatch({ type: "toggleAppSettings", open: true, page: target.slice("settings:".length) });
      // one conversation by name, from a row in the notch: picked the way
      // the sidebar picks it, so it is activated as well as shown
      else if (target.startsWith(CONVERSATION_TARGET)) {
        const to = conversationOf(target);
        if (to) dispatch({ type: "select", id: to.id, lane: to.lane });
      } else rawDispatch({ type: "select", id: target });
    };
    void bridge.pendingNotifyTarget?.().then(open).catch(() => {});
    return bridge.onNotifyActivate(({ target }) => open(target));
  }, []);

  useEffect(() => {
    let alive = true;
    let stopBots: (() => void) | null = null;
    let botsLoad: SnapshotLoad<Action> | null = null;
    const loadAll = () => {
      // The agent list is what ends the loading screen, so it is asked
      // again until it comes; the rest can wait for the next reload. A
      // newer load takes over from one still out, whose answer is older.
      stopBots?.();
      botsLoad?.drop();
      const load = (botsLoad = listOrder.current.begin());
      stopBots = keepTrying(() =>
        api("/api/bots").then(({ bots, seq }) => {
          if (!alive || botsLoad !== load) return;
          botsLoad = null;
          hydrateFrom(bots, seq, load);
        }),
      );
      api("/api/bloks")
        .then(({ bloks }) => alive && rawDispatch({ type: "hydrateBloks", bloks }))
        .catch(() => {});
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
      api("/api/providers")
        .then(({ providers }) => alive && rawDispatch({ type: "providers", providers }))
        .catch(() => {});
      api("/api/engines/updates")
        .then(({ updates }) => alive && updates && rawDispatch({ type: "engineUpdates", updates }))
        .catch(() => {});
      api("/api/config")
        .then((config) => alive && rawDispatch({ type: "configStatus", config }))
        .catch(() => {});
      api("/api/sidebar")
        .then(({ sectionOrder, sectionOrderSaved }) => {
          if (!alive) return;
          // The headings used to be ordered per device. The first device
          // to connect with an order of its own hands it to the workspace;
          // every device after that takes the workspace's and lets its own
          // go, so none of them drifts again.
          const local = localSectionOrder();
          if (!sectionOrderSaved && local.length) {
            rawDispatch({ type: "sectionOrder", order: local });
            api("/api/sidebar/sections", { method: "PUT", body: JSON.stringify({ order: local }) })
              .then(forgetLocalSectionOrder)
              .catch(() => {});
            return;
          }
          rawDispatch({ type: "sectionOrder", order: Array.isArray(sectionOrder) ? sectionOrder : [] });
          if (local.length) forgetLocalSectionOrder();
        })
        .catch(() => {});
    };
    // The stream carries sequence numbers, and reconnecting with the last
    // one seen replays exactly the missed frames. Only when the server
    // cannot cover the gap (hello says resumed: false) is the full state
    // re-downloaded, which turns most reconnects from a re-hydrate into a
    // catch-up. EventSource cannot change its URL between retries, so the
    // retry loop is ours.
    let es: EventSource | null = null;
    let lastSeq = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!alive) return;
      noticeDelivery.current.reconnect();
      es = new EventSource(lastSeq ? `/api/events?since=${lastSeq}` : "/api/events");
      es.onopen = () => rawDispatch({ type: "connected", value: true });
      es.onerror = () => {
        rawDispatch({ type: "connected", value: false });
        es?.close();
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, 1500);
      };
      es.onmessage = onFrame;
    };

    const onFrame = (raw: MessageEvent) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      // An inspection asking what this window's settings are: answered
      // aside, never folded into state (src/lib/settings-client.ts).
      if (consumeSettingsRequest(frame)) return;
      // your hosted workspace waking up, from the app's stand-in for its
      // server rather than from the server: this window's, never the
      // workspace's, so it is never folded into state (src/lib/waking.ts)
      if (frame?.kind === "remote.wake") return takeWake(frame);
      if (typeof frame._seq === "number") lastSeq = frame._seq;
      // what touches the agents is applied now and kept for a list still
      // on its way, which is older than it when made before it
      const applyFrame = (action: Action) => {
        rawDispatch(action);
        listOrder.current.note(serverSeq(frame), action);
      };
      // the workspace's people go to their own small bus (src/lib/members.ts)
      if (typeof frame.kind === "string" && frame.kind.startsWith("workspace.")) {
        workspaceFrame(frame, typeof frame._seq !== "number" || frame._seq > replayUntil.current);
      }
      // how far somebody has read, for "Seen by" (src/lib/readReceipts.ts)
      if (frame.kind === "read") return takeReadFrame(frame);
      switch (frame.kind) {
        case "hello":
          // Everything up to the server's current sequence is either
          // already ours or about to be replayed to catch us up. Neither
          // is news: a laptop opened after an hour should not fire an
          // hour of banners.
          replayUntil.current = typeof frame._seq === "number" ? frame._seq : 0;
          noticeDelivery.current.hello(frame._seq);
          // the server on the other end may have changed since the last
          // hello, so whether it says when a turn is over is asked again
          fetch("/api/health")
            .then((res) => (res.ok ? res.json() : null))
            .then((health) => {
              const settles = settlesReplies(health);
              if (alive && settles !== null) settledReplies.current = settles;
            })
            .catch(() => {});
          if (!frame.resumed) {
            // a server that could not resume may have restarted and begun
            // counting again, so its sequences say nothing about ours
            botSeq.current.clear();
            // and what was streaming then will never hear its end
            rawDispatch({ type: "streamRestarted" });
            loadAll();
          }
          break;
        case "message": {
          applyFrame({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          const msg = frame.message;
          const news = typeof frame._seq !== "number" || frame._seq > replayUntil.current;
          // a check-in's replies are spoken when its turn ends, if it was
          // not quiet (src/lib/notify.ts); its banner is reply.settled, or
          // the release below for an older server
          if (news && msg && checkIns.current.holds(msg, frame.checkIn === true)) {
            checkIns.current.hold(frame.threadId, msg);
            break;
          }
          speak(frame.threadId, msg);
          if (news && msg?.kind !== "text" && noticeDelivery.current.take(frame._seq,
            `message:${frame.threadId}:${msg?.card?.requestId ?? msg?.id}`)) announce(frame.threadId, msg);
          // a server that sends reply.settled says the reply there instead
          if (news && msg?.kind === "text" && !settledReplies.current) announceLanded(frame.threadId, msg);
          break;
        }
        case "brief.ready":
          // The morning's one notification (src/lib/notify.ts). Caught up
          // on after a sleep, it is not said again: the brief is on
          // Overview, and the server's own frame is already in the past.
          if (noticeDelivery.current.take(frame._seq, `brief:${frame.id}`)) {
            const notice = briefNoticeFor(frame, {
              focused: document.hasFocus() && document.visibilityState === "visible",
              onOverview: stateRef.current.page === "overview",
            });
            if (notice && window.bloks) void window.bloks.notifyShow(notice).catch(() => {});
          }
          break;
        case "reply.settled":
          // Saved-content snapshot only: no history insertion or speech.
          if (noticeDelivery.current.take(frame._seq, `reply:${frame.threadId}:${frame.botId}:${frame.turnId}`)) {
            announce(frame.threadId, frame.message, true);
          }
          break;
        case "message.patch": {
          applyFrame({ type: "messagePatched", threadId: frame.threadId, message: frame.message, moved: frame.moved === true });
          // A failure's own notice turned into the person's card arrives
          // as a patch (server/incidents.ts). Said once per incident, as
          // a new card would be; its later updates are not news again.
          const card = frame.message as Message | undefined;
          if (card?.kind === "notice" && card.incident?.kind === "needs-you" && card.incident.state !== "resolved" &&
            noticeDelivery.current.take(frame._seq, `incident:${card.incident.id}`)) announce(frame.threadId, card);
          break;
        }
        case "rehearsals":
          rawDispatch({ type: "rehearsalsChanged" });
          break;
        // an agent's memory, or the shared memory ("_shared"), changed:
        // whatever shows that one re-reads, and the Memory place's list
        // of every agent re-reads its meta lines
        case "memory.changed":
          if (typeof frame.botId === "string") rawDispatch({ type: "tick", key: `memory:${frame.botId}` });
          rawDispatch({ type: "tick", key: "memory" });
          break;
        case "profile":
        case "brief":
        case "location":
        case "watchers":
        case "intents":
        case "meetings":
        case "enginePauses":
        case "routines":
        case "incidents":
        case "secrets":
        case "connections":
          rawDispatch({ type: "tick", key: frame.kind });
          break;
        // a rule changed, or an approval was answered: what is offered as
        // a rule may have changed with it (src/lib/ruleSuggestions.ts)
        case "rules":
          rawDispatch({ type: "tick", key: "rules" });
          rawDispatch({ type: "tick", key: "suggestions" });
          break;
        case "suggestions":
          rawDispatch({ type: "tick", key: "suggestions" });
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // an unread badge on the conversation already open is wrong the
          // moment it arrives; another lane that pinged stays unread
          const kept = keptUnread.current;
          const keptHere = kept?.botId === bot.id && kept.laneId === (bot.activeTaskId ?? bot.threadId);
          if (bot.id === stateRef.current.selectedId && bot.threadId && !keptHere && openLaneUnread(bot as Bot)) {
            Object.assign(bot, readOpenLane(bot as Bot));
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          const made = serverSeq(frame);
          if (made !== undefined) botSeq.current.set(bot.id, made);
          applyFrame({ type: "botPatched", bot: withoutEdits(bot, editing(bot.id)) });
          break;
        }
        case "runtime": {
          const event = frame.event;
          if (event.type === "commands.updated") {
            rawDispatch({ type: "tick", key: `commands:${event.threadId}` });
          } else if (event.type === "content.delta" && event.streamKind === "assistant_text") {
            if (!isProgressText(event.codexText)) rawDispatch({ type: "streamDelta", threadId: event.threadId, delta: event.delta });
          } else if (event.type === "turn.started") {
            applyFrame({ type: "turnStarted", threadId: event.threadId, turnId: typeof event.turnId === "string" ? event.turnId : undefined });
          } else if (event.type === "turn.completed") {
            // The streamed text stays until its message lands and takes its
            // place: through the relay the message can come after the end
            // of the turn, and clearing now left a gap where the reply was.
            // A turn that ended with no message of its own lets go shortly.
            applyFrame({ type: "turnSettled", threadId: event.threadId, turnId: typeof event.turnId === "string" ? event.turnId : undefined });
            const threadId = event.threadId;
            setTimeout(() => rawDispatch({ type: "streamClear", threadId, onlyIfSettled: true }), STREAM_LINGER_MS);
            // a check-in that had something to say says it now
            const reported = checkIns.current.release(threadId);
            if (reported) {
              speak(threadId, reported);
              if (!settledReplies.current) announceLanded(threadId, reported);
            }
          }
          break;
        }
        case "screen":
          rawDispatch({
            type: "screenFrame",
            botId: frame.botId,
            png: frame.png,
            mime: frame.mime ?? "image/png",
            ...(frame.source === "browser" ? { source: "browser" as const } : {}),
          });
          break;
        case "computer":
          rawDispatch({ type: "computerState", botId: frame.botId, state: String(frame.state ?? "") });
          break;
        case "browser.app":
          // the Mac's browser, for a page that is not on the Mac; the
          // desktop app hears its own browser first-hand (src/lib/appBrowser.ts)
          if (!hasOwnBrowser()) noteBrowserState(frame.state);
          break;
        case "blok":
          rawDispatch({ type: "blokPatched", blok: frame.blok });
          break;
        case "blok.deleted":
          rawDispatch({ type: "blokDeleted", blokId: frame.blokId });
          break;
        // the headings were put in a new order, here or on another device
        case "sidebar":
          if (Array.isArray(frame.sectionOrder)) rawDispatch({ type: "sectionOrder", order: frame.sectionOrder });
          break;
        // shared rooms: who is in them, who is at the door, who is typing
        case "room.people":
          if (Array.isArray(frame.people)) rawDispatch({ type: "roomPeople", roomId: frame.roomId, people: frame.people });
          break;
        case "room.joinRequest":
          rawDispatch({ type: "joinRequest", roomId: frame.roomId });
          break;
        case "room.typing":
          rawDispatch({ type: "roomTyping", roomId: frame.roomId, name: frame.name, at: frame.at ?? Date.now() });
          break;
        // an OAuth sign-in finishes in the browser, so the news that an
        // engine connected arrives here rather than from a fetch
        case "providers":
          rawDispatch({ type: "providers", providers: frame.providers });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
        case "instances":
          if (Array.isArray(frame.instances)) rawDispatch({ type: "instances", instances: frame.instances });
          break;
        // the server looks for engine releases on its own schedule
        case "engineUpdates":
          if (frame.updates && typeof frame.updates === "object") {
            rawDispatch({ type: "engineUpdates", updates: frame.updates });
          }
          break;
        // only ever a delete for good (an archive arrives as a bot frame),
        // so it leaves the drawer too rather than staying there as a ghost
        case "bot.deleted":
          applyFrame({ type: "deleteBot", botId: frame.botId, forget: true });
          break;
        // credentials changed and the engines were rebuilt, so the
        // picker needs to hear that something became usable
        // a run refused for an empty balance, or more added since
        case "credits": {
          const { kind: _kind, _seq, ...credits } = frame;
          rawDispatch({ type: "credits", credits: credits as unknown as CreditsSummary });
          break;
        }
        case "config":
          rawDispatch({ type: "configStatus", config: configFromFrame(frame) });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    connect();
    return () => {
      alive = false;
      stopBots?.();
      botsLoad?.drop();
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** The store, or null outside one: a member's app (src/components/member)
 * has none, and the few pieces shared with it ask this way. */
export function useOptionalStore() {
  return useContext(StoreContext);
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return formatDate(at, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Sidebar stamps: a bare clock time on a three-day-old message reads as
 * "this morning". Show the time only for today, then the weekday, then
 * the date.
 */
export function formatWhen(at: number) {
  const then = new Date(at);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= midnight) return formatTime(at);
  if (at >= midnight - 86_400_000) return t("store.yesterday");
  if (at >= midnight - 6 * 86_400_000) return formatDate(then, { weekday: "short" });
  return formatDate(then, { month: "short", day: "numeric" });
}
