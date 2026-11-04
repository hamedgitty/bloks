// How fast agents' voices play here: a listening preference for this
// device, like the transcript's width, not part of any agent.
//
// An agent's voice is chosen on the agent and heard the same by everyone
// in the workspace. How fast it is played is the listener's own: one
// person likes 1.5x, another on the same team wants every word. So it is
// kept on this device and holds for every agent, and nothing about it
// reaches the server. The person's own recordings are never played
// through here and stay at 1x.
//
// This file is the choosing and the keeping, plain functions over storage
// and a media element's three fields. No "@/" imports, so the tests can
// load it as it is.

export const SPEECH_SPEED_KEY = "bloks-speech-speed";

/** The speeds offered, slowest first, as the settings select lists them. */
export const SPEECH_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export type SpeechSpeed = (typeof SPEECH_SPEEDS)[number];

/** The order the chip on a call steps through: up from normal, then the
 * one slower speed, then back to normal, so a press or two away from 1x
 * is always where most people want to be. */
const CYCLE: readonly SpeechSpeed[] = [1, 1.25, 1.5, 2, 0.75];

/** A stored or sent value as a speed, and 1x for anything else: an old
 * value, a hand edit, a number the list never offered. */
export function speechSpeed(value: unknown): SpeechSpeed {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return SPEECH_SPEEDS.find((speed) => speed === n) ?? 1;
}

/** The speed after this one, as the call's chip steps. */
export function nextSpeechSpeed(current: unknown): SpeechSpeed {
  const at = CYCLE.indexOf(speechSpeed(current));
  return CYCLE[(at + 1) % CYCLE.length];
}

/** The parts of a media element a speed is written to. */
export interface SpeedTarget {
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch?: boolean;
}

/** Plays `audio` at `speed` from now on, at its natural pitch. The
 * default rate is set too, because loading a source resets the rate to
 * it, and a faster voice that drops to normal partway would be a bug. */
export function applySpeechSpeed(audio: SpeedTarget, speed: SpeechSpeed): void {
  audio.preservesPitch = true;
  audio.defaultPlaybackRate = speed;
  audio.playbackRate = speed;
}

interface SpeedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The kept choice. A store that cannot be read gives 1x; one that
 * cannot be written keeps the choice for this window only. */
export function createSpeechSpeed(storage: SpeedStorage) {
  const read = (): SpeechSpeed => {
    try {
      return speechSpeed(storage.getItem(SPEECH_SPEED_KEY));
    } catch {
      return 1;
    }
  };
  let current = read();
  let sessionOnly = false;
  return {
    get: () => current,
    set(value: unknown) {
      current = speechSpeed(value);
      try {
        storage.setItem(SPEECH_SPEED_KEY, String(current));
        sessionOnly = false;
      } catch {
        sessionOnly = true;
      }
    },
    sync() {
      // re-reading a write that failed would quietly undo the choice
      if (!sessionOnly) current = read();
    },
  };
}
