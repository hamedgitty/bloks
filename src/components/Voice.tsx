// How an agent sounds, and the call you have with it.
//
// VoiceCard is the picker in agent settings: every voice the configured
// vendors offer, one vendor at a time, with a one-tap preview in the
// agent's own voice.
//
// CallOverlay is the call itself: a loop of listen → think → speak.
// Your words are recorded in the page and written down by whoever hears
// for the workspace (src/lib/listen.ts), or by the Mac's own recognizer,
// and become an ordinary turn; the reply comes back as ordinary text and
// is synthesized through the harness (which holds the vendor keys); when
// the audio ends, the mic opens again. The transcript is just the chat,
// a call leaves the same record a typed conversation would.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "@/components/icons";
import { Mic } from "@/components/icons";
import { Phone } from "@/components/icons";
import { PhoneOff } from "@/components/icons";
import { Volume2 } from "@/components/icons";
import { api, useStore, type Bot, type Message, type VoiceProvider } from "@/state/store";
import { BLOK_COLORS, type BlokColor } from "@/lib/mascot";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { routeSpokenToRoom } from "@/lib/spokenRouting";
import { thisComputer } from "@/lib/thisComputer";
import { t } from "@/lib/i18n";
import { callEars, type CallEars } from "@/lib/listen";
import { heardBy, troubleText, useEars } from "@/lib/hearingWords";

interface VoiceOption {
  provider: VoiceProvider;
  id: string;
  name: string;
}

/** Each vendor as the picker names it, in the order the server lists
 * them: the ones somebody set up first, the Mac's own last. Product
 * names, the same in every language. */
const PROVIDERS: Array<[VoiceProvider, string]> = [
  ["elevenlabs", "ElevenLabs"],
  ["openai", "OpenAI"],
  ["fish", "Fish Audio"],
  ["xai", "xAI"],
  ["chatterbox", "Chatterbox"],
  ["system", "Mac"],
];


async function fetchSpeech(botId: string, text?: string): Promise<HTMLAudioElement> {
  const res = await fetch(`/api/bots/${botId}/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? t("voice.speechFailed"));
  const clip = await res.blob();
  // anything but sound (a page, an empty answer) would only reach the
  // player as "no supported source", which names nothing to fix
  if (!clip.size || !/^audio\//.test(clip.type)) throw new Error(t("voice.noSoundCameBack"));
  const url = URL.createObjectURL(clip);
  const audio = new Audio(url);
  audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  return audio;
}

/** The call lease: one device on the line at a time, workspace-wide.
 * Claim before the mic opens; renew on a timer; release on hang-up. A
 * claim that fails names the device already talking. */
export async function claimCall(targetId: string): Promise<
  { ok: true; token: string; stop: () => void } | { ok: false; reason: string }
> {
  try {
    const r = await api("/api/calls/claim", {
      method: "POST",
      body: JSON.stringify({ targetId, device: thisComputer() }),
    });
    const token: string = r.token;
    const timer = setInterval(() => {
      api("/api/calls/renew", { method: "POST", body: JSON.stringify({ token }) }).catch(() => {});
    }, Math.max(4000, (r.ttlMs ?? 20000) / 3));
    return {
      ok: true,
      token,
      stop: () => {
        clearInterval(timer);
        void api("/api/calls", { method: "DELETE", body: JSON.stringify({ token }) }).catch(
          () => {},
        );
      },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** True while a call owns the speaker and the mic. */
let callActive = false;
export function setCallActive(on: boolean) {
  callActive = on;
}

let autoAudio: HTMLAudioElement | null = null;

/** A settled reply read aloud, when its agent opted in. One clip at a
 * time; a newer reply replaces an older one still playing; calls own
 * the speaker outright. */
export function maybeAutoSpeak(
  bot: { id: string; voice?: unknown; speakReplies?: boolean },
  text: string,
) {
  if (!bot.speakReplies || !bot.voice || callActive) return;
  autoAudio?.pause();
  fetchSpeech(bot.id, text)
    .then((audio) => {
      if (callActive) return;
      autoAudio = audio;
      return audio.play();
    })
    .catch(() => {});
}

/** The voice picker card in agent settings. */
export function VoiceCard({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [shown, setShown] = useState<VoiceProvider | null>(null);
  const speech = state.config?.speech;
  const configured =
    speech?.elevenlabs || speech?.openai || speech?.fish || speech?.xai || speech?.chatterbox || speech?.system;
  // one vendor's voices at a time: a Fish Audio list alone can run to a
  // hundred, and the others would scroll out of reach under it
  const offered = PROVIDERS.filter(([provider]) => voices?.some((v) => v.provider === provider));
  const current =
    (shown && offered.some(([p]) => p === shown) ? shown : null) ??
    (bot.voice && offered.some(([p]) => p === bot.voice!.provider) ? bot.voice.provider : null) ??
    offered[0]?.[0] ??
    null;
  const listed = (voices ?? []).filter((v) => v.provider === current);

  useEffect(() => {
    if (!open || voices !== null) return;
    api("/api/speech/voices")
      .then((r) => setVoices(r.voices ?? []))
      .catch((e: Error) => setError(e.message));
  }, [open, voices]);

  const choose = (voice: VoiceOption | null) => {
    setError(null);
    api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ voice } ) }).catch(
      (e: Error) => setError(e.message),
    );
  };

  const preview = () => {
    if (previewing) return;
    setPreviewing(true);
    // heard in the reader's own language, like everything else they read
    fetchSpeech(bot.id, t("voice.previewLine"))
      .then((audio) => {
        audio.addEventListener("ended", () => setPreviewing(false), { once: true });
        return audio.play();
      })
      .catch((e: Error) => {
        setError(e.message);
        setPreviewing(false);
      });
  };

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(!open)}>
        <div>
          <div className="text-ui font-semibold text-foreground">{t("voice.voice")}</div>
          <div className="mt-0.5 text-body text-muted-foreground">
            {!configured
              ? t("voice.addAVoiceKeyOr")
              : bot.voice
                ? t("voice.speaksAs", { voice: bot.voice.name ?? bot.voice.id })
                : t("voice.pickAVoiceToCall")}
          </div>
        </div>
        <span className="text-small text-muted-foreground">{open ? t("common.hide") : t("voice.choose")}</span>
      </button>

      {open && (
        <div className="mt-3">
          {bot.voice && (
            <div className="mb-2 flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={preview} disabled={previewing}>
                <Volume2 size={13} />
                {previewing ? t("voice.playing") : t("common.preview")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => choose(null)}>
                {t("voice.removeVoice")}
              </Button>
              <label className="ml-auto flex items-center gap-1.5 text-small text-muted-foreground">
                <input
                  type="checkbox"
                  checked={bot.speakReplies ?? false}
                  onChange={(e) =>
                    api(`/api/bots/${bot.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ speakReplies: e.target.checked }),
                    }).catch(() => {})
                  }
                  className="accent-(--brand)"
                />
                {t("voice.readRepliesAloud")}
              </label>
            </div>
          )}
          {offered.length > 1 && (
            <div role="tablist" aria-label={t("voice.voicesFrom")} className="mb-2 flex flex-wrap gap-1">
              {offered.map(([provider, label]) => (
                <button
                  key={provider}
                  type="button"
                  role="tab"
                  aria-selected={current === provider}
                  onClick={() => setShown(provider)}
                  className={cn(
                    "h-7 rounded-full px-3 text-small font-medium transition-colors duration-150",
                    current === provider ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div role={offered.length > 1 ? "tabpanel" : undefined} className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto">
            {voices === null && !error && (
              <div className="py-3 text-body text-muted-foreground">{t("voice.loadingVoices")}</div>
            )}
            {voices?.length === 0 && (
              <div className="py-3 text-body text-muted-foreground">
                {t("voice.noVoicesAvailableCheckYour")}
              </div>
            )}
            {listed.map((voice) => {
              const active = bot.voice?.provider === voice.provider && bot.voice?.id === voice.id;
              return (
                <button
                  key={`${voice.provider}:${voice.id}`}
                  onClick={() => choose(voice)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150",
                    active ? "bg-brand-soft" : "hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full",
                      active ? "bg-brand-ink text-brand-foreground" : "border",
                    )}
                  >
                    {active && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span className="flex-1 truncate text-body font-medium text-foreground">
                    {voice.name}
                  </span>
                  {offered.length <= 1 && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-micro uppercase tracking-wide text-muted-foreground">
                      {PROVIDERS.find(([p]) => p === voice.provider)?.[1] ?? voice.provider}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {error && <div className="mt-2 text-small text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}

type CallState = "listening" | "transcribing" | "thinking" | "speaking" | "idle";

/** Who is hearing the call, under the state line: a call says plainly
 * where your voice goes. */
function HeardBy({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="mt-1.5 text-small text-muted-foreground">{text}</div>;
}

/** The round button that opens the mic again: to barge in while the
 * agent speaks, or to try again after something went wrong. */
function TalkButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex size-14 items-center justify-center rounded-full border bg-card text-foreground shadow-sm transition-transform active:scale-95"
    >
      <Mic size={20} />
    </button>
  );
}

/**
 * The call. What you say is recorded and written down when you pause,
 * which is what makes the loop hands-free; with the Mac's own recognizer
 * the words appear as you speak and a button says when you are done.
 */
export function CallOverlay({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { dispatch } = useStore();
  const { ears } = useEars();
  const [callState, setCallState] = useState<CallState>("idle");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const earsRef = useRef<CallEars | null>(null);
  const baselineCount = useRef(bot.messages.length);
  const live = useRef(true);
  const botRef = useRef(bot);
  botRef.current = bot;

  const [needsManualFinish, setNeedsManualFinish] = useState(false);

  const stopAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
  };

  const listen = useCallback(() => {
    if (!live.current) return;
    setHeard("");
    setError(null);
    setCallState("listening");
    earsRef.current?.listen();
  }, []);

  const finishUtterance = (text: string) => {
    const said = text.trim();
    if (!said) return listen();
    baselineCount.current = botRef.current.messages.length;
    setCallState("thinking");
    dispatch({ type: "send", botId: botRef.current.id, text: said });
  };

  // the reply lands as an ordinary message; when it does, it is spoken
  useEffect(() => {
    if (callState !== "thinking") return;
    const fresh = bot.messages.slice(baselineCount.current);
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text);
    if (!reply || bot.busy) return;
    setCallState("speaking");
    fetchSpeech(bot.id, reply.text)
      .then((audio) => {
        if (!live.current) return;
        audioRef.current = audio;
        audio.addEventListener("ended", () => live.current && listen(), { once: true });
        return audio.play();
      })
      .catch((e: Error) => {
        setError(e.message);
        if (live.current) listen();
      });
  }, [bot.messages, bot.busy, callState, bot.id, listen]);

  const lease = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    setCallActive(true);
    const callsEars = callEars(ears, {
      onPartial: setHeard,
      onHeard: (text) => live.current && finishUtterance(text),
      onTranscribing: () => setCallState("transcribing"),
      onTrouble: (trouble) => setError(troubleText(trouble)),
    });
    earsRef.current = callsEars;
    setNeedsManualFinish(callsEars.manualFinish);
    void claimCall(bot.id).then((claim) => {
      if (!claim.ok) {
        setError(claim.reason);
        return;
      }
      lease.current = claim;
      if (live.current) listen();
    });
    return () => {
      setCallActive(false);
      live.current = false;
      callsEars.close();
      stopAudio();
      lease.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listen]);

  const hangUp = () => {
    live.current = false;
    earsRef.current?.close();
    stopAudio();
    onClose();
  };

  /** Barge in: tap the mic while it speaks and it stops to hear you. */
  const bargeIn = () => {
    stopAudio();
    listen();
  };

  const stateLabel =
    callState === "listening"
      ? heard || t("voice.state.listening")
      : callState === "transcribing"
        ? t("voice.state.transcribing")
        : callState === "thinking"
          ? t("voice.state.thinking")
          : callState === "speaking"
            ? t("voice.state.speaking")
            : "";
  // after a trouble the mic is shut; the same button opens it again
  const stuck = Boolean(error) && lease.current !== null && (callState === "listening" || callState === "transcribing");

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <span className="absolute right-5 top-5 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-caption font-semibold uppercase tracking-wider text-warning">
        {t("voice.beta")}
      </span>
      <div className="flex flex-col items-center gap-5">
        <div
          className={cn(
            "rounded-full p-2 transition-shadow duration-500",
            callState === "listening" && !error && "shadow-[0_0_0_10px_color-mix(in_srgb,var(--brand)_14%,transparent)]",
            callState === "speaking" && "call-speaking-ring",
          )}
          style={{ "--ring-tint": BLOK_COLORS[bot.color as BlokColor] } as React.CSSProperties}
        >
          <AgentAvatar bot={bot} size={132} />
        </div>
        <div className="text-center">
          <div className="text-heading font-semibold text-foreground">{bot.name}</div>
          <div role="status" className="mt-1 min-h-[20px] max-w-[340px] px-4 text-ui text-muted-foreground">
            {error ?? stateLabel}
          </div>
          <HeardBy text={heardBy(ears)} />
        </div>

        <div className="mt-4 flex items-center gap-4">
          {callState === "speaking" && <TalkButton onClick={bargeIn} title={t("voice.interruptAndTalk")} />}
          {stuck && <TalkButton onClick={listen} title={t("voice.talkAgain")} />}
          {needsManualFinish && callState === "listening" && !error && (
            <Button variant="secondary" onClick={() => earsRef.current?.finish()}>
              {t("voice.doneTalking")}
            </Button>
          )}
          <button
            onClick={hangUp}
            title={t("voice.endCall")}
            aria-label={t("voice.endCall")}
            className="flex size-14 items-center justify-center rounded-full bg-destructive text-white shadow-md transition-transform active:scale-95"
          >
            <PhoneOff size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The header affordance: appears once the agent can actually speak. */
export function CallButton({ bot }: { bot: Bot }) {
  const [calling, setCalling] = useState(false);
  if (!bot.voice) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title={t("voice.call", { name: bot.name })}
        aria-label={t("voice.call", { name: bot.name })}
        onClick={() => setCalling(true)}
      >
        <Phone size={16} />
      </Button>
      {calling && <CallOverlay bot={bot} onClose={() => setCalling(false)} />}
    </>
  );
}



/**
 * A room on the line. The room's own turn engine decides who answers;
 * this overlay routes your spoken address ("Kat, …" → "@Kat …"), then
 * speaks each fresh reply in arrival order, each in its own member's
 * voice. Strictly one voice at a time, a FIFO, not a mixer, and the
 * mic reopens only when the queue drains and the room has gone quiet.
 * Members without a voice still answer; their replies show as text in
 * the caption instead of being spoken.
 */
export function GroupCallOverlay({
  blok,
  members,
  onClose,
}: {
  blok: { id: string; name: string; messages: Message[] };
  members: Bot[];
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const { ears } = useEars();
  const [callState, setCallState] = useState<CallState>("idle");
  const [heard, setHeard] = useState("");
  const [caption, setCaption] = useState("");
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsManualFinish, setNeedsManualFinish] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const earsRef = useRef<CallEars | null>(null);
  const baseline = useRef(blok.messages.length);
  const spoken = useRef(new Set<string>());
  const callStateRef = useRef<CallState>("idle");
  const botsRef = useRef(state.bots);
  botsRef.current = state.bots;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);
  const live = useRef(true);

  const liveMembers = state.bots.filter((b) => members.some((m) => m.id === b.id));
  const anyBusy = liveMembers.some((m) => m.busy);

  const stopAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
  };

  const listen = useCallback(() => {
    if (!live.current) return;
    setHeard("");
    setSpeakingId(null);
    setError(null);
    setCallState("listening");
    callStateRef.current = "listening";
    earsRef.current?.listen();
  }, []);

  const finishUtterance = (text: string) => {
    const said = text.trim();
    if (!said) return listen();
    baseline.current = blok.messages.length;
    setCallState("thinking");
    callStateRef.current = "thinking";
    dispatch({
      type: "sendToRoom",
      blokId: blok.id,
      text: routeSpokenToRoom(said, members.map((m) => m.name)),
    });
  };

  // every fresh settled reply queues in order, spoken in its own voice
  useEffect(() => {
    if (callState !== "thinking" && callState !== "speaking") return;
    const room = state.bloks.find((r) => r.id === blok.id);
    if (!room) return;
    const fresh = room.messages
      .slice(baseline.current)
      .filter((m) => m.role === "bot" && m.kind === "text" && m.text && !spoken.current.has(m.id));
    for (const message of fresh) {
      spoken.current.add(message.id);
      const speaker = liveMembers.find((b) => b.id === message.from);
      const gen = generation.current;
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          if (!live.current || gen !== generation.current) return;
          setCallState("speaking");
          callStateRef.current = "speaking";
          setSpeakingId(speaker?.id ?? null);
          setCaption(t("voice.caption", { name: speaker?.name ?? t("common.agent"), text: message.text!.slice(0, 120) }));
          if (speaker?.voice) {
            try {
              const audio = await fetchSpeech(speaker.id, message.text!);
              if (!live.current || gen !== generation.current) return;
              audioRef.current = audio;
              await new Promise<void>((resolve) => {
                audio.addEventListener("ended", () => resolve(), { once: true });
                audio.addEventListener("error", () => resolve(), { once: true });
                void audio.play().catch(() => resolve());
              });
            } catch {
              // one member's voice failing must not stall the call
            }
          } else {
            // voiceless members hold the floor long enough to be read
            await new Promise((r) => setTimeout(r, Math.min(4000, 1200 + message.text!.length * 25)));
          }
        });
    }
    // when the queue drains and nobody is working, the floor is yours;
    // guards read refs, because a queued check outlives its render
    const gen = generation.current;
    queue.current = queue.current.catch(() => {}).then(() => {
      if (!live.current || gen !== generation.current) return;
      if (callStateRef.current === "listening") return;
      const stillBusy = botsRef.current.some(
        (b) => members.some((m) => m.id === b.id) && b.busy,
      );
      if (!stillBusy) listen();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.bloks, state.bots, callState]);

  const lease = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    setCallActive(true);
    // the backlog is never recited: a call starts in the present
    for (const m of blok.messages) spoken.current.add(m.id);
    const callsEars = callEars(ears, {
      onPartial: setHeard,
      onHeard: (text) => live.current && finishUtterance(text),
      onTranscribing: () => {
        setCallState("transcribing");
        callStateRef.current = "transcribing";
      },
      onTrouble: (trouble) => setError(troubleText(trouble)),
    });
    earsRef.current = callsEars;
    setNeedsManualFinish(callsEars.manualFinish);
    void claimCall(blok.id).then((claim) => {
      if (!claim.ok) {
        setError(claim.reason);
        return;
      }
      lease.current = claim;
      if (live.current) listen();
    });
    return () => {
      setCallActive(false);
      live.current = false;
      generation.current += 1;
      callsEars.close();
      stopAudio();
      lease.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const interrupt = () => {
    generation.current += 1;
    queue.current = Promise.resolve();
    stopAudio();
    if (anyBusy) {
      for (const m of liveMembers.filter((b) => b.busy)) {
        dispatch({ type: "interrupt", botId: m.id });
      }
    }
    listen();
  };

  const hangUp = () => {
    live.current = false;
    generation.current += 1;
    earsRef.current?.close();
    stopAudio();
    onClose();
  };

  const stateLabel =
    callState === "listening"
      ? heard || t("voice.state.roomListening")
      : callState === "transcribing"
        ? t("voice.state.transcribing")
        : callState === "thinking"
          ? t("voice.state.roomThinking")
          : caption;
  const stuck = Boolean(error) && lease.current !== null && (callState === "listening" || callState === "transcribing");

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <span className="absolute right-5 top-5 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-caption font-semibold uppercase tracking-wider text-warning">
        {t("voice.beta")}
      </span>
      <div className="flex flex-col items-center gap-6">
        <div className="flex items-end gap-3">
          {liveMembers.map((member) => {
            const focused = speakingId === member.id || (speakingId === null && member.busy);
            return (
              <div
                key={member.id}
                className={cn(
                  "flex flex-col items-center gap-1.5 transition-[scale,opacity] duration-300 ease-out",
                  focused ? "scale-110" : "opacity-70",
                )}
              >
                <div
                  className={cn("rounded-full", speakingId === member.id && "call-speaking-ring")}
                  style={{ "--ring-tint": BLOK_COLORS[member.color as BlokColor] } as React.CSSProperties}
                >
                  <AgentAvatar bot={member} size={focused ? 76 : 60} />
                </div>
                <span className="text-small font-medium text-muted-foreground">{member.name}</span>
              </div>
            );
          })}
        </div>
        <div className="text-center">
          <div className="text-title font-semibold text-foreground">{blok.name}</div>
          <div role="status" className="mt-1 min-h-[20px] max-w-[420px] px-4 text-ui text-muted-foreground">
            {error ?? stateLabel}
          </div>
          <HeardBy text={heardBy(ears)} />
        </div>
        <div className="flex items-center gap-4">
          {callState === "speaking" && <TalkButton onClick={interrupt} title={t("voice.interruptAndTalk")} />}
          {stuck && <TalkButton onClick={listen} title={t("voice.talkAgain")} />}
          {needsManualFinish && callState === "listening" && !error && (
            <Button variant="secondary" onClick={() => earsRef.current?.finish()}>
              {t("voice.doneTalking")}
            </Button>
          )}
          <button
            onClick={hangUp}
            title={t("voice.endCall")}
            aria-label={t("voice.endCall")}
            className="flex size-14 items-center justify-center rounded-full bg-destructive text-white shadow-md transition-transform active:scale-95"
          >
            <PhoneOff size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The room header affordance: live once anyone in the room can speak. */
export function GroupCallButton({
  blok,
  members,
}: {
  blok: { id: string; name: string; messages: Message[] };
  members: Bot[];
}) {
  const [calling, setCalling] = useState(false);
  const voiced = members.filter((m) => m.voice).length;
  if (voiced === 0) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title={
          voiced === members.length
            ? t("voice.call", { name: blok.name })
            : t("voice.callSomeInText", { name: blok.name, count: members.length - voiced })
        }
        aria-label={t("voice.call", { name: blok.name })}
        onClick={() => setCalling(true)}
      >
        <Phone size={16} />
      </Button>
      {calling && <GroupCallOverlay blok={blok} members={members} onClose={() => setCalling(false)} />}
    </>
  );
}
