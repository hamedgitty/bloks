// Hand-written twin of shell-path.mjs, so the tests typecheck against the
// same shapes the main process uses.
export const PATH_START: string;
export const PATH_END: string;
export const PATH_SCRIPT: string;
export const FIRST_ASK_MS: number;
export const SECOND_ASK_MS: number;

export function readShellPath(output: unknown): string | null;
export function mergePath(reported: string | null | undefined, current: string | null | undefined): string;
export function cutOff(error: unknown): boolean;

type Run = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: (Error & { killed?: boolean; signal?: string | null; code?: unknown }) | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

export function askLoginShell(options?: { shell?: string; timeoutMs?: number; run?: Run }): Promise<{ path: string | null; timedOut: boolean }>;
