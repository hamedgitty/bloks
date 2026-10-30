// Moving a whole workspace between this Mac and the person's hosted
// machine, as one pipeline that runs either way.
//
// The pieces were already there. A server writes its workspace out to one
// file with every key left behind (server/workspace-move.ts), takes one in
// a part at a time (server/move-upload.ts), and puts it in place with a
// restart, the way a restore does. What this adds is the carrying: the
// app asks one side for the file a part at a time and hands each part to
// the other, through the hosted workspace's own connection when it is the
// hosted side, which is Bloks Cloud and takes one small request at a time.
// Each part's SHA-256 is said when the file is written, checked when the
// part is read here, and checked again where it lands; the whole file's
// too, before anything is put in place.
//
// The steps, in order: pairing (the hosted workspace listed and reachable,
// or the workspace on this Mac made), packing (the file written out),
// sending, unpacking (put in place there, which restarts it) and checking
// (agents, conversations, rooms, routines, watchers, workflows and memory
// files counted there, against what was written out). Then done.
//
// Nothing is ever merged. A move lands in an empty workspace, or, when the
// person chose it in so many words, in the copy it was moved out of,
// which it replaces whole. Until a move is checked, both sides stay as
// they were: the workspace it leaves is only paused (marked moving, so
// its routines, watchers, workflows and bots stop while it is carried, and
// started again if the move does not finish), and a move that landed but
// does not count up is taken back out there. A move that stopped, a
// window closed or an app quit, carries on from where it was: the parts
// already there stay there, and the state is kept on disk at app level
// (electron/main.mjs keeps it beside the licence and the plan).
//
// Plain Node, no Electron, so the tests can run it between two real
// servers (test/hosting-move.test.ts).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const STEPS = Object.freeze(["pairing", "packing", "sending", "unpacking", "checking", "done"]);
export const PHASES = Object.freeze(["waiting", "running", "stopped", "later", "failed", "done"]);
export const DIRECTIONS = Object.freeze(["to-hosted", "to-mac"]);

/** Parts in flight at once: enough to keep the line busy, few enough that
 * a slow one is not a crowd behind it. */
export const LANES = 3;
/** Tries per part before the send stops and says so. */
export const TRIES = 6;
/** How long a machine putting a move in place has to come back. A big
 * workspace unpacks for a while, and a hosted one may have to wake. */
export const BACK_WITHIN_MS = 10 * 60_000;
/** The toast before a move started on its own begins. */
export const AUTO_DELAY_MS = 6_000;

/** What to call the machine this app runs on, which is the local end of
 * every move. The same words as server/this-machine.ts, written out here
 * because the app cannot import the server's files: they are TypeScript,
 * built apart into Resources/server, outside the app's own files.
 * test/this-machine.test.ts holds the two to each other. */
export function thisMachine(platform = process.platform) {
  return platform === "darwin" ? "this Mac" : platform === "win32" ? "this PC" : "this computer";
}

const COUNTED = [
  ["agents", "agent", "agents"],
  ["conversations", "conversation", "conversations"],
  ["rooms", "room", "rooms"],
  ["routines", "routine", "routines"],
  ["watchers", "watcher", "watchers"],
  ["workflows", "workflow", "workflows"],
  ["memoryFiles", "memory file", "memory files"],
];

/** What did not arrive as it left, in words, or an empty list. The same
 * rule as server/workspace-move.ts countsDiffer, so the app can say it. */
export function countsDiffer(sent, arrived) {
  const out = [];
  for (const [key, one, many] of COUNTED) {
    const a = Number(sent?.[key] ?? NaN);
    const b = Number(arrived?.[key] ?? NaN);
    if (a !== b) out.push(`${Number.isFinite(b) ? b : 0} of ${Number.isFinite(a) ? a : 0} ${a === 1 ? one : many}`);
  }
  return out;
}

/** Something to tell the person, in a sentence. `code` marks the kinds the
 * app treats apart: "not-empty" and "stopped". */
export class MoveProblem extends Error {
  constructor(message, { code = "failed" } = {}) {
    super(message);
    this.code = code;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A sentence for a target with work in it already. */
export function notEmptyWords(move) {
  return move.direction === "to-hosted"
    ? "Your hosted workspace already has work in it, so nothing was moved. A workspace moves only into an empty one, and nothing there is merged or replaced."
    : `${move.to?.name || "That workspace"} already has work in it, so nothing was moved. Choose an empty workspace or a new one, or bring it back into the copy it came from.`;
}

// ── the state, kept on disk ────────────────────────────────────────────

/** A fresh move, before anything has happened. */
export function newMove({ direction, from, to, replace = false, auto = false, now = Date.now() }) {
  if (!DIRECTIONS.includes(direction)) throw new Error(`A move goes to the hosted machine or to ${thisMachine()}.`);
  return {
    id: `mv_${now.toString(36)}`,
    direction,
    auto: auto === true,
    from: { id: String(from?.id ?? ""), name: String(from?.name ?? "") },
    to: { id: to?.id ? String(to.id) : null, name: String(to?.name ?? "") },
    replace: replace === true,
    phase: auto ? "waiting" : "running",
    step: "pairing",
    startsAt: auto ? now + AUTO_DELAY_MS : null,
    file: null,
    upload: null,
    held: false,
    finishing: null,
    sent: 0,
    size: 0,
    keys: null,
    error: null,
    code: null,
    startedAt: now,
    updatedAt: now,
    doneAt: null,
  };
}

/** The app's record, whatever the file said: a broken one costs the record,
 * never the app. Kept under the licence's fingerprint (never the key), so
 * a move begun on one licence is not carried on under another. */
export function readMoveState(file, print) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    raw = null;
  }
  const blank = { version: 1, print: print ?? null, boughtFrom: null, moved: null, move: null };
  if (!raw || typeof raw !== "object") return blank;
  // a different licence (or none) starts over, except a move under way,
  // which belongs to the workspaces and not the licence
  const same = (raw.print ?? null) === (print ?? null);
  const move = raw.move && typeof raw.move === "object" && DIRECTIONS.includes(raw.move.direction) && PHASES.includes(raw.move.phase) ? raw.move : null;
  return {
    version: 1,
    print: print ?? null,
    boughtFrom: same && raw.boughtFrom && typeof raw.boughtFrom.id === "string" ? { id: raw.boughtFrom.id, at: Number(raw.boughtFrom.at) || 0 } : null,
    moved: same && raw.moved && typeof raw.moved === "object" ? { at: Number(raw.moved.at) || 0, from: String(raw.moved.from ?? ""), to: String(raw.moved.to ?? "") } : null,
    move,
  };
}

/** Written whole and renamed into place, so a crash halfway leaves the last
 * state rather than half of a new one. */
export function keepMoveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const staging = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(staging, file);
  } catch {
    /* kept in memory for this run; the next change tries the disk again */
  }
}

// ── starting on its own ────────────────────────────────────────────────

const LOCAL_KINDS = ["personal", "business", "custom"];
const ENDED = new Set(["canceled", "cancelled", "incomplete_expired", "unpaid", "past_due"]);

/** Whether the account answer says the hosted machine is running now. */
export function hostingRunning(account) {
  if (!account || account.shared === false) return false;
  if (account.accountStatus && ENDED.has(String(account.accountStatus))) return false;
  return String(account.hosting?.state ?? "").toLowerCase() === "active";
}

/**
 * The workspace to move to Hosting without asking, or null for no move.
 * Buying is the consent: once the account says the machine is running and
 * this licence has not moved yet, the workspace whose Plan page sent the
 * person to checkout goes, or Personal when that is not known or not here
 * any more. Never one already moved, a hosted or joined one, or while a
 * move is under way or was put off ("Not now" leaves a card instead).
 */
export function autoMoveFrom({ account, state, registry }) {
  if (!hostingRunning(account) || !registry) return null;
  if (state?.moved || state?.move) return null;
  const own = (id) => registry.workspaces.find((w) => w.id === id && LOCAL_KINDS.includes(w.kind) && !w.moved);
  const chosen = (state?.boughtFrom?.id && own(state.boughtFrom.id)) || registry.workspaces.find((w) => w.kind === "personal" && !w.moved);
  return chosen ? { id: chosen.id, name: chosen.name } : null;
}

/** The toast's words before a move started on its own begins. */
export function startingWords(move) {
  return move.direction === "to-hosted" ? `Moving ${move.from.name} to your hosted machine.` : `Moving ${move.from.name} to ${thisMachine()}.`;
}

/** The one calm sentence once a move is done. */
export function doneWords(move) {
  return move.direction === "to-hosted"
    ? `${move.from.name} runs on your hosted machine now. The copy on ${thisMachine()} stays, paused, until you remove it.`
    : `${move.from.name} runs on ${thisMachine()} now, as ${move.to.name}. Hosting is still paid for; change your plan in Settings, Plan.`;
}

// ── talking to the two servers ─────────────────────────────────────────

async function ask(doFetch, base, method, route, body, signal) {
  if (!base) return { ok: false, status: 0, body: { error: "It is not running right now." } };
  try {
    const res = await doFetch(`${base}${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(90_000),
    });
    const text = await res.text().catch(() => "");
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { ok: res.ok, status: res.status, body: parsed && typeof parsed === "object" ? parsed : {} };
  } catch (error) {
    if (signal?.aborted) throw new MoveProblem("Stopped.", { code: "stopped" });
    return { ok: false, status: 0, body: { error: "It could not be reached." } };
  }
}

const said = (answer, fallback) => (typeof answer?.body?.error === "string" && answer.body.error ? answer.body.error : fallback);

/**
 * Runs a move from wherever it got to, and answers it as it ends: done,
 * failed, stopped or put off. Every change is handed to `save`, which the
 * app keeps on disk and shows.
 *
 * `deps`:
 *  source(), target(): where each side answers now (it may move after a
 *    restart), or null while it is not up;
 *  pair(move): the pairing step, answering a patch for the move (a new
 *    workspace's id, say), or nothing;
 *  save(move): keeps and shows it;
 *  signal: stops it before it is being put in place, and its `reason` says
 *    "later" for Not now;
 *  fetch, wait, now, lanes, onPart: for the tests.
 */
export async function runMove(start, deps) {
  const doFetch = deps.fetch ?? ((...args) => fetch(...args));
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const backWithin = deps.backWithinMs ?? BACK_WITHIN_MS;
  const signal = deps.signal;
  let move = { ...start, phase: "running", error: null, code: null, startsAt: null };
  const save = (patch) => {
    move = { ...move, ...patch, updatedAt: now() };
    deps.save?.(move);
    return move;
  };
  const stopping = () => {
    if (signal?.aborted) throw new MoveProblem("Stopped.", { code: "stopped" });
  };
  const source = (method, route, body) => ask(doFetch, deps.source(), method, route, body);
  const target = (method, route, body) => ask(doFetch, deps.target(), method, route, body);
  const markTo = move.direction === "to-hosted" ? "hosted" : "mac";

  /** The side it leaves runs again, as it was. What it does from now on is
   * not in the file written out, so that file is no longer the workspace:
   * it is cleared, and the next try writes a fresh one. (A move cut off
   * with no chance to say so, an app quit or killed, stays paused and
   * carries on from its parts.) */
  const release = async () => {
    if (!move.held) return;
    const back = await source("DELETE", "/api/workspace/move/moved");
    if (!back.ok) return;
    if (move.file?.name) await source("DELETE", `/api/workspace/move/${encodeURIComponent(move.file.name)}`);
    save({ held: false, file: null, upload: null, sent: 0 });
  };

  save({});
  try {
    // ── pairing ──
    if (!move.finishing) {
      save({ step: "pairing" });
      const patch = await deps.pair?.(move);
      if (patch) save(patch);
      stopping();
      const there = await target("GET", "/api/workspace/move");
      if (!there.ok) throw new MoveProblem(`${move.to.name || "The other machine"} did not answer (${said(there, `HTTP ${there.status}`)}). Retry once it is up.`);
      // a Bloks from before this pipeline can take a file in by hand, from
      // Backups, but cannot say what arrived, so a move is not started there
      if (!there.body.counts || !("lastRestore" in there.body)) {
        throw new MoveProblem(`Bloks on ${move.direction === "to-hosted" ? "your hosted machine" : thisMachine()} needs an update before a workspace can move there.`);
      }
      const replaceable = move.replace && there.body.moved && !there.body.moved.pending;
      if (!there.body.empty && !replaceable) throw new MoveProblem(notEmptyWords(move), { code: "not-empty" });
    }

    // ── packing ──
    if (!move.file && !move.finishing) {
      save({ step: "packing" });
      // paused while it is carried: what runs on its own stops here now,
      // so nothing it does meanwhile is left behind in this copy
      const held = await source("POST", "/api/workspace/move/moved", { to: markTo, name: move.to.name, workspaceId: move.to.id, pending: true });
      if (!held.ok) throw new MoveProblem(`${move.from.name} could not be paused for the move (${said(held, `HTTP ${held.status}`)}).`);
      save({ held: true });
      stopping();
      const made = await source("POST", "/api/workspace/move", {});
      if (!made.ok) throw new MoveProblem(`${move.from.name} could not be written out (${said(made, `HTTP ${made.status}`)}).`);
      const b = made.body;
      const partDigests = Array.isArray(b.partDigests) ? b.partDigests.map(String) : [];
      if (!b.backup?.name || !Number.isInteger(b.size) || !b.sha256 || !b.partSize || partDigests.length !== Math.ceil(b.size / b.partSize)) {
        throw new MoveProblem(`${move.from.name} wrote the file out in a way this app does not understand. Update Bloks and try again.`);
      }
      save({
        file: { name: b.backup.name, size: b.size, sha256: b.sha256, partSize: b.partSize, partDigests, counts: b.counts ?? null, keys: Array.isArray(b.keys) ? b.keys : [] },
        size: b.size,
        sent: 0,
        upload: null,
      });
    }

    // ── sending ──
    if (!move.finishing) {
      save({ step: "sending" });
      await send();
    }

    // ── unpacking ──
    if (!move.finishing) {
      stopping();
      save({ step: "unpacking" });
      if (!move.held) {
        const held = await source("POST", "/api/workspace/move/moved", { to: markTo, name: move.to.name, workspaceId: move.to.id, pending: true });
        if (!held.ok) throw new MoveProblem(`${move.from.name} could not be paused for the move (${said(held, `HTTP ${held.status}`)}).`);
        save({ held: true });
      }
      const done = await target("POST", `/api/workspace/move/upload/${move.upload.id}/finish`, {
        sha256: move.file.sha256,
        counts: move.file.counts,
        replace: move.replace,
      });
      if (!done.ok) {
        if (done.body.notEmpty) throw new MoveProblem(notEmptyWords(move), { code: "not-empty" });
        throw new MoveProblem(`It could not be put in place there (${said(done, `HTTP ${done.status}`)}), so both sides are as they were. Retry sends it again.`);
      }
      save({ finishing: { name: String(done.body.restore?.from ?? ""), at: now() }, keys: Array.isArray(done.body.keys) ? done.body.keys : move.file.keys });
    } else {
      save({ step: "unpacking" });
    }

    // ── waiting for it to be in place, then checking ──
    const there = await backAgain((b) => b.lastRestore?.from === move.finishing.name, "after putting the workspace in place");
    save({ step: "checking" });
    const differ = countsDiffer(move.file.counts, there.counts);
    if (differ.length) {
      // landed, but not all of it: taken back out there, and this copy runs
      // again, so both are as they were
      const undo = await target("POST", "/api/workspace/move/undo");
      if (undo.ok) await backAgain((b) => b.lastRestore?.from !== move.finishing.name, "after taking the move back").catch(() => null);
      await release();
      save({ finishing: null, upload: null, file: null });
      throw new MoveProblem(`Not everything arrived (${differ.join(", ")}), so the move was taken back and ${move.from.name} carries on where it was. Try again.`);
    }

    // ── done ──
    const final = await source("POST", "/api/workspace/move/moved", { to: markTo, name: move.to.name, workspaceId: move.to.id, pending: false });
    if (!final.ok) {
      // it is in place there and checked; this copy stays paused, which is
      // what the mark is for, so this is worth saying and nothing more
      save({ error: `${move.from.name} could not be marked as moved here (${said(final, `HTTP ${final.status}`)}). It stays paused.` });
    }
    // the file was carried; it is the whole workspace, so it does not stay
    await source("DELETE", `/api/workspace/move/${encodeURIComponent(move.file.name)}`);
    // the hosted side, moved home, is left empty: set aside whole there,
    // its settings kept, and nothing of it running
    if (move.direction === "to-mac") await source("POST", "/api/workspace/move/empty");
    return save({ step: "done", phase: "done", doneAt: now(), held: false });
  } catch (error) {
    const problem = error instanceof MoveProblem ? error : new MoveProblem(String(error?.message ?? error));
    if (problem.code === "stopped") {
      // put off or stopped before it was being put in place: this copy
      // runs again, and the parts already there wait for the next try
      if (!move.finishing) await release().catch(() => {});
      return save({ phase: signal?.reason === "later" ? "later" : "stopped", error: null, code: null });
    }
    // anything before the finish leaves both sides as they were; after
    // it, what is known is kept so Retry checks again rather than resends
    if (!move.finishing) await release().catch(() => {});
    return save({ phase: "failed", error: problem.message, code: problem.code });
  }

  /** Every part not yet there, a few at once, each checked twice. */
  async function send() {
    const file = move.file;
    const sizeOf = (index) => (index === file.partDigests.length - 1 ? file.size - index * file.partSize : file.partSize);
    let missing = null;
    if (move.upload?.id) {
      const was = await target("GET", `/api/workspace/move/upload/${move.upload.id}`);
      if (was.ok && was.body.size === file.size && (was.body.sha256 ?? file.sha256) === file.sha256 && Array.isArray(was.body.missing)) missing = was.body.missing;
    }
    if (!missing) {
      const started = await target("POST", "/api/workspace/move/upload", { size: file.size, sha256: file.sha256, replace: move.replace });
      if (!started.ok) {
        if (started.body.notEmpty) throw new MoveProblem(notEmptyWords(move), { code: "not-empty" });
        throw new MoveProblem(`The other machine would not take it (${said(started, `HTTP ${started.status}`)}).`);
      }
      if (started.body.partSize !== file.partSize) throw new MoveProblem("The two machines cut the file into parts of different sizes. Update Bloks on both and try again.");
      save({ upload: { id: started.body.id } });
      missing = Array.from({ length: file.partDigests.length }, (_, i) => i);
    }
    const queue = [...missing];
    let sent = file.size - queue.reduce((n, index) => n + sizeOf(index), 0);
    save({ sent });
    const one = async (index) => {
      let why = "";
      for (let attempt = 1; ; attempt++) {
        stopping();
        await deps.onPart?.(index, attempt);
        stopping();
        const got = await partFrom(index);
        if (got.bytes) {
          const put = await putPart(index, got.bytes);
          if (put.ok) return;
          // gone there, or refused for what it is: sending it again changes nothing
          if (put.status === 404) {
            save({ upload: null });
            throw new MoveProblem("The parts sent so far were cleared on the other machine. Retry sends the workspace again.");
          }
          if (put.status === 400 || put.status === 413) throw new MoveProblem(`A part was refused there (${said(put, `HTTP ${put.status}`)}).`);
          why = said(put, `HTTP ${put.status}`);
        } else {
          why = got.why;
        }
        if (attempt >= TRIES) throw new MoveProblem(`A part did not get through (${why}), so nothing was moved and ${move.from.name} carries on here. Retry sends it again.`);
        await wait(Math.min(1_000 * 2 ** attempt, 20_000));
      }
    };
    const lane = async () => {
      while (queue.length) {
        const index = queue.shift();
        await one(index);
        sent += sizeOf(index);
        save({ sent });
      }
    };
    const lanes = Math.max(1, Math.min(deps.lanes ?? LANES, queue.length || 1));
    await Promise.all(Array.from({ length: lanes }, lane));
  }

  /** One part, read from the side it leaves and checked against the digest
   * said when the file was written. */
  async function partFrom(index) {
    const base = deps.source();
    if (!base) return { why: `${move.from.name} is not running` };
    try {
      const res = await doFetch(`${base}/api/workspace/move/${encodeURIComponent(move.file.name)}/part/${index}`, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { why: body.error ?? `HTTP ${res.status}` };
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (sha256(bytes) !== move.file.partDigests[index]) return { why: `part ${index} was changed on the way` };
      return { bytes };
    } catch {
      return { why: `${move.from.name} could not be reached` };
    }
  }

  async function putPart(index, bytes) {
    const base = deps.target();
    if (!base) return { ok: false, status: 0, body: { error: "the other machine is not running" } };
    try {
      const res = await doFetch(`${base}/api/workspace/move/upload/${move.upload.id}/${index}?sha256=${move.file.partDigests[index]}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(90_000),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    } catch {
      return { ok: false, status: 0, body: { error: "the other machine could not be reached" } };
    }
  }

  /** The target answering again after a restart, with `ready` true of what
   * it says; what it says, once it is. */
  async function backAgain(ready, while_) {
    const until = now() + backWithin;
    for (;;) {
      await deps.waitBack?.(move);
      const there = await target("GET", "/api/workspace/move");
      if (there.ok) {
        const b = there.body;
        if (b.restore?.phase === "failed") {
          await release().catch(() => {});
          save({ finishing: null, upload: null });
          throw new MoveProblem(`It could not be put in place there (${b.restore.error ?? "the restore stopped"}), so both sides are as they were. Try again.`);
        }
        const settled = !b.restore || b.restore.phase === "cancelled";
        if (settled && ready(b)) return b;
      }
      if (now() > until) throw new MoveProblem(`The other machine did not come back ${while_}. Retry checks again.`);
      await wait(1_500);
    }
  }
}
