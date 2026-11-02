// Listening, for calls and meeting notes: the microphone recorded in the
// page, cut into stretches of speech at the pauses, and each stretch sent
// to the server to be written down (POST /api/speech/transcribe). Or, in
// the Mac app with the Mac chosen to hear, the native helper, which hears
// on device and sends words instead of sound.
//
// The browser's own speech recognition is not used. In the desktop app it
// has no service behind it and fails with "network", and in a browser it
// sends your voice to the browser maker, which is nobody the person chose.
//
// Nothing is kept. A stretch lives in memory until the server has its
// words, and silence is never sent anywhere: a stretch with no speech in
// it is thrown away where it was recorded.
import { CALL_PAUSES, NoWords, Pauses, loudness, type Ears, type HearingChoice, type PauseRules } from "./hearing";

/** Why listening could not start or carry on, as a code the screen says
 * in words (src/lib/hearingWords.ts); `message` is the server's own. */
export type Trouble =
  | { code: "insecure" | "no-mic" | "mic-denied" | "mic-busy" | "no-recorder" | "deaf" }
  | { code: "server"; message: string }
  | { code: "mac"; error: string }
  /** Nothing can hear: what was wanted and is not set up. */
  | { code: "nobody"; missing: HearingChoice };

export class TroubleError extends Error {
  readonly trouble: Trouble;
  constructor(trouble: Trouble) {
    super(trouble.code);
    this.trouble = trouble;
  }
}

/** The recording formats, best first: Opus where the browser has it, and
 * Safari's AAC otherwise. Every vendor and Whisper server takes all three. */
const FORMATS = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

/** Speech is small: this keeps a minute near a quarter of a megabyte,
 * which travels well through Bloks Cloud and costs nothing to hear. */
const BITS_PER_SECOND = 32_000;

/**
 * The microphone, or why not. A call wants echo cancelled, so the agent's
 * own voice is not heard back; a meeting does not, since the other side
 * of a call playing out loud is exactly what it is there to hear.
 */
export async function openMicrophone(kind: "call" | "meeting"): Promise<MediaStream> {
  if (typeof window !== "undefined" && !window.isSecureContext) throw new TroubleError({ code: "insecure" });
  if (!navigator.mediaDevices?.getUserMedia) throw new TroubleError({ code: "no-mic" });
  if (typeof MediaRecorder === "undefined") throw new TroubleError({ code: "no-recorder" });
  // In the Mac app macOS decides first: a refusal there would otherwise
  // reach the page as a bare "not allowed" with no way to fix it.
  const bridge = window.bloks;
  if (bridge?.permStatus) {
    const status = await bridge.permStatus().catch(() => null);
    let mic = status?.mic ?? "unknown";
    if (mic === "not-determined") mic = (await bridge.permRequestMic().catch(() => false)) ? "granted" : "denied";
    if (mic === "denied" || mic === "restricted") throw new TroubleError({ code: "mic-denied" });
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: kind === "call", noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new TroubleError({ code: "mic-denied" });
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new TroubleError({ code: "no-mic" });
    throw new TroubleError({ code: "mic-busy" });
  }
}

/** A stretch of speech to text, by whoever hears for the workspace. */
export async function transcribeClip(clip: Blob): Promise<string> {
  const res = await fetch("/api/speech/transcribe", {
    method: "POST",
    headers: { "content-type": clip.type || "audio/webm" },
    body: clip,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new TroubleError({ code: "server", message: typeof body.error === "string" ? body.error : `${res.status}` });
  return typeof body.text === "string" ? body.text.trim() : "";
}

export interface RecorderHandlers {
  /** Loudness, about ten times a second, for the meter. */
  onLevel?: (level: number) => void;
  /** Speech has started in this stretch. */
  onSpeech?: () => void;
  /** A finished stretch with speech in it, and when it began. */
  onClip: (clip: Blob, startedAt: number) => void;
}

/**
 * The microphone cut into stretches of speech. `continuous` begins the
 * next stretch the moment one ends (a meeting); otherwise it stops after
 * one, until `start` is called again (a call, which waits while the
 * agent answers).
 *
 * Loudness is read on the audio thread's schedule, not a timer's: a
 * window in the background has its timers slowed to once a second, and a
 * meeting is mostly heard from behind the call it is taking notes on.
 */
export class SpeechRecorder {
  private readonly context: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly tap: ScriptProcessorNode;
  private readonly pauses: Pauses;
  private readonly format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f)) ?? "";
  private recorder: MediaRecorder | null = null;
  private startedAt = 0;
  private lastLevelAt = 0;
  private closed = false;
  private readonly stream: MediaStream;
  private readonly continuous: boolean;
  private readonly handlers: RecorderHandlers;

  constructor(stream: MediaStream, rules: PauseRules, continuous: boolean, handlers: RecorderHandlers) {
    this.stream = stream;
    this.continuous = continuous;
    this.handlers = handlers;
    this.pauses = new Pauses(rules);
    this.context = new AudioContext();
    this.source = this.context.createMediaStreamSource(stream);
    this.tap = this.context.createScriptProcessor(2048, 1, 1);
    this.tap.onaudioprocess = (event) => this.hear(loudness(event.inputBuffer.getChannelData(0)));
    this.source.connect(this.tap);
    // a processor only runs while connected onward; it writes silence
    this.tap.connect(this.context.destination);
  }

  get listening(): boolean {
    return this.recorder !== null;
  }

  /** Begins a stretch. */
  start() {
    if (this.closed || this.recorder) return;
    void this.context.resume().catch(() => {});
    this.begin();
  }

  /** Ends the stretch now: sent if it had speech in it, dropped if not.
   * Settles once a stretch that is sent has been handed to `onClip`. */
  finish(): Promise<void> {
    return this.recorder ? this.cut(this.pauses.heardSpeech, false) : Promise.resolve();
  }

  /** Stops listening without sending anything. */
  stop() {
    if (this.recorder) void this.cut(false, false);
  }

  /** Lets go of the audio. The stream is the caller's to stop. */
  close() {
    this.stop();
    this.closed = true;
    this.tap.onaudioprocess = null;
    this.source.disconnect();
    this.tap.disconnect();
    void this.context.close().catch(() => {});
  }

  private begin() {
    const recorder = new MediaRecorder(this.stream, {
      ...(this.format ? { mimeType: this.format } : {}),
      audioBitsPerSecond: BITS_PER_SECOND,
    });
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
    };
    (recorder as MediaRecorder & { parts: Blob[] }).parts = parts;
    recorder.start();
    this.recorder = recorder;
    this.startedAt = Date.now();
    this.pauses.reset(this.startedAt);
  }

  /** Closes the stretch. `send` keeps what was recorded; `again` begins
   * the next one at once. */
  private cut(send: boolean, again: boolean): Promise<void> {
    const recorder = this.recorder!;
    const parts = (recorder as MediaRecorder & { parts: Blob[] }).parts;
    const startedAt = this.startedAt;
    this.recorder = null;
    // the last of the sound arrives just before the recorder says it stopped
    const handed = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        if (send && parts.length) this.handlers.onClip(new Blob(parts, { type: recorder.mimeType || this.format || "audio/webm" }), startedAt);
        resolve();
      };
    });
    if (recorder.state !== "inactive") recorder.stop();
    if (again && !this.closed) this.begin();
    return handed;
  }

  private hear(level: number) {
    if (!this.recorder) return;
    const now = Date.now();
    if (now - this.lastLevelAt >= 100) {
      this.lastLevelAt = now;
      this.handlers.onLevel?.(level);
    }
    const event = this.pauses.push(level, now);
    if (event === "speech") this.handlers.onSpeech?.();
    else if (event === "end") void this.cut(true, this.continuous);
    else if (event === "idle") void this.cut(false, true);
  }
}

// ── a call's ears ──────────────────────────────────────────────────────

export interface CallHandlers {
  /** Words so far, from a recognizer that has them as you speak (the Mac's). */
  onPartial: (text: string) => void;
  /** What was said, or "" when nothing was. */
  onHeard: (text: string) => void;
  /** A stretch is being written down. */
  onTranscribing: () => void;
  onTrouble: (trouble: Trouble) => void;
}

export interface CallEars {
  /** Listens for one thing said. */
  listen(): void;
  /** Stops listening without sending (the agent is about to speak). */
  hush(): void;
  /** Ends what is being said now: the Mac's recognizer cannot tell. */
  finish(): void;
  /** Hangs up the microphone. */
  close(): void;
  /** Whether finishing is the person's to do, with a button. */
  readonly manualFinish: boolean;
}

/** A call's ears, from the server's hearer or the Mac's own recognizer. */
export function callEars(ears: Ears, handlers: CallHandlers): CallEars {
  if (ears.kind === "mac") return macEars(handlers);
  if (ears.kind === "none") {
    const missing = ears.missing;
    return {
      listen: () => handlers.onTrouble({ code: "nobody", missing }),
      hush: () => {},
      finish: () => {},
      close: () => {},
      manualFinish: false,
    };
  }
  let recorder: SpeechRecorder | null = null;
  let stream: MediaStream | null = null;
  let opening: Promise<void> | null = null;
  let closed = false;
  /** Which listen a clip belongs to, so one hushed meanwhile is dropped. */
  let turn = 0;

  const open = () =>
    (opening ??= openMicrophone("call").then((s) => {
      if (closed) return void s.getTracks().forEach((track) => track.stop());
      stream = s;
      recorder = new SpeechRecorder(s, CALL_PAUSES, false, {
        onClip: (clip) => {
          const mine = turn;
          handlers.onTranscribing();
          transcribeClip(clip)
            .then((text) => mine === turn && !closed && handlers.onHeard(text))
            .catch((e) => mine === turn && !closed && handlers.onTrouble(e instanceof TroubleError ? e.trouble : { code: "server", message: String(e) }));
        },
      });
    }));

  return {
    listen() {
      turn += 1;
      open()
        .then(() => recorder?.start())
        .catch((e) => {
          opening = null;
          handlers.onTrouble(e instanceof TroubleError ? e.trouble : { code: "mic-busy" });
        });
    },
    hush() {
      turn += 1;
      recorder?.stop();
    },
    finish() {
      void recorder?.finish();
    },
    close() {
      closed = true;
      turn += 1;
      recorder?.close();
      (stream as MediaStream | null)?.getTracks().forEach((track) => track.stop());
    },
    manualFinish: false,
  };
}

/** The Mac's dictation helper, one utterance at a time. It writes words
 * as you go and usually cannot tell when you are done, so the call offers
 * a button for that. */
function macEars(handlers: CallHandlers): CallEars {
  const bridge = window.bloks;
  let off: Array<() => void> = [];
  let said = "";
  const quiet = () => {
    off.forEach((stop) => stop());
    off = [];
  };
  const stop = () => {
    quiet();
    void bridge?.speechStop?.();
  };
  return {
    listen() {
      stop();
      said = "";
      if (!bridge?.speechStart) return handlers.onTrouble({ code: "no-mic" });
      const deafness = new NoWords();
      off.push(
        bridge.onSpeechTranscript((line) => {
          if (typeof line.level === "number") {
            deafness.level(line.level, Date.now());
            if (deafness.deaf) {
              stop();
              handlers.onTrouble({ code: "deaf" });
            }
            return;
          }
          if (typeof line.error === "string") {
            stop();
            return handlers.onTrouble({ code: "mac", error: line.error });
          }
          if (typeof line.text === "string") {
            deafness.heardWords();
            said = line.text;
            handlers.onPartial(said);
            // the helper does finish on its own now and then: take it
            if (line.partial === false) {
              stop();
              handlers.onHeard(said);
            }
          }
        }),
        // gone without a word of why: macOS refused it before it could say
        bridge.onSpeechEnd(({ code }) => {
          if (code !== 1) return;
          quiet();
          handlers.onTrouble({ code: "mac", error: "stopped" });
        }),
      );
      void bridge.speechStart();
    },
    hush: stop,
    finish() {
      stop();
      handlers.onHeard(said);
    },
    close: stop,
    manualFinish: true,
  };
}
