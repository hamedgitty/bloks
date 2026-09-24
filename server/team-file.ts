// A team as one Markdown file.
//
// The JSON manifest a room exports is exact and unreadable. A team worth
// sharing is one somebody wrote on purpose, so the file is prose first:
// a title, a line on what the team is for, and one section per member,
// headed by the role, with the member's brief as the body. The few things
// that are not prose ride as `key: value` lines at the top of a section.
//
//   ---
//   name: Launch crew
//   blurb: Ships a product launch, end to end.
//   ---
//
//   ## Launch lead
//   seniority: 5
//   look: blue star
//   skills:
//   - Review everything before it ships
//   - Keep the plan to one page
//
//   Runs the launch. Reviews what comes back and makes the call.
//
// Members carry no names, like the premade library: a name is assigned
// when the team is hired. A file that does carry one (`name:` in a
// section) keeps it as a suggestion.
//
// Everything is clamped to the same limits the import route applies, and
// a file that cannot be read says which line, rather than hiring half a
// team. The gallery on bloks.dev is checked with this same parser before
// anything reaches the hire dialog.
import {
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_SKILL_CHARS,
  MAX_SKILLS,
  MAX_TITLE_CHARS,
} from "./limits.ts";
import type { BlokColor, BlokShape } from "./store.ts";

export const TEAM_FILE_MAX_BYTES = 64 * 1024;
/** The most seats a room holds (server/bloks.ts). */
const MAX_TEAM_MEMBERS = 8;

export const COLORS: BlokColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];
export const SHAPES: BlokShape[] = ["star", "burst", "diamond", "bit", "triangle", "cloud", "drop", "invader"];

export interface TeamFileMember {
  name?: string;
  title: string;
  description: string;
  skills: string[];
  seniority: number;
  color: BlokColor;
  shape: BlokShape;
}

export interface TeamFile {
  name: string;
  blurb: string;
  members: TeamFileMember[];
}

export class TeamFileError extends Error {}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max).trimEnd() : text);
/** No dashes of the long kinds, whatever an author typed; the house style. */
const plain = (text: string) => text.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\r/g, "");

/**
 * Reads a team file. Throws TeamFileError with a sentence a person can act
 * on; anything it returns is within every limit.
 */
export function parseTeamFile(source: string): TeamFile {
  if (Buffer.byteLength(source, "utf8") > TEAM_FILE_MAX_BYTES) throw new TeamFileError("That file is too large to be a team.");
  const text = plain(source).replace(/^\uFEFF/, "");
  const lines = text.split("\n");
  let at = 0;
  const head: Record<string, string> = {};
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    const close = end === -1 ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : end;
    if (close === -1) throw new TeamFileError("The block at the top opens with --- but never closes.");
    for (const line of lines.slice(1, close)) {
      const m = line.match(/^([A-Za-z]+):\s*(.*)$/);
      if (m) head[m[1].toLowerCase()] = m[2].trim();
    }
    at = close + 1;
  }
  // a "# Title" line also names the team, for files written without the block
  let name = head.name ?? "";
  const members: TeamFileMember[] = [];
  let current: { head: string; lineNo: number; body: string[] } | null = null;
  const sections: Array<{ head: string; lineNo: number; body: string[] }> = [];
  const intro: string[] = [];
  for (let i = at; i < lines.length; i++) {
    const line = lines[i];
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1 && !current && !name) {
      name = h1[1].trim();
      continue;
    }
    if (h2) {
      current = { head: h2[1].trim(), lineNo: i + 1, body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    else intro.push(line);
  }
  name = clip(name.trim(), MAX_NAME_CHARS);
  if (!name) throw new TeamFileError("Give the team a name: `name:` at the top, or a `# Title` line.");
  const blurb = clip((head.blurb ?? head.description ?? intro.join(" ").replace(/\s+/g, " ")).trim(), 280);
  if (sections.length < 2) throw new TeamFileError("A team needs at least two members, each a `## Role` section.");
  if (sections.length > MAX_TEAM_MEMBERS) throw new TeamFileError(`A room holds up to ${MAX_TEAM_MEMBERS} members; this file has ${sections.length}.`);

  for (const [index, section] of sections.entries()) {
    const fields: Record<string, string> = {};
    const skills: string[] = [];
    const body: string[] = [];
    let inSkills = false;
    let inBody = false;
    for (const raw of section.body) {
      const line = raw.trimEnd();
      if (!inBody) {
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        if (inSkills && bullet) {
          skills.push(bullet[1].trim());
          continue;
        }
        const field = line.match(/^([A-Za-z]+):\s*(.*)$/);
        if (field && ["name", "seniority", "look", "color", "shape", "skills"].includes(field[1].toLowerCase())) {
          const key = field[1].toLowerCase();
          inSkills = key === "skills";
          if (inSkills && field[2].trim()) skills.push(...field[2].split(/\s*;\s*/).filter(Boolean));
          else if (!inSkills) fields[key] = field[2].trim();
          continue;
        }
        if (!line.trim()) {
          inSkills = false;
          continue;
        }
        inBody = true;
      }
      body.push(raw);
    }
    const where = `the ${section.head} section (line ${section.lineNo})`;
    const seniorityRaw = fields.seniority ?? "";
    const seniority = seniorityRaw ? Number(seniorityRaw) : 1;
    if (!Number.isInteger(seniority) || seniority < 1 || seniority > 5) {
      throw new TeamFileError(`Seniority in ${where} should be a whole number from 1 to 5.`);
    }
    const look = (fields.look ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const color = (fields.color?.toLowerCase() ?? look.find((w) => (COLORS as string[]).includes(w))) as BlokColor | undefined;
    const shape = (fields.shape?.toLowerCase() ?? look.find((w) => (SHAPES as string[]).includes(w))) as BlokShape | undefined;
    if (color && !COLORS.includes(color)) throw new TeamFileError(`The color in ${where} should be one of ${COLORS.join(", ")}.`);
    if (shape && !SHAPES.includes(shape)) throw new TeamFileError(`The shape in ${where} should be one of ${SHAPES.join(", ")}.`);
    const description = clip(body.join("\n").trim(), MAX_DESCRIPTION_CHARS);
    if (!description) throw new TeamFileError(`Say what the member in ${where} does, as a line or two under its heading.`);
    members.push({
      ...(fields.name ? { name: clip(fields.name, MAX_NAME_CHARS) } : {}),
      title: clip(section.head, MAX_TITLE_CHARS),
      description,
      skills: skills.map((s) => clip(s, MAX_SKILL_CHARS)).filter(Boolean).slice(0, MAX_SKILLS),
      seniority,
      color: color ?? COLORS[index % COLORS.length],
      shape: shape ?? SHAPES[index % SHAPES.length],
    });
  }
  // A room reviews under its most senior member. A file where two tie at
  // the top is fine; one with nobody above 1 still gets a lead: the first.
  if (members.every((m) => m.seniority === 1)) members[0].seniority = 5;
  return { name, blurb, members };
}

/** Writes a team back out as a file someone would want to read. */
export function writeTeamFile(team: { name: string; blurb?: string; members: Array<Partial<TeamFileMember> & { title?: string }> }): string {
  const out: string[] = ["---", `name: ${oneLine(team.name) || "A team"}`];
  if (team.blurb?.trim()) out.push(`blurb: ${oneLine(team.blurb)}`);
  out.push("---", "");
  for (const member of team.members) {
    out.push(`## ${oneLine(member.title || member.name || "Member")}`);
    if (member.name) out.push(`name: ${oneLine(member.name)}`);
    out.push(`seniority: ${member.seniority ?? 1}`);
    if (member.color || member.shape) out.push(`look: ${[member.color, member.shape].filter(Boolean).join(" ")}`);
    const skills = (member.skills ?? []).map(oneLine).filter(Boolean);
    if (skills.length) {
      out.push("skills:");
      for (const skill of skills) out.push(`- ${skill}`);
    }
    out.push("", plain(member.description?.trim() || "Works on whatever the lead hands over."), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function oneLine(text: string): string {
  return plain(text).replace(/\s+/g, " ").trim();
}

// ── the gallery ───────────────────────────────────────────────────────

export const GALLERY_URL = "https://bloks.dev/teams/index.json";
export const GALLERY_MAX_BYTES = 1024 * 1024;

export interface GalleryTeam extends TeamFile {
  slug: string;
  author?: string;
}

/**
 * The gallery's index as teams, each read with the same parser a file
 * from a friend gets. An entry that does not parse is left out rather
 * than shown broken; the gallery is ours, but the rule is the same.
 */
export function parseGallery(value: unknown): GalleryTeam[] {
  const list = Array.isArray((value as { teams?: unknown })?.teams) ? (value as { teams: unknown[] }).teams : [];
  const out: GalleryTeam[] = [];
  const seen = new Set<string>();
  for (const raw of list.slice(0, 200)) {
    const entry = raw as Record<string, unknown>;
    const slug = typeof entry?.slug === "string" ? entry.slug : "";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || seen.has(slug) || typeof entry.file !== "string") continue;
    try {
      const team = parseTeamFile(entry.file);
      seen.add(slug);
      out.push({ slug, ...team, ...(typeof entry.author === "string" ? { author: entry.author.slice(0, 60) } : {}) });
    } catch {
      /* not shown */
    }
  }
  return out;
}

/** A JSON manifest from an older export, read as a team file would be. */
export function teamFromManifest(value: unknown): TeamFile {
  const manifest = value as { name?: unknown; members?: unknown };
  if (!manifest || !Array.isArray(manifest.members)) throw new TeamFileError("That is not a team file.");
  const rows = manifest.members as Array<Record<string, unknown>>;
  return parseTeamFile(
    writeTeamFile({
      name: typeof manifest.name === "string" ? manifest.name : "A team",
      members: rows.map((row) => ({
        ...(typeof row.name === "string" ? { name: row.name } : {}),
        title: typeof row.title === "string" && row.title ? row.title : typeof row.name === "string" ? row.name : "Member",
        description: typeof row.description === "string" ? row.description : "",
        skills: Array.isArray(row.skills) ? row.skills.filter((s): s is string => typeof s === "string") : [],
        seniority: typeof row.seniority === "number" ? Math.max(1, Math.min(5, Math.round(row.seniority))) : 1,
        ...(COLORS.includes(row.color as BlokColor) ? { color: row.color as BlokColor } : {}),
        ...(SHAPES.includes(row.shape as BlokShape) ? { shape: row.shape as BlokShape } : {}),
      })),
    }),
  );
}
