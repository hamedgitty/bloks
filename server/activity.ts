// What is happening right now, and what it is costing.
//
// A workspace with ten agents in it accumulates work nobody is watching. A
// routine fires into a background lane at nine in the morning. A job is
// offered to three agents in turn and one of them takes it. A workflow
// parks on an approval and waits a day for an answer. Each of those is
// visible, but only from the surface that owns it, and only if you think
// to go and look.
//
// So this is one place that answers two questions. What is running, and
// what is waiting on me. Everything it shows is already tracked somewhere
// else; the work here is joining it up and saying why each thing is
// happening, which is the part nothing else does.
//
// Three decisions.
//
//   Waiting comes before running. A turn that is working needs nothing
//   from anybody, and a card that has been open since yesterday does. An
//   overlay that sorted by start time would bury the only rows that
//   actually want a person.
//
//   Every row says what set it off. "Sage is busy" is the fact the sidebar
//   already gives you; "Sage is busy because the 9am routine fired" is the
//   one worth opening a panel for, and it is the only thing here that
//   cannot be read off any single store.
//
//   Cost is what was spent, never what is left. Same rule as
//   server/usage.ts, for the same reason: Bloks does not resell tokens, so
//   the ceiling belongs to whoever you signed in with and inventing a
//   denominator would be a lie. Today's spend is the honest number.
import type { Message } from "./store.ts";

/** Why a lane is busy. */
export type WorkKind = "you" | "routine" | "job" | "workflow";

/** Why a lane is stopped. */
export type WaitKind = "approval" | "workflow";

export interface Spend {
  turns: number;
  input: number;
  output: number;
  cost: number;
  /** Turns whose engine said nothing about tokens, so a zero above is
   * "not reported" rather than "nothing used". */
  unmeasured?: number;
}

const noSpend = (): Spend => ({ turns: 0, input: 0, output: 0, cost: 0 });

/** A lane, as the caller finds it. Everything else here is derived. */
export interface Lane {
  threadId: string;
  botId: string;
  botName: string;
  laneTitle: string;
  busy: boolean;
  /** When the turn began. Absent when the caller does not know, which
   * happens for a turn that was already running before a restart. */
  since?: number;
  context?: { used: number; limit: number; fraction: number };
  /** A room rather than an agent's lane. A gate can park on a room's card
   * and somebody still has to answer it, so it belongs in the waiting
   * list; it does not belong in a tally of what each agent is doing. */
  room?: boolean;
}

/** A card a lane has stopped on. */
export interface Block {
  messageId: string;
  /** The card's own words, so a row reads without opening it. */
  asks: string;
  since: number;
  kind: WaitKind;
  /** Only a workflow gate has a deadline. */
  until?: number;
  /** Set for a workflow gate, so answering can find the run. */
  runId?: string;
}

export interface RunningWork extends Lane {
  kind: WorkKind;
  because: string;
}

export interface WaitingWork extends Block {
  threadId: string;
  botId: string;
  botName: string;
  laneTitle: string;
}

export interface AgentRoll {
  botId: string;
  botName: string;
  running: number;
  waiting: number;
  today: Spend;
}

/** A computer somebody has taken over. The agent is not stuck, it is
 * waiting, and those read the same in a list unless one says so. */
export interface Paused {
  botId: string;
  botName: string;
  since: number;
  why: string;
  /** How much the hold has turned away. A hold that stops things should
   * be able to say how many, or it reads as a label rather than a gate. */
  turnedAway: number;
}

export interface Activity {
  waiting: WaitingWork[];
  running: RunningWork[];
  paused: Paused[];
  agents: AgentRoll[];
  today: Spend;
  /** False when nothing in range reported a price, so the interface can
   * leave cost out rather than showing a zero that means "unknown". */
  costKnown: boolean;
  at: number;
}

/**
 * The card a lane has stopped on, or null.
 *
 * The one definition, used both by the roster's own lane state and by the
 * overlay, because two rules for "is this waiting on me" is how a lane
 * ends up reading as idle in one place and blocked in another.
 *
 * A question only counts while somebody can still hear the answer. A turn
 * that errored out, or a server that restarted, leaves the card on screen
 * with nothing behind it, and sending a person to a dead door is worse
 * than saying nothing.
 */
export function blockedOn(
  messages: Message[],
  live: {
    /** Is this engine permission request still open. */
    request: (requestId: string) => boolean;
    /** Is this workflow run still parked on its gate. */
    run: (runId: string) => { until: number; name: string } | null;
  },
  /**
   * Whether a gate somebody put aside still counts.
   *
   * Two different questions are being asked of this function and they
   * have different answers. The activity list asks "what is still
   * waiting on me anywhere", and a gate put aside is: the run is parked
   * and only that list can reach it now. A lane asks "what would I find
   * if I opened this", and a gate put aside is not, because the card is
   * hidden and the lane would open on nothing. Saying "needs you" and
   * then showing an empty chat is the dead door this file exists to
   * avoid, so the lane gets the narrower answer by default.
   */
  { includingPutAside = false }: { includingPutAside?: boolean } = {},
): Block | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const card = message.card;
    if (message.kind !== "options" || !card || card.answered) continue;

    // Putting a card aside hides it in the chat. For an approval that is
    // the end of it: dismissing one denies the request, and there is
    // nothing left waiting. A workflow gate is not the same. The run
    // stays parked with a deadline whatever the chat shows, so a
    // dismissed gate has to keep its row in the list that can still
    // reach it, or the only way back is gone and the run quietly times
    // out.
    if (card.dismissed && !(card.runId && includingPutAside)) continue;

    if (card.requestId && live.request(card.requestId)) {
      return {
        messageId: message.id,
        asks: card.subtitle || card.title || "a question",
        since: message.at ?? 0,
        kind: "approval",
      };
    }
    if (card.runId) {
      const parked = live.run(card.runId);
      if (parked) {
        return {
          messageId: message.id,
          asks: card.title || card.subtitle || "a question",
          since: message.at ?? 0,
          kind: "workflow",
          until: parked.until,
          runId: card.runId,
        };
      }
    }
  }
  return null;
}

/**
 * Whether a message, as it lands, asks something of the person: an
 * approval or a question a turn is waiting on, a workflow gate, a team a
 * lead wants to hire, a key or a connection asked for, a decision put to
 * them. Who started the turn does not matter here. A routine that stops
 * on an approval at nine in the morning wants the person as much as a
 * turn they started does.
 *
 * Wider than blockedOn on purpose: that asks whether a lane is stopped
 * right now, with somebody still listening, and this asks whether the
 * conversation just turned to the person, which a decision or a key does
 * without stopping anything.
 */
export function asksYou(message: Message): boolean {
  if (!asked(message)) return false;
  if (message.kind === "options") return !message.card?.answered && !message.card?.dismissed;
  if (message.kind === "secret") return message.secret?.status === "needs-value";
  if (message.kind === "connector") return message.connector?.status === "needs-auth";
  return message.decisionChoice === undefined;
}

/** Whether a message is one of those asks at all, settled since or not:
 * read back from a transcript, a card answered an hour later still asked
 * the person something at the moment it was written. */
function asked(message: Message): boolean {
  if (message.agent || message.afterAgent || message.deleted) return false;
  if (message.kind === "options") {
    const card = message.card;
    return Boolean(card && (card.requestId || card.runId || card.team));
  }
  if (message.kind === "secret") return Boolean(message.secret);
  if (message.kind === "connector") return Boolean(message.connector);
  return message.kind === "component" && message.component?.kind === "decision";
}

/**
 * Whether a message just written is the conversation turning toward the
 * person, which is what moves a row up the sidebar (GitHub 156).
 *
 * Two ways. Anything that asks something of them (asksYou). And a reply,
 * but only in a turn the person started: `yourTurn` is the caller's to
 * know, because a reply to a routine and a reply to the person read the
 * same. An agent answering another agent, a routine, a watcher or a job
 * waking it, does not count, or a team that talks among itself all day
 * would reshuffle the list all day.
 *
 * The person's own messages are not decided here. By the time one is in
 * a transcript it looks like a routine's prompt or a job's offer, so the
 * routes the person speaks through say so themselves.
 */
export function towardYou(message: Message, yourTurn: boolean): boolean {
  if (asksYou(message)) return true;
  if (!yourTurn || message.role !== "bot" || message.agent || message.afterAgent || message.event) return false;
  return message.kind === "text" || message.kind === "component" || message.kind === "artifact";
}

/** Whether a message reads as the person's own: typed by them, here,
 * rather than arriving from a watcher, an email or a webhook, from
 * another agent, or from a member of a shared room. */
function yours(message: Message): boolean {
  return message.role === "user" && message.kind === "text" && !message.agent && !message.author && !message.via;
}

/**
 * The last moment a transcript had something to do with the person, or
 * 0. Used once, to start a workspace from before this was kept with an
 * order that already means something, so it reads the transcript the
 * only way a transcript can be read: the person's own messages, anything
 * that asked something of them, and a reply that came after one of
 * theirs. A routine's prompt is written like the person's, so the caller
 * leaves out the lanes routines and other background work run in.
 */
export function lastWithYou(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (yours(message) || asked(message)) return message.at ?? 0;
    if (!towardYou(message, true)) continue;
    // a reply counts when the last thing said to it was the person
    for (let j = i - 1; j >= 0; j--) {
      const before = messages[j];
      if (before.role !== "user") continue;
      if (yours(before)) return message.at ?? 0;
      break;
    }
  }
  return 0;
}

/** What set this lane off, in the words a person would use. */
export function whyBusy(
  threadId: string,
  sources: {
    routines: Map<string, string>;
    jobs: Map<string, string>;
    workflows: Map<string, { name: string; step: string }>;
  },
): { kind: WorkKind; because: string } {
  const routine = sources.routines.get(threadId);
  if (routine) return { kind: "routine", because: `the routine ${routine}` };
  const job = sources.jobs.get(threadId);
  if (job) return { kind: "job", because: `a job from the board: ${job}` };
  const workflow = sources.workflows.get(threadId);
  if (workflow) {
    return { kind: "workflow", because: `${workflow.name}, at ${workflow.step}` };
  }
  return { kind: "you", because: "you asked" };
}

export interface AssembleInput {
  lanes: Array<Lane & { blocked?: Block | null }>;
  routines: Map<string, string>;
  jobs: Map<string, string>;
  workflows: Map<string, { name: string; step: string }>;
  /** Today's spend per agent, from server/usage.ts. */
  spend: Array<{ botId: string } & Spend>;
  paused?: Paused[];
  costKnown: boolean;
  at: number;
}

/**
 * Everything happening, in the order somebody would want to see it.
 *
 * Waiting first, oldest first inside each group. A card that has been open
 * longest is the one most likely to have been forgotten, and a turn that
 * has been running longest is the one most likely to be stuck.
 */
export function assemble(input: AssembleInput): Activity {
  const waiting: WaitingWork[] = [];
  const running: RunningWork[] = [];

  for (const lane of input.lanes) {
    const { blocked, ...rest } = lane;
    if (blocked) {
      waiting.push({
        ...blocked,
        threadId: lane.threadId,
        botId: lane.botId,
        botName: lane.botName,
        laneTitle: lane.laneTitle,
      });
      // A lane can be blocked and busy at once: a turn that asked and is
      // still holding the question open. It belongs in one list, and the
      // list that wants a person wins.
      continue;
    }
    if (rest.busy) {
      running.push({ ...rest, ...whyBusy(lane.threadId, input) });
    }
  }

  waiting.sort((a, b) => a.since - b.since);
  running.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));

  const spent = new Map(input.spend.map((s) => [s.botId, s]));
  const seen = new Map<string, AgentRoll>();
  const roll = (botId: string, botName: string): AgentRoll => {
    let row = seen.get(botId);
    if (!row) {
      const today = spent.get(botId);
      row = {
        botId,
        botName,
        running: 0,
        waiting: 0,
        today: today
          ? {
              turns: today.turns,
              input: today.input,
              output: today.output,
              cost: today.cost,
              ...(today.unmeasured ? { unmeasured: today.unmeasured } : {}),
            }
          : noSpend(),
      };
      seen.set(botId, row);
    }
    return row;
  };

  const rooms = new Set(input.lanes.filter((lane) => lane.room).map((lane) => lane.botId));
  for (const work of running) if (!rooms.has(work.botId)) roll(work.botId, work.botName).running++;
  for (const work of waiting) if (!rooms.has(work.botId)) roll(work.botId, work.botName).waiting++;
  // An agent that spent something today belongs in the tally even with
  // nothing running, or the sum of the rows would not match the total.
  for (const s of input.spend) {
    const named = input.lanes.find((lane) => lane.botId === s.botId);
    if (named) roll(s.botId, named.botName);
  }

  const today = noSpend();
  for (const s of input.spend) {
    today.turns += s.turns;
    today.input += s.input;
    today.output += s.output;
    today.cost += s.cost;
    if (s.unmeasured) today.unmeasured = (today.unmeasured ?? 0) + s.unmeasured;
  }

  const agents = [...seen.values()].sort(
    (a, b) =>
      b.waiting - a.waiting ||
      b.running - a.running ||
      b.today.input + b.today.output - (a.today.input + a.today.output),
  );

  return {
    waiting,
    running,
    paused: input.paused ?? [],
    agents,
    today,
    costKnown: input.costKnown,
    at: input.at,
  };
}

/** One line for the ambient counter, or null when nothing is happening. */
export function tally(activity: Pick<Activity, "waiting" | "running">): string | null {
  const bits: string[] = [];
  if (activity.waiting.length) {
    bits.push(`${activity.waiting.length} waiting on you`);
  }
  if (activity.running.length) {
    bits.push(`${activity.running.length} running`);
  }
  return bits.length ? bits.join(", ") : null;
}
