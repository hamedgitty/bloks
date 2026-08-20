// Saved teams: rooms someone liked enough to keep.
//
// A saved team is a name plus the same member rows a team manifest
// carries (title, description, skills, seniority, appearance), never
// agent ids or transcripts. Saving is what makes a custom room
// repeatable: hire it again next month, or hand the file to a friend.
//
// One JSON file under DATA_DIR, small and rewritten whole; this is a
// bookshelf, not a database.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export interface SavedTeam {
  id: string;
  name: string;
  members: unknown[];
  savedAt: number;
}

const FILE = join(DATA_DIR, "team-library.json");
const MAX_TEAMS = 50;

export class TeamLibrary {
  private teams: SavedTeam[] = [];

  constructor(file: string = FILE) {
    this.file = file;
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) this.teams = parsed.filter((t) => t && typeof t.id === "string");
    } catch {
      /* first run */
    }
  }

  private readonly file: string;

  list(): SavedTeam[] {
    return this.teams;
  }

  save(name: string, members: unknown[]): SavedTeam {
    const team: SavedTeam = { id: randomUUID(), name, members, savedAt: Date.now() };
    // saving the same name again replaces it: re-saving a refined room
    // should update the shelf copy, not breed near-duplicates
    this.teams = [team, ...this.teams.filter((t) => t.name !== name)].slice(0, MAX_TEAMS);
    this.write();
    return team;
  }

  remove(id: string) {
    this.teams = this.teams.filter((t) => t.id !== id);
    this.write();
  }

  private write() {
    writeFileSync(this.file, JSON.stringify(this.teams, null, 2), { mode: 0o600 });
  }
}
