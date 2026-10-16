// A reading preference for this device, not part of an agent's workspace.
export const TRANSCRIPT_WIDTH_KEY = "bloks-transcript-width";
export const TRANSCRIPT_WIDTHS = { narrow: "760px", medium: "800px", wide: "960px" } as const;
export type TranscriptWidth = keyof typeof TRANSCRIPT_WIDTHS;

export function transcriptWidth(value: unknown): TranscriptWidth {
  return value === "medium" || value === "wide" ? value : "narrow";
}

interface WidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The DOM adapter supplies storage and the CSS write. Keeping them out of
 * this part also makes a blocked/private store an ordinary session choice. */
export function createTranscriptWidth(storage: WidthStorage, apply: (pixels: string) => void) {
  const read = (): TranscriptWidth => {
    try { return transcriptWidth(storage.getItem(TRANSCRIPT_WIDTH_KEY)); }
    catch { return "narrow"; }
  };
  let current = read();
  let sessionOnly = false;
  const show = () => apply(TRANSCRIPT_WIDTHS[current]);
  show();
  return {
    get: () => current,
    set(value: unknown) {
      current = transcriptWidth(value);
      try {
        storage.setItem(TRANSCRIPT_WIDTH_KEY, current);
        sessionOnly = false;
      } catch {
        sessionOnly = true;
      }
      show();
    },
    sync() {
      // Re-reading a failed write would silently undo the choice just made.
      if (!sessionOnly) current = read();
      show();
    },
  };
}
