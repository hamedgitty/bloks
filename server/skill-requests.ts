// A new skill an agent asks to add to the library, and to use itself.
//
// Asked to write a skill and make it its own, an agent could write the
// files and stop: adding to the library is the person's, and an agent's
// credential is refused there (GitHub 455). That stays true. What changes
// is the way to ask. The agent sends the whole skill, its instructions,
// its supporting files and whether it wants it for itself, and the person
// gets one card in the conversation that shows all of it and answers it
// with one press: Add, which adds the skill and gives it to the agent, or
// Not now. Nothing is in the library until then, whatever the agent says
// the person asked for: its words are an input, and a skill is read into
// every turn of every agent that uses it.
//
// The id is said up front and is the id the skill will have. A skill
// already in the library under that id is never written over: the agent
// is told whose it is and to propose a change to it instead, or to choose
// another id. The same request sent twice, after an answer that never
// arrived, finds the card already waiting, or the skill already added,
// and says so rather than asking twice.
//
// Pure: the reading of a request and its fingerprint, and where the words
// of a waiting one are kept. The card, the waiting and the answer are
// server/index.ts's.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkSupportingFiles, type SupportingFile } from "./skill-files.ts";
import { parseSkillFile } from "./catalog.ts";
import { countChars, MAX_SKILL_CHARS, parseMarkdown, slugify } from "./skills.ts";

/** A skill's name as the library shows it, and its one line. */
export const MAX_SKILL_NAME = 80;
export const MAX_SKILL_DESCRIPTION = 200;
/** Requests waiting on the person at once, workspace wide: a card each,
 * and the words of each kept until it is answered. */
export const MAX_WAITING = 50;

/** A skill as an agent asked for it, read and checked. */
export interface SkillDraft {
  id: string;
  name: string;
  description: string;
  body: string;
  files: SupportingFile[];
  /** Give it to the agent that asked, as well as adding it. */
  attach: boolean;
  why: string;
}

/** The card in the conversation: what the person decides on, without
 * the words themselves, which are fetched when the card is opened. */
export interface SkillRequestCard {
  /** The request's own id, stable from the moment it is made. */
  id: string;
  /** The conversation the card is in. */
  laneId: string;
  botId: string;
  agentName: string;
  /** The id the skill will have in the library. */
  skillId: string;
  name: string;
  description: string;
  /** How long the instructions are, in characters. */
  chars: number;
  files: Array<{ path: string; size: number }>;
  attach: boolean;
  why?: string;
  fingerprint: string;
  /** Set once the agent has been told how it went. */
  told?: boolean;
  /** added: in the library, and given to the agent if it asked; declined:
   * Not now; failed: Add was pressed and it could not be added; replaced:
   * the agent sent a newer version, on a card of its own. */
  outcome?: "added" | "declined" | "failed" | "replaced";
  attached?: boolean;
  error?: string;
  replacedBy?: string;
}

const line = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** A request as it came, read into a draft, or what is wrong with it,
 * with the status that says so. */
export function readSkillRequest(raw: Record<string, unknown>): { ok: true; draft: SkillDraft } | { ok: false; status: number; error: string } {
  const tooLong = (length: number) => ({
    ok: false as const,
    status: 413,
    error:
      `The instructions are ${length.toLocaleString("en-US")} characters; a skill's are at most ${MAX_SKILL_CHARS.toLocaleString("en-US")}. ` +
      "Keep them to what to do and when, and move references, tables and scripts into supporting files that the instructions name: they are read only when needed.",
  });
  // A SKILL.md, read as the catalogue reads one: its name is the id it
  // keeps, and the name people see is its title (or its first heading),
  // so a folder made for another tool comes in with both.
  let doc: { id?: string; name?: string; description?: string; body: string } | null = null;
  if (typeof raw.skillMd === "string") {
    const source = raw.skillMd;
    try {
      const parsed = parseSkillFile(source);
      // the top block names it, as a line of its own before the block ends
      const declared = /^\uFEFF?---\r?\n(?:(?!---)[^\n]*\n)*?name\s*:\s*\S/.test(source);
      doc = { ...(declared ? { id: parsed.name } : {}), name: parsed.title, description: parsed.description, body: parsed.body };
    } catch (error) {
      if ((error as { status?: number }).status === 413) return tooLong(countChars(parseMarkdown(source).body));
      return { ok: false, status: 400, error: `That SKILL.md could not be read: ${(error as Error).message}` };
    }
  }
  const body = (typeof raw.body === "string" ? raw.body : doc?.body ?? "").trim();
  if (!body) return { ok: false, status: 400, error: "A skill needs its instructions: the text an agent follows." };
  const length = countChars(body);
  if (length > MAX_SKILL_CHARS) return tooLong(length);
  const name = line(typeof raw.name === "string" ? raw.name : doc?.name, MAX_SKILL_NAME + 1);
  if (!name) return { ok: false, status: 400, error: "A skill needs a name, as the person will see it in the library (--name)." };
  if (name.length > MAX_SKILL_NAME) return { ok: false, status: 400, error: `A skill's name is at most ${MAX_SKILL_NAME} characters.` };
  const description = line(typeof raw.description === "string" ? raw.description : doc?.description, MAX_SKILL_DESCRIPTION + 1);
  if (!description) {
    return { ok: false, status: 400, error: "A skill needs one line on when to use it (--description): it is how an agent decides to read it." };
  }
  if (description.length > MAX_SKILL_DESCRIPTION) {
    return { ok: false, status: 400, error: `A skill's description is at most ${MAX_SKILL_DESCRIPTION} characters.` };
  }
  let id: string;
  const askedId = raw.id !== undefined && raw.id !== null && raw.id !== "" ? raw.id : doc?.id;
  if (askedId !== undefined) {
    const asked = typeof askedId === "string" ? askedId.trim() : "";
    id = slugify(asked);
    // said exactly, because it is the id the skill will keep
    if (!asked || id !== asked) {
      return { ok: false, status: 400, error: `"${asked.slice(0, 80)}" is not an id a skill can have: lowercase letters, numbers and dashes, like ${id}.` };
    }
  } else {
    id = slugify(name);
  }
  const files = checkSupportingFiles(raw.files);
  if (!files.ok) return { ok: false, status: 400, error: files.error };
  return {
    ok: true,
    draft: { id, name, description, body, files: files.files, attach: raw.attach !== false, why: line(raw.why, 200) },
  };
}

/** The same request, word for word: what a retry is recognised by. */
export function fingerprintOf(draft: SkillDraft): string {
  return createHash("sha256")
    .update(JSON.stringify([draft.id, draft.name, draft.description, draft.body, draft.attach, draft.files.map((f) => [f.path, f.text])]))
    .digest("hex")
    .slice(0, 32);
}

/** A request waiting on the person: whose, where its card is, and the
 * skill in full. */
export interface WaitingSkillRequest {
  id: string;
  botId: string;
  laneId: string;
  messageId: string;
  fingerprint: string;
  at: number;
  draft: SkillDraft;
}

/** The words of requests still waiting, one file each, kept off the card
 * so a conversation does not carry a skill's every file. Gone once the
 * request is answered. */
export class SkillRequestStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(id: string): string | null {
    return /^[\w-]{8,64}$/.test(id) ? join(this.dir, `${id}.json`) : null;
  }

  save(request: WaitingSkillRequest): void {
    const file = this.file(request.id);
    if (!file) throw new Error("not a request id");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  }

  get(id: string): WaitingSkillRequest | null {
    const file = this.file(id);
    if (!file) return null;
    try {
      const request = JSON.parse(readFileSync(file, "utf8")) as WaitingSkillRequest;
      return request?.id === id && typeof request.draft?.body === "string" && Array.isArray(request.draft.files) ? request : null;
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    const file = this.file(id);
    if (file) rmSync(file, { force: true });
  }

  /** Every request waiting, oldest first. */
  list(): WaitingSkillRequest[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => this.get(name.slice(0, -".json".length)))
      .filter((request): request is WaitingSkillRequest => Boolean(request))
      .sort((a, b) => a.at - b.at);
  }
}
