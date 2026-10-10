// The security checkup's latest report, shared by the page that shows it
// and the dot on Settings that says something in it is risky.
//
// One copy for the whole app rather than one per component: the page and
// the sidebar would otherwise ask the server twice for the same thing, and
// a fix made on the page would leave the dot showing until the sidebar
// happened to ask again. The route answers only this computer
// (server/index.ts), so on a phone or at bloks.dev/web the report stays
// empty and the dot never shows.
import { useEffect, useSyncExternalStore } from "react";

/** The app's request helper, kept here rather than imported from the
 * store, so this file stays plain TypeScript a test can load. */
export async function checkupApi(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export type CheckupLevel = "ok" | "look" | "risky";

export type CheckupFix =
  | { kind: "page"; page: string; label: string }
  | { kind: "automations"; tab: "webhooks"; label: string }
  | { kind: "agents" | "full-access" | "rooms" | "secrets" | "permissions"; label: string };

export interface CheckupFinding {
  id: string;
  title: string;
  level: CheckupLevel;
  summary: string;
  why: string;
  items?: Array<{ id: string; name: string; detail?: string }>;
  fix?: CheckupFix;
}

export interface CheckupReport {
  findings: CheckupFinding[];
  risky: number;
  look: number;
  checkedAt: number;
  /** After fixing permissions: what changed, and what could not be. */
  fixed?: string[];
  failed?: string[];
}

interface CheckupState {
  report: CheckupReport | null;
  /** Why there is no report: "not from here" on any other device. */
  error: string | null;
  loading: boolean;
}

let current: CheckupState = { report: null, error: null, loading: false };
const listeners = new Set<() => void>();

function set(next: Partial<CheckupState>) {
  current = { ...current, ...next };
  for (const listener of listeners) listener();
}

/** Asks again, or takes a report a fix already answered with. */
export async function refreshCheckup(given?: Promise<CheckupReport>): Promise<CheckupReport | null> {
  set({ loading: true });
  try {
    const report = await (given ?? (checkupApi("/api/security") as Promise<CheckupReport>));
    set({ report, error: null, loading: false });
    return report;
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e), loading: false });
    return null;
  }
}

/** How old a report may be before a new reader asks again. */
const FRESH_MS = 60_000;

/** `maxAge` 0 asks again on every mount: the page itself, where somebody
 * who just changed a setting elsewhere comes to see it counted. The dot
 * on Settings can live with a minute. */
export function useSecurityCheckup(maxAge = FRESH_MS): CheckupState {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  useEffect(() => {
    if (!current.loading && (!current.report || Date.now() - current.report.checkedAt >= maxAge)) void refreshCheckup();
  }, []);
  return state;
}

/** How many findings are risky, for a badge: 0 without a report, so a
 * device the checkup does not answer shows nothing rather than a guess. */
export function riskyCount(report: CheckupReport | null | undefined): number {
  return report ? report.findings.filter((f) => f.level === "risky").length : 0;
}
