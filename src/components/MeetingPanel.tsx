// Meeting notes (server/meetings.ts): an agent listens in, and writes it
// up when you stop.
//
// Two ways to listen, whichever hears for this window (src/lib/hearing.ts).
// The page records the microphone and sends each stretch of speech, at a
// pause, to whoever hears for the workspace (src/lib/listen.ts); that
// works in any browser and in the app. Or, in the Mac app with the Mac
// chosen, the native helper hears on device, you and, when asked, the
// other side of the call. Either way only text is kept: no audio is
// saved anywhere. When you stop, the agent writes a summary, the
// decisions and the action items in its Meetings lane, and an item that
// belongs to one of your agents can be handed to it from here with one
// press.
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines } from "@/components/icons";
import { CircleStop } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Send } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { formatDate, t, type MessageKey } from "@/lib/i18n";
import { MEETING_PAUSES, NoWords } from "@/lib/hearing";
import { heardBy, missingText, troubleText, useEars } from "@/lib/hearingWords";
import { SpeechRecorder, TroubleError, openMicrophone, transcribeClip } from "@/lib/listen";

interface Item {
  owner: string;
  botId?: string;
  text: string;
  sentAt?: number;
}
interface MeetingRow {
  id: string;
  botId: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  laneId?: string;
  items?: Item[];
  heard: number;
}
interface Line {
  who: "you" | "them";
  text: string;
}

const NOTICE: Record<string, MessageKey> = {
  "system-sound-unavailable": "meetingPanel.notice.systemSoundUnavailable",
  "system-sound-needs-macos-13": "meetingPanel.notice.systemSoundNeedsMacos13",
  "system-sound-stopped": "meetingPanel.notice.systemSoundStopped",
};
const ERROR: Record<string, MessageKey> = {
  "speech-not-authorized": "meetingPanel.error.speechNotAuthorized",
  "recognizer-unavailable": "meetingPanel.error.recognizerUnavailable",
  "mic-failed": "meetingPanel.error.micFailed",
};

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function Items({ meeting, onChanged }: { meeting: MeetingRow; onChanged: () => void }) {
  const { state } = useStore();
  const [error, setError] = useState<string | null>(null);
  if (!meeting.items?.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {meeting.items.map((item, i) => {
        const agent = item.botId ? state.bots.find((b) => b.id === item.botId) : undefined;
        return (
          <div key={i} className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-body">
            <span className="shrink-0 font-medium text-foreground">{item.owner}</span>
            <span className="min-w-0 flex-1 text-muted-foreground">{item.text}</span>
            {agent &&
              (item.sentAt ? (
                <span className="shrink-0 text-small text-muted-foreground">{t("meetingPanel.handedOver")}</span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    api(`/api/meetings/${meeting.id}/items/${i}/send`, { method: "POST" })
                      .then(onChanged)
                      .catch((e: Error) => setError(e.message))
                  }
                >
                  <Send size={12} /> {t("meetingPanel.handTo", { name: agent.name })}
                </Button>
              ))}
          </div>
        );
      })}
      {error && <div className="text-small text-destructive">{error}</div>}
    </div>
  );
}

/** The page's own listening while a meeting runs: the recorder, the
 * microphone it records, and the stretches still being written down. */
interface PageListening {
  recorder: SpeechRecorder;
  stream: MediaStream;
  /** Every stretch, written down in the order it was said. */
  written: Promise<void>;
}

export function MeetingPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const bridge = window.bloks;
  const { ears, macApp } = useEars();
  const available = ears.kind !== "none";
  const onMac = ears.kind === "mac";
  const [title, setTitle] = useState("");
  const [system, setSystem] = useState(true);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState<Line | null>(null);
  const [writing, setWriting] = useState(0);
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [past, setPast] = useState<MeetingRow[]>([]);
  const pending = useRef<Array<{ at: number; who: "you" | "them"; text: string }>>([]);
  const page = useRef<PageListening | null>(null);
  const close = () => dispatch({ type: "openMeeting", botId: null });

  const load = useCallback(() => {
    api("/api/meetings")
      .then((r) => setPast((r.meetings ?? []).filter((m: MeetingRow) => m.botId === bot.id)))
      .catch(() => {});
  }, [bot.id]);
  useEffect(load, [load, state.ticks.meetings]);

  const flush = useCallback(async (id: string) => {
    const batch = pending.current.splice(0);
    if (batch.length) await api(`/api/meetings/${id}/segments`, { method: "POST", body: JSON.stringify({ segments: batch }) });
  }, []);

  // what was heard goes to the server every few seconds while it runs
  useEffect(() => {
    if (!meetingId) return;
    const timer = setInterval(() => void flush(meetingId).catch(() => {}), 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
    };
  }, [meetingId, flush]);

  // what the Mac's helper hears, while a meeting runs on it
  useEffect(() => {
    if (!meetingId || !onMac || !bridge?.onMeetingLine) return;
    const deafness = new NoWords();
    const offLine = bridge.onMeetingLine((line) => {
      if (typeof line.level === "number") {
        setLevel(line.level);
        deafness.level(line.level, Date.now());
        if (deafness.deaf) setNotice((shown) => shown ?? t("hearing.trouble.deaf"));
      }
      if (line.notice) setNotice(NOTICE[line.notice] ? t(NOTICE[line.notice]) : null);
      // a code we have no words for is shown as the helper said it
      if (line.error) setError(ERROR[line.error] ? t(ERROR[line.error]) : line.error);
      if (line.partial && line.text && line.who) {
        deafness.heardWords();
        setPartial({ who: line.who, text: line.text });
      }
      if (line.segment && line.who) {
        deafness.heardWords();
        pending.current.push({ at: Date.now(), who: line.who, text: line.segment });
        setLines((prev) => [...prev, { who: line.who!, text: line.segment! }].slice(-200));
        setPartial((p) => (p?.who === line.who ? null : p));
      }
    });
    const offEnd = bridge.onMeetingEnd?.(() => setLevel(0));
    return () => {
      offLine();
      offEnd?.();
    };
  }, [meetingId, onMac, bridge]);

  // a panel that goes away takes the microphone with it
  useEffect(
    () => () => {
      page.current?.recorder.close();
      page.current?.stream.getTracks().forEach((track) => track.stop());
      page.current = null;
    },
    [],
  );

  /** The page's microphone, cut at the pauses, each stretch written down
   * in turn so the lines stay in the order they were said. */
  const listenInPage = async () => {
    const stream = await openMicrophone("meeting");
    const listening: PageListening = { stream, written: Promise.resolve(), recorder: null as unknown as SpeechRecorder };
    listening.recorder = new SpeechRecorder(stream, MEETING_PAUSES, true, {
      onLevel: setLevel,
      onClip: (clip, at) => {
        setWriting((n) => n + 1);
        listening.written = listening.written.then(async () => {
          try {
            const text = await transcribeClip(clip);
            if (!text) return;
            pending.current.push({ at, who: "you", text });
            setLines((prev) => [...prev, { who: "you" as const, text }].slice(-200));
            setError(null);
          } catch (e) {
            // the meeting goes on; the next stretch may well be heard
            setError(e instanceof TroubleError ? troubleText(e.trouble) : String(e));
          } finally {
            setWriting((n) => n - 1);
          }
        });
      },
    });
    listening.recorder.start();
    page.current = listening;
  };

  const start = async () => {
    setError(null);
    setNotice(null);
    setLines([]);
    setStarting(true);
    let id: string | null = null;
    try {
      const r = await api("/api/meetings", { method: "POST", body: JSON.stringify({ botId: bot.id, title, system: onMac && system }) });
      id = r.meeting.id as string;
      if (onMac) await bridge?.meetingStart?.({ system });
      else await listenInPage();
      setMeetingId(id);
      setStartedAt(Date.now());
    } catch (e) {
      // a meeting nobody could listen to is not kept as an empty one
      if (id) void api(`/api/meetings/${id}`, { method: "DELETE" }).catch(() => {});
      setError(e instanceof TroubleError ? troubleText(e.trouble) : (e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!meetingId) return;
    setStopping(true);
    if (onMac) {
      await bridge?.meetingStop?.();
      // the helper finishes its last sentence before it exits
      await new Promise((r) => setTimeout(r, 1800));
    } else if (page.current) {
      const listening = page.current;
      // the last stretch is still being said: it is sent, and waited for
      await listening.recorder.finish();
      await listening.written;
      listening.recorder.close();
      listening.stream.getTracks().forEach((track) => track.stop());
      page.current = null;
      setLevel(0);
    }
    try {
      await flush(meetingId);
      const r = await api(`/api/meetings/${meetingId}/end`, { method: "POST" });
      setMeetingId(null);
      setPartial(null);
      load();
      if (r.laneId) {
        dispatch({ type: "selectTask", botId: bot.id, taskId: r.laneId });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const recording = Boolean(meetingId);
  const who = heardBy(ears);

  return (
    <div className="absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60" onClick={recording ? undefined : close}>
      <div
        className="flex max-h-[84%] w-[640px] max-w-[94vw] animate-pop-in flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl shadow-(color:--shadow-color)"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("meetingPanel.meetingNotes")}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-title font-semibold text-foreground">
              <AudioLines size={17} className="text-muted-foreground" /> {t("meetingPanel.meetingNotes")}
            </div>
            <div className="mt-0.5 text-body text-muted-foreground">
              {onMac ? t("meetingPanel.listensOnThisMac", { name: bot.name }) : t("meetingPanel.listensThroughTheMicrophone", { name: bot.name })}
            </div>
          </div>
          {!recording && (
            <Button variant="ghost" size="icon-sm" aria-label={t("common.close")} onClick={close}>
              <X size={16} />
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!available ? (
            <div className="px-4 py-10 text-center text-body text-muted-foreground">
              {ears.kind === "none" && missingText(ears.missing)}
            </div>
          ) : recording ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/60" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
                </span>
                <span className="font-mono text-body tabular-nums text-foreground">{clock(now - startedAt)}</span>
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className="h-full rounded-full bg-success transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
                {who && <span className="ml-auto truncate text-small text-muted-foreground">{who}</span>}
              </div>
              {notice && <div className="rounded-lg bg-warning/10 px-3 py-2 text-body text-warning">{notice}</div>}
              <div
                aria-live="polite"
                className="flex max-h-[320px] min-h-[120px] flex-col gap-1.5 overflow-y-auto rounded-xl border bg-muted/30 p-3 text-body leading-relaxed"
              >
                {lines.length === 0 && !partial && !writing && (
                  <span className="text-muted-foreground">
                    {onMac ? t("meetingPanel.listeningWordsAppearHereAs") : t("meetingPanel.listeningWordsAppearAfterPauses")}
                  </span>
                )}
                {lines.map((line, i) => (
                  <div key={i}>
                    <span className={cn("mr-1.5 font-medium", line.who === "you" ? "text-foreground" : "text-brand-ink")}>
                      {line.who === "you" ? t("meetingPanel.you") : t("meetingPanel.them")}
                    </span>
                    <span className="text-foreground">{line.text}</span>
                  </div>
                ))}
                {partial && (
                  <div className="text-muted-foreground">
                    <span className="mr-1.5 font-medium">{partial.who === "you" ? t("meetingPanel.you") : t("meetingPanel.them")}</span>
                    {partial.text}
                  </div>
                )}
                {writing > 0 && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 size={12} className="animate-spin" /> {t("meetingPanel.writingDown")}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("meetingPanel.meetingNameOptional")} className="text-body" />
              {onMac ? (
                <label className="flex items-center justify-between gap-3 text-body text-foreground">
                  <span>
                    {t("meetingPanel.hearTheOtherSideToo")}
                    <span className="block text-small text-muted-foreground">
                      {t("meetingPanel.fromZoomMeetAndOther")}
                    </span>
                  </span>
                  <Switch checked={system} onCheckedChange={setSystem} aria-label={t("meetingPanel.hearTheCall")} />
                </label>
              ) : (
                <p className="text-pretty text-small leading-relaxed text-muted-foreground">
                  {macApp ? t("meetingPanel.onlyYourMicrophoneMac") : t("meetingPanel.onlyYourMicrophone")}
                </p>
              )}
              {who && <p className="text-small text-muted-foreground">{who}</p>}
              {past.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1.5 text-small font-medium text-muted-foreground">{t("meetingPanel.earlier")}</div>
                  <div className="flex flex-col gap-3">
                    {past.slice(0, 5).map((m) => (
                      <div key={m.id} className="rounded-xl border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 truncate text-body font-medium text-foreground">{m.title || t("meetingPanel.aMeeting")}</div>
                          <div className="shrink-0 text-small text-muted-foreground">
                            {formatDate(m.startedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          </div>
                        </div>
                        {m.laneId && !m.items && (
                          <div className="mt-1 flex items-center gap-1.5 text-small text-muted-foreground">
                            <Loader2 size={12} className="animate-spin" /> {t("meetingPanel.writingTheNotes")}
                          </div>
                        )}
                        <Items meeting={m} onChanged={load} />
                        {m.laneId && (
                          <button
                            onClick={() => {
                              dispatch({ type: "selectTask", botId: bot.id, taskId: m.laneId! });
                              close();
                            }}
                            className="mt-2 text-small text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {t("meetingPanel.readTheNotes")}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {error && (
            <div role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-body text-destructive">
              {error}
            </div>
          )}
        </div>

        {available && (
          <div className="flex justify-end border-t px-5 py-3">
            {recording ? (
              <Button variant="destructive" disabled={stopping} onClick={() => void stop()}>
                {stopping ? <Loader2 size={14} className="animate-spin" /> : <CircleStop size={14} />} {t("meetingPanel.stopAndWriteItUp")}
              </Button>
            ) : (
              <Button disabled={starting} onClick={() => void start()}>
                {starting ? <Loader2 size={14} className="animate-spin" /> : <AudioLines size={14} />} {t("meetingPanel.startListening")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
