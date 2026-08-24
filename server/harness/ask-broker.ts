// Holding a turn open while a person decides.
//
// An agent partway through a turn sometimes needs an answer: permission to
// run something, or a genuine question it should not guess at. The model
// is blocked until it hears back, so something has to hold that request,
// surface it, and unblock the turn when the answer arrives (or when it
// becomes clear no answer is coming).
//
// That is all this is. It is deliberately not Claude-specific: the shape
// is the same for any driver whose CLI can be pointed at an out-of-process
// prompt tool, and keeping it here means the driver files stay about their
// own protocol.
//
// The transport is a unix socket because the asking end is a separate
// process the CLI spawned, not something we can hand a callback to. One
// socket per turn, deleted when the turn ends.
import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

export interface PendingAsk {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  at: number;
}

export interface ResolvedAsk extends PendingAsk {
  behavior: string;
  /** Who ended it: the person, a timeout, or the turn finishing. */
  source: string;
}

/** Fifteen minutes. Long enough to answer a card you noticed on your phone
 * after a meeting; short enough that a forgotten turn eventually releases
 * the agent instead of pinning a process open indefinitely. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/**
 * What an unanswered request resolves to.
 *
 * The two cases pull in opposite directions and that is the point. An
 * unanswered *permission* denies, because doing something consequential
 * that nobody approved is the one outcome worth ruling out. An unanswered
 * *question* answers with guidance instead, because a question is not a
 * gate: refusing it would strand a turn that could have finished fine.
 */
const TIMED_OUT_PERMISSION =
  "Bloks: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const TIMED_OUT_QUESTION = "Bloks: nobody answered in time. Use your best judgment and continue.";
const TURN_ENDED_PERMISSION = "Bloks: the turn ended";
const TURN_ENDED_QUESTION = "Bloks: the turn is ending, wrap up.";

/** One readable line describing what is being asked, for the card. The
 * useful field moves around by tool, so the likely ones are tried in the
 * order that produces the most informative summary. */
export function summarise(ask: PendingAsk): string {
  const input = ask.input ?? {};
  if (typeof input.question === "string") return input.question.slice(0, 300);
  // AskUserQuestion nests its prompts: {questions: [{question, options}]}.
  // The person should read the question, never the envelope around it.
  if (Array.isArray(input.questions) && typeof input.questions[0]?.question === "string") {
    const first = input.questions[0].question.slice(0, 300);
    return input.questions.length > 1 ? `${first} (+${input.questions.length - 1} more)` : first;
  }
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.url === "string") return input.url.slice(0, 200);

  const serialised = JSON.stringify(input);
  return serialised === "{}" ? (ask.tool ?? "tool") : serialised.slice(0, 200);
}

export interface AskBrokerOptions {
  socketPath: string;
  /** A request has arrived and needs to reach the user. */
  onAsk: (ask: PendingAsk) => void;
  /** It has been settled, however that happened. */
  onResolve: (resolved: ResolvedAsk) => void;
  timeoutMs?: number;
}

export interface AskBroker {
  /** Deliver a person's decision. False when the id is unknown, which
   * usually means it already timed out. */
  answer(askId: string, behavior: string, message?: string): boolean;
  /** End the turn: settle anything still open and remove the socket. */
  close(): void;
}

export function createAskBroker(options: AskBrokerOptions): AskBroker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  interface Entry {
    ask: PendingAsk;
    settle: (behavior: string, message: string | undefined, source: string) => void;
  }
  const open = new Map<string, Entry>();

  // A stale socket file from a process that died badly would make bind
  // fail. Nothing else can legitimately own this path.
  try {
    unlinkSync(options.socketPath);
  } catch {
    /* nothing there, which is the normal case */
  }

  const server: Server = createServer((connection) => {
    // The proxy going away is ordinary (its CLI exited); the turn's own
    // settle path handles the consequences.
    connection.on("error", () => {});

    let pending = "";
    connection.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const cut = pending.indexOf("\n");
        if (cut === -1) break;
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 1);

        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.t !== "ask") continue;

        const id = String(frame.id ?? randomUUID());
        const kind = frame.kind === "question" ? ("question" as const) : ("permission" as const);
        const ask: PendingAsk = {
          id,
          kind,
          tool: frame.tool ?? "tool",
          input: frame.input ?? {},
          at: Date.now(),
        };

        const settle = (behavior: string, message: string | undefined, source: string) => {
          // delete() doubles as the guard: whoever removes it first wins,
          // so a timeout racing a tap cannot answer twice.
          if (!open.delete(id)) return;
          clearTimeout(timer);
          try {
            connection.write(JSON.stringify({ t: "answer", id, behavior, message }) + "\n");
          } catch {
            /* the proxy is gone; the turn is ending anyway */
          }
          options.onResolve({ ...ask, behavior, source });
        };

        const timer = setTimeout(() => {
          if (kind === "question") settle("answer", TIMED_OUT_QUESTION, "timeout");
          else settle("deny", TIMED_OUT_PERMISSION, "timeout");
        }, timeoutMs);
        // never hold the process open just to expire a card
        timer.unref?.();

        open.set(id, { ask, settle });
        options.onAsk(ask);
      }
    });
  });

  server.on("error", () => {});
  server.listen(options.socketPath);

  return {
    answer(askId, behavior, message) {
      const entry = open.get(askId);
      if (!entry) return false;

      // A question cannot be allowed or denied and a permission cannot be
      // answered with prose. Rejecting the mismatch here keeps a malformed
      // client from putting the CLI into a state it has no contract for.
      const permitted = entry.ask.kind === "question" ? ["answer"] : ["allow", "deny"];
      if (!permitted.includes(behavior)) return false;

      entry.settle(behavior, message, "user");
      return true;
    },

    close() {
      for (const entry of [...open.values()]) {
        if (entry.ask.kind === "question") {
          entry.settle("answer", TURN_ENDED_QUESTION, "shutdown");
        } else {
          entry.settle("deny", TURN_ENDED_PERMISSION, "shutdown");
        }
      }
      try {
        server.close();
      } catch {
        /* already down */
      }
      try {
        unlinkSync(options.socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}
