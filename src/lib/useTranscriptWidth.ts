import { useEffect, useState } from "react";
import { createTranscriptWidth, TRANSCRIPT_WIDTH_KEY, type TranscriptWidth } from "./transcriptWidth";

const EVENT = "bloks:transcript-width";
const preference = createTranscriptWidth({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
}, (pixels) => document.documentElement.style.setProperty("--transcript-width", pixels));

/** Called before React renders so a saved width does not jump on first paint. */
export function startTranscriptWidth() {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== TRANSCRIPT_WIDTH_KEY) return;
    preference.sync();
    window.dispatchEvent(new Event(EVENT));
  });
}

export function useTranscriptWidth(): [TranscriptWidth, (width: TranscriptWidth) => void] {
  const [width, setWidth] = useState(preference.get);
  useEffect(() => {
    const sync = () => setWidth(preference.get());
    window.addEventListener(EVENT, sync);
    sync();
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return [width, (next) => {
    preference.set(next);
    window.dispatchEvent(new Event(EVENT));
  }];
}
