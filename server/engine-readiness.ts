// Whether an agent's engine can answer right now, told to another agent.
//
// The person sees it when an agent cannot answer: a banner over the chat
// for an engine that is not signed in or not there, a notice under the
// turn for one that ran out or was refused. Another agent saw none of
// that. `bloks agents` listed a blocked teammate like any other, and
// `bloks say` answered ok to a message nobody was going to read, so an
// agent waiting on that teammate waited for good (GitHub 239).
//
// So the facts the app already has (the engine there or not, resting after
// running out, signed in by its own account) are put into a state for the
// roster and a sentence for whoever just wrote. Only those: never a key, a
// path or an engine's own error text, which can carry either.
import { REASON_WORDS, type OutReason, type Rest } from "./failover.ts";

export type Readiness =
  | { state: "ready" }
  | { state: "signedOut" }
  | { state: "out"; until: number; reason: Exclude<OutReason, "signedOut"> }
  | { state: "unavailable" };

/** What Bloks knows of one engine right now. */
export interface EngineFacts {
  /** Built, and not switched off. */
  present: boolean;
  /** Resting after running out (server/failover.ts). */
  rest?: Rest;
  /** What the engine last said of itself, when it was asked. */
  snapshot?: { state: "available" | "unavailable"; authenticated?: boolean } | null;
}

/**
 * One engine. A rest comes before the engine's own word on itself: a CLI
 * can think it is signed in on a login its provider has stopped taking,
 * and the turn that was refused is the better witness.
 */
export function engineReadiness(facts: EngineFacts): Readiness {
  if (!facts.present) return { state: "unavailable" };
  if (facts.rest) {
    return facts.rest.reason === "signedOut"
      ? { state: "signedOut" }
      : { state: "out", until: facts.rest.until, reason: facts.rest.reason };
  }
  if (facts.snapshot?.state === "unavailable") return { state: "unavailable" };
  if (facts.snapshot?.authenticated === false) return { state: "signedOut" };
  return { state: "ready" };
}

/** An agent: its own engine, unless that one cannot answer and its backup
 * can, which is where its turn goes then. */
export function agentReadiness(own: Readiness, backup?: Readiness | null): Readiness {
  return own.state !== "ready" && backup?.state === "ready" ? backup : own;
}

/** A moment in this computer's own time, as the command line writes one. */
export function localStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * What an agent writing to `name` is told when it cannot answer, or null
 * when it can. Said plainly enough to act on: who can fix it, and when it
 * might answer, so the sender tells the person or asks someone else rather
 * than waiting for a reply that is not coming.
 */
export function readinessWarning(name: string, engine: string | undefined, r: Readiness): string | null {
  const its = engine ? `${name}'s engine, ${engine},` : `${name}'s engine`;
  if (r.state === "signedOut") {
    return `${its} is not signed in, so ${name} cannot answer this until the person signs it in. Tell them, or ask someone else.`;
  }
  if (r.state === "out") {
    return `${its} ${REASON_WORDS[r.reason]} until ${localStamp(r.until)}, so ${name} cannot answer this before then.`;
  }
  if (r.state === "unavailable") {
    return `${its} is not available on this computer, so ${name} cannot answer this until the person sets it up or picks another engine for it.`;
  }
  return null;
}
