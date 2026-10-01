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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { noticeFor } from "@/lib/notify";
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
  withoutEdits,
  type Action,
  type AppState,
  type Bot,
  type OptionCardData,
} from "./reducer";

export * from "./reducer";

// ── talking to the harness ─────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
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

  /** The sequence of the last bot frame applied for each agent. An answer
   * to a conversation action carries the sequence it was built at; one
   * older than a frame already shown would put an older record back (a
   * rename from elsewhere undone by a slow answer), so only its
   * conversation's messages are taken. */
  const botSeq = useRef(new Map<string, number>());
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
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    // Remembering that a card was dealt with is a nicety, not a
  // correctness requirement, so a failure here is allowed to pass.
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      rawDispatch(action);
      switch (action.type) {
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, replyTo: action.replyTo }),
          }).catch(showError);
          break;
        case "answerCard": {
          const card = findCard(stateRef.current, action);
          if (card?.runId) {
            // A workflow run is parked on this card. Answering resumes
            // the run, which is a different thing from saying something
            // to an agent, so it goes to its own route. That route marks
            // the card answered itself: this one can be in a room, and
            // the card route only reaches an agent's own thread.
            api(`/api/workflows/runs/${card.runId}/answer`, {
              method: "POST",
              body: JSON.stringify({ answer: action.answer }),
            }).catch(showError);
          } else if (card?.requestId) {
            // a live provider ask settles against the agent that raised it,
            // wherever the card happens to be shown
            const behavior =
              action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          } else if (action.roomId) {
            api(`/api/bloks/${action.roomId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
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
          if (card?.requestId) {
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
          api(`/api/bots/${action.botId}${action.forget ? "?forget=1" : ""}`, { method: "DELETE" }).catch(
            showError,
          );
          break;
        case "restoreBot":
          api(`/api/bots/${action.botId}/restore`, { method: "POST" }).catch(showError);
          break;
        case "createRoom":
          api("/api/bloks", {
            method: "POST",
            body: JSON.stringify({ name: action.name, memberIds: action.memberIds }),
          })
            .then(({ blok }) => {
              rawDispatch({ type: "blokPatched", blok });
              rawDispatch({ type: "hydrateBloks", bloks: [] });
              return api("/api/bloks").then(({ bloks }) => {
                rawDispatch({ type: "hydrateBloks", bloks });
                rawDispatch({ type: "select", id: blok.id });
                rawDispatch({ type: "toggleNewRoom", open: false });
              });
            })
            .catch(showError);
          break;
        case "patchRoom":
          api(`/api/bloks/${action.blokId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(() => {});
          break;
        case "deleteRoom":
          api(`/api/bloks/${action.blokId}`, { method: "DELETE" })
            .then(() => rawDispatch({ type: "blokDeleted", blokId: action.blokId }))
            .catch(showError);
          break;
        case "newTask":
          api(`/api/bots/${action.botId}/tasks`, { method: "POST", body: "{}" })
            .then(adoptAnswer)
            .catch(showError);
          break;
        case "selectTask":
          api(`/api/bots/${action.botId}/tasks/${action.taskId}/activate`, { method: "POST" })
            .then(adoptAnswer)
            .catch(showError);
          break;
        case "closeTask":
          api(`/api/bots/${action.botId}/tasks/${action.taskId}`, { method: "DELETE" })
            .then(adoptAnswer)
            .catch(showError);
          break;
        case "clearTask":
          api(`/api/bots/${action.botId}/tasks/${action.taskId}/clear`, { method: "POST" })
            .then(adoptAnswer)
            .catch(showError);
          break;
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.taskId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          })
            .then(adoptAnswer)
            .catch(showError);
          break;
        case "sendToRoom":
          api(`/api/bloks/${action.blokId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, replyTo: action.replyTo }),
          }).catch(showError);
          break;
        case "markLaneUnread":
          api(`/api/bots/${action.botId}/tasks/${action.taskId}`, {
            method: "PATCH",
            body: JSON.stringify({ unread: true }),
          }).catch(() => {});
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          if (!bot) break;
          // The dot on an agent is about one conversation; go to it, and
          // opening it reads it. Otherwise read the one that is open. A
          // conversation picked by name wins over both.
          const open = bot.activeTaskId ?? bot.threadId;
          const pinged = action.lane ? (action.lane === open ? null : action.lane) : pingedLane(bot);
          if (pinged) {
            api(`/api/bots/${bot.id}/tasks/${pinged}/activate`, { method: "POST" })
              .then(adoptAnswer)
              .catch(showError);
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

  // ── first load, then live updates ────────────────────────────────────
  /**
   * Raise a banner when something happens that is worth looking up for.
   * The decision lives in src/lib/notify.ts so it can be reasoned about
   * and tested on its own; this only supplies the context it needs and
   * hands the result to the shell.
   */
  /** Frames at or below this sequence are catch-up, not news. */
  const replayUntil = useRef(0);
  /** When each thread last raised a banner, to keep a chatty turn to one. */
  const lastBanner = useRef(new Map<string, number>());

  const announce = useCallback((threadId: string, message: unknown) => {
    const bridge = window.bloks;
    if (!bridge || !message) return;
    const current = stateRef.current;
    const bot = current.bots.find((b) => b.tasks?.some((t) => t.id === threadId));
    const room = current.bloks.find((r) => r.id === threadId);
    if (!bot && !room) return;
    const text = (message as { text?: string }).text ?? "";
    const notice = noticeFor(message as never, {
      focused: document.hasFocus() && document.visibilityState === "visible",
      selectedId: current.selectedId,
      threadId,
      ...(bot ? { bot: { id: bot.id, name: bot.name, notifications: bot.notifications } } : {}),
      ...(room ? { room: { id: room.id, name: room.name } } : {}),
      // a room line that named you is the one worth hearing about
      mentionsUser: /(^|\s)@(you|me)\b/i.test(text),
    });
    if (!notice) return;
    // A single turn can settle several messages. The first one is the
    // news; the rest would be the same news again, louder. An approval
    // is exempt, because it is the one thing that is always worth saying.
    const now = Date.now();
    const previous = lastBanner.current.get(threadId) ?? 0;
    if (!notice.urgent && now - previous < 4000) return;
    lastBanner.current.set(threadId, now);
    if (bot?.avatarAt) notice.avatar = `/api/bots/${bot.id}/avatar?v=${bot.avatarAt}`;
    void bridge.notifyShow(notice).catch(() => {});
  }, []);

  // "Add to Bloks" on the website: a gallery team opens in the hire
  // review (NewRoomDialog), whether the app was running or not.
  useEffect(() => {
    const bridge = window.bloks;
    if (!bridge?.onLink) return;
    const open = (link: { kind?: string; slug?: string } | null) => {
      if (link?.kind === "team" && link.slug) rawDispatch({ type: "openTeamLink", slug: link.slug });
    };
    void bridge.pendingLink?.().then(open).catch(() => {});
    return bridge.onLink(open);
  }, []);

  // Clicking a banner opens what it was about.
  useEffect(() => {
    const bridge = window.bloks;
    if (!bridge?.onNotifyActivate) return;
    return bridge.onNotifyActivate(({ target }) => {
      if (target) rawDispatch({ type: "select", id: target });
    });
  }, []);

  useEffect(() => {
    let alive = true;
    const loadAll = () => {
      api("/api/bots")
        .then(({ bots }) => alive && rawDispatch({ type: "hydrate", bots }))
        .catch(() => {});
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
      if (typeof frame._seq === "number") lastSeq = frame._seq;
      switch (frame.kind) {
        case "hello":
          // Everything up to the server's current sequence is either
          // already ours or about to be replayed to catch us up. Neither
          // is news: a laptop opened after an hour should not fire an
          // hour of banners.
          replayUntil.current = typeof frame._seq === "number" ? frame._seq : 0;
          if (!frame.resumed) {
            // a server that could not resume may have restarted and begun
            // counting again, so its sequences say nothing about ours
            botSeq.current.clear();
            loadAll();
          }
          break;
        case "message": {
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          // agents that opted in read their settled replies aloud, even
          // when their chat is not the one on screen
          const msg = frame.message;
          if (msg?.role === "bot" && msg.kind === "text" && msg.text) {
            const owner = stateRef.current.bots.find((b) =>
              b.tasks?.some((t) => t.id === frame.threadId),
            );
            if (owner) maybeAutoSpeak(owner, msg.text);
          }
          if (typeof frame._seq !== "number" || frame._seq > replayUntil.current) {
            announce(frame.threadId, msg);
          }
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "rehearsals":
          rawDispatch({ type: "rehearsalsChanged" });
          break;
        case "profile":
        case "brief":
        case "watchers":
        case "meetings":
          rawDispatch({ type: "tick", key: frame.kind });
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // an unread badge on the conversation already open is wrong the
          // moment it arrives; another lane that pinged stays unread
          if (bot.id === stateRef.current.selectedId && bot.threadId && openLaneUnread(bot as Bot)) {
            Object.assign(bot, readOpenLane(bot as Bot));
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          if (typeof frame._seq === "number") botSeq.current.set(bot.id, frame._seq);
          rawDispatch({ type: "botPatched", bot: withoutEdits(bot, editing(bot.id)) });
          break;
        }
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta" && event.streamKind === "assistant_text") {
            rawDispatch({ type: "streamDelta", threadId: event.threadId, delta: event.delta });
          } else if (event.type === "turn.started") {
            rawDispatch({ type: "turnStarted", threadId: event.threadId });
          } else if (event.type === "turn.completed") {
            // The streamed text stays until its message lands and takes its
            // place: through the relay the message can come after the end
            // of the turn, and clearing now left a gap where the reply was.
            // A turn that ended with no message of its own lets go shortly.
            rawDispatch({ type: "turnSettled", threadId: event.threadId });
            const threadId = event.threadId;
            setTimeout(() => rawDispatch({ type: "streamClear", threadId, onlyIfSettled: true }), STREAM_LINGER_MS);
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
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "blok":
          rawDispatch({ type: "blokPatched", blok: frame.blok });
          break;
        case "blok.deleted":
          rawDispatch({ type: "blokDeleted", blokId: frame.blokId });
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
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // credentials changed and the engines were rebuilt, so the
        // picker needs to hear that something became usable
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
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
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
  if (at >= midnight - 86_400_000) return "Yesterday";
  if (at >= midnight - 6 * 86_400_000) return then.toLocaleDateString([], { weekday: "short" });
  return then.toLocaleDateString([], { month: "short", day: "numeric" });
}
