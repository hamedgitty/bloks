// The speech speed as the page uses it: one copy for the window, kept in
// step with the app's other windows through the storage event, and the
// agent voices playing right now, which a change reaches at once rather
// than at the next reply.
import { useSyncExternalStore } from "react";
import { applySpeechSpeed, createSpeechSpeed, SPEECH_SPEED_KEY, type SpeechSpeed } from "./speechSpeed";

const preference = createSpeechSpeed({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});

const listeners = new Set<() => void>();
/** Agent voices that are playing. A clip leaves when it pauses or ends,
 * so a reply cut off by a barge-in is not held on to. */
const playing = new Set<HTMLAudioElement>();

function changed() {
  const speed = preference.get();
  for (const audio of playing) applySpeechSpeed(audio, speed);
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== SPEECH_SPEED_KEY) return;
    preference.sync();
    changed();
  });
}

/** Sets the speed for every agent voice on this device, the one playing
 * now included. */
export function setSpeechSpeed(speed: SpeechSpeed) {
  preference.set(speed);
  changed();
}

/** An agent's voice, played at the chosen speed for as long as it plays.
 * Never the person's own recordings: those are theirs, heard as said. */
export function atSpeechSpeed(audio: HTMLAudioElement): HTMLAudioElement {
  applySpeechSpeed(audio, preference.get());
  audio.addEventListener("play", () => {
    applySpeechSpeed(audio, preference.get());
    playing.add(audio);
  });
  const done = () => playing.delete(audio);
  audio.addEventListener("pause", done);
  audio.addEventListener("ended", done);
  audio.addEventListener("error", done);
  return audio;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useSpeechSpeed(): [SpeechSpeed, (speed: SpeechSpeed) => void] {
  return [useSyncExternalStore(subscribe, preference.get), setSpeechSpeed];
}
