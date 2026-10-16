// A finished turn's work, folded into one line (GitHub 257).
//
// While an agent works, everything it does on the way is worth seeing:
// it shows the agent is moving, what it is doing, and when to steer. Once
// the turn is over, all of that is only how it got there, and reading a
// conversation back meant scrolling past it to find what was asked and
// what came of it. So a turn that has ended keeps the request and the
// result on the page, and everything between them becomes one line that
// says how long it took, how much it did and who it wrote to, and opens
// back into the work with a click.
//
// Where a turn begins is read from the transcript: at a message from the
// person, another agent, a routine, a watcher, a webhook or a goal, unless
// that message says it went into a turn already running (`midTurn`, the
// one thing the server writes down for this). It ends where the next one
// begins, and the last one has ended once its conversation is no longer
// working. No fold is stored: the same messages fold the same way on
// every screen, and a transcript written before any of this folds too.
//
// This file decides what folds and what the line says. The components
// only draw it.
import type { Message } from "@/state/reducer";

/** Who started a turn, when it was not the person. */
export type Asker =
  | { by: "agent"; peerId: string; peerName: string; message: Message }
  | { by: "routine"; name?: string }
  | { by: "watcher" }
  | { by: "webhook" }
  | { by: "goal"; text: string };

/** One fold: the messages under it, and what its line is made of. */
export interface TurnFold {
  /** The first message under it, which stays the first as the fold grows
   * (a changes card arrives a moment after its turn ends). */
  key: string;
  messages: Message[];
  /** Where each of them sits in the transcript, for find and for links. */
  indices: number[];
  /** Named on the line when the turn was not the person's. */
  asker: Asker | null;
  /** In a room, whose work this is. */
  speaker?: string;
  /** From the turn's start to the last thing it did. */
  ms: number;
  /** Each tool call's label, as its row carries it. */
  tools: string[];
  /** Files the turn changed that are its own. */
  files: number;
  /** Other agents it wrote to, the one that asked left out. */
  messaged: Array<{ peerId: string; peerName: string }>;
  /** It wrote back to the agent that asked. */
  replied: boolean;
  /** Nothing was said to the person, so the line is all there is. */
  alone: boolean;
}

export interface SaidItem {
  message: Message;
  index: number;
}

/** A transcript as it is drawn: stretches of messages shown as they
 * always were, and the folds between them. */
export type TurnRow = { kind: "said"; items: SaidItem[] } | { kind: "fold"; fold: TurnFold };

export interface Folded {
  rows: TurnRow[];
  /** Replies whose "After a message from" link the line now says. */
  named: Set<string>;
  /** The newest folded turn's reply, which stays where it is on screen
   * when the fold closes over the work above it. */
  hold: SaidItem | null;
}

const MACHINES = new Set<Message["via"]>(["routine", "watcher", "webhook", "goal"]);

/** Somebody or something saying a thing to the agent. */
function said(m: Message): boolean {
  return m.role === "user" && m.kind === "text";
}

/** A person's own words: the owner's, or anyone's who wrote by mail or
 * from a chat app. These never fold, whoever started the turn. */
function personsWords(m: Message): boolean {
  return said(m) && !m.agent && !(m.via && MACHINES.has(m.via));
}

function startsTurn(m: Message): boolean {
  return said(m) && !m.midTurn;
}

/** Words the agent wrote in its own chat. A message to another agent is
 * a row, not one of these (older replies were marked dir "reply"). */
function botWords(m: Message): boolean {
  return m.role === "bot" && m.kind === "text" && (!m.agent || m.agent.dir === "reply") && !m.deleted && !m.quiet;
}

/** A card the person has dealt with, or that no longer waits on them. */
function settledCard(m: Message): boolean {
  if (m.kind === "options") return !m.card || Boolean(m.card.answered || m.card.dismissed || m.card.cutOff);
  if (m.kind === "connector") return !m.connector || m.connector.status === "connected" || m.connector.status === "dismissed";
  if (m.kind === "secret") return !m.secret || m.secret.status !== "needs-value";
  return false;
}

/**
 * Whether a message goes under the fold once its turn is over. What is
 * left out is what the person came back for or still has to act on:
 * their own words, a card that waits for them, a file or a component
 * made for them, and any notice. A message taken back and a quiet
 * check-in keep the rows they already have.
 */
function tucks(m: Message): boolean {
  if (m.deleted || m.quiet) return false;
  if (m.role === "user") return said(m) && !personsWords(m);
  switch (m.kind) {
    case "text":
    case "activity":
    case "screen":
      return true;
    case "changes":
      // a rehearsal still asks to be applied or discarded
      return m.changes?.rehearsal?.state !== "pending";
    case "options":
    case "connector":
    case "secret":
      return settledCard(m);
    default:
      return false;
  }
}

function askerOf(m: Message): Asker | null {
  if (m.agent?.dir === "in") return { by: "agent", peerId: m.agent.peerId, peerName: m.agent.peerName, message: m };
  if (m.via === "routine") return { by: "routine", ...(m.routine?.name ? { name: m.routine.name } : {}) };
  if (m.via === "watcher") return { by: "watcher" };
  if (m.via === "webhook") return { by: "webhook" };
  if (m.via === "goal") return { by: "goal", text: m.text ?? "" };
  return null;
}

/**
 * The fold over these messages, or null when there is nothing in them
 * worth a line: cards the person already answered are no work of the
 * turn's, and on their own they stay where they are (an agent's first
 * question under its greeting, say).
 */
function foldOver(
  all: readonly Message[],
  indices: number[],
  o: { asker: Asker | null; speaker?: string; from: number; to: number; alone: boolean },
): TurnFold | null {
  const messages = indices.map((i) => all[i]);
  if (messages.every(settledCard)) return null;
  const tools: string[] = [];
  const messaged: TurnFold["messaged"] = [];
  let files = 0;
  let replied = false;
  for (const m of messages) {
    if (m.agent?.dir === "out") {
      // one that was not delivered reached nobody
      if (m.agent.status === "failed" || m.agent.status === "uncertain") continue;
      if (o.asker?.by === "agent" && o.asker.peerId === m.agent.peerId) replied = true;
      else if (!messaged.some((p) => p.peerId === m.agent!.peerId)) messaged.push({ peerId: m.agent.peerId, peerName: m.agent.peerName });
    } else if (m.kind === "activity" && m.tool && !m.agent) {
      tools.push(m.tool.name);
    } else if (m.kind === "changes" && m.changes && m.changes.rehearsal?.state !== "discarded") {
      // only the turn's own: files that changed while others worked in
      // the folder are not counted as its work, here or on the card
      files += Math.max(0, m.changes.total - (m.changes.shared?.total ?? 0));
    }
  }
  return {
    key: messages[0].id,
    messages,
    indices,
    asker: o.asker,
    ...(o.speaker ? { speaker: o.speaker } : {}),
    ms: Math.max(0, o.to - o.from),
    tools,
    files,
    messaged,
    replied,
    alone: o.alone,
  };
}

/** When the last of these was said. */
function lastAt(all: readonly Message[], indices: readonly number[]): number {
  return indices.reduce((latest, i) => Math.max(latest, all[i].at ?? 0), 0);
}

/** The transcript in the order it is drawn, each fold where `before`
 * puts it and its messages gone from between the others. */
function lay(all: readonly Message[], folds: Array<{ fold: TurnFold; before: number }>): TurnRow[] {
  const under = new Set<number>();
  const at = new Map<number, TurnFold[]>();
  for (const { fold, before } of folds) {
    for (const i of fold.indices) under.add(i);
    at.set(before, [...(at.get(before) ?? []), fold]);
  }
  const rows: TurnRow[] = [];
  all.forEach((message, index) => {
    for (const fold of at.get(index) ?? []) rows.push({ kind: "fold", fold });
    if (under.has(index)) return;
    const last = rows[rows.length - 1];
    if (last?.kind === "said") last.items.push({ message, index });
    else rows.push({ kind: "said", items: [{ message, index }] });
  });
  return rows;
}

/**
 * Whether the open conversation's turn is still going. A lane that waits
 * on the person reads "needs-you" whether its turn is paused on a card,
 * ended long ago with its goal blocked, or is running beside a workflow
 * parked there. So there the card decides first: a question the agent is
 * still held on means the turn has not ended. Failing that, the agent's
 * own busy flag does, unless another of its conversations (`elsewhere`)
 * could be what it is busy with.
 */
export function turnRunning(
  state: "working" | "needs-you" | "idle" | undefined,
  busy: boolean,
  messages: readonly Message[],
  elsewhere = false,
): boolean {
  // a harness too old to say how each conversation is doing
  if (state === undefined) return busy;
  if (state !== "needs-you") return state === "working";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "options" && m.card?.requestId && !settledCard(m)) return true;
    if (startsTurn(m)) break;
  }
  return busy && !elsewhere;
}

/**
 * An agent's own conversation, folded. `running` is whether its last
 * turn is still going (turnRunning): that one is left exactly as it is,
 * because nothing changes while a turn runs.
 */
export function foldTurns(messages: readonly Message[], running: boolean): Folded {
  const folds: Array<{ fold: TurnFold; before: number }> = [];
  const named = new Set<string>();
  let hold: SaidItem | null = null;

  const turn = (a: number, b: number) => {
    // What started it. Several can: a burst that waited goes as one turn.
    let h = a;
    while (h < b && startsTurn(messages[h])) h++;
    const head = messages.slice(a, h);
    // with the person among them, it is theirs and the line names nobody
    const first = head.some(personsWords) ? undefined : head.find((m) => !m.deleted);
    const asker = first ? askerOf(first) : null;
    // the result: the last thing the agent said in it
    let reply = -1;
    for (let j = h; j < b; j++) if (botWords(messages[j])) reply = j;
    // The person's words in the middle of a turn never fold, so the work
    // on either side of them is a fold of its own.
    const parts: Array<{ start: number; from: number; ins: number[] }> = [{ start: a, from: messages[a].at, ins: [] }];
    for (let j = a; j < b; j++) {
      const m = messages[j];
      if (j >= h && personsWords(m)) parts.push({ start: j, from: m.at, ins: [] });
      else if (j !== reply && tucks(m)) parts[parts.length - 1].ins.push(j);
    }
    let made = false;
    parts.forEach((part, k) => {
      if (!part.ins.length) return;
      const next = parts[k + 1];
      const mine = reply >= part.start && reply < (next?.start ?? b);
      const fold = foldOver(messages, part.ins, {
        asker: k === 0 ? asker : null,
        from: part.from,
        to: next ? next.from : lastAt(messages, mine ? [...part.ins, reply] : part.ins),
        alone: k === 0 && asker !== null && reply < 0,
      });
      if (!fold) return;
      // above the result even when all of it came after: a commit made
      // once the summary was written is still how the turn got there
      folds.push({ fold, before: mine && reply < part.ins[0] ? reply : part.ins[0] });
      made = true;
    });
    if (!made) return;
    hold = reply >= 0 ? { message: messages[reply], index: reply } : null;
    if (asker?.by === "agent") for (let j = h; j < b; j++) if (botWords(messages[j])) named.add(messages[j].id);
  };

  let start = 0;
  let head = true;
  for (let i = 0; i < messages.length; i++) {
    if (!startsTurn(messages[i])) head = false;
    else if (!head) {
      turn(start, i);
      start = i;
      head = true;
    }
  }
  if (!running && start < messages.length) turn(start, messages.length);
  return { rows: lay(messages, folds), named, hold };
}

/**
 * A room, folded: each agent's turn on its own. A room's transcript does
 * not say where an agent's turn began, so a turn is read as what one
 * agent did until somebody else spoke: the person, or another agent,
 * whose message is that agent's reply and stays. Two agents working at
 * once can split one turn in two that way, which leaves a progress
 * message on the page and never hides a reply.
 *
 * `working` is who is taking a turn in the room now, and from which
 * place in the transcript when that was seen (null when it was not: the
 * room was opened with the agent already at work, and then only its
 * latest stretch is taken as still going).
 */
export function foldRoom(messages: readonly Message[], working: ReadonlyMap<string, number | null>): Folded {
  const open = new Map<string, number[]>();
  const stretches: Array<{ from: string; all: number[] }> = [];
  const close = (except?: string) => {
    for (const [from, all] of [...open]) {
      if (from === except) continue;
      stretches.push({ from, all });
      open.delete(from);
    }
  };
  messages.forEach((m, i) => {
    if (m.role === "user") {
      if (m.kind === "text") close();
      return;
    }
    // the room's own lines are nobody's turn
    if (!m.from) return;
    if (m.kind === "text" && !m.deleted) close(m.from);
    const mine = open.get(m.from);
    if (mine) mine.push(i);
    else open.set(m.from, [i]);
  });
  close();

  const latest = new Map<string, number[]>();
  for (const s of stretches) if ((latest.get(s.from)?.[0] ?? -1) < s.all[0]) latest.set(s.from, s.all);

  const folds: Array<{ fold: TurnFold; before: number }> = [];
  for (const { from, all } of stretches) {
    if (working.has(from)) {
      const since = working.get(from) ?? null;
      if (since === null ? latest.get(from) === all : all[all.length - 1] >= since) continue;
    }
    let reply = -1;
    for (const j of all) if (botWords(messages[j])) reply = j;
    const ins = all.filter((j) => j !== reply && tucks(messages[j]));
    if (!ins.length) continue;
    const fold = foldOver(messages, ins, {
      asker: null,
      speaker: from,
      from: messages[all[0]].at,
      to: lastAt(messages, reply >= 0 ? [...ins, reply] : ins),
      alone: false,
    });
    if (fold) folds.push({ fold, before: reply >= 0 && reply < ins[0] ? reply : ins[0] });
  }
  const rows = lay(messages, folds);
  // the reply under the fold drawn last, which is the one that just closed
  let hold: SaidItem | null = null;
  rows.forEach((row, at) => {
    if (row.kind !== "fold") return;
    const after = rows[at + 1];
    const under = after?.kind === "said" ? after.items[0] : undefined;
    hold = under && under.message.from === row.fold.speaker && botWords(under.message) ? under : null;
  });
  return { rows, named: new Set(), hold };
}

/** The rows of a long transcript's rendered tail. A fold that reaches
 * into it is drawn whole, so its line counts the whole turn. */
export function rowsFrom(rows: readonly TurnRow[], start: number): TurnRow[] {
  if (start <= 0) return [...rows];
  const shown: TurnRow[] = [];
  for (const row of rows) {
    if (row.kind === "fold") {
      if (row.fold.indices[row.fold.indices.length - 1] >= start) shown.push(row);
      continue;
    }
    const items = row.items.filter((item) => item.index >= start);
    if (items.length) shown.push({ kind: "said", items });
  }
  return shown;
}

/** The fold a message is under, if it is under one: a find hit or a
 * link that points at it has to open that fold to show it. */
export function foldHolding(rows: readonly TurnRow[], index: number): string | null {
  for (const row of rows) if (row.kind === "fold" && row.fold.indices.includes(index)) return row.fold.key;
  return null;
}

/** The fold drawn last, which changes when a turn ends and folds. */
export function lastFoldKey(rows: readonly TurnRow[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "fold") return row.fold.key;
  }
  return "";
}

function count(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** "40 sec", "8 min", "1 hr 5 min": how long a turn took, to the
 * nearest unit worth saying. */
export function workedFor(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} hr ${rest} min` : `${Math.floor(minutes / 60)} hr`;
}

/**
 * What the line counts: "worked 8 min", "27 commands", "4 files". Time,
 * counts and nothing else, in lower case for whoever joins them. Tool
 * calls are commands when every one of them was (`kindOf` is
 * tool-summary's), and steps when the turn also read, searched or
 * edited, since calling a file it read a command would be wrong.
 */
export function foldWords(fold: TurnFold, kindOf: (name: string) => string): string[] {
  const words = [`worked ${workedFor(fold.ms)}`];
  if (fold.tools.length) {
    words.push(count(fold.tools.length, fold.tools.every((name) => kindOf(name) === "command") ? "command" : "step"));
  }
  if (fold.files) words.push(count(fold.files, "file"));
  return words;
}

/**
 * Who started the turn, as the line opens. Another agent asked; the
 * rest are named the way their message's own label named them. `name`
 * is the agent's name now, which may not be the one it had then, and
 * `turn` is which turn of a goal's this was, where its note says.
 */
export function askerWords(asker: Asker, o: { name?: string; turn?: { of: number; budget: number } } = {}): string {
  switch (asker.by) {
    case "agent":
      return `${o.name ?? asker.peerName} asked`;
    case "routine":
      return `From your routine${asker.name ? ` ${asker.name}` : ""}`;
    case "watcher":
      return "From your watcher";
    case "webhook":
      return "From a webhook";
    case "goal":
      return o.turn ? `Toward your goal, turn ${o.turn.of} of ${o.turn.budget}` : "Toward your goal";
  }
}
