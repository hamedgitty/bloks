// Hand-written twin of hosting-move.mjs, so the tests typecheck against
// the same shapes the main process uses.
export type MoveStep = "pairing" | "packing" | "sending" | "unpacking" | "checking" | "done";
export type MovePhase = "waiting" | "running" | "stopped" | "later" | "failed" | "done";
export type MoveDirection = "to-hosted" | "to-mac";

export const STEPS: readonly MoveStep[];
export const PHASES: readonly MovePhase[];
export const DIRECTIONS: readonly MoveDirection[];
export const LANES: number;
export const TRIES: number;
export const BACK_WITHIN_MS: number;
export const AUTO_DELAY_MS: number;

export interface MoveCounts {
  agents: number;
  conversations: number;
  rooms: number;
  routines: number;
  watchers: number;
  workflows: number;
  memoryFiles: number;
}

export interface KeyToEnter {
  label: string;
  page: string;
  path: string;
}

export interface MoveFile {
  name: string;
  size: number;
  sha256: string;
  partSize: number;
  partDigests: string[];
  counts: MoveCounts | null;
  keys: KeyToEnter[];
}

export interface Move {
  id: string;
  direction: MoveDirection;
  auto: boolean;
  from: { id: string; name: string };
  to: { id: string | null; name: string };
  replace: boolean;
  phase: MovePhase;
  step: MoveStep;
  startsAt: number | null;
  file: MoveFile | null;
  upload: { id: string } | null;
  held: boolean;
  finishing: { name: string; at: number } | null;
  sent: number;
  size: number;
  keys: KeyToEnter[] | null;
  error: string | null;
  code: string | null;
  startedAt: number;
  updatedAt: number;
  doneAt: number | null;
}

export interface MoveState {
  version: 1;
  print: string | null;
  boughtFrom: { id: string; at: number } | null;
  moved: { at: number; from: string; to: string } | null;
  move: Move | null;
}

export interface AccountForMove {
  shared?: boolean;
  accountStatus?: string | null;
  hosting?: { tier?: string | null; state?: string | null } | null;
  bloksAi?: boolean;
}

export class MoveProblem extends Error {
  code: string;
  constructor(message: string, options?: { code?: string });
}

export function countsDiffer(sent: Partial<MoveCounts> | null | undefined, arrived: Partial<MoveCounts> | null | undefined): string[];
export function notEmptyWords(move: Pick<Move, "direction" | "to">): string;
export function newMove(input: {
  direction: MoveDirection;
  from: { id: string; name: string };
  to: { id?: string | null; name: string };
  replace?: boolean;
  auto?: boolean;
  now?: number;
}): Move;
export function readMoveState(file: string, print: string | null): MoveState;
export function keepMoveState(file: string, state: MoveState): void;
export function hostingRunning(account: AccountForMove | null | undefined): boolean;
export function autoMoveFrom(input: {
  account: AccountForMove | null | undefined;
  state: MoveState | null | undefined;
  registry: { workspaces: Array<{ id: string; kind: string; name: string; moved?: unknown }> } | null | undefined;
}): { id: string; name: string } | null;
export function thisMachine(platform?: string): string;
export function startingWords(move: Pick<Move, "direction" | "from">): string;
export function doneWords(move: Pick<Move, "direction" | "from" | "to">): string;

export interface MoveDeps {
  source(): string | null;
  target(): string | null;
  pair?(move: Move): Promise<Partial<Move> | void | null> | Partial<Move> | void | null;
  save?(move: Move): void;
  waitBack?(move: Move): Promise<void> | void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  wait?(ms: number): Promise<void>;
  now?(): number;
  lanes?: number;
  backWithinMs?: number;
  onPart?(index: number, attempt: number): Promise<void> | void;
}

export function runMove(start: Move, deps: MoveDeps): Promise<Move>;
