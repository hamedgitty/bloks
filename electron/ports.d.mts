// Hand-written twin of ports.mjs, so the tests typecheck against the
// same shapes the main process uses.
export const USUAL_PORTS: number[];

export function portOrder(input: {
  prefer?: string | number | null;
  env?: string | number | null;
  configured?: string | number | null;
  last?: string | number | null;
  usual?: number[];
}): number[];

export function portFree(port: number): Promise<boolean>;
export function anyFreePort(): Promise<number | null>;
export function parseLsof(text: string | null | undefined): { name: string; pid: number | null } | null;

export interface PortAttempt {
  port: number;
  why: "busy" | "other-server" | "exited" | "slow";
  holder: { name: string; pid: number | null } | null;
}

export function describeAttempt(attempt: PortAttempt): string;
export function failurePage(input: {
  attempts: PortAttempt[];
  crash: string;
  backdrop: string;
  machine: string;
  /** another Bloks server already holds ~/.bloks (server/data-lock.ts) */
  inUse?: { pid: number; port: number } | null;
  /** the server started, then kept dying each time it was brought back */
  stopped?: boolean;
}): string;
