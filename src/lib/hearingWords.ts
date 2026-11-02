// Hearing, in words: who is hearing you, and what to do when nothing can
// or something went wrong. The choosing is src/lib/hearing.ts; this is
// what the call screen, meeting notes and Settings say about it.
import { useStore } from "@/state/store";
import { t, type MessageKey } from "@/lib/i18n";
import { macRecognizerHere } from "@/lib/thisComputer";
import { pickEars, type Ears, type HearingChoice } from "./hearing";
import type { Trouble } from "./listen";

/** Who hears you, for this window. */
export function useEars(): { ears: Ears; macApp: boolean } {
  const { state } = useStore();
  const macApp = macRecognizerHere(Boolean(window.bloks?.speechStart && window.bloks?.meetingStart));
  return { ears: pickEars(state.config?.speech?.hearing, macApp), macApp };
}

const HEARD_BY: Record<"mac" | "whisper" | "elevenlabs" | "openai", MessageKey> = {
  mac: "hearing.by.mac",
  whisper: "hearing.by.whisper",
  elevenlabs: "hearing.by.elevenlabs",
  openai: "hearing.by.openai",
};

/** "Heard by OpenAI", for the call screen and the meeting panel. */
export function heardBy(ears: Ears): string | null {
  if (ears.kind === "none") return null;
  return t(HEARD_BY[ears.kind === "server" ? ears.by : "mac"]);
}

const MISSING: Record<HearingChoice, MessageKey> = {
  auto: "hearing.missing.auto",
  whisper: "hearing.missing.whisper",
  elevenlabs: "hearing.missing.elevenlabs",
  openai: "hearing.missing.openai",
  mac: "hearing.missing.mac",
};

/** What the Mac's helper says went wrong, as the thing to do. */
const MAC_TROUBLE: Record<string, MessageKey> = {
  "speech-not-authorized": "dictation.speech.notAuthorized",
  "recognizer-unavailable": "dictation.speech.recognizerUnavailable",
  "mic-failed": "dictation.speech.micFailed",
  "recognition-error": "dictation.speech.recognitionError",
  stopped: "dictation.speech.allowInSettings",
};

const TROUBLE: Record<Exclude<Trouble["code"], "server" | "mac" | "nobody">, MessageKey> = {
  insecure: "hearing.trouble.insecure",
  "no-mic": "hearing.trouble.noMic",
  "mic-denied": "hearing.trouble.micDenied",
  "mic-busy": "hearing.trouble.micBusy",
  "no-recorder": "hearing.trouble.noRecorder",
  deaf: "hearing.trouble.deaf",
};

/** Why nothing can hear, said as what to set up. */
export function missingText(missing: HearingChoice): string {
  return t(MISSING[missing]);
}

/** A trouble, as the sentence that fixes it. */
export function troubleText(trouble: Trouble): string {
  if (trouble.code === "server") return trouble.message;
  if (trouble.code === "nobody") return missingText(trouble.missing);
  if (trouble.code === "mac") return t(MAC_TROUBLE[trouble.error] ?? "dictation.speech.stoppedUnexpectedly");
  return t(TROUBLE[trouble.code]);
}
