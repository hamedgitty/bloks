// Whose file is it: the turns that write into an agent's files.
//
// An agent has one folder of deliverables, and every conversation it has
// saves into it. A turn's cards come from a snapshot of the folder when it
// began and another when it ends (server/artifacts.ts), which answers
// exactly while the agent has one turn running. Two conversations of one
// agent working at once both see a new file appear between their two
// snapshots, and the file used to become a card in both, under a reply
// that had nothing to do with it (GitHub 460).
//
// So, as the change card does for a shared working folder (GitHub 153,
// server/checkpoints.ts), a turn knows which other turns of its agent
// overlapped it, kept for as long as both ran so one that came and went in
// the middle still counts. A turn that ran alone claims everything that
// changed, as it always did. One that overlapped others claims a file only
// on the strongest evidence any of them has for it, in this order:
//
//   1. its engine said it wrote the file (a write or edit naming it, or
//      the outbox it brought back from working elsewhere);
//   2. it said the file's name, in a command it ran or in its reply;
//   3. a call of its that may write files without naming them (a shell
//      command) was running when the file was last written.
//
// A file two turns both have the best evidence for at one of the first two
// levels is both of theirs: they both worked on it. At the third, two
// commands running at the same moment say nothing about which one wrote
// it, and a file nobody has any evidence for is nobody's. Neither becomes
// a card on its own: a card under the wrong reply is the bug this is here
// to fix, and the file is still in the agent's files, where the agent can
// share it on purpose.
//
// Sharing on purpose settles it. A file shared into a conversation is
// carded there and then; the turn that shared it does not card it again,
// and no other turn running at the time cards that version of it.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import * as artifacts from "./artifacts.ts";

/** How far either side of a call a write still counts as made during it:
 * a file's time is the disk's and a call's are when its events arrived,
 * which are close but not the same clock reading. */
const WINDOW_SLACK_MS = 500;
/** What a turn said that is kept to look for names in. A name is short;
 * a reply that runs past this has said what it was going to say. */
const MAX_WORDS = 256 * 1024;

interface Turn {
  botId: string;
  /** The folder as it was when the turn began: name to fingerprint. */
  before: Map<string, string>;
  /** Where relative paths its engine names are read from. */
  cwd?: string;
  /** Still running. A finished turn is kept while a running turn it
   * overlapped may still need its evidence. */
  running: boolean;
  /** The other turns of the agent that overlapped it. */
  alongside: Set<string>;
  /** Files its engine said it wrote, by name inside the folder. */
  named: Set<string>;
  /** What it ran and replied, to find a file's name in. */
  words: string;
  /** Calls that may have written something, from start to end. */
  calls: Map<string, { from: number; to?: number }>;
  /** Versions shared on purpose while it ran, which it leaves alone. */
  handled: Map<string, string>;
  endedAt?: number;
}

export class ArtifactTurns {
  private turns = new Map<string, Turn>();
  private unnamedCalls = 0;
  private readonly now: () => number;
  /** Whether a lane's turn is really still running. A turn that ended
   * without being finished here (a crash, a path that forgot) would
   * otherwise overlap every turn its agent takes from then on. */
  private readonly alive: (taskId: string) => boolean;

  constructor(opts: { now?: () => number; alive?: (taskId: string) => boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.alive = opts.alive ?? (() => true);
  }

  /** A turn beginning: the folder as it is now, and every other turn of
   * the agent already running overlaps this one. */
  begin(taskId: string, botId: string) {
    this.drop(taskId);
    const turn: Turn = {
      botId,
      before: artifacts.snapshot(botId),
      running: true,
      alongside: new Set(),
      named: new Set(),
      words: "",
      calls: new Map(),
      handled: new Map(),
    };
    for (const [id, other] of [...this.turns]) {
      if (!other.running || other.botId !== botId) continue;
      if (!this.alive(id)) {
        this.drop(id);
        continue;
      }
      other.alongside.add(taskId);
      turn.alongside.add(id);
    }
    this.turns.set(taskId, turn);
    this.prune();
  }

  /** Whether a turn is being watched, for a caller deciding whether there
   * is anything to sweep. */
  has(taskId: string): boolean {
    return this.turns.get(taskId)?.running === true;
  }

  /** The folder the turn's engine works in, for the relative paths it
   * names. */
  workingIn(taskId: string, cwd: string | null | undefined) {
    const turn = this.live(taskId);
    if (turn && cwd) turn.cwd = cwd;
  }

  /** A tool call starting. `paths` are the files it says it writes; a
   * call that may write without saying which (`mayWrite`) is timed, so a
   * file written while it ran can be laid at its door. */
  call(taskId: string, call: { itemId?: string; paths?: readonly string[]; mayWrite?: boolean; command?: string }) {
    const turn = this.live(taskId);
    if (!turn) return;
    if (call.paths?.length) this.noteNamed(turn, call.paths);
    if (call.command) this.say(taskId, call.command);
    if (call.paths?.length || call.mayWrite) {
      turn.calls.set(call.itemId ?? `unnamed-${++this.unnamedCalls}`, { from: this.now() });
    }
  }

  /** A tool call ending. One that never ends is taken to have run until
   * its turn did. */
  callEnded(taskId: string, itemId: string | undefined) {
    const span = itemId ? this.live(taskId)?.calls.get(itemId) : undefined;
    if (span && span.to === undefined) span.to = this.now();
  }

  /** Words the turn said: its reply, or a command it ran. */
  say(taskId: string, text: string) {
    const turn = this.live(taskId);
    if (!turn || typeof text !== "string" || !text) return;
    if (turn.words.length >= MAX_WORDS) return;
    turn.words = `${turn.words}\n${text}`.slice(0, MAX_WORDS);
  }

  /** Names the turn brought into the folder itself, as a turn working
   * elsewhere does with its outbox when it ends: its own by the best
   * evidence there is. */
  brought(taskId: string, names: readonly string[]) {
    const turn = this.live(taskId);
    if (!turn) return;
    for (const name of names) {
      const clean = artifacts.safeName(name);
      if (clean) turn.named.add(clean);
    }
  }

  /**
   * A file shared on purpose, already a card in the conversation it was
   * shared into. `lanes` are that conversation's turn and the turn that
   * shared it, which do not card this version again; every other turn of
   * the agent running now leaves this version alone too.
   */
  shared(botId: string, name: string, lanes: readonly string[]) {
    const print = artifacts.fingerprint(botId, name);
    if (!print) return;
    for (const [id, turn] of this.turns) {
      if (!turn.running || turn.botId !== botId) continue;
      if (lanes.includes(id)) turn.before.set(name, print);
      else turn.handled.set(name, print);
    }
  }

  /** A turn that never ran, forgotten. */
  cancel(taskId: string) {
    this.drop(taskId);
    this.prune();
  }

  /** The turn ending: the files it made or changed, newest last, and the
   * turn forgotten once no running turn needs what it knew. Empty for a
   * turn that was never begun. */
  finish(taskId: string): artifacts.ArtifactInfo[] {
    const turn = this.live(taskId);
    if (!turn) return [];
    turn.running = false;
    turn.endedAt = this.now();
    const changed = artifacts.changedSince(turn.botId, turn.before).filter((file) => {
      const handled = turn.handled.get(file.name);
      return !handled || handled !== file.print;
    });
    const others = [...turn.alongside].map((id) => this.turns.get(id)).filter((t): t is Turn => Boolean(t));
    const mine = others.length
      ? changed.filter((file) => {
          const own = this.evidence(turn, file.name, file.at);
          if (own === 0) return false;
          const best = Math.max(0, ...others.map((other) => this.evidence(other, file.name, file.at)));
          // at the first two levels a tie is two turns that both worked on
          // it; at the third it is two commands that ran at once
          return own > best || (own === best && own >= 2);
        })
      : changed;
    this.prune();
    return mine.map(({ name, mime, size }) => ({ name, mime, size }));
  }

  /** 3: its engine named the file. 2: it said the name. 1: something of
   * its that may write unnamed files ran when the file was written. */
  private evidence(turn: Turn, name: string, at: number): number {
    if (turn.named.has(name)) return 3;
    if (saysName(turn.words, name)) return 2;
    for (const span of turn.calls.values()) {
      const to = span.to ?? turn.endedAt ?? this.now();
      if (at >= span.from - WINDOW_SLACK_MS && at <= to + WINDOW_SLACK_MS) return 1;
    }
    return 0;
  }

  /** Paths as an engine says them, absolute or relative to where it
   * works, kept when they land in the agent's folder. */
  private noteNamed(turn: Turn, paths: readonly string[]) {
    const root = artifacts.artifactsDir(turn.botId);
    let real = root;
    try {
      real = realpathSync(root);
    } catch {}
    const inside = (base: string, path: string) => {
      const rel = relative(base, path);
      return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
    };
    for (const path of paths) {
      if (typeof path !== "string" || !path) continue;
      if (!isAbsolute(path) && !turn.cwd) continue;
      const full = resolve(turn.cwd ?? root, path);
      // an engine may name the folder by where it really is, every link
      // followed (any temporary folder on a Mac), or the way it was told
      const rel = inside(root, full) ?? inside(real, full);
      const clean = rel ? artifacts.safeName(rel) : null;
      if (clean) turn.named.add(clean);
    }
  }

  private live(taskId: string): Turn | undefined {
    const turn = this.turns.get(taskId);
    return turn?.running ? turn : undefined;
  }

  private drop(taskId: string) {
    if (!this.turns.delete(taskId)) return;
    for (const other of this.turns.values()) other.alongside.delete(taskId);
  }

  /** Finished turns no running turn overlapped, let go. */
  private prune() {
    const needed = new Set<string>();
    for (const turn of this.turns.values()) if (turn.running) for (const id of turn.alongside) needed.add(id);
    for (const [id, turn] of this.turns) if (!turn.running && !needed.has(id)) this.turns.delete(id);
  }
}

/** Whether the words say this file's name as a name: on its own, or at
 * the end of a path, not inside a longer one ("meeting-notes.md" does not
 * say "notes.md"). */
export function saysName(words: string, name: string): boolean {
  let at = words.indexOf(name);
  while (at !== -1) {
    const before = at === 0 ? "" : words[at - 1];
    const after = words[at + name.length] ?? "";
    if (!/[\w.-]/.test(before) && !/[\w-]/.test(after)) return true;
    at = words.indexOf(name, at + 1);
  }
  return false;
}
