// What your agents know about you, and how they came to know it.
//
// "About you" in Settings is one paragraph a person writes once and never
// updates. Everything an agent learns after that (you want bullet points,
// you are in Toronto, the company is called Rahimi, Fridays are for
// writing) lives in that one agent's memory at best, and a new agent
// starts from nothing.
//
// So agents can suggest a note about you, and you decide. Three rules:
//
//   Nothing lands on its own. A suggestion is a suggestion until you keep
//   it, exactly like a suggested skill. Something written about a person
//   without them agreeing to it is the thing people are right to dislike
//   about assistants that "learn".
//
//   Short and specific. A note is one fact, not a biography, so a person
//   can read the whole list in a minute and every agent can carry it
//   without cost.
//
//   Shared by every agent. A kept note is part of how every agent is
//   briefed from then on, so hiring a new one does not mean teaching it
//   from scratch. It stays out of rooms shared with other people, like
//   the rest of your private context.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { newId } from "./contracts.ts";
import { readSaved } from "./atomic-write.ts";

export interface ProfileNote {
  id: string;
  text: string;
  state: "suggested" | "kept";
  /** Who suggested it: an agent's id and name, or "you". */
  by: { id: string; name: string };
  at: number;
  keptAt?: number;
  /** The conversation it came from, so a person can check the context. */
  threadId?: string;
}

export const MAX_NOTE = 200;
export const MAX_KEPT = 60;
export const MAX_SUGGESTED = 20;

/** Lowercased letters and digits only: "Prefers bullet points." and
 * "prefers bullet-points" are the same note. */
const shape = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function cleanNote(text: unknown): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*•]\s*/, "")
    .slice(0, MAX_NOTE);
}

export class ProfileNotes {
  private notes: ProfileNote[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.notes = readSaved<ProfileNote[]>(file, [], Array.isArray).filter((n) => n?.id && typeof n.text === "string");
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.notes, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  list(): ProfileNote[] {
    return [...this.notes].sort((a, b) => b.at - a.at);
  }

  kept(): ProfileNote[] {
    return this.notes.filter((n) => n.state === "kept").sort((a, b) => (a.keptAt ?? a.at) - (b.keptAt ?? b.at));
  }

  suggested(): ProfileNote[] {
    return this.notes.filter((n) => n.state === "suggested");
  }

  /**
   * An agent's suggestion. Refused (null) when it is empty, already known
   * in either state, or the list of open suggestions is full: a pile of
   * forty unread suggestions is a sign agents are over-sharing, and the
   * answer is to stop taking more rather than to bury the good ones.
   */
  suggest(text: unknown, by: ProfileNote["by"], threadId?: string, now = Date.now()): ProfileNote | null {
    const clean = cleanNote(text);
    if (clean.length < 3) return null;
    if (this.notes.some((n) => shape(n.text) === shape(clean))) return null;
    if (this.suggested().length >= MAX_SUGGESTED) return null;
    const note: ProfileNote = { id: newId(), text: clean, state: "suggested", by, at: now, ...(threadId ? { threadId } : {}) };
    this.notes.push(note);
    this.save();
    return note;
  }

  /** A note you write yourself is kept from the start. */
  add(text: unknown, now = Date.now()): ProfileNote | null {
    const clean = cleanNote(text);
    if (clean.length < 3 || this.kept().length >= MAX_KEPT) return null;
    const existing = this.notes.find((n) => shape(n.text) === shape(clean));
    if (existing) return this.keep(existing.id, undefined, now);
    const note: ProfileNote = { id: newId(), text: clean, state: "kept", by: { id: "you", name: "You" }, at: now, keptAt: now };
    this.notes.push(note);
    this.save();
    return note;
  }

  /** Keep a suggestion, optionally in your own words. */
  keep(id: string, text?: unknown, now = Date.now()): ProfileNote | null {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return null;
    if (note.state !== "kept" && this.kept().length >= MAX_KEPT) return null;
    if (text !== undefined) {
      const clean = cleanNote(text);
      if (clean.length < 3) return null;
      note.text = clean;
    }
    note.state = "kept";
    note.keptAt = note.keptAt ?? now;
    this.save();
    return note;
  }

  remove(id: string): boolean {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    if (this.notes.length === before) return false;
    this.save();
    return true;
  }

  /** An agent that is gone takes its open suggestions with it; what you
   * kept is yours and stays. */
  forgetSuggestionsBy(botId: string) {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => !(n.state === "suggested" && n.by.id === botId));
    if (this.notes.length !== before) this.save();
  }

  /** The kept notes as agents are briefed on them. */
  prompt(): string | null {
    const kept = this.kept();
    if (!kept.length) return null;
    return `What you and the other agents have learned about this person, and they confirmed:\n${kept.map((n) => `- ${n.text}`).join("\n")}`;
  }
}

/** How agents are told they can add to it. */
export function noteBriefing(command: string | null): string {
  const how = command
    ? `suggest it with \`${command} note "<one short fact>"\``
    : "suggest it with the note_about_person tool";
  return `If you learn something lasting about the person you work for (how they like answers, their role, their timezone, names they use), ${how}. One fact per note, only things that will still be true next month, never secrets or anything sensitive. They decide whether to keep it.`;
}
