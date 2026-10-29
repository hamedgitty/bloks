// What happens to a message sent while the agent is in the middle of a
// turn.
//
// Until now there was one answer: the person's words went into the
// running turn whenever its engine could take them, and waited for the
// turn to end when it could not (see Queued messages in
// docs/ARCHITECTURE.md). That is right for "no, the other folder" and
// wrong for "also, when you're done, book the table": the second is a
// new piece of work, and pushing it into a turn halfway through another
// one muddles both.
//
// So each message is read first, and a person can say how they want it
// once, per agent or for the workspace:
//
//   Automatic  reads the message. A stop stops; a correction, a "wait",
//              an answer to what the agent just asked, or something
//              urgent goes in now; everything else waits its turn.
//   Interrupt  everything goes in now, as before this existed.
//   Queue      everything waits for the turn to end.
//
// "Goes in now" means the gentlest way the engine has. Claude Code and
// Codex take words mid-turn and read them after the step they are on,
// with nothing thrown away (steerTurn). An engine that cannot is stopped,
// and the message starts the next turn, which is what Command-Enter has
// always done.
//
// Reading is rules first, because they are instant, free and the same
// every time, and a person can predict them. Only a message the rules
// have nothing to say about may be put to a model, only when the person
// asked for that (each ask is a call on their key), and only to the
// agent's own engine when it has a small one: the words go nowhere they
// were not already going, and a slow or failed answer just means wait.
// Whatever was decided is said in a quiet line under the message, and
// one tap goes the other way.

export type DeliveryMode = "auto" | "interrupt" | "queue";
export const DELIVERY_MODES: readonly DeliveryMode[] = ["auto", "interrupt", "queue"];

/** Why a message went the way it did. */
export type DeliveryWhy =
  | "stop"
  | "wait"
  | "correction"
  | "answer"
  | "urgent"
  | "later"
  | "other"
  /** the agent's or the workspace's mode said so, not the words */
  | "setting"
  /** the person chose, with the one tap */
  | "you"
  /** the rules had nothing to say and the small model did */
  | "model";

/** What to do with it. `now` is into the running turn (or stop and send
 * when the engine cannot take words mid-turn), `stop` is stop and send
 * whatever the engine can do, `queue` is after the turn. */
export type DeliveryRoute = "now" | "stop" | "queue";

export interface Reading {
  route: DeliveryRoute;
  why: DeliveryWhy;
  /** Whether the rules recognised anything. An unsure reading may be put
   * to a model; a sure one never is. */
  sure: boolean;
}

/** What actually happened, kept on the message for the line under it. */
export interface Delivery {
  route: "steered" | "stopped" | "queued" | "pending" | "uncertain" | "not-sent";
  why: DeliveryWhy;
  line: string;
}

/** A per-agent or workspace value, read safely: anything else is unset. */
export function deliveryMode(value: unknown): DeliveryMode | undefined {
  return DELIVERY_MODES.includes(value as DeliveryMode) ? (value as DeliveryMode) : undefined;
}

/** The mode that applies: the agent's own, then the workspace's, then
 * Automatic. */
export function resolveMode(agent: unknown, workspace: unknown): DeliveryMode {
  return deliveryMode(agent) ?? deliveryMode(workspace) ?? "auto";
}

// ── reading the words ──────────────────────────────────────────────────

/** Plain lower case words, without the punctuation people lead with. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^[\s"'*_>~.,!?-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = /\b(stop|halt|abort|cancel|enough|nevermind|never mind|nvm|scrap (?:that|it|this)|forget (?:it|that|this)|kill it)\b/;
const WAIT_LEAD = /^(wait|hold on|hold up|hang on|one sec(ond)?|one moment|just a (sec|second|moment|minute)|pause|whoa|woah)\b/;
/** Words that put a message after the work in hand, said outright. */
const LATER = /\b(when you'?re (done|finished|free)|when you (finish|are done|get a (chance|moment|minute))|once you'?re (done|finished)|once you (finish|are done)|after (that|this|you'?re done|you finish|you are done)|afterwards|no rush|no hurry|whenever you can|later on|later today|next time|by the way|btw)\b/;
/** A message that opens by taking back or changing what was asked. */
const CORRECTION_LEAD = /^(no|nope|nah|not that|not quite|not yet|actually|instead|correction|sorry,? i meant|i meant|scratch that|rather|change of plans?|on second thought|oops|whoops|wrong|that'?s (wrong|not (it|right|what i))|don'?t|do not|please don'?t|please do not|stop doing|undo|revert)\b/;
/** "no" that is only politeness. */
const NOT_A_NO = /^no (worries|problem|need|pressure|rush|hurry|big deal|thanks)\b/;
/** A change of course said in the middle of a short message. */
const CORRECTION_ANYWHERE = /\b(instead|rather than|not what i (asked|meant|wanted)|you misunderstood|that'?s wrong)\b/;
const URGENT = /\b(urgent(ly)?|asap|right now|right away|immediately|emergency|critical)\b/;

/**
 * What the words alone say, before any setting.
 *
 * `asked` is whether the agent's latest words in this turn end on a
 * question: then a short reply that is not itself a question is taken as
 * the answer to it.
 */
export function classify(text: string, context: { asked?: boolean } = {}): Reading {
  const t = plain(text);
  if (!t) return { route: "queue", why: "other", sure: false };
  const words = t.split(" ");
  // "stop", "ok stop", "please cancel that": short, and only that. A long
  // message that starts with "cancel" is an instruction, not a brake.
  if (words.length <= 4 && STOP_WORDS.test(t) && !/\b(don'?t|do not|never|no need to|not) (stop|cancel|abort)\b/.test(t)) {
    return { route: "stop", why: "stop", sure: true };
  }
  if (WAIT_LEAD.test(t)) return { route: "now", why: "wait", sure: true };
  if (LATER.test(t)) return { route: "queue", why: "later", sure: true };
  if (CORRECTION_LEAD.test(t) && !NOT_A_NO.test(t)) return { route: "now", why: "correction", sure: true };
  if (t.length <= 300 && CORRECTION_ANYWHERE.test(t)) return { route: "now", why: "correction", sure: true };
  if (URGENT.test(t) || /!!/.test(text)) return { route: "now", why: "urgent", sure: true };
  if (context.asked && text.trim().length <= 300 && !/\?\s*$/.test(text.trim())) return { route: "now", why: "answer", sure: true };
  return { route: "queue", why: "other", sure: false };
}

/** Whether the agent's latest words end on a question to the person. */
export function endsOnQuestion(agentText: string | undefined): boolean {
  const lines = (agentText ?? "").trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  // code fences and quoted output do not ask anything
  return /\?[\s"')\]*_]*$/.test(last) && !last.startsWith("```");
}

/**
 * What to do, with the mode applied. `choice` is the person's one tap,
 * which outranks both the mode and the words.
 */
export function plan(mode: DeliveryMode, text: string, context: { asked?: boolean } = {}, choice?: "now" | "wait"): Reading {
  if (choice === "now") return { route: "now", why: "you", sure: true };
  if (choice === "wait") return { route: "queue", why: "you", sure: true };
  if (mode === "queue") return { route: "queue", why: "setting", sure: true };
  const read = classify(text, context);
  if (mode === "interrupt") {
    // a stop is still a stop; everything else goes in now
    return read.route === "queue" ? { route: "now", why: "setting", sure: true } : { ...read, sure: true };
  }
  return read;
}

// ── a small model, when the rules have nothing to say ──────────────────

/** How long a send waits for the model before it waits for the turn. */
export const MODEL_DEADLINE_MS = 1_500;

/** The one question, with as little of the conversation as answers it. */
export function modelPrompt(text: string, agentText?: string): string {
  const said = (agentText ?? "").trim().slice(-600);
  return [
    "An AI agent is in the middle of a task. The person just sent the message below.",
    "Decide whether it changes or stops the task in progress (NOW), or is a separate request that can wait until the task is finished (WAIT).",
    "Answer with one word: NOW or WAIT.",
    said ? `\nThe agent last said:\n"""\n${said}\n"""` : "",
    `\nThe person's message:\n"""\n${text.slice(0, 1_200)}\n"""`,
  ].join("\n");
}

/** NOW or WAIT out of a reply, or null for anything else. */
export function readModelAnswer(reply: string): "now" | "wait" | null {
  const word = reply.trim().split(/\s+/)[0]?.replace(/[^a-z]/gi, "").toLowerCase();
  return word === "now" ? "now" : word === "wait" ? "wait" : null;
}

// ── what the person is told ────────────────────────────────────────────

const TAKES: Partial<Record<DeliveryWhy, string>> = {
  correction: "your correction",
  answer: "your answer",
};

/** The quiet line under a message, or above it while it waits. */
export function deliveryLine(route: Delivery["route"], why: DeliveryWhy, agent: string): string {
  if (route === "queued") return `Queued until ${agent} finishes`;
  if (route === "pending") return "Waiting for this turn to start";
  if (route === "uncertain") return "Delivery could not be confirmed";
  if (route === "not-sent") return "Not sent";
  if (why === "you") return route === "stopped" ? `Stopped ${agent} to send this now` : "Sent now, as you asked";
  if (route === "stopped") return why === "stop" ? `Stopped ${agent}` : `Stopped ${agent} to take ${TAKES[why] ?? "your message"}`;
  if (why === "urgent") return "Interrupted: this sounded urgent";
  return `Interrupted to take ${TAKES[why] ?? "your message"}`;
}

/** What the composer says before sending, for the same decision. */
export function previewLine(route: DeliveryRoute, why: DeliveryWhy, agent: string, canSteer: boolean): string {
  if (route === "queue") {
    return why === "you" ? `Waits until ${agent} finishes` : `Will wait until ${agent} finishes`;
  }
  if (route === "stop") return why === "stop" ? `Will stop ${agent}` : `Will stop ${agent} to send this`;
  const what = TAKES[why] ?? (why === "urgent" ? "this, as urgent" : "this");
  if (why === "you") return canSteer ? `Goes into ${agent}'s turn now` : `Will stop ${agent} to send this now`;
  return canSteer ? `Will interrupt to take ${what}` : `Will stop ${agent} to take ${what}`;
}
