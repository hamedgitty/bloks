export function nativeSettingsObservation(input: {
  window: {
    isDestroyed(): boolean;
    getBounds(): { width: number; height: number; x: number; y: number };
    isMaximized(): boolean;
  } | null;
  remote: boolean;
  shortcut: unknown;
  update: string;
  media(kind: "microphone" | "screen"): string | undefined;
}): Record<string, { status: "observed"; value: unknown } | { status: "unknown"; reason: "unsupported" }>;
