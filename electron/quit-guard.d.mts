// Hand-written twin of quit-guard.mjs, so the tests typecheck against the
// same shapes the main process uses.

export type QuitPhase = "holding" | "armed" | "leaving";

export interface KeyLike {
  key?: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const HOLD_MS: number;
export const AGAIN_MS: number;
export const LINGER_MS: number;
export const LEAVE_MAX_MS: number;
export const FADE_MS: number;
export const HINT_SIZE: Readonly<{ width: number; height: number }>;

export function isQuitKey(input: KeyLike | null | undefined): boolean;
export function endsQuitKey(input: KeyLike | null | undefined): boolean;

export interface QuitGuard {
  readonly state: "idle" | "holding" | "armed" | "leaving" | "gone";
  press(input?: { repeat?: boolean }): boolean;
  release(input: KeyLike): void;
  other(input: KeyLike): void;
  blur(): void;
  menu(): void;
  reset(): void;
}

export function createQuitGuard(options: {
  quit: () => void;
  hint?: (phase: QuitPhase | null) => void;
  later?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
  holdMs?: number;
  againMs?: number;
  lingerMs?: number;
  leaveMaxMs?: number;
}): QuitGuard;

export function hintBounds(over: Rect, size?: { width: number; height: number }): Rect;

export function quitHintPage(options: { text: string; dark?: boolean; holdMs?: number; fadeMs?: number }): string;

export function createQuitHint(options: {
  BrowserWindow: new (options: Record<string, unknown>) => unknown;
  over: () => { getBounds(): Rect } | null;
  words: () => string;
  dark: () => boolean;
  holdMs?: number;
  later?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}): { show(phase: QuitPhase | null): void; window(): unknown };
