// Hearing: who turns what you say into text, and when a stretch of
// speech has ended.
//
// Calls and meeting notes share one way in (src/lib/listen.ts). The page
// records the microphone and hands each stretch of speech to the server,
// which passes it to whoever hears for the workspace (server/speech.ts
// hearer): a Whisper server of the person's own, ElevenLabs or OpenAI,
// with a key the page never sees. In the Mac app the Mac's own
// recognizer can hear instead, through the native helper.
//
// This file is the choosing and the listening for pauses, both plain
// functions over numbers. No "@/" imports, so the tests can load it as
// it is.

export type Hearer = "whisper" | "elevenlabs" | "openai";
export type HearingChoice = "auto" | Hearer | "mac";

/** What the server says about hearing (GET /api/config, speech.hearing). */
export interface HearingStatus {
  choice: HearingChoice;
  /** Who hears on the server, or null with nothing set up there. */
  engine: Hearer | null;
  whisper: boolean;
  whisperUrl?: string;
}

/** Who will hear you here: the server's hearer, the Mac's own recognizer,
 * or nobody, with what was wanted and is not there. */
export type Ears = { kind: "server"; by: Hearer } | { kind: "mac" } | { kind: "none"; missing: HearingChoice };

/**
 * Who hears you, for this window. `macHere` is the Mac app's own window,
 * which alone has the Mac's recognizer. Automatic takes the server's
 * hearer first, since it is the one the person set up, and the Mac's
 * only with nothing else; a vendor chosen by name and not set up is said
 * so, rather than quietly heard by somebody else. The Mac chosen where
 * there is no Mac's recognizer hears with the server's instead.
 */
export function pickEars(status: HearingStatus | undefined, macHere: boolean): Ears {
  const choice = status?.choice ?? "auto";
  if (choice === "mac" && macHere) return { kind: "mac" };
  if (status?.engine) return { kind: "server", by: status.engine };
  if ((choice === "auto" || choice === "mac") && macHere) return { kind: "mac" };
  return { kind: "none", missing: choice };
}

/** Loudness of a run of samples, lifted into a usable 0 to 1, the same
 * scale the Mac's helper reports (electron/resources/speech-helper.swift). */
export function loudness(samples: ArrayLike<number>): number {
  const count = samples.length;
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / count) * 12);
}

export interface PauseRules {
  /** Quiet after speech that ends a stretch. */
  quietMs: number;
  /** The longest a stretch runs before it is cut anyway: the vendors take
   * a few minutes at most, and a meeting reads better in pieces. */
  maxMs: number;
  /** How long a stretch with no speech in it is kept before it is
   * thrown away and begun again, so silence is never sent anywhere. */
  idleMs: number;
}

/** A call answers when you stop, so it waits only a breath. */
export const CALL_PAUSES: PauseRules = { quietMs: 1_200, maxMs: 60_000, idleMs: 15_000 };
/** A meeting has longer pauses that are not the end of anything. */
export const MEETING_PAUSES: PauseRules = { quietMs: 1_500, maxMs: 45_000, idleMs: 30_000 };

/** Never quieter than this counts as speech, however still the room. */
const SPEECH_FLOOR = 0.08;
/** Sound has to last this long to be speech rather than a click or a cough. */
const ONSET_MS = 160;

export type PauseEvent = "speech" | "end" | "idle";

/**
 * Where speech starts and stops, from loudness readings. The room's own
 * hum is followed slowly, so a fan or a busy café raises the bar for what
 * counts as speech instead of reading as one endless sentence.
 */
export class Pauses {
  private hum = 0.02;
  private startedAt: number | null = null;
  private lastAt = 0;
  private lastLoudAt = 0;
  private soundMs = 0;
  private speaking = false;
  private readonly rules: PauseRules;

  constructor(rules: PauseRules) {
    this.rules = rules;
  }

  /** A new stretch begins now. */
  reset(now: number) {
    this.startedAt = now;
    this.lastAt = now;
    this.lastLoudAt = now;
    this.soundMs = 0;
    this.speaking = false;
  }

  /** Whether this stretch has had speech in it. */
  get heardSpeech(): boolean {
    return this.speaking;
  }

  /** One reading. Says when speech starts, when a stretch with speech in
   * it has ended, and when one without any has gone on long enough. */
  push(level: number, now: number): PauseEvent | null {
    if (this.startedAt === null) this.reset(now);
    // a reading that arrives late (a busy machine) counts for a moment, not for the gap
    const dt = Math.min(250, Math.max(0, now - this.lastAt));
    this.lastAt = now;
    const loud = level >= Math.max(SPEECH_FLOOR, this.hum * 3);
    // down at once, up slowly: the gaps between words fall back to the
    // room's own level many times a second, so speech never becomes the
    // hum, and a fan that never stops does, in a few seconds
    this.hum += (level - this.hum) * (level < this.hum ? 0.1 : 0.003);
    let event: PauseEvent | null = null;
    if (loud) {
      this.lastLoudAt = now;
      if (!this.speaking) {
        this.soundMs += dt;
        if (this.soundMs >= ONSET_MS) {
          this.speaking = true;
          event = "speech";
        }
      }
    } else if (!this.speaking) {
      this.soundMs = Math.max(0, this.soundMs - dt / 2);
    }
    if (event) return event;
    if (this.speaking && (now - this.lastLoudAt >= this.rules.quietMs || now - this.startedAt! >= this.rules.maxMs)) return "end";
    if (!this.speaking && now - this.startedAt! >= this.rules.idleMs) return "idle";
    return null;
  }
}

/**
 * The Mac's recognizer running and hearing nothing: sound for a good
 * while, and no words back. That is what it looks like with Siri and
 * Dictation turned off, or no speech model for the language, where the
 * helper hears the microphone fine and the recognizer says nothing.
 */
export class NoWords {
  private soundMs = 0;
  private lastAt: number | null = null;
  private words = false;
  private readonly afterMs: number;

  constructor(afterMs = 12_000) {
    this.afterMs = afterMs;
  }

  level(level: number, now: number) {
    const dt = this.lastAt === null ? 0 : Math.min(250, Math.max(0, now - this.lastAt));
    this.lastAt = now;
    if (level >= 0.15) this.soundMs += dt;
  }

  heardWords() {
    this.words = true;
  }

  get deaf(): boolean {
    return !this.words && this.soundMs >= this.afterMs;
  }
}
