// How an agent sounds, and the call you have with it.
//
// VoiceCard is the picker in agent settings: every voice the configured
// vendors offer, with a one-tap preview in the agent's own voice.
//
// CallOverlay is the call itself: a loop of listen → think → speak.
// Your words go through speech recognition and become an ordinary turn;
// the reply comes back as ordinary text and is synthesized through the
// harness (which holds the vendor keys); when the audio ends, the mic
// opens again. The transcript is just the chat, a call leaves the same
// record a typed conversation would.
import { useCallback, useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Mic from "lucide-react/dist/esm/icons/mic.mjs";
import Phone from "lucide-react/dist/esm/icons/phone.mjs";
import PhoneOff from "lucide-react/dist/esm/icons/phone-off.mjs";
import Volume2 from "lucide-react/dist/esm/icons/volume-2.mjs";
import { api, useStore, type Bot, type Message } from "@/state/store";
import { BLOK_COLORS, type BlokColor } from "@/lib/mascot";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { routeSpokenToRoom } from "@/lib/spokenRouting";

interface VoiceOption {
  provider: "elevenlabs" | "openai";
  id: string;
  name: string;
}

const PREVIEW_LINE = "Hi, this is how I sound. Ready when you are.";

async function fetchSpeech(botId: string, text?: string): Promise<HTMLAudioElement> {
  const res = await fetch(`/api/bots/${botId}/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "speech failed");
  const url = URL.createObjectURL(await res.blob());
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
      body: JSON.stringify({ targetId, device: "this Mac" }),
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
  const configured = state.config?.speech?.elevenlabs || state.config?.speech?.openai;

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
    fetchSpeech(bot.id, PREVIEW_LINE)
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
          <div className="text-[13.5px] font-semibold text-foreground">Voice</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
            {!configured
              ? "Add an ElevenLabs or OpenAI key in Settings → Voices first."
              : bot.voice
                ? `Speaks as ${bot.voice.name ?? bot.voice.id} · calls enabled`
                : "Pick a voice to enable calls with this agent."}
          </div>
        </div>
        <span className="text-[12px] text-muted-foreground">{open ? "Hide" : "Choose"}</span>
      </button>

      {open && (
        <div className="mt-3">
          {bot.voice && (
            <div className="mb-2 flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={preview} disabled={previewing}>
                <Volume2 size={13} />
                {previewing ? "Playing…" : "Preview"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => choose(null)}>
                Remove voice
              </Button>
              <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={bot.speakReplies ?? false}
                  onChange={(e) =>
                    api(`/api/bots/${bot.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ speakReplies: e.target.checked }),
                    }).catch(() => {})
                  }
                  className="accent-[--brand]"
                />
                Read replies aloud
              </label>
            </div>
          )}
          <div className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto">
            {voices === null && !error && (
              <div className="py-3 text-[12.5px] text-muted-foreground">Loading voices…</div>
            )}
            {voices?.length === 0 && (
              <div className="py-3 text-[12.5px] text-muted-foreground">
                No voices available. Check your keys in Settings → Voices.
              </div>
            )}
            {(voices ?? []).map((voice) => {
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
                  <span className="flex-1 truncate text-[13px] font-medium text-foreground">
                    {voice.name}
                  </span>
                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {voice.provider === "elevenlabs" ? "11L" : "OpenAI"}
                  </span>
                </button>
              );
            })}
          </div>
          {error && <div className="mt-2 text-[12px] text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}

type CallState = "listening" | "transcribing" | "thinking" | "speaking" | "idle";

/** Start speech recognition with whatever this platform has: the
 * browser engine (endpoints on silence, hands-free), else the desktop
 * dictation bridge (tap-to-finish). Returns a stop handle, or null when
 * neither exists. */
function startRecognition(handlers: {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onSilence: () => void;
  onError: (message: string) => void;
}): { stop: () => void; needsManualFinish: boolean } | null {
  const Recognition =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const bridge = (window as any).bloks;
  if (Recognition) {
    const recog = new Recognition();
    recog.continuous = false;
    recog.interimResults = true;
    recog.onresult = (event: any) => {
      const result = event.results[event.results.length - 1];
      handlers.onPartial(result[0].transcript);
      if (result.isFinal) {
        recog.stop();
        handlers.onFinal(result[0].transcript);
      }
    };
    recog.onerror = (event: any) => {
      if (event.error === "no-speech") handlers.onSilence();
      else handlers.onError(`microphone: ${event.error}`);
    };
    recog.start();
    return { stop: () => recog.stop(), needsManualFinish: false };
  }
  if (bridge?.speechStart) {
    const offTranscript = bridge.onSpeechTranscript((line: { text?: string }) => {
      if (typeof line.text === "string") handlers.onPartial(line.text);
    });
    void bridge.speechStart();
    return {
      stop: () => {
        offTranscript?.();
        void bridge.speechStop?.();
      },
      needsManualFinish: true,
    };
  }
  handlers.onError("No microphone input is available here.");
  return null;
}



/**
 * The call. Speech recognition prefers the browser engine (it endpoints
 * on silence, which is what makes the loop hands-free); inside the
 * desktop shell it falls back to the native dictation bridge with a
 * tap-to-finish control.
 */
export function CallOverlay({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { dispatch } = useStore();
  const [callState, setCallState] = useState<CallState>("idle");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recogRef = useRef<any>(null);
  const baselineCount = useRef(bot.messages.length);
  const live = useRef(true);
  const botRef = useRef(bot);
  botRef.current = bot;

  const [needsManualFinish, setNeedsManualFinish] = useState(false);
  const heardRef = useRef("");

  const stopAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
  };

  const listen = useCallback(() => {
    if (!live.current) return;
    setHeard("");
    heardRef.current = "";
    setError(null);
    setCallState("listening");
    const session = startRecognition({
      onPartial: (text) => {
        setHeard(text);
        heardRef.current = text;
      },
      onFinal: (text) => finishUtterance(text),
      onSilence: () => listen(),
      onError: (message) => setError(message),
    });
    recogRef.current = session;
    setNeedsManualFinish(Boolean(session?.needsManualFinish));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      recogRef.current?.stop?.();
      stopAudio();
      lease.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listen]);

  const hangUp = () => {
    live.current = false;
    recogRef.current?.stop?.();
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
      ? heard || "Listening…"
      : callState === "thinking"
        ? "Thinking…"
        : callState === "speaking"
          ? "Speaking"
          : "";

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <span className="absolute right-5 top-5 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-warning">
        Beta
      </span>
      <div className="flex flex-col items-center gap-5">
        <div
          className={cn(
            "rounded-full p-2 transition-shadow duration-500",
            callState === "listening" && "shadow-[0_0_0_10px_color-mix(in_srgb,var(--brand)_14%,transparent)]",
            callState === "speaking" && "call-speaking-ring",
          )}
          style={{ "--ring-tint": BLOK_COLORS[bot.color as BlokColor] } as React.CSSProperties}
        >
          <AgentAvatar bot={bot} size={132} />
        </div>
        <div className="text-center">
          <div className="text-[19px] font-semibold text-foreground">{bot.name}</div>
          <div className="mt-1 min-h-[20px] max-w-[340px] px-4 text-[13.5px] text-muted-foreground">
            {error ?? stateLabel}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4">
          {callState === "speaking" && (
            <button
              onClick={bargeIn}
              title="Interrupt and talk"
              className="flex size-14 items-center justify-center rounded-full border bg-card text-foreground shadow-sm transition-transform active:scale-95"
            >
              <Mic size={20} />
            </button>
          )}
          {needsManualFinish && callState === "listening" && (
            <Button
              variant="secondary"
              onClick={() => {
                recogRef.current?.stop?.();
                finishUtterance(heardRef.current);
              }}
            >
              Done talking
            </Button>
          )}
          <button
            onClick={hangUp}
            title="End call"
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
        title={`Call ${bot.name}`}
        aria-label={`Call ${bot.name}`}
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
  const [callState, setCallState] = useState<CallState>("idle");
  const [heard, setHeard] = useState("");
  const [caption, setCaption] = useState("");
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsManualFinish, setNeedsManualFinish] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recogRef = useRef<{ stop: () => void } | null>(null);
  const heardRef = useRef("");
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
    heardRef.current = "";
    setSpeakingId(null);
    setError(null);
    setCallState("listening");
    callStateRef.current = "listening";
    const session = startRecognition({
      onPartial: (text) => {
        setHeard(text);
        heardRef.current = text;
      },
      onFinal: (text) => finishUtterance(text),
      onSilence: () => listen(),
      onError: (message) => setError(message),
    });
    recogRef.current = session;
    setNeedsManualFinish(Boolean(session?.needsManualFinish));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          setCaption(`${speaker?.name ?? "Agent"}: ${message.text!.slice(0, 120)}`);
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
      recogRef.current?.stop?.();
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
    recogRef.current?.stop?.();
    stopAudio();
    onClose();
  };

  const stateLabel =
    callState === "listening"
      ? heard || "Listening. Say a name or just talk."
      : callState === "thinking"
        ? "The room is thinking…"
        : caption;

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <span className="absolute right-5 top-5 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-warning">
        Beta
      </span>
      <div className="flex flex-col items-center gap-6">
        <div className="flex items-end gap-3">
          {liveMembers.map((member) => {
            const focused = speakingId === member.id || (speakingId === null && member.busy);
            return (
              <div
                key={member.id}
                className={cn(
                  "flex flex-col items-center gap-1.5 transition-all duration-300",
                  focused ? "scale-110" : "opacity-70",
                )}
              >
                <div
                  className={cn("rounded-full", speakingId === member.id && "call-speaking-ring")}
                  style={{ "--ring-tint": BLOK_COLORS[member.color as BlokColor] } as React.CSSProperties}
                >
                  <AgentAvatar bot={member} size={focused ? 76 : 60} />
                </div>
                <span className="text-[11.5px] font-medium text-muted-foreground">{member.name}</span>
              </div>
            );
          })}
        </div>
        <div className="text-center">
          <div className="text-[18px] font-semibold text-foreground">{blok.name}</div>
          <div className="mt-1 min-h-[20px] max-w-[420px] px-4 text-[13.5px] text-muted-foreground">
            {error ?? stateLabel}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {callState === "speaking" && (
            <button
              onClick={interrupt}
              title="Interrupt and talk"
              className="flex size-14 items-center justify-center rounded-full border bg-card text-foreground shadow-sm transition-transform active:scale-95"
            >
              <Mic size={20} />
            </button>
          )}
          {needsManualFinish && callState === "listening" && (
            <Button
              variant="secondary"
              onClick={() => {
                recogRef.current?.stop?.();
                finishUtterance(heardRef.current);
              }}
            >
              Done talking
            </Button>
          )}
          <button
            onClick={hangUp}
            title="End call"
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
            ? `Call ${blok.name}`
            : `Call ${blok.name} (${members.length - voiced} member${members.length - voiced === 1 ? "" : "s"} without a voice will show as text)`
        }
        aria-label={`Call ${blok.name}`}
        onClick={() => setCalling(true)}
      >
        <Phone size={16} />
      </Button>
      {calling && <GroupCallOverlay blok={blok} members={members} onClose={() => setCalling(false)} />}
    </>
  );
}
